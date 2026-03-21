export class InflightFetchManager {
    private _inflightFetches = new Map<string, Promise<unknown>>();

    private _getKey(resourceType: string, identifier: string): string {
        return `${resourceType}::${identifier}`;
    }

    async withKey<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
        let inflight = this._inflightFetches.get(key) as Promise<T> | undefined;
        if (!inflight) {
            let fetchPromiseRef: Promise<T> | undefined;
            const fetchPromise = (async () => {
                try {
                    return await fetcher();
                } finally {
                    queueMicrotask(() => {
                        if (fetchPromiseRef && this._inflightFetches.get(key) === fetchPromiseRef) this._inflightFetches.delete(key);
                    });
                }
            })();
            fetchPromiseRef = fetchPromise;
            this._inflightFetches.set(key, fetchPromise);
            inflight = fetchPromise;
        }
        return inflight;
    }

    async withResource<T>(resourceType: string, identifier: string, fetcher: () => Promise<T>): Promise<T> {
        if (!resourceType) throw new Error("resourceType is required for inflight fetches");
        if (typeof identifier !== "string" || identifier.length === 0)
            throw new Error("identifier is required for inflight fetches and must be a string");
        return this.withKey(this._getKey(resourceType, identifier), fetcher);
    }
}

export const InflightResourceTypes = {
    SUBPLEBBIT_IPNS: "subplebbit-ipns",
    COMMENT_IPFS: "comment-ipfs"
} as const;

export type InflightResourceType = (typeof InflightResourceTypes)[keyof typeof InflightResourceTypes];
