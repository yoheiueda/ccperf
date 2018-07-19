// Author: Yohei Ueda <yohei@jp.ibm.com>

const cluster = require('cluster');
const program = require('commander');
const fs = require('fs');
const path = require('path');
const sdk = require('fabric-client');
const sprintf = require('sprintf-js').sprintf;

const logger = require('winston');
if (process.env.FABRIC_CONFIG_LOGLEVEL) {
    logger.level = process.env.FABRIC_CONFIG_LOGLEVEL;
}

function loadFile(path) {
    return fs.readFileSync(path, 'utf8');
}

class MemoryKeyValueStore {
    constructor(options){
       const self = this;
       logger.debug('MemoryKeyValueStore: constructor options=%j', options);
       self._store = new Map();
       return Promise.resolve(self);
   }

   getValue(name) {
       const value = Promise.resolve(this._store.get(name));
       logger.debug('MemoryKeyValueStore: getValue name=%j value=%j', name, value);
       return value;
   }

   setValue(name, value) {
       this._store.set(name, value);
       logger.debug('MemoryKeyValueStore: setValue name=%j value=%j', name, value);
       return Promise.resolve(value);
   }
}

async function getClient(profile) {
    const cryptoSuite = sdk.newCryptoSuite();
    const cryptoKeyStore = sdk.newCryptoKeyStore(MemoryKeyValueStore, {})
    cryptoSuite.setCryptoKeyStore(cryptoKeyStore);

    process.chdir(path.dirname(profile));
    const client = sdk.loadFromConfig(path.basename(profile));

    client.setCryptoSuite(cryptoSuite);
    const newStore = await new MemoryKeyValueStore();
    client.setStateStore(newStore);

    const mspid = client.getMspid();
    org = client._network_config.getOrganizationByMspId(mspid);

    const userOpts = {
        username: "admin",
        mspid: mspid,
        cryptoContent: {signedCertPEM: org.getAdminCert(), privateKeyPEM: org.getAdminPrivateKey()},
        skipPersistence: false
    };

    const user = await client.createUser(userOpts);

    return client;
}


function roundDown(num, base) {
    return Math.floor(num/base) * base;
}

function roundUp(num, base) {
    return roundDown(num, base) + base;
}

function percentile(list, percent) {
    if (list.length == 0) {
        return 0.0;
    }
    list.sort();
    nth = roundDown(list.length * percent, 1);
    return list[nth];
}

function average(list) {
    if (list.length == 0) {
        return 0.0;
    }
    let sum = 0;
    for (const item of list) {
        sum += item;
    }
    return sum / list.length;
}

