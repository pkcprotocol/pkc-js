export class InflightFetchManager {
    private _inflightFetches = new Map<string, Promise<unknown>>();
    // True once the pkc that owns these fetches is destroyed. Its teardown stops every instance that owns a fetch,
    // so the cancellations it causes are no reason for a joiner to fetch again.
    private _isDestroyed: () => boolean;

    constructor({ isDestroyed }: { isDestroyed?: () => boolean } = {}) {
        this._isDestroyed = isDestroyed ?? (() => false);
    }

    private _getKey(resourceType: string, identifier: string): string {
        return `${resourceType}::${identifier}`;
    }

    // abortSignal is the caller's own cancellation, the one its fetcher runs under. A caller that joins a fetch
    // already in flight shares that fetch's outcome, except its owner's cancellation: when the shared fetch
    // rejects with an AbortError, this caller was not cancelled itself and the pkc is not destroyed, it fetches
    // on its own instead.
    async withKey<T>(key: string, fetcher: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
        const inflight = this._inflightFetches.get(key) as Promise<T> | undefined;
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
            return fetchPromise;
        }
        try {
            return await this._waitUnlessAborted(inflight, abortSignal);
        } catch (e) {
            if (!(e instanceof Error && e.name === "AbortError") || abortSignal?.aborted || this._isDestroyed()) throw e;
            if (this._inflightFetches.get(key) === inflight) this._inflightFetches.delete(key);
            return this.withKey(key, fetcher, abortSignal);
        }
    }

    // A joiner's wait for a fetch another caller owns. That fetch runs under its owner's signal, so the joiner's
    // stop cannot cancel it, but it ends the joiner's wait: a stopped Comment or community must not be handed the
    // record when the owner's fetch succeeds later. The fetch itself goes on for its owner and the other joiners.
    private async _waitUnlessAborted<T>(inflight: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
        if (!abortSignal) return inflight;
        let onAbort: (() => void) | undefined;
        try {
            return await Promise.race([
                inflight,
                new Promise<never>((_, reject) => {
                    const rejectWithAbort = () => {
                        const error = new Error("The caller that joined this fetch was stopped");
                        error.name = "AbortError";
                        reject(error);
                    };
                    if (abortSignal.aborted) return rejectWithAbort();
                    onAbort = rejectWithAbort;
                    abortSignal.addEventListener("abort", onAbort, { once: true });
                })
            ]);
        } finally {
            if (onAbort) abortSignal.removeEventListener("abort", onAbort);
        }
    }

    async withResource<T>(resourceType: string, identifier: string, fetcher: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
        if (!resourceType) throw new Error("resourceType is required for inflight fetches");
        if (typeof identifier !== "string" || identifier.length === 0)
            throw new Error("identifier is required for inflight fetches and must be a string");
        return this.withKey(this._getKey(resourceType, identifier), fetcher, abortSignal);
    }
}

export const InflightResourceTypes = {
    COMMUNITY_IPNS: "community-ipns",
    COMMENT_IPFS: "comment-ipfs"
} as const;

export type InflightResourceType = (typeof InflightResourceTypes)[keyof typeof InflightResourceTypes];
