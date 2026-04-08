export class InflightFetchManager {
    constructor() {
        this._inflightFetches = new Map();
    }
    _getKey(resourceType, identifier) {
        return `${resourceType}::${identifier}`;
    }
    async withKey(key, fetcher) {
        let inflight = this._inflightFetches.get(key);
        if (!inflight) {
            let fetchPromiseRef;
            const fetchPromise = (async () => {
                try {
                    return await fetcher();
                }
                finally {
                    queueMicrotask(() => {
                        if (fetchPromiseRef && this._inflightFetches.get(key) === fetchPromiseRef)
                            this._inflightFetches.delete(key);
                    });
                }
            })();
            fetchPromiseRef = fetchPromise;
            this._inflightFetches.set(key, fetchPromise);
            inflight = fetchPromise;
        }
        return inflight;
    }
    async withResource(resourceType, identifier, fetcher) {
        if (!resourceType)
            throw new Error("resourceType is required for inflight fetches");
        if (typeof identifier !== "string" || identifier.length === 0)
            throw new Error("identifier is required for inflight fetches and must be a string");
        return this.withKey(this._getKey(resourceType, identifier), fetcher);
    }
}
export const InflightResourceTypes = {
    COMMUNITY_IPNS: "community-ipns",
    COMMENT_IPFS: "comment-ipfs"
};
//# sourceMappingURL=inflight-fetch-manager.js.map