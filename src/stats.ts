import { Plebbit } from "./plebbit/plebbit.js";
import assert from "assert";
import * as remeda from "remeda";

type StatTypes = "ipns" | "ipfs" | "pubsub-publish" | "pubsub-subscribe" | "pubsub-unsubscribe";
export default class Stats {
    private _plebbit: Pick<Plebbit, "_storage" | "clients">;
    constructor(plebbit: Stats["_plebbit"]) {
        this._plebbit = plebbit;
    }

    toJSON() {
        return undefined;
    }

    private _getSuccessCountKey(gatewayUrl: string, type: StatTypes) {
        return `${this._getBaseKey(gatewayUrl, type)}_COUNT_SUCCESS`;
    }

    private _getSuccessAverageKey(gatewayUrl: string, type: StatTypes) {
        return `${this._getBaseKey(gatewayUrl, type)}_AVERAGE_SUCCESS`;
    }

    async recordGatewaySuccess(gatewayUrl: string, type: StatTypes, timeElapsedMs: number) {
        const countKey = this._getSuccessCountKey(gatewayUrl, type);
        const averageKey = this._getSuccessAverageKey(gatewayUrl, type);

        const curAverage: number = (await this._plebbit._storage.getItem(averageKey)) || 0;
        const curCount: number = (await this._plebbit._storage.getItem(countKey)) || 0;

        const newAverage = curAverage + (timeElapsedMs - curAverage) / (curCount + 1);
        const newCount = curCount + 1;

        await Promise.all([this._plebbit._storage.setItem(averageKey, newAverage), this._plebbit._storage.setItem(countKey, newCount)]);
    }

    private _getBaseKey(url: string, type: StatTypes) {
        return `STATS_${url}_${type}`;
    }

    private _getFailuresCountKey(url: string, type: StatTypes) {
        return `${this._getBaseKey(url, type)}_COUNT_FAILURE`;
    }

    async recordGatewayFailure(gatewayUrl: string, type: StatTypes) {
        const countKey = this._getFailuresCountKey(gatewayUrl, type);

        const curCount: number = (await this._plebbit._storage.getItem(countKey)) || 0;

        const newCount: number = curCount + 1;
        await this._plebbit._storage.setItem(countKey, newCount);
    }

    private _gatewayScore(failureCounts: number, successCounts: number, successAverageMs: number) {
        // Thanks for @thisisnotph for their input on this formula
        return (
            (1 / (successAverageMs + 150) / (1 / (successAverageMs + 100) + 1 / 150)) * 0.2 +
            ((successCounts + 0.288) / (failureCounts * 2 + successCounts + 1)) * 0.8
        );
    }

    async sortGatewaysAccordingToScore(type: StatTypes): Promise<string[]> {
        const gatewayType =
            type === "ipfs" || type === "ipns"
                ? "ipfsGateways"
                : type === "pubsub-publish" || type === "pubsub-subscribe"
                  ? remeda.keys.strict(this._plebbit.clients.pubsubKuboRpcClients).length > 0
                      ? "pubsubKuboRpcClients"
                      : remeda.keys.strict(this._plebbit.clients.libp2pJsClients).length > 0
                        ? "libp2pJsClients"
                        : undefined
                  : undefined;
        assert(gatewayType, "Can't find the gateway type to sort");
        const gateways = remeda.keys.strict(this._plebbit.clients[gatewayType]);

        const score = async (gatewayUrl: string) => {
            const failureCounts: number = (await this._plebbit._storage.getItem(this._getFailuresCountKey(gatewayUrl, type))) || 0;
            const successCounts: number = (await this._plebbit._storage.getItem(this._getSuccessCountKey(gatewayUrl, type))) || 0;
            const successAverageMs: number = (await this._plebbit._storage.getItem(this._getSuccessAverageKey(gatewayUrl, type))) || 0;

            return this._gatewayScore(failureCounts, successCounts, successAverageMs);
        };

        const gatewaysSorted = remeda.sortBy.strict(gateways, score);
        return gatewaysSorted;
    }
}
