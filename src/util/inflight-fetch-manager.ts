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
                    // Use setTimeout instead of queueMicrotask to defer cleanup to the next macrotask.
                    // queueMicrotask runs during the microtask phase, before all promise continuations
                    // have settled, causing late-arriving callers to miss the inflight entry and start
                    // duplicate fetches. setTimeout ensures all microtasks (promise resolutions) complete first.
                    setTimeout(() => {
                        if (fetchPromiseRef && this._inflightFetches.get(key) === fetchPromiseRef) this._inflightFetches.delete(key);
                    }, 0);
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