async function master(profile, processes, duration, interval, type, num, size, population) {
    const cwd1 = process.cwd();
    const client = await getClient(profile)
    const channel = client.getChannel()

    const peer_name = channel.getPeers()[0].getName();
    const eventhub = channel.getChannelEventHub(peer_name);
    eventhub.connect(false);

    if (population) {
        const tx_id = client.newTransactionID();

        p = new Promise(resolve => eventhub.registerTxEvent(tx_id.getTransactionID(),
                                                            (txId, code, block_bumber) => resolve(txId),
                                                            err => console.error('EventHub error ', err),
                                                            {unregister:true}));
        
        const request = {
            chaincodeId : 'ccperf',
            fcn: 'populate',
            args: ['0', String(population), String(size)],
            txId: tx_id
        };
    
        const results = await channel.sendTransactionProposal(request);
    
        const proposalResponses = results[0];
        const proposal = results[1];
        const orderer_request = {
            txId: tx_id,
            proposalResponses: proposalResponses,
            proposal: proposal
        };
        
        await channel.sendTransaction(orderer_request);    

        await p;
    }

    const blockTable = {}

    const start = Date.now() + 5000;
    let prev_t = 0;

    const blockRegNum = eventhub.registerBlockEvent(
        (block) => {
            // Example data structure of a filtered block:
            // {
            //   "channel_id": "mychannel",
            //   "number": "123",
            //   "filtered_transactions": [
            //     {
            //       "Data": "transaction_actions",
            //       "txid": "cd1c24b15e19e1923a1cda0fbd1a2db4528eafd6140d563e8ec9abdd5655bcc3",
            //       "type": "ENDORSER_TRANSACTION",
            //       "tx_validation_code": "VALID",
            //       "transaction_actions": {
            //         "chaincode_actions": []
            //       }
            //     }, ...]
            //  }
            const now = Date.now();
            if (prev_t == 0) {
                prev_t = start;
                return;
            }
            const txset = {}
            for (const tx of block.filtered_transactions) {
                let txTypes = txset[tx.type];
                if (txTypes === undefined) {
                    txTypes = {};
                    txset[tx.type] = txTypes;
                }
                let txResults = txTypes[tx.tx_validation_code];
                if (txResults === undefined) {
                    txResults = []
                    txTypes[tx.tx_validation_code] = txResults;
                }
                txResults.push(tx.txid);
            }
            blockTable[block.number] = { txset:txset, timestamp: now };
            const count = block.filtered_transactions.length;
            const tps = count / (now - prev_t) * 1000;
            console.error(sprintf('Block %d contains %d transaction(s). TPS is %.2f', block.number, count, tps));
            prev_t = now;
        },
        (err) => {
            console.error('EventHub error ', err);
        }
    );

    const cwd2 = process.cwd();
    process.chdir(cwd1);

    const txTable = {};

    cluster.on('message', (w, txStats) => {
        for (const txid in txStats) {
            txTable[txid] =  txStats[txid];
        }
    });

    const promises = [];

    for (var i = 0; i < processes; i++) {
        const delay = i*interval/processes;
        cluster.setupMaster({
            args: [profile, start, duration, interval, delay, type, num, size, population]
        });
    
        const w = cluster.fork();

        promises.push(new Promise(resolve => w.on('exit', resolve)));
    }

    await Promise.all(promises);
    await sleep(3000);

    process.chdir(cwd2);

    // info = await channel.queryInfo();
    // height = Number(info.height)
    // block = await channel.queryBlock(height-1);

    eventhub.unregisterBlockEvent(blockRegNum);
    eventhub.disconnect();

    let min_t1 = Number.MAX_VALUE;
    let max_t4 = 0;
    for (const num in blockTable) {
        const t4 = blockTable[num].timestamp;
        for (const txType in blockTable[num].txset) {
            for (const code in blockTable[num].txset[txType]) {
                for (const txid of blockTable[num].txset[txType][code]) {
                    tx = txTable[txid];
                    if (tx !== undefined) {
                        const [t1, t2, t3] = tx;
                        tx.push(t4);
                        if (t1 < min_t1) {
                            min_t1 = t1;
                        }
                        if (t4 > max_t4) {
                            max_t4 = t4;
                        }
                    }
                }
            }
        }
    }

    const period = 5000;

    min_t1 = roundDown(min_t1, period);
    max_t4 = roundUp(max_t4, period);
    const elapsed = max_t4 - min_t1;

    const latencies = [];

    for (let i = 0; i < elapsed/period; i++) {
        latencies.push({
            peer: [],
            orderer: [],
            commit: [],
        });
    }

    const begin = min_t1;

    for (const txid in txTable) {
        const tx = txTable[txid];
        const [t1, t2, t3, t4] = tx;
        latencies[roundDown(t2-begin, period)/period].peer.push(t2 - t1);
        latencies[roundDown(t3-begin, period)/period].orderer.push(t3 - t2);
        if (t4 !== undefined) {
            latencies[roundDown(t4-begin, period)/period].commit.push(t4 - t3);
        }
    }

    console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg peer.pctl orderer.pctl commit.pctl');
    for (let i = 0; i <  elapsed/period; i++) {
        const data = {
            elapsed: i * period / 1000,
            peer: {
                tps: latencies[i].peer.length / period * 1000,
                avg: average(latencies[i].peer),
                pctl: percentile(latencies[i].peer, 0.9)
            },
            orderer: {
                tps: latencies[i].orderer.length / period * 1000,
                avg: average(latencies[i].orderer),
                pctl: percentile(latencies[i].orderer, 0.9)                
            },
            commit: {
                tps: latencies[i].commit.length / period * 1000,
                avg: average(latencies[i].commit),
                pctl: percentile(latencies[i].commit, 0.9)        
            }
        };
        s = sprintf('%(elapsed)8d %(peer.tps)8.2f %(orderer.tps)11.2f %(commit.tps)10.2f %(peer.avg)8.2f %(orderer.avg)11.2f %(commit.avg)10.2f %(peer.pctl)9.2f %(orderer.pctl)12.2f %(commit.pctl)11.2f', data);
        console.log('%s', s);
    }
}

