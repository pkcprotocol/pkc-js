import assert from "assert";
import * as remeda from "remeda";
export default class Stats {
    constructor(pkc) {
        this._pkc = pkc;
    }
    toJSON() {
        return undefined;
    }
    _getSuccessCountKey(gatewayUrl, type) {
        return `${this._getBaseKey(gatewayUrl, type)}_COUNT_SUCCESS`;
    }
    _getSuccessAverageKey(gatewayUrl, type) {
        return `${this._getBaseKey(gatewayUrl, type)}_AVERAGE_SUCCESS`;
    }
    async recordGatewaySuccess(gatewayUrl, type, timeElapsedMs) {
        const countKey = this._getSuccessCountKey(gatewayUrl, type);
        const averageKey = this._getSuccessAverageKey(gatewayUrl, type);
        const curAverage = (await this._pkc._storage.getItem(averageKey)) || 0;
        const curCount = (await this._pkc._storage.getItem(countKey)) || 0;
        const newAverage = curAverage + (timeElapsedMs - curAverage) / (curCount + 1);
        const newCount = curCount + 1;
        await Promise.all([this._pkc._storage.setItem(averageKey, newAverage), this._pkc._storage.setItem(countKey, newCount)]);
    }
    _getBaseKey(url, type) {
        return `STATS_${url}_${type}`;
    }
    _getFailuresCountKey(url, type) {
        return `${this._getBaseKey(url, type)}_COUNT_FAILURE`;
    }
    async recordGatewayFailure(gatewayUrl, type) {
        const countKey = this._getFailuresCountKey(gatewayUrl, type);
        const curCount = (await this._pkc._storage.getItem(countKey)) || 0;
        const newCount = curCount + 1;
        await this._pkc._storage.setItem(countKey, newCount);
    }
    _gatewayScore(failureCounts, successCounts, successAverageMs) {
        // Thanks for @thisisnotph for their input on this formula
        return ((1 / (successAverageMs + 150) / (1 / (successAverageMs + 100) + 1 / 150)) * 0.2 +
            ((successCounts + 0.288) / (failureCounts * 2 + successCounts + 1)) * 0.8);
    }
    async sortGatewaysAccordingToScore(type) {
        const gatewayType = type === "ipfs" || type === "ipns"
            ? "ipfsGateways"
            : type === "pubsub-publish" || type === "pubsub-subscribe"
                ? remeda.keys.strict(this._pkc.clients.pubsubKuboRpcClients).length > 0
                    ? "pubsubKuboRpcClients"
                    : remeda.keys.strict(this._pkc.clients.libp2pJsClients).length > 0
                        ? "libp2pJsClients"
                        : undefined
                : undefined;
        assert(gatewayType, "Can't find the gateway type to sort");
        const gateways = remeda.keys.strict(this._pkc.clients[gatewayType]);
        const score = async (gatewayUrl) => {
            const failureCounts = (await this._pkc._storage.getItem(this._getFailuresCountKey(gatewayUrl, type))) || 0;
            const successCounts = (await this._pkc._storage.getItem(this._getSuccessCountKey(gatewayUrl, type))) || 0;
            const successAverageMs = (await this._pkc._storage.getItem(this._getSuccessAverageKey(gatewayUrl, type))) || 0;
            return this._gatewayScore(failureCounts, successCounts, successAverageMs);
        };
        const gatewaysSorted = remeda.sortBy.strict(gateways, score);
        return gatewaysSorted;
    }
}
//# sourceMappingURL=stats.js.map