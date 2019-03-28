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
const TDigest = require('tdigest').TDigest;

const aggregatorRegistry = new prom.AggregatorRegistry();

const logger = require('winston');
if (process.env.FABRIC_CONFIG_LOGLEVEL) {
    logger.level = process.env.FABRIC_CONFIG_LOGLEVEL;
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
                console.error(body);
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
    constructor() {
        this.txTable = new Map();
        this.registry = new prom.Registry()
        this.histgramCommit = new prom.Histogram({
            name: 'ccperf_commit',
            help: 'Commit latency',
            labelNames: ['ccperf', 'type', 'tx_validation_code'],
            registers: [this.registry]
        });
        this.histgramE2E = new prom.Histogram({
            name: 'ccperf_e2e',
            help: 'E2E latency',
            labelNames: ['ccperf', 'type', 'tx_validation_code'],
            registers: [this.registry]
        });
        this.quantileEndorsement = new TDigest();
        this.quantileSendTransaction = new TDigest();
        this.quantileCommit = new TDigest();
        this.quantileE2E = new TDigest();
    }

    daemon(ws) {
        const driver = this;
        ws.on('message', message => {
            const msg = JSON.parse(message);

            switch (msg.type) {
                case 'init':
                    driver.init(msg.config).then(() => {
                        ws.send(JSON.stringify({
                            type: 'initAck'
                        }))
                    });
                    driver.waitCompletion().then(() => {
                        ws.send(JSON.stringify({
                            type: 'completed'
                        }));
                    });
                    break;
                case 'start':
                    driver.start(msg.startTime);
                    break;
                case 'exit':
                    driver.exit().then(() => {
                        ws.close();
                    });
                    break;
                case 'colletMetrics':
                    driver.collectMetrics().then(metrics => {
                        ws.send(JSON.stringify({
                            type: 'metrics',
                            requestId: msg.requestId,
                            metrics: metrics
                        }));
                    });
                    break;
                case 'feedBlockInfo':
                    driver.feedBlockInfo(msg.block);
                    break;
                default:
                    console.error('Daemon receives unknown message %j', msg);
            }
        });
    }

    async init(config) {
        this.config = config;
        const driver = this;
        const completionPromises = [];
        const exitedPromises = [];
        const numProcesses = this.config.processes / this.config.remotes.length;
        const initAckPromises = [];

        for (var i = 0; i < numProcesses; i++) {
            this.config.delay = i * this.config.rampup / numProcesses;
            const w = cluster.fork();
            w.on('online', () => {
                w.send({ type: 'init', config: this.config });
            });

            initAckPromises.push(new Promise(resolve => {
                w.on('message', msg => {
                    if (msg.type === 'initAck') {
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

            completionPromises.push(new Promise(resolve => {
                w.on('message', msg => {
                    if (msg.type == 'completed') {
                        resolve(msg);
                    }
                });
            }));

            exitedPromises.push(new Promise(resolve => w.on('disconnect', resolve)));

            exitedPromises.push(new Promise((resolve, reject) => {
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

        this.completionPromise = Promise.all(completionPromises);
        this.exitedPromise = Promise.all(exitedPromises);

        console.log('Started %d workers', numProcesses);

        return Promise.all(initAckPromises);;
    }

    async waitCompletion() {
        return this.completionPromise;
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

    async exit() {
        for (const id in cluster.workers) {
            const w = cluster.workers[id];
            w.send({ type: 'exit' });

        }
        return this.exitedPromise;
    }

    async collectMetrics() {
        const commitMetricString = this.registry.getSingleMetricAsString('ccperf_commit');
        const quantiles = {
            'endorsement': this.quantileEndorsement.toArray(),
            'sendtransaction': this.quantileSendTransaction.toArray(),
            'commit': this.quantileCommit.toArray(),
            'e2e': this.quantileE2E.toArray()
        };

        return new Promise((resolve, reject) => {
            aggregatorRegistry.clusterMetrics((err, metricsStr) => {
                metricsStr += '\n' + commitMetricString;
                if (err) {
                    reject(err);
                } else {
                    resolve({
                        promMetrics: decodeMetricsString(metricsStr),
                        quantiles: quantiles
                    });
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
                const commitLatency = (now - tx.t3) / 1000;
                const e2eLatency = (now - tx.t1) / 1000;
                const labels = {
                    "ccperf": "test",
                    "type": commit.type,
                    "tx_validation_code": commit.tx_validation_code
                }
                this.histgramCommit.observe(labels, commitLatency);
                this.histgramE2E.observe(labels, e2eLatency);

                this.quantileEndorsement.push((tx.t2 - tx.t1) / 1000);
                this.quantileSendTransaction.push((tx.t3 - tx.t2) / 1000);
                this.quantileCommit.push(commitLatency);
                this.quantileE2E.push(e2eLatency);
            }
        }
    }
}


class RemoteDriver {
    constructor(remote) {
        this.handlers = {};
        const hostport = remote.split(':');
        const host = hostport[0];
        const port = Number(hostport[1]);
        this.url = `ws://${host}:${port}`;
    }

    handler(message) {
        const msg = JSON.parse(message);

        const handler = this.handlers[msg.type];
        if (handler === undefined) {
            console.error('Daemon process returns unknown message: %j', msg);
            return;
        }
        handler(msg);
    }

    async init(config) {
        this.config = config;
        const driver = this;
        const ws = new WebSocket(this.url);
        this.ws = ws;
        this.metricRequests = new Map();
        this.metricRequestCount = 0;

        ws.on('message', message => {
            driver.handler(message);
        });

        await new Promise(resolve => ws.on('open', resolve));

        this.exitedPromise = new Promise(resolve => ws.on('close', resolve));

        const initAckPromise = new Promise(resolve => {
            driver.handlers['initAck'] = resolve
        });

        this.completionPromise = new Promise(resolve => {
            driver.handlers['completed'] = message => {
                resolve(message);
            };
        });

        this.handlers['metrics'] = msg => {
            const request = this.metricRequests.get(msg.requestId);
            if (request !== undefined) {
                this.metricRequests.delete(msg.requestId);
                request.done(msg.metrics);
            } else {
                console.error('Unknown metricRequestId: ', msg.requestId);
            }
        };

        ws.send(JSON.stringify({ type: 'init', config: config }));

        return initAckPromise;
    }

    async waitCompletion() {
        return this.completionPromise;
    }

    async start(startTime) {
        this.ws.send(JSON.stringify({
            type: 'start',
            startTime: startTime
        }));
    }

    async exit() {
        this.ws.send(JSON.stringify({
            type: 'exit',
        }));
        return this.exitedPromise;
    }

    async collectMetrics() {
        const driver = this;
        const requestId = this.metricRequestCount++;
        const promise = new Promise((resolve, reject) => {
            const request = {
                done: resolve
            }
            driver.metricRequests.set(requestId, request);
        });
        driver.ws.send(JSON.stringify({
            type: 'colletMetrics',
            requestId: requestId
        }));
        return promise;
    }

    async feedBlockInfo(block) {
        this.ws.send(JSON.stringify({
            type: 'feedBlockInfo',
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

class Master {
    constructor(config) {
        this.config = config;
    }

    setupEventHub() {
        this.eventhub = this.channel.getChannelEventHub(this.config.committingPeerName);
        this.eventhub.connect(false);

        if (this.config.logdir) {
            const blocksLogPath = config.logdir + '/blocks.json';
            this.blocksLog = fs.createWriteStream(blocksLogPath, { flags: 'wx' });
            this.blocksLog.write('[\n');
            this.blocksLog.firstWriteFlag = true;
        }

        const master = this;
        this.blockRegNum = this.eventhub.registerBlockEvent(
            block => {
                for (const driver of master.drivers) {
                    driver.feedBlockInfo(block);
                }
                if (master.blocksLog) {
                    if (blocksLog.firstWriteFlag) {
                        blocksLog.firstWriteFlag = false;
                    } else {
                        blocksLog.write(',\n');
                    }
                    master.blocksLog.write(JSON.stringify({ timestamp: now, block: block }, undefined, 4));
                }
            },
            err => {
                console.error('EventHub error ', err);
            }
        );
    }

    shutdownEventHub() {
        this.eventhub.unregisterBlockEvent(this.blockRegNum);
        this.eventhub.disconnect();
        if (this.blocksLog) {
            this.blocksLog.close();
        }
    }

    printMetricsHeading() {
        //console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg peer.pctl orderer.pctl commit.pctl');
        console.log(' elapsed peer.tps orderer.tps commit.tps peer.avg orderer.avg commit.avg');
    }

    printMetrics(interval, elapsed, current, prev) {
        function delta(name, key, current, prev) {
            const fullname = name + "_" + key;
            if (current[name] === undefined || prev[name] === undefined) {
                return NaN;
            }
            return current[name].values[fullname] - prev[name].values[fullname];
        }

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
                tps: delta('ccperf_commit', 'count{ccperf="test",type="ENDORSER_TRANSACTION",tx_validation_code="VALID"}', current, prev) / interval,
                avg: 1000 * delta('ccperf_commit', 'sum{ccperf="test",type="ENDORSER_TRANSACTION",tx_validation_code="VALID"}', current, prev) / delta('ccperf_commit', 'count{ccperf="test",type="ENDORSER_TRANSACTION",tx_validation_code="VALID"}', current, prev),
                pctl: 0
            }
        };
        //const s = sprintf('%(elapsed)8d %(peer.tps)8.2f %(orderer.tps)11.2f %(commit.tps)10.2f %(peer.avg)8.2f %(orderer.avg)11.2f %(commit.avg)10.2f %(peer.pctl)9.2f %(orderer.pctl)12.2f %(commit.pctl)11.2f', data);
        const s = sprintf('%(elapsed)8d %(peer.tps)8.2f %(orderer.tps)11.2f %(commit.tps)10.2f %(peer.avg)8.2f %(orderer.avg)11.2f %(commit.avg)10.2f', data);
        console.log('%s', s);

    }

    aggregateMetrics(metricsArray) {
        const metricsTable = {};

        const tdigestTable = {
            endorsement: new TDigest(),
            sendtransaction: new TDigest(),
            commit: new TDigest(),
            e2e: new TDigest()
        };

        for (const metrics of metricsArray) {
            // Prometheus Histograms
            for (const name of Object.keys(metrics.promMetrics)) {
                const metric = metrics.promMetrics[name];
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
            // TDigest quantiles
            for (const name of Object.keys(metrics.quantiles)) {
                const quantile = metrics.quantiles[name];
                const tdigest = tdigestTable[name];
                tdigest.push_centroid(quantile);
            }
        }

        for (const key of Object.keys(tdigestTable)) {
            const name = 'ccperf_' + key + '_quantile';
            const tdigest = tdigestTable[key];
            const metricObj = {
                help: key + " latency quantile",
                type: "gauge",
                values: {}
            }
            for (const p of [0.5, 0.9, 0.95, 0.99]) {
                const percentile = tdigest.percentile(p);
                if (percentile !== undefined) {
                    metricObj.values[name + '{le="' + String(p) + '"}'] = percentile;
                }
            }
            metricsTable[name] = metricObj;
        }

        return metricsTable;
    }

    collectMetrics() {
        const promises = [];
        for (const driver of this.drivers) {
            promises.push(driver.collectMetrics());
        }
        return Promise.all(promises);
    }

    async postPrometheus(metricString) {
        const timestamp = parseInt((this.startTime + this.config.rampup) / 1000);
        const url = this.config.prometheus + '/metrics/job/fabric/run_timestamp/' + timestamp + '/duration_seconds/' + this.config.duration / 1000;
        const requestOptions = {
            url: url,
            method: "PUT",
            headers: {
                "Content-type": "text/plain",
            },
            body: metricString
        }
        //console.log(requestOptions);
        return doRequest(requestOptions).catch(err => { throw new Error(err) });
    }

    async start() {
        const config = this.config;

        this.client = await getClient(config.profile, config.orgName)
        this.channel = this.client.getChannel(config.channelID);

        if (config.population) {
            await populate(config);
        }
        if (config.committingPeerName) {
            this.setupEventHub();
        }

        this.drivers = [];

        for (const remote of config.remotes) {
            let driver;
            if (remote === "local") {
                //console.log('Creating local driver');
                driver = new LocalDriver();

            } else {
                driver = new RemoteDriver(remote);
            }

            await driver.init(config);
            this.drivers.push(driver);
        }

        this.startTime = Date.now() + 1000;
        for (const driver of this.drivers) {
            driver.start(this.startTime);
        }

        const interval = 5000.0;
        let previousMetrics;
        let elapsed = 0.0;

        await sleep(this.startTime - Date.now());

        this.collectMetrics().then(metricsArray => {
            previousMetrics = this.aggregateMetrics(metricsArray);
        });

        const promInt = setInterval(() => {
            this.collectMetrics().then(metricsArray => {
                const currentMetrics = this.aggregateMetrics(metricsArray);
                //console.log(encodeMetricsString(currentMetrics));
                this.printMetrics(interval / 1000, elapsed, currentMetrics, previousMetrics);
                if (config.prometheus) {
                    this.postPrometheus(encodeMetricsString(currentMetrics));
                }
                previousMetrics = currentMetrics;
                elapsed += interval / 1000;
            });
        }, interval);

        console.log('Start: ', this.startTime + config.rampup);
        console.log('End: ', this.startTime + config.rampup + config.duration);

        this.printMetricsHeading();

        for (const driver of this.drivers) {
            await driver.waitCompletion();
        }

        clearInterval(promInt);

        if (config.committingPeerName) {
            this.shutdownEventHub();
        }

        for (const driver of this.drivers) {
            await driver.exit();
        }
    }
}

class DefaultChaincodeTxPlugin {
    constructor() {
        this._chaincodeId = 'ccperf';
        this._genArgsTable = {
            'putstate': context => [String(context.config.num), String(context.config.size), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index)],
            'getstate': context => [String(context.config.num), String(context.config.population), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index)],
            'mix': context => [String(context.config.num), String(context.config.size), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index), String(context.config.population)],
            'json': context => [String(context.config.num), String(context.config.size), util.format('key_mychannel_org1_0_%d_%d', context.workerID, context.index), String(context.config.population)],
        }
    }

    getChaincodeId() {
        return this._chaincodeId;
    }

    getTxTypes() {
        return Object.keys(this._genArgsTable);
    }

    getTxHandler(txType) {
        return {
            chaincodeId: this.getChaincodeId(),
            isQuery: false,
            fcn: txType,
            genArgs: this._genArgsTable[txType],
            genTransientMap: undefined,
            genUserName: undefined,
        };
    }
}

class Worker {
    constructor(config) {
        this.workerID = cluster.worker.id;
        this.index = 1;
        this.config = config;

        let plugin;
        if (config.txPluginStr) {
            const txPluginClass = eval(config.txPluginStr);
            plugin = new txPluginClass();
        } else {
            plugin = new DefaultChaincodeTxPlugin();
        }

        const handler = plugin.getTxHandler(config.txType);
        this.chaincodeId = handler.chaincodeId;
        this.fcn = handler.fcn;
        this.genArgs = handler.genArgs;
        this.genTransientMap = handler.genTransientMap;
        this.genUserName = handler.genUserName;

        if (config.logdir) {
            const requestsLogPath = config.logdir + '/requests-' + cluster.worker.id + '.json';
            this.requestsLog = fs.createWriteStream(requestsLogPath, { flags: 'wx' });
            this.requestsLog.write('[\n');
        }

        this.registry = new prom.Registry();
        prom.AggregatorRegistry.setRegistries([this.registry]);

        this.histgramEndorsement = new prom.Histogram({
            name: 'ccperf_endorsement',
            help: 'Endorsement latency',
            labelNames: ['ccperf'],
            registers: [this.registry]
        });
        this.histgramSendTransaction = new prom.Histogram({
            name: 'ccperf_sendtransaction',
            help: 'SendTransaction latency',
            labelNames: ['ccperf'],
            registers: [this.registry]
        });
        this.digestCommits = null;
    }

    async start() {
        const config = this.config;
        this.client = await getClient(config.profile, config.orgName);
        this.channel = this.client.getChannel(config.channelID);

        if (this.config.clientKeystore !== undefined) {
            this.cryptoSuite = sdk.newCryptoSuite();
            const cryptoKeyStore = sdk.newCryptoKeyStore(undefined, { path: config.clientKeystore });
            this.cryptoSuite.setCryptoKeyStore(cryptoKeyStore);
            this.stateStore = await sdk.newDefaultKeyValueStore({ path: config.clientKeystore });
        }

        const orgs = config.endorsingOrgs;
        this.peers = []
        for (const org of orgs) {
            const orgPeers = this.channel.getPeersForOrg(config.profile.organizations[org].mspid).filter(p => p.isInRole("endorsingPeer"));
            this.peers.push(orgPeers[cluster.worker.id % orgPeers.length]);
        }

        if (config.ordererSelection == 'balance') {
            const orderers = this.channel.getOrderers();
            const orderer = orderers[cluster.worker.id % orderers.length];
            this.orderer = orderer.getName();
        }

        const promise = new Promise(resolve => {
            process.once('message', msg => {
                if (msg.type === 'start') {
                    resolve(msg.startTime);
                }
            })
        });

        process.send({ type: 'initAck' });

        const startTime = await promise;

        const wait = startTime + config.delay - Date.now();
        if (wait > 0) {
            await sleep(wait);
        }

        const end = startTime + config.rampup + config.duration + config.rampdown;
        let behind = 0;
        while (true) {
            const before = Date.now();

            this.execute();

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

        process.send({ type: 'completed' });

        //console.log(info.index/duration*1000);

        if (config.logdir) {
            requestsLog.write('\n]\n');
            requestsLog.close();
        }

        await new Promise(resolve => {
            process.on('message', msg => {
                if (msg.type === 'exit') {
                    resolve(msg);
                }
            })
        });

        process.exit(0); // Forces to close all connections
    }

    async execute() {
        let client = this.client;
        let channel = this.channel;

	let username;
        if (this.config.clientKeystore !== undefined) {
	    //client = sdk.loadFromConfig(this.config.profile);
            client = new sdk();
            client._network_config = this.client._network_config; //FIXME
            client.setCryptoSuite(this.cryptoSuite);
            client.setStateStore(this.stateStore);

            username = this.genUserName(this);
            const user = await client.getUserContext(username, true);
            if (!(user && user.isEnrolled())) {
                throw new Error("User not found in keystore: " + username);
            }
            const oldClientContext = client._network_config._client_context;
            client._network_config._client_context = client;
            channel = client.getChannel(this.config.channelID);
            client._network_config._client_context = oldClientContext;
        }

        const tx_id = client.newTransactionID();

        const request = {
            targets: this.peers,
            chaincodeId: this.chaincodeId,
            fcn: this.fcn,
            args: this.genArgs(this, username),
            txId: tx_id
        };

        if (this.genTransientMap) {
            request.transientMap = this.genTransientMap(this);
        }

        const t1 = Date.now();

        const results = await channel.sendTransactionProposal(request);

        const t2 = Date.now();

        this.histgramEndorsement.observe({ "ccperf": "test" }, (t2 - t1) / 1000);

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

        if (this.orderer) {
            orderer_request.orderer = this.orderer;
        }

        const orderer_results = await channel.sendTransaction(orderer_request);

        const t3 = Date.now();

        this.histgramSendTransaction.observe({ "ccperf": "test" }, (t3 - t2) / 1000);

        process.send({
            type: 'tx',
            tx: {
                id: tx_id.getTransactionID(),
                t1: t1,
                t2: t2,
                t3: t3
            }
        });

        if (this.requestsLog) {
            if (this.index > 0) {
                this.requestsLog.write(',\n');
            }
            this.requestsLog.write(JSON.stringify({ txid: tx_id.getTransactionID(), peer: [{ submission: t1, response: t2 }], orderer: { submission: t2, response: t3 } }, undefined, 4));
        }

        this.index += 1;
    }
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

    let txPluginStr;
    if (cmd.txPlugin !== undefined) {
        txPluginStr = loadFile(cmd.txPlugin);
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
        txType: cmd.type,
        num: cmd.num === undefined ? 1 : Number(cmd.num),
        size: cmd.size === undefined ? 1 : Number(cmd.size),
        population: cmd.population === undefined ? undefined : Number(cmd.population),
        txPluginStr: txPluginStr,
        clientKeystore: cmd.clientKeystore,
        grafana: cmd.grafana,
        prometheus: cmd.prometheusPushgateway,
        duration: duration,
        interval: interval,
        rampup: rampup,
        rampdown: 5,
        remotes: remotes
    };

    const master = new Master(config);

    master.start().catch(err => {
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
        const driver = new LocalDriver();
        driver.daemon(ws);
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
                if (msg !== undefined && msg.type === 'init' && msg.config !== undefined) {
                    resolve(msg.config)
                } else {
                    reject(util.format('Worker process receives an unknown mesasge from master process: %j', msg));
                }
            });
        });

        return promise.then(config => {
            const worker = new Worker(config);
            return worker.start();
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
        .option('--tx-plugin [plugin]', "JavaScript file that defines transaction handler")
        .option('--committing-peer [name]', "Peer name whose commit events are monitored ")
        .option('--endorsing-orgs [org1,org2]', 'Comma-separated list of organizations')
        .option('--orderer-selection [type]', "Orderer selection method: first or balance. Default is first")
        .option('--grafana [url]', "Grafana endpoint URL ")
        .option('--prometheus-pushgateway [url]', "Prometheus endpoint URL ")
        .option('--remote [hostport]', "Remote worker daemons. Comma-separated list of host:port or local")
        .option('--client-keystore [dir]', 'Keystore for client keys')
        .action(run);

    program.command('daemon')
        .option('--port [port]', "Listen port number")
        .action(daemon);

    program.parse(process.argv);
}

main()