const handlerTable = {
    'putstate' : {
        'genArgs': info => [String(info.num), String(info.size), sprintf('key_mychannel_org1_0_%d_%d', info.workerID, info.index)]
    },
    'getstate' : {
        'genArgs': info => [String(info.num), String(info.population), sprintf('key_mychannel_org1_0_%d_%d', info.workerID, info.index)]
    },
    'mix' : {
        'genArgs': info => [String(info.num), String(info.size), sprintf('key_mychannel_org1_0_%d_%d', info.workerID, info.index), String(info.population)]
    }
}

async function execute(info) {
    const client = info.client;
    const channel = info.channel;
    const txStats = info.txStats;
    info.index += 1;

    const tx_id = client.newTransactionID();

    const request = {
        chaincodeId : 'ccperf',
        fcn: info.type,
        args: info.genArgs(info),
        txId: tx_id
    };

    const t1 = Date.now();

    const results = await channel.sendTransactionProposal(request);

    const t2 = Date.now();

    const proposalResponses = results[0];
    const proposal = results[1];
    const orderer_request = {
        txId: tx_id,
        proposalResponses: proposalResponses,
        proposal: proposal
    };
    
    orderer_results = await channel.sendTransaction(orderer_request);

    const t3 = Date.now();

    txStats[tx_id.getTransactionID()] = [t1, t2, t3];
}

async function worker(profile, start, duration, interval, delay, type, num, size, population) {
    const client = await getClient(profile);
    const channel = client.getChannel();
    const txStats = {};
    const genArgs = handlerTable[type].genArgs;
    const info = {
        client: client,
        channel: channel,
        txStats: txStats,
        workerID: cluster.worker.id,
        type: type,
        num: num,
        size: size,
        population: population,
        index: 1,
        genArgs: genArgs
    };

    const wait = start + delay - Date.now();
    if (wait > 0) {
        await sleep(wait);
    }

    const timeout = setInterval(execute, interval, info);

    await sleep(duration);

    clearInterval(timeout);

    await new Promise(resolve => {
        process.send(txStats, null, {}, resolve);
    });

    process.exit(0); // Forces to close all connections
}

function sleep(msec) {
    return new Promise(resolve => setTimeout(resolve, msec));
}

async function run(cmd) {
    const profile = cmd.profile;
    const processes = cmd.processes;
    const target = cmd.target;
    const type = cmd.type;
    const num = cmd.num;
    const size = cmd.size;
    const population = cmd.population;

    const duration = 1000.0 * cmd.duration;

    const tps = target / processes;
    const interval = 1000.0 / tps

    await master(profile, processes, duration, interval, type, num, size, population);

}

function main() {

    if (! cluster.isMaster) {
        const [profile, start, duration, interval, delay, type, num, size, population] = process.argv.slice(2);
        worker(profile, Number(start), Number(duration), Number(interval), Number(delay), type, Number(num), Number(size), Number(population));
        return;
    }
    
    program.command('run')
        .option('--processes [number]', "Number of processes to be launched")
        .option('--profile [path]',     "Connection profile")
        .option('--target [number]',    "Target input TPS")
        .option('--duration [number]',    "Duration in second")
        .option('--type [string]',   "Type of workload (eg. putstate)")
        .option('--num [number]',    "Number of operations per transaction")
        .option('--size [bytes]',    "Payload size of a PutState call")
        .option('--population [number]',    "Number of prepopulated key-values")
        .action(run);
    program.parse(process.argv);
}

main();
