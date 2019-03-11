// Author: Yohei Ueda <yohei@jp.ibm.com>

const cluster = require('cluster');
const program = require('commander');
const fs = require('fs');
const path = require('path');
const sdk = require('fabric-client');
const sdkutil = require('fabric-client/lib/utils.js');
const util = require('util');
const sprintf = require('sprintf-js').sprintf;
const yaml = require('js-yaml');
const request = require('request');
const WebSocket = require('ws');
const glob = require('glob');

const logger = require('winston');
if (process.env.FABRIC_CONFIG_LOGLEVEL) {
    logger.level = process.env.FABRIC_CONFIG_LOGLEVEL;
}
function loadFile(filePath, baseDir) {
    if (!path.isAbsolute(filePath) && baseDir !== undefined) {
        filePath = path.join(baseDir, filePath);
    }
    return fs.readFileSync(filePath, 'utf8');
}

class MemoryKeyValueStore {
    constructor(options) {
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

async function getClient(profile, orgName) {
    const cryptoSuite = sdk.newCryptoSuite();
    const cryptoKeyStore = sdk.newCryptoKeyStore(MemoryKeyValueStore, {})
    cryptoSuite.setCryptoKeyStore(cryptoKeyStore);

    const client = sdk.loadFromConfig(profile);

    client.setCryptoSuite(cryptoSuite);
    const newStore = await new MemoryKeyValueStore();
    client.setStateStore(newStore);

    const org = profile.organizations[orgName];

    const userOpts = {
        username: "admin",
        mspid: org.mspid,
        cryptoContent: { signedCertPEM: org.signedCert.pem, privateKeyPEM: org.adminPrivateKey.pem },
        skipPersistence: false
    };

    const user = await client.createUser(userOpts);

    return client;
}


function roundDown(num, base) {
    return Math.floor(num / base) * base;
}

function roundUp(num, base) {
    return roundDown(num, base) + base;
}

function percentile(list, percent) {
    if (list.length == 0) {
        return 0.0;
    }
    list.sort((a, b) => a - b);
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

function doRequest(options) {
    return new Promise(function (resolve, reject) {
        request(options, function (error, res, body) {
            if (!error && res.statusCode < 300) {
                resolve(body);
            } else {
                reject(error);
            }
        });
    });
}

async function populate(config, channel) {
    const client = await getClient(config.profile, config.orgName)
    const channel = client.getChannel(config.channelID);

    const peer_name = channel.getPeers()[0].getName();
    const eventhub = channel.getChannelEventHub(peer_name);
    eventhub.connect(false);

    const tx_id = client.newTransactionID();

    const p = new Promise(resolve => eventhub.registerTxEvent(tx_id.getTransactionID(),
        (txId, code, block_bumber) => resolve(txId),
        err => console.error('EventHub error ', err),
        { unregister: true }));

    const request = {
        chaincodeId: 'ccperf',
        fcn: 'populate',
        args: ['0', String(config.population), String(config.size)],
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
    eventhub.disconnect();
}

async function monitor(config, channel, blockTable, blocksLog, txTable, metrics, prometheusConfig) {
    if (config.prometheus) {
        const timestamp = parseInt((config.start + config.rampup) / 1000);
        const url = config.prometheus + '/metrics/job/fabric/run_timestamp/' + timestamp + '/duration_seconds/' + config.duration / 1000;

        const requestOptions = {
            url: url,
            method: "PUT",
            headers: {
                "Content-type": "text/plain",
            },
            body: "ccperf_last_run_timestamp " + timestamp + "\n"
        }
        const res = await doRequest(requestOptions).catch(err => { throw new Error(err) });

        prometheusConfig.intId = setInterval(() => {
            const body =
                "ccperf_endorsement_count " + metrics.endorsementCount + "\n" +
                "ccperf_endorsement_sum " + metrics.endorsementSum / 1000 + "\n" +
                "ccperf_sendtransaction_count " + metrics.endorsementCount + "\n" +
                "ccperf_sendtransaction_sum " + metrics.endorsementSum / 1000 + "\n" +
                "ccperf_commit_count_accurate " + metrics.commitCountAccurate + "\n" +
                "ccperf_commit_count " + metrics.commitCount + "\n" +
                "ccperf_commit_sum " + metrics.commitSum / 1000 + "\n";
            //console.log(body);
            const requestOptions = {
                url: url,
                method: "PUT",
                headers: {
                    "Content-type": "text/plain",
                },
                body: body
            }
            //console.log(requestOptions);
            const p = doRequest(requestOptions).catch(err => { throw new Error(err) });

        }, 1000);
    }
    if (config.grafana) {
        const description = util.format("Target:%d Processes:%d Duration:%d Type:%s Num:%d Size:%d", 1000 / config.interval * config.processes, config.processes, config.duration, config.type, config.num, config.size);

        const payload = {
            "time": config.start + config.rampup,
            "isRegion": true,
            "timeEnd": config.start + config.rampup + config.duration,
            "tags": ["run"],
            "text": description
        }

        const requestOptions = {
            url: config.grafana + '/api/annotations',
            method: "POST",
            headers: {
                "Content-type": "application/json",
            },
            json: payload
        }

        const res = await doRequest(requestOptions).catch(err => { throw new Error(err) });
    }

    if (config.committingPeerName) {
        let blocksLogFirst = true;
        if (blocksLog) {
            blocksLog.write('[\n');
        }

        const eventhub = channel.getChannelEventHub(config.committingPeerName);
        eventhub.connect(false);
        let prev_t = 0;
        config.blockRegNum = eventhub.registerBlockEvent(
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
                const date = new Date();
                const now = date.getTime();
                if (prev_t == 0) {
                    prev_t = config.start;
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

                    metrics.commitCountAccurate += 1;

                    if (txTable[tx.txid] !== undefined) {
                        metrics.commitCount += 1;
                        metrics.commitSum += now - txTable[tx.txid][2];
                    } else {
                        metrics.pendings.set(tx.txid, now);
                    }
                }
                blockTable[block.number] = { txset: txset, timestamp: now };
                const count = block.filtered_transactions.length;
                const tps = count / (now - prev_t) * 1000;
                console.error(sprintf('Block %d contains %d transaction(s). TPS is %.2f', block.number, count, tps));

                if (blocksLog) {
                    if (blocksLogFirst) {
                        blocksLogFirst = false;
                    } else {
                        blocksLog.write(',\n');
                    }
                    blocksLog.write(JSON.stringify({ timestamp: date, block: block }, undefined, 4));
                }

                prev_t = now;
            },
            (err) => {
                console.error('EventHub error ', err);
            }
        );
    }
}

async function unmonitor(config, channel, blocksLog, prometheusConfig) {
    const eventhub = channel.getChannelEventHub(config.committingPeerName);
    eventhub.unregisterBlockEvent(config.blockRegNum);
    eventhub.disconnect();
    if (config.logdir) {
        blocksLog.write('\n]\n');
    }
    if (prometheusConfig.intId !== undefined) {
        clearInterval(prometheusConfig.intId);
    }
}

async function printMetrics(blockTable, txTable) {

    let min_t = Number.MAX_VALUE;
    let max_t = 0;
    for (const txid in txTable) {
        const tx = txTable[txid];
        const [t1, t2, t3] = tx;
        if (t1 < min_t) {
            min_t = t1;
        }
        if (t2 > max_t) {
            max_t = t2;
        }
        if (t3 !== undefined && t3 > max_t) {
            max_t = t3;
        }
    }

    for (const num in blockTable) {
        const t4 = blockTable[num].timestamp;
        for (const txType in blockTable[num].txset) {
            for (const code in blockTable[num].txset[txType]) {
                for (const txid of blockTable[num].txset[txType][code]) {
                    tx = txTable[txid];
                    if (tx !== undefined) {
                        tx.push(t4);
                        if (t4 > max_t) {
                            max_t = t4;
                        }
                    }
                }
            }
        }
    }

    const period = 5000;

    min_t = roundDown(min_t, period);
    max_t = roundUp(max_t, period);
    const elapsed = max_t - min_t;

    const latencies = [];

    for (let i = 0; i < elapsed / period; i++) {
        latencies.push({
            peer: [],
            orderer: [],
            commit: [],
        });
    }

    const begin = min_t;

    for (const txid in txTable) {
        const tx = txTable[txid];
        const [t1, t2, t3, t4] = tx;
        latencies[roundDown(t2 - begin, period) / period].peer.push(t2 - t1);
        latencies[roundDown(t3 - begin, period) / period].orderer.push(t3 - t2);
        if (t4 !== undefined) {
            latencies[roundDown(t4 - begin, period) / period].commit.push(t4 - t3);
        }
    }

    console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg peer.pctl orderer.pctl commit.pctl');
    for (let i = 0; i < elapsed / period; i++) {
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

async function invokeLocalWorkers(config, txTable, metrics, ws) {
    const promises = [];

    const numProcesses = config.processes / config.remotes.length;

    for (var i = 0; i < numProcesses; i++) {
        config.delay = i * config.rampup / numProcesses;
        const w = cluster.fork();
        w.on('online', () => {
            w.send({ config: config });
        });
        if (txTable) {
            w.on('message', (msg) => {
                if (msg.txStats) {
                    const txStats = msg.txStats;
                    for (const txid in txStats) {
                        txTable[txid] = txStats[txid];
                        const t4 = metrics.pendings.get(txid);
                        if (t4 !== undefined) {
                            metrics.pendings.delete(txid);
                            metrics.commitCount += 1;
                            metrics.commitSum += t4 - txStats[txid][2];
                        }
                    }
                }
                if (msg.metrics) {
                    metrics.endorsementCount += msg.metrics.endorsementCount;
                    metrics.endorsementSum += msg.metrics.endorsementSum;
                    metrics.sendTransactionCount += msg.metrics.sendTransactionCount;
                    metrics.sendTransactionSum += msg.metrics.sendTransactionSum;
                }
            });
        } else {
            w.on('message', (msg) => {
                //TODO: Aggregate txStats and metrics here, and periodically send them to master
                try {
                    ws.send(JSON.stringify(msg));
                } catch (err) {
                    console.error(err);
                }
            });
        }

        promises.push(new Promise(resolve => w.on('disconnect', resolve)));

        promises.push(new Promise((resolve, reject) => {
            w.on('exit', (code, signal) => {
                if (signal) {
                    reject(`Worker ${w.id} is killed by ${signal}`);
                } else if (code != 0) {
                    reject(`Worker ${w.id} exited with return code ${code}`);
                } else {
                    resolve();
                }
            });
        }));
    }

    return Promise.all(promises);
}

async function invokeRemoteWorkers(config, remote, txTable, metrics) {
    const hostport = remote.split(':');
    const host = hostport[0];
    const port = Number(hostport[1]);
    const url = `ws://${host}:${port}`;

    const ws = new WebSocket(url);

    ws.on('message', message => {
        const json = JSON.parse(message);
        if (json.txStats) {
            const txStats = json.txStats;
            for (const txid in txStats) {
                txTable[txid] = txStats[txid];
            }
        }
        if (json.metrics) {
            metrics.endorsementCount += json.metrics.endorsementCount;
            metrics.endorsementSum += json.metrics.endorsementSum;
            metrics.sendTransactionCount += json.metrics.sendTransactionCount;
            metrics.sendTransactionSum += json.metrics.sendTransactionSum;
        }
    });

    await new Promise(resolve => ws.on('open', resolve));

    ws.send(JSON.stringify({ command: 'start', config: config }));

    return new Promise(resolve => ws.on('close', resolve));
}

async function master(config) {
    const client = await getClient(config.profile, config.orgName)
    const channel = client.getChannel(config.channelID);

    if (config.population) {
        await populate(config);
    }

    config.start = Date.now() + 5000;
    const blockTable = {};

    const txTable = {};
    const metrics = {
        endorsementCount: 0,
        endorsementSum: 0,
        sendTransactionCount: 0,
        sendTransactionSum: 0,
        commitCountAccurate: 0,
        commitCount: 0,
        commitSum: 0,
        pendings: new Map()
    };
    const prometheusConfig = {};

    let blocksLog;
    if (config.committingPeerName || config.grafana || config.prometheus) {
        if (config.committingPeer && config.logdir) {
            const blocksLogPath = config.logdir + '/blocks.json';
            blocksLog = fs.createWriteStream(blocksLogPath, { flags: 'wx' });
        }
        await monitor(config, channel, blockTable, blocksLog, txTable, metrics, prometheusConfig);
    }

    const promises = [];
    for (const remote of config.remotes) {
        let promise;
        if (remote === "local") {
            promise = invokeLocalWorkers(config, txTable, metrics);
        } else {
            promise = invokeRemoteWorkers(config, remote, txTable, metrics);
        }
        promises.push(promise);
    }

    await Promise.all(promises);

    await sleep(3000);

    // info = await channel.queryInfo();
    // height = Number(info.height)
    // block = await channel.queryBlock(height-1);

    if (config.committingPeerName) {
        await unmonitor(config, channel, blocksLog, prometheusConfig);
    }
    if (blocksLog) {
        blocksLog.close();
    }


    console.log('Start: ', config.start + config.rampup);
    console.log('End: ', config.start + config.rampup + config.duration);
    await printMetrics(blockTable, txTable);
}

function getAccount(max) {
    const randomNum = 1 + Math.floor(Math.random() * max);
    return sprintf('%034d', randomNum);
}

const handlerTable = {
    'putstate': {
	'chaincodeId': 'ccperf',
        'genArgs': context => [String(context.config.num), String(context.config.size), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index)]
    },
    'getstate': {
	'chaincodeId': 'ccperf',
        'genArgs': context => [String(context.config.num), String(context.config.population), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index)]
    },
    'mix': {
	'chaincodeId': 'ccperf',
        'genArgs': context => [String(context.config.num), String(context.config.size), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index), String(context.config.population)]
    },
    'json': {
	'chaincodeId': 'ccperf',
        'genArgs': context => [String(context.config.num), String(context.config.size), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index), String(context.config.population)]
    }
}

async function execute(context) {
    const client = context.client;
    const channel = context.channel;
    if (context.userClients) {
        client = info.userClients[(context.workerID * 41 + context.index * 601) % context.userClients.length];
        console.log('client=', client);
        channel = client.getChannel();
    }
    const txStats = context.txStats;

    const tx_id = client.newTransactionID();

    const request = {
        targets: context.peers,
        chaincodeId: context.chaincodeId,
        fcn: context.config.type,
        args: context.genArgs(context),
        txId: tx_id
    };
    if (context.genTransientMap) {
        request.transientMap = context.genTransientMap(context);
    }

    const t1 = new Date();

    const results = await channel.sendTransactionProposal(request);

    const t2 = new Date();

    if (context.metrics) {
        context.metrics.endorsementCount += 1;
        context.metrics.endorsementSum += t2 - t1;
    }

    const proposalResponses = results[0];

    if (proposalResponses.length == 0) {
        console.error('Endorsement failure: Proposal response is empty');
        return;
    }
    if (!proposalResponses.reduce((ok, res) => ok && res.response && res.response.status == 200, true)) {
        const res = proposalResponses.filter(res => !res.response || res.response.status != 200)[0];
        console.error('Endorsement failure: ' + res.message);
        return;
    }

    const proposal = results[1];

    const orderer_request = {
        txId: tx_id,
        proposalResponses: proposalResponses,
        proposal: proposal,
    };

    if (context.orderer) {
        orderer_request.orderer = context.orderer;
    }

    orderer_results = await channel.sendTransaction(orderer_request);

    const t3 = new Date();

    if (context.metrics) {
        context.metrics.sendTransactionCount += 1;
        context.metrics.sendTransactionSum += t3 - t2;
    }

    txStats[tx_id.getTransactionID()] = [t1.getTime(), t2.getTime(), t3.getTime()];
    if (context.requestsLog) {
        if (context.index > 0) {
            context.requestsLog.write(',\n');
        }
        context.requestsLog.write(JSON.stringify({ txid: tx_id.getTransactionID(), peer: [{ submission: t1, response: t2 }], orderer: { submission: t2, response: t3 } }, undefined, 4));
    }

    context.index += 1;
}

function reportPrometheusMetrics(context) {
    const txStats = context.txStats;
    context.txStats = {};
    //console.log(context.metrics);
    process.send({ metrics: context.metrics, txStats: txStats });
}

async function worker(config) {
    const client = await getClient(config.profile, config.orgName);
    const channel = client.getChannel(config.channelID);
    const txStats = {};

    if (config.txHandler) {
        const txHandler = eval(config.txHandler);
        const plugin = new txHandler();
        const txName = plugin.getName();
        handlerTable[txName] = plugin.getHandler();
    }

    const chaincodeId = handlerTable[config.type].chaincodeId;
    const genArgs = handlerTable[config.type].genArgs;
    const genTransientMap = handlerTable[config.type].genTransientMap;

    let requestsLog;
    if (config.logdir) {
        const requestsLogPath = config.logdir + '/requests-' + cluster.worker.id + '.json';
        requestsLog = fs.createWriteStream(requestsLogPath, { flags: 'wx' });
        requestsLog.write('[\n');
    }

    let peers;
    if (config.endorsingPeerName) {
        peers = [client.getPeer(endorsingPeerName)];
    } else if (config.endorsingOrgs) {
        const orgs = config.endorsingOrgs;
        peers = []
        for (org of orgs) {
            const orgPeers = client.getPeersForOrg(profile.organizations[org].mspid);
            peers.push(orgPeers[context.workerID % orgPeers.length]);
        }
    }

    const context = {
        config: config,
        client: client,
        channel: channel,
	chaincodeId: chaincodeId,
        peers: peers,
        txStats: txStats,
        workerID: cluster.worker.id,
        index: 0,
        genArgs: genArgs,
        requestsLog: requestsLog
    };

    if (config.ordererSelection == 'balance') {
        const orderers = channel.getOrderers();
        const orderer = orderers[cluster.worker.id % orderers.length];
        context.orderer = orderer.getName();
    }

    if (genTransientMap) {
        context.genTransientMap = genTransientMap;
    }

    if (config.clientKeys) {
	const clientKeys = config.clientKeys;
        const userClients = [];
        const keys = glob.sync(clientKeys + '/*');
        for (keyfile of keys) {
            if (keyfile.endsWith('-pub') || keyfile.endsWith('-priv')) {
                continue;
            }
            const json = JSON.parse(loadFile(keyfile));
            const ski = json.enrollment.signingIdentity;
            const userOpts = {
                username: json.name,
                mspid: json.mspid,
                cryptoContent: {
                    signedCertPEM: json.enrollment.identity.certificate,
                    privateKeyPEM: loadFile(clientKeys + '/' + ski + '-priv')
                },
                skipPersistence: false
            };
            const userClient = await getClient(config.profile, config.orgName);
            const user = await userClient.createUser(userOpts);
            userClients.push(userClient);
        }
        info.userClients = userClients;
    }

    let intId;
    if (config.prometheus) {
        context.metrics = {
            endorsementCount: 0,
            endorsementSum: 0,
            sendTransactionCount: 0,
            sendTransactionSum: 0
        };
        intId = setInterval(() => {
            reportPrometheusMetrics(context);
            context.metrics = {
                endorsementCount: 0,
                endorsementSum: 0,
                sendTransactionCount: 0,
                sendTransactionSum: 0
            };
        }, 1000);
    }

    const wait = config.start + config.delay - Date.now();
    if (wait > 0) {
        await sleep(wait);
    }

    //const timeout = setInterval(execute, interval, info);
    //await sleep(duration);
    //clearInterval(timeout);

    const end = config.start + config.rampup + config.duration + config.rampdown;
    let behind = 0;
    while (true) {
        const before = Date.now();
        execute(context);
        const after = Date.now();
        const remaining = config.interval - (after - before) - behind;
        if (remaining > 0) {
            behind = 0;
            await sleep(remaining);
        } else {
            behind = -remaining;
        }
        if (Date.now() > end) {
            break;
        }
    }

    //console.log(info.index/duration*1000);

    if (config.prometheus) {
        clearInterval(intId);
        reportPrometheusMetrics(context);
    }

    await new Promise(resolve => {
        process.send({ txStats: txStats }, null, {}, resolve);
    });

    if (config.logdir) {
        requestsLog.write('\n]\n');
        requestsLog.close();
    }

    process.exit(0); // Forces to close all connections
}

function sleep(msec) {
    return new Promise(resolve => setTimeout(resolve, msec));
}

function loadConnectionProfile(filePath) {
    const baseDir = path.dirname(filePath);
    const profile = yaml.safeLoad(loadFile(filePath));

    function path2pem(key) {
        if (key !== undefined && key.path !== undefined && key.pem === undefined) {
            const pem = loadFile(key.path, baseDir);
            key.pem = pem;
            delete key.path;
        }
    }

    for (const name of Object.keys(profile.organizations)) {
        const org = profile.organizations[name];
        path2pem(org.signedCert);
        path2pem(org.adminPrivateKey);
    }
    for (const name of Object.keys(profile.orderers)) {
        const orderer = profile.orderers[name];
        path2pem(orderer.tlsCACerts);
    }
    for (const name of Object.keys(profile.peers)) {
        const peer = profile.peers[name];
        path2pem(peer.tlsCACerts);
    }

    return profile;
}

function run(cmd) {
    const profilePath = cmd.profile === undefined ? "./connection-profile.yaml" : cmd.profile;
    const profile = loadConnectionProfile(profilePath);

    let processes = cmd.processes === undefined ? 1 : Number(cmd.processes);
    let target = cmd.target === undefined ? 1 : Number(cmd.target);
    const duration = 1000.0 * cmd.duration;
    const tps = target / processes;
    const interval = 1000.0 / tps
    const rampup = cmd.rampup === undefined ? interval : 1000.0 * Number(cmd.rampup);

    let channelID = cmd.channelID
    if (channelID === undefined) {
        if (profile.channels !== undefined) {
            channelID = Object.keys(profile.channels)[0]
        }
        if (channelID === undefined) {
            throw new Error("No channel is defined in connection profile");
        }
    } else if (profile.channels === undefined || profile.channels[channelID] === undefined) {
        throw new Error(util.format("%s: channel is not defined in connection profile", channelID));
    }
    if (profile.organizations === undefined || Object.keys(profile.organizations).length === 0) {
        throw new Error("No valid organization is defined in connection profile");
    }
    if (profile.channels[channelID].peers === undefined || Object.keys(profile.channels[channelID].peers).length === 0) {
        throw new Error(util.format("No valid peer is defined for %s in connection profile", channelID));
    }
    if (profile.channels[channelID].orderers === undefined || Object.keys(profile.channels[channelID].orderers).length === 0) {
        throw new Error(util.format("No valid orderer is defined for %s in connection profile", channelID));
    }

    const endorsingPeers = Object.entries(profile.channels[channelID].peers).filter(([name, peer]) => peer.endorsingPeer === true).map(([name, peer]) => name);
    let endorsingOrgs = Object.entries(profile.organizations).filter(([name, org]) => org.peers.reduce((flag, peerName) => flag || endorsingPeers.includes(peerName), false)).map(([name, org]) => name);
    if (cmd.endorsingOrgs !== undefined) {
        const orgs = cmd.endorsingOrgs.split(',');
        if (orgs.length == 0 || orgs.filter(name => endorsingOrgs.includes(name)).length < orgs.length) {
            throw new Error("Invalid --endorsingOrgs option");
        }
        endorsingOrgs = orgs;
    }

    let orgName = cmd.org;
    if (orgName === undefined) {
        orgName = endorsingOrgs[0];
    } else if (!endorsingOrgs.includes(orgName)) {
        throw new Error(util.format("%s: not a valid organization for endorsing in %s", orgName, channelID));
    }

    let remotes = ["local"]
    if (cmd.remote !== undefined) {
        remotes = cmd.remote.split(',');
    }

    let txHandlerStr;
    if (cmd.txHandler !== undefined) {
        txHandlerStr = loadFile(cmd.TxHandler);
    }

    const config = {
        profile: profile,
        channelID: cmd.channelID,
        logdir: cmd.logdir,
        processes: processes,
        target: target,
        orgName: orgName,
        endorsingOrgs: cmd.endorsingOrgs === undefined ? undefined : cmd.endorsingOrgs.split(','),
        peerSelection: cmd.peerSelection,
        ordererSelection: cmd.ordererSelection,
        committingPeerName: cmd.committingPeer,
        type: cmd.type,
        num: cmd.num === undefined ? 1 : Number(cmd.num),
        size: cmd.size === undefined ? 1 : Number(cmd.size),
        population: cmd.population === undefined ? undefined : Number(cmd.population),
	txHandler: txHandlerStr,
	clientKeys: cmd.clientKeys,
        grafana: cmd.grafana,
        prometheus: cmd.prometheusPushgateway,
        duration: duration,
        interval: interval,
        rampup: rampup,
        rampdown: 5,
        remotes: remotes
    };

    master(config).catch(err => {
        console.error(err);
        process.exit(1);
    });
}


function daemon(cmd) {
    if (cmd.port === undefined) {
        console.error('Port number is not specified');
        process.exit(1);
    }
    const port = Number(cmd.port);
    console.log(`Listening on ${port}`);

    const wss = new WebSocket.Server({ port: port });
    wss.on('connection', function connection(ws) {
        ws.on('message', function incoming(message) {
            const json = JSON.parse(message);

            switch (json.command) {
                case 'start':
                    const config = json.config;
                    console.log('Start %d workers', json.config.processes);
                    invokeLocalWorkers(config, null, null, ws).then(() => { ws.close() });
                    break;
            }
        });
        return;
    });
}

function main() {
    if (!cluster.isMaster) {
        cluster.worker.on('disconnect', () => {
            console.error('Worker %d: Master process prematurely disconnected', cluster.worker.id);
            process.exit(1);
        });

        const promise = new Promise((resolve, reject) => {
            cluster.worker.on('message', msg => {
                if (msg !== undefined && msg.config !== undefined) {
                    resolve(msg.config)
                } else {
                    reject('Worker process receives an unknown mesasge from master process');
                }
            });
        });

        return promise.then(config => {
            return worker(config);
        }).then(() => {
            return cluster.disconnect();
        }).catch(err => {
            console.error('Worker %d: ', cluster.worker.id, err);
            process.exit(1);
        });
    }

    program.command('run')
        .option('--logdir [dir]', "Directory name where log files are stored")
        .option('--processes [number]', "Number of processes to be launched")
        .option('--profile [path]', "Connection profile")
        .option('--channelID [channel]', "Channel name")
        .option('--target [number]', "Target input TPS")
        .option('--rampup [number]', "Rampup in second")
        .option('--duration [number]', "Duration in second")
        .option('--org [string]', "Organization name")
        .option('--type [string]', "Type of workload (eg. putstate)")
        .option('--num [number]', "Number of operations per transaction")
        .option('--size [bytes]', "Payload size of a PutState call")
        .option('--population [number]', "Number of prepopulated key-values")
	.option('--tx-plugin', "JavaScript file that defines transaction handler")
        .option('--committing-peer [name]', "Peer name whose commit events are monitored ")
        .option('--endorsing-orgs [org1,org2]', 'Comma-separated list of organizations')
        .option('--orderer-selection [type]', "Orderer selection method: first or balance. Default is first")
        .option('--grafana [url]', "Grafana endpoint URL ")
        .option('--prometheus-pushgateway [url]', "Prometheus endpoint URL ")
        .option('--remote [hostport]', "Remote worker daemons. Comma-separated list of host:port or local")
	.option('--client-keys [dir]', 'Directory for client keys')
        .action(run);

    program.command('daemon')
        .option('--port [port]', "Listen port number")
        .action(daemon);

    program.parse(process.argv);
}

main()
