type StatTypes = "ipns" | "ipfs" | "pubsub-publish" | "pubsub-subscribe" | "pubsub-unsubscribe";
export default class Stats {
    private _pkc;
    constructor(pkc: Stats["_pkc"]);
    toJSON(): undefined;
    private _getSuccessCountKey;
    private _getSuccessAverageKey;
    recordGatewaySuccess(gatewayUrl: string, type: StatTypes, timeElapsedMs: number): Promise<void>;
    private _getBaseKey;
    private _getFailuresCountKey;
    recordGatewayFailure(gatewayUrl: string, type: StatTypes): Promise<void>;
    private _gatewayScore;
    sortGatewaysAccordingToScore(type: StatTypes): Promise<string[]>;
}
export {};
