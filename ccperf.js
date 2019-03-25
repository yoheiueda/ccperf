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
const prom = require('prom-client');

const aggregatorRegistry = new prom.AggregatorRegistry();

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

class LocalDriver {
    constructor(config, ws) {
        this.config = config;
        this.ws = ws;
        this.txTable = new Map();
        this.histgramCommit = new prom.Histogram({
            name: 'ccperf_commit',
            help: 'Commit latency',
            labelNames: ['ccperf', 'type', 'tx_validation_code']
        });
    }

    async init() {
        const driver = this;
        const completedPromises = [];
        const numProcesses = this.config.processes / this.config.remotes.length;
        const configAckPromises = [];

        for (var i = 0; i < numProcesses; i++) {
            this.config.delay = i * this.config.rampup / numProcesses;
            const w = cluster.fork();
            w.on('online', () => {
                w.send({ type: 'config', config: this.config });
            });

            configAckPromises.push(new Promise(resolve => {
                w.on('message', msg => {
                    if (msg.type === 'configAck') {
                        resolve(msg);
                    }
                });
            }));

            w.on('message', msg => {
                if (msg.type === 'tx') {
                    const tx = msg.tx;
                    driver.txTable.set(tx.id, tx);
                }
            });

            completedPromises.push(new Promise(resolve => w.on('disconnect', resolve)));

            completedPromises.push(new Promise((resolve, reject) => {
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

        if (this.ws !== undefined) {
            const ws = this.ws;
            ws.on('message', message => {
                const msg = JSON.parse(message);
                if (msg.command === 'colletMetrics') {
                    driver.collectMetrics().then(metrics => {
                        ws.send(JSON.stringify({
                            type: 'metrics',
                            metrics: metrics
                        }))
                    });
                } else if (msg.commanmd === 'feedBlockInfo') {
                    dreiver.feedBlockInfo(block);
                }
            });
        }

        this.completedPromise = Promise.all(completedPromises);

        return Promise.all(configAckPromises);;
    }

    async waitCompletion() {
        return this.completedPromise;
    }

    async start(startTime) {
        for (const id in cluster.workers) {
            const w = cluster.workers[id];
            w.send({
                type: 'start',
                startTime: startTime
            });
        }
    }

    async collectMetrics() {
        const sum = this.histgramCommit.hashMap['ccperf:test,tx_validation_code:VALID,type:ENDORSER_TRANSACTION'].sum;
        const count = this.histgramCommit.hashMap['ccperf:test,tx_validation_code:VALID,type:ENDORSER_TRANSACTION'].count;
        const commitMetricString = `
# HELP ccperf_commit Endorsement latency
# TYPE ccperf_commit histogram
ccperf_commit_sum{ccperf="test"} ${sum}
ccperf_commit_count{ccperf="test"} ${count}
`;
        //console.log(commitMetricString);
        return new Promise((resolve, reject) => {
            aggregatorRegistry.clusterMetrics((err, metricsStr) => {
                metricsStr += commitMetricString;
                if (err) {
                    reject(err);
                } else {
                    resolve(decodeMetricsString(metricsStr));
                }
            });
        });
    }

    async feedBlockInfo(block) {
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

        for (const commit of block.filtered_transactions) {
            const txid = commit.txid;
            const tx = this.txTable.get(txid);
            if (tx !== undefined) {
                this.txTable.delete(txid);
                const msLatency = now - tx.timestamp;
                const labels = {
                    "ccperf": "test",
                    "type": commit.type,
                    "tx_validation_code": commit.tx_validation_code
                }
                this.histgramCommit.observe(labels, msLatency / 1000);
            }
        }
    }
}


class RemoteDriver {
    constructor(config, remote) {
        this.config = config;
        const hostport = remote.split(':');
        const host = hostport[0];
        const port = Number(hostport[1]);
        this.url = `ws://${host}:${port}`;
    }

    async init() {
        this.ws = new WebSocket(url);
        this.metricsQueue = []; // FIXME: Use requsest id instead of queqing

        this.ws.on('message', message => {
            const msg = JSON.parse(message);
            if (msg.type == 'metrics') {
                const resolve = this.metricsQueue.shift();
                if (resolve !== undefined) {
                    resolve(msg.metrics);
                }
            }
        });

        await new Promise(resolve => ws.on('open', resolve));

        this.ws.send(JSON.stringify({ command: 'start', config: config }));

        return new Promise(resolve => ws.on('close', resolve));
    }

    async collectMetrics() {
        const promise = new Promise((resolve, reject) => {
            this.metricsQueue.push(resolve);
        });
        this.ws.send(JSON.stringify({ command: 'colletMetrics' }));
        return promise;
    }

    async feedBlockInfo(block) {
        this.ws.send(JSON.stringify({
            command: 'feedBlockInfo',
            block: block
        }));
    }
}

function decodeMetricsString(metricsStr) {
    const metricsTable = {};

    for (const metric of metricsStr.split('\n\n')) {
        let name;
        for (const line of metric.split('\n')) {
            const items = line.split(' ');
            if (items[0] === '#') {
                name = items[2]
                let metricObj = metricsTable[name];
                if (metricObj === undefined) {
                    metricObj = { values: {} }
                    metricsTable[name] = metricObj;
                }
                if (items[1] === 'HELP') {
                    metricObj.help = items.slice(3).join(' ');
                } else if (items[1] === 'TYPE') {
                    metricObj.type = items[3];
                }
            } else if (items[0] !== '') {
                const metricObj = metricsTable[name];
                const fullname = items[0];
                metricObj.values[fullname] = Number(items[1]);
            }
        }
    }

    return metricsTable;
}

function encodeMetricsString(metrics) {
    let str = '';

    for (const name of Object.keys(metrics)) {
        const metric = metrics[name];
        str += `# HELP ${name} ${metric.help}\n`
        str += `# TYPE ${name} ${metric.type}\n`

        const keys = Object.keys(metric.values);
        if (keys.length > 0) {
            for (const key of keys) {
                const value = metric.values[key];
                str += `${key} ${value}\n`
            }
        }

        str += '\n';
    }

    return str;
}

function aggregateMetrics(metricsArray) {
    const metricsTable = {};

    for (const metrics of metricsArray) {
        for (const name of Object.keys(metrics)) {
            const metric = metrics[name];
            let metricObj = metricsTable[name];
            if (metricObj === undefined) {
                metricObj = {
                    help: metric.help,
                    type: metric.type,
                    values: {}
                };
                metricsTable[name] = metricObj
            };
            for (const fullname of Object.keys(metric.values)) {
                let oldValue = metricObj.values[fullname];
                if (oldValue === undefined) {
                    oldValue = 0.0;
                }
                metricObj.values[fullname] = oldValue + metric.values[fullname];
            }
        }
    }

    return metricsTable;
}

function delta(name, key, current, prev) {
    const fullname = name + "_" + key;
    if (current[name] === undefined || prev[name] === undefined) {
        return NaN;
    }
    return current[name].values[fullname] - prev[name].values[fullname];
}

function printMetricsHeading(interval, elapsed, current, prev) {
    //console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg peer.pctl orderer.pctl commit.pctl');
    console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg');
}

function printMetrics(interval, elapsed, current, prev) {
    const data = {
        elapsed: elapsed,
        peer: {
            tps: delta('ccperf_endorsement', 'count{ccperf="test"}', current, prev) / interval,
            avg: 1000 * delta('ccperf_endorsement', 'sum{ccperf="test"}', current, prev) / delta('ccperf_endorsement', 'count{ccperf="test"}', current, prev),
            pctl: 0
        },
        orderer: {
            tps: delta('ccperf_sendtransaction', 'count{ccperf="test"}', current, prev) / interval,
            avg: 1000 * delta('ccperf_sendtransaction', 'sum{ccperf="test"}', current, prev) / delta('ccperf_sendtransaction', 'count{ccperf="test"}', current, prev),
            pctl: 0
        },
        commit: {
            tps: delta('ccperf_commit', 'count{ccperf="test"}', current, prev) / interval,
            avg: 1000 * delta('ccperf_commit', 'sum{ccperf="test"}', current, prev) / delta('ccperf_commit', 'count{ccperf="test"}', current, prev),
            pctl: 0
        }
    };
    //s = sprintf('%(elapsed)8d %(peer.tps)8.2f %(orderer.tps)11.2f %(commit.tps)10.2f %(peer.avg)8.2f %(orderer.avg)11.2f %(commit.avg)10.2f %(peer.pctl)9.2f %(orderer.pctl)12.2f %(commit.pctl)11.2f', data);
    s = sprintf('%(elapsed)8d %(peer.tps)8.2f %(orderer.tps)11.2f %(commit.tps)10.2f %(peer.avg)8.2f %(orderer.avg)11.2f %(commit.avg)10.2f', data);
    console.log('%s', s);

}

function setupEventHub(config, channel, handler) {
    const eventhub = channel.getChannelEventHub(config.committingPeerName);
    eventhub.connect(false);

    config.blockRegNum = eventhub.registerBlockEvent(
        handler,
        (err) => {
            console.error('EventHub error ', err);
        }
    );
    return config.blockRegNum;
}

function shutdownEventHub(config, channel, blockRegNum) {
    const eventhub = channel.getChannelEventHub(config.committingPeerName);
    eventhub.unregisterBlockEvent(blockRegNum);
    eventhub.disconnect();
}

async function master(config) {
    const client = await getClient(config.profile, config.orgName)
    const channel = client.getChannel(config.channelID);

    if (config.population) {
        await populate(config);
    }

    const prometheusConfig = {};

    let blocksLog;
    if (config.committingPeerName || config.grafana || config.prometheus) {
        if (config.committingPeer && config.logdir) {
            const blocksLogPath = config.logdir + '/blocks.json';
            blocksLog = fs.createWriteStream(blocksLogPath, { flags: 'wx' });
            blocksLog.write('[\n');
            blocksLog.firstWriteFlag = true;
        }
        //await monitor(config, channel, prometheusConfig);
    }

    const drivers = [];
    const promises = [];
    for (const remote of config.remotes) {
        let driver;
        if (remote === "local") {
            console.log('Creating local driver');
            driver = new LocalDriver(config);

        } else {
            driver = new RemoteDriver(config, remote);
        }
        drivers.push(driver);
        const promise = driver.init();
        promises.push(promise);
    }

    let blockRegNum;
    if (config.committingPeerName) {
        blockRegNum = setupEventHub(config, channel, block => {
            for (const driver of drivers) {
                driver.feedBlockInfo(block);
            }
            if (blocksLog) {
                if (blocksLog.firstWriteFlag) {
                    blocksLog.firstWriteFlag = false;
                } else {
                    blocksLog.write(',\n');
                }
                blocksLog.write(JSON.stringify({ timestamp: now, block: block }, undefined, 4));
            }
        });
    }
    await Promise.all(promises);

    const startTime = Date.now() + 1000;
    for (const driver of drivers) {
        driver.start(startTime);
    }

    console.log('Started workers');
    const interval = 5000.0;
    let previousMetrics;
    let elapsed = 0.0;

    await sleep(startTime + config.rampup - Date.now());

    {
        const promises = [];
        for (const driver of drivers) {
            promises.push(driver.collectMetrics());
        }
        Promise.all(promises).then(metricsArray => {
            previousMetrics = aggregateMetrics(metricsArray);
        });
    }

    const promInt = setInterval(() => {
        const promises = [];
        for (const driver of drivers) {
            promises.push(driver.collectMetrics());
        }

        Promise.all(promises).then(metricsArray => {
            const currentMetrics = aggregateMetrics(metricsArray);
            //console.log(encodeMetricsString(currentMetrics));
            if (previousMetrics !== undefined) {
                printMetrics(interval / 1000, elapsed, currentMetrics, previousMetrics);
            }
            previousMetrics = currentMetrics;
            elapsed += interval / 1000;
        });
    }, interval);

    await Promise.all(promises);

    // info = await channel.queryInfo();
    // height = Number(info.height)
    // block = await channel.queryBlock(height-1);

    console.log('Start: ', startTime + config.rampup);
    console.log('End: ', startTime + config.rampup + config.duration);

    printMetricsHeading();

    for (const driver of drivers) {
        await driver.waitCompletion();
    }

    clearInterval(promInt);

    if (config.committingPeerName) {
        shutdownEventHub(config, channel, blockRegNum);
        //await unmonitor(config, channel, blocksLog, prometheusConfig);
    }
    if (blocksLog) {
        blocksLog.close();
    }
    //await printStats(blockTable, txTable);
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

    const t1 = Date.now();

    const results = await channel.sendTransactionProposal(request);

    const t2 = Date.now();

    context.histgramEndorsement.observe({ "ccperf": "test" }, (t2 - t1) / 1000);

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

    const t3 = Date.now();

    context.histgramSendTransaction.observe({ "ccperf": "test" }, (t3 - t2) / 1000);

    process.send({
        type: 'tx',
        tx: {
            id: tx_id.getTransactionID(),
            timestamp: t3
        }
    });

    if (context.requestsLog) {
        if (context.index > 0) {
            context.requestsLog.write(',\n');
        }
        context.requestsLog.write(JSON.stringify({ txid: tx_id.getTransactionID(), peer: [{ submission: t1, response: t2 }], orderer: { submission: t2, response: t3 } }, undefined, 4));
    }

    context.index += 1;
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

    const orgs = config.endorsingOrgs;
    const peers = []
    for (org of orgs) {
        const orgPeers = channel.getPeersForOrg(config.profile.organizations[org].mspid).filter(p => p.isInRole("endorsingPeer"));
        peers.push(orgPeers[cluster.worker.id % orgPeers.length]);
    }

    const histgramEndorsement = new prom.Histogram({
        name: 'ccperf_endorsement',
        help: 'Endorsement latency',
        labelNames: ['ccperf']
    });
    const histgramSendTransaction = new prom.Histogram({
        name: 'ccperf_sendtransaction',
        help: 'SendTransaction latency',
        labelNames: ['ccperf']
    });
    const digestCommits = null;

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
        requestsLog: requestsLog,
        histgramEndorsement: histgramEndorsement,
        histgramSendTransaction: histgramSendTransaction,
        digestCommits: digestCommits
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

    const promise = new Promise(resolve => {
        process.once('message', msg => {
            if (msg.type === 'start') {
                resolve(msg.startTime);
            }
        })
    });

    process.send({ type: 'configAck' });

    const startTime = await promise;

    const wait = startTime + config.delay - Date.now();
    if (wait > 0) {
        await sleep(wait);
    }

    //const timeout = setInterval(execute, interval, info);
    //await sleep(duration);
    //clearInterval(timeout);

    const end = startTime + config.rampup + config.duration + config.rampdown;
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

    if (config.logdir) {
        requestsLog.write('\n]\n');
        requestsLog.close();
    }

    await sleep(5000);

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
        endorsingOrgs: endorsingOrgs,
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
                case 'metrics':
                    aggregatorRegistry.clusterMetrics((err, metricsStr) => {
                        if (err) console.log(err);
                        const metrics = decodeMetricsString(metricsStr);
                        ws.send(JSON.stringify({ type: 'metrics', metrics: metrics }));
                    });
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
            cluster.worker.once('message', msg => {
                if (msg !== undefined && msg.type === 'config' && msg.config !== undefined) {
                    resolve(msg.config)
                } else {
                    reject(util.format('Worker process receives an unknown mesasge from master process: %j', msg));
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
