
class ChaincodeTxPlugin {
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
            genTransientMap: undefined
        };
    }
}

module.exports = ChaincodeTxPlugin;
