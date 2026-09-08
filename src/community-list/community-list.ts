import { TypedEmitter } from "tiny-typed-emitter";
import retry, { RetryOperation } from "retry";
import Logger from "../logger.js";
import type { PKC } from "../pkc/pkc.js";
import { PKCError } from "../pkc-error.js";
import { cleanUpBeforePublishing, signCommunityList, verifyCommunityList } from "../signer/signatures.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import type { SignerWithPublicKeyAddress } from "../signer/index.js";
import { buildRuntimeAuthor } from "../publications/publication-author.js";
import {
    calculateIpfsCidV0,
    calculateStringSizeSameAsIpfsAddCidV0,
    isStringDomain,
    retryKuboIpfsAddAndProvide,
    shortifyAddress,
    shortifyCid
} from "../util.js";
import { parseCommunityListSchemaWithPKCErrorIfItFails, parseJsonWithPKCErrorIfFails } from "../schema/schema-util.js";
import { MAX_COMMUNITY_LIST_SIZE_BYTES } from "./schema.js";
import type { CommunityListEntryJson, CommunityListEvents, CommunityListIpfsType, CommunityListState } from "./types.js";
import type { AuthorPubsubJsonType, AuthorPubsubType } from "../types.js";
import type { JsonSignature } from "../signer/types.js";
import { sha256 } from "js-sha256";

type UnsignedCommunityListProps = Omit<CommunityListIpfsType, "signature">;

// A CommunityList is an immutable, signed IPFS file addressed by CID. One class, no Remote split:
// constructed with a signer it can publish(), constructed with a cid it can update(). Spec:
// docs/protocol/community-lists.md
export class CommunityList extends TypedEmitter<CommunityListEvents> {
    // wire-derived props (runtime view)
    title?: string;
    description?: string;
    author?: AuthorPubsubJsonType & { nameResolved?: boolean };
    communities?: CommunityListEntryJson[];
    timestamp?: number;
    protocolVersion?: string;
    signature?: JsonSignature;

    cid?: string;
    shortCid?: string;
    signer?: SignerWithPublicKeyAddress;
    state: CommunityListState = "stopped";
    raw: { communityList?: CommunityListIpfsType } = {};

    _pkc: PKC;
    private _unsignedProps?: UnsignedCommunityListProps;
    private _stopAbortController?: AbortController;
    private _loadingAbortController?: AbortController;
    private _loadingOperation?: RetryOperation;

    constructor(pkc: PKC) {
        super();
        this._pkc = pkc;
        // The error listener initialized here must never be removed (see AGENTS.md on removeAllListeners)
        this.on("error", (...args) => this.listenerCount("error") === 1 && this._pkc.emit("error", ...args)); // only bubble up to pkc if no other listeners are attached
    }

    _initWithCidOnly(cid: string) {
        this.cid = cid;
        this.shortCid = shortifyCid(cid);
    }

    _initUnsignedProps({ signer, ...props }: UnsignedCommunityListProps & { signer: SignerWithPublicKeyAddress }) {
        this.signer = signer;
        this._unsignedProps = props;
        this.title = props.title;
        this.description = props.description;
        this.timestamp = props.timestamp;
        this.protocolVersion = props.protocolVersion;
        this.communities = props.communities.map((entry) => this._buildRuntimeEntry(entry));
        // author identity always comes from the signature; before publishing, the signer is who will sign
        this.author = this._buildRuntimeAuthor(props.author, signer.publicKey);
    }

    private _buildRuntimeEntry(entry: CommunityListIpfsType["communities"][number]): CommunityListEntryJson {
        const address = entry.name || entry.publicKey;
        return { ...entry, address, shortAddress: shortifyAddress(address) };
    }

    private _buildRuntimeAuthor(
        wireAuthor: AuthorPubsubType | undefined,
        signaturePublicKey: string
    ): AuthorPubsubJsonType & { nameResolved?: boolean } {
        const runtimeAuthor = buildRuntimeAuthor({ author: wireAuthor, signaturePublicKey });
        return { ...runtimeAuthor, shortAddress: shortifyAddress(runtimeAuthor.address) };
    }

    _initFromWireRecord(record: CommunityListIpfsType, cid: string) {
        this.raw.communityList = record;
        this.cid = cid;
        this.shortCid = shortifyCid(cid);
        this.title = record.title;
        this.description = record.description;
        this.timestamp = record.timestamp;
        this.protocolVersion = record.protocolVersion;
        this.signature = record.signature;
        this.communities = record.communities.map((entry) => this._buildRuntimeEntry(entry));
        const previousNameResolved = this.author?.nameResolved;
        this.author = this._buildRuntimeAuthor(record.author, record.signature.publicKey);
        if (typeof previousNameResolved === "boolean") this.author.nameResolved = previousNameResolved;
    }

    toJSON() {
        return {
            ...this.raw.communityList,
            ...(this.author ? { author: this.author } : undefined),
            ...(this.communities ? { communities: this.communities } : undefined),
            cid: this.cid,
            shortCid: this.shortCid
        };
    }

    private _setState(newState: CommunityListState) {
        if (this.state === newState) return;
        this.state = newState;
        this.emit("statechange", newState);
    }

    private _throwIfPublishAborted(signal: AbortSignal) {
        if (signal.aborted) throw new PKCError("ERR_COMMUNITY_LIST_PUBLISH_ABORTED", { cid: this.cid });
    }

    // Sign the JSON and add the file to IPFS (locally, or via the RPC server). Sets cid and returns it
    async publish(): Promise<string> {
        const log = Logger("pkc-js:community-list:publish");
        if (!this.signer || !this._unsignedProps) throw new PKCError("ERR_COMMUNITY_LIST_HAS_NO_SIGNER", { cid: this.cid });
        if (this.state === "publishing") throw new PKCError("ERR_COMMUNITY_LIST_ALREADY_PUBLISHING", {});
        if (this.state === "updating") throw new PKCError("ERR_COMMUNITY_LIST_ALREADY_UPDATING", {});
        this._setState("publishing");
        this._stopAbortController = new AbortController();
        const signal = this._stopAbortController.signal;
        try {
            const cleanedProps = cleanUpBeforePublishing(this._unsignedProps);
            const signature = await signCommunityList({ communityList: cleanedProps, signer: this.signer, pkc: this._pkc });
            const record = <CommunityListIpfsType>{ ...cleanedProps, signature };
            parseCommunityListSchemaWithPKCErrorIfItFails(record); // throws on schema violations incl. duplicate entry publicKey
            const recordString = JSON.stringify(record);
            const sizeBytes = await calculateStringSizeSameAsIpfsAddCidV0(recordString);
            if (sizeBytes > MAX_COMMUNITY_LIST_SIZE_BYTES)
                throw new PKCError("ERR_COMMUNITY_LIST_OVER_ALLOWED_SIZE", {
                    sizeBytes,
                    maxSizeBytes: MAX_COMMUNITY_LIST_SIZE_BYTES
                });
            this._throwIfPublishAborted(signal);

            let cid: string;
            if (this._pkc._pkcRpcClient) {
                // The raw string crosses the wire so the server adds the exact bytes we signed
                const res = await this._pkc._pkcRpcClient.publishCommunityList({ communityListRawString: recordString });
                // The server can pin whatever it wants, but the cid it hands back must be the cid of
                // the exact bytes we signed, or every consumer would fail signature verification
                const expectedCid = await calculateIpfsCidV0(recordString);
                if (res.cid !== expectedCid)
                    throw new PKCError("ERR_ADDED_COMMUNITY_LIST_TO_IPFS_BUT_GOT_DIFFERENT_CID", {
                        expectedCid,
                        cidFromRpcServer: res.cid
                    });
                cid = res.cid;
            } else {
                const kuboRpcClient = this._pkc._clientsManager.getDefaultKuboRpcClient();
                const addRes = await retryKuboIpfsAddAndProvide({
                    ipfsClient: kuboRpcClient._client,
                    log,
                    content: recordString,
                    addOptions: { pin: true },
                    provideInBackground: true
                });
                cid = String(addRes.cid);
            }
            this._throwIfPublishAborted(signal);
            this._initFromWireRecord(record, cid);
            log(`Published CommunityList (${cid}) with ${record.communities.length} entries`);
            return cid;
        } finally {
            this._setState("stopped");
        }
    }

    // Fetch and verify the record (retrying transient failures), emit `update`, then keep driving
    // author.nameResolved until the verdict is definitive, emit `update` again, and stop itself
    async update(): Promise<void> {
        if (this.state === "updating") return; // no-op, same as Comment.update()
        if (this.state === "publishing") throw new PKCError("ERR_COMMUNITY_LIST_ALREADY_PUBLISHING", {});
        if (!this.cid) throw new PKCError("ERR_COMMUNITY_LIST_HAS_NO_CID", {});
        this._setState("updating");
        this._stopAbortController = new AbortController();
        const signal = this._stopAbortController.signal;
        this._pkc._updatingCommunityLists.add(this);
        void this._runUpdateLoop(signal);
    }

    private async _runUpdateLoop(signal: AbortSignal) {
        const log = Logger("pkc-js:community-list:update");
        // Next macrotask, so a caller doing `await list.update()` can attach listeners before the
        // already-loaded path emits synchronously
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal.aborted) return;
        try {
            if (!this.raw.communityList) await this._loadCommunityListIpfsWithRetries(signal);
            else this.emit("update", this); // already loaded (e.g. update() after publish()): emit current state
            if (signal.aborted) return;
            await this._settleAuthorNameResolvedIfNeeded(signal);
            // The record is immutable: once the record is loaded and the nameResolved verdict is
            // definitive (or there is nothing to settle) there is nothing left to watch
            if (!signal.aborted) await this.stop();
        } catch (e) {
            if (signal.aborted) return;
            log.error(`Failed to update CommunityList (${this.cid})`, e);
            this.emit("error", <Error>e);
            await this.stop();
        }
    }

    // Deterministic record errors: the record is content-addressed, so refetching the same cid can
    // never fix these. Everything else (transport) is retried forever
    private _isNonRetriableError(e: unknown): boolean {
        // Classified by code, not instanceof: an error rejected by an RPC call crosses the wire as a
        // plain object carrying the server-side PKCError's code, never as a PKCError instance
        const code = (<{ code?: unknown }>e)?.code;
        return (
            typeof code === "string" &&
            (
                [
                    "ERR_INVALID_JSON",
                    "ERR_INVALID_COMMUNITY_LIST_SCHEMA",
                    "ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID",
                    "ERR_OVER_DOWNLOAD_LIMIT",
                    "ERR_CALCULATED_CID_DOES_NOT_MATCH"
                ] as const
            ).includes(<never>code)
        );
    }

    async _loadCommunityListIpfsWithRetries(outerSignal?: AbortSignal): Promise<void> {
        if (this.raw.communityList) return;
        const cid = this.cid;
        if (!cid) throw new PKCError("ERR_COMMUNITY_LIST_HAS_NO_CID", {});
        // Own controller so stop() can cancel a load that was started without update() (getCommunityList)
        this._loadingAbortController = new AbortController();
        const signal = this._loadingAbortController.signal;
        const onOuterAbort = () => this._loadingAbortController?.abort(outerSignal?.reason);
        outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
        try {
            this._loadingOperation = retry.operation({ forever: true, factor: 2 });
            const record = await new Promise<CommunityListIpfsType>((resolve, reject) => {
                this._loadingOperation!.attempt(async () => {
                    if (signal.aborted) return reject(<Error>signal.reason || new Error("Aborted loading CommunityList"));
                    try {
                        resolve(await this._fetchAndVerifyOnce(cid, signal));
                    } catch (e) {
                        if (signal.aborted || this._isNonRetriableError(e)) return reject(<Error>e);
                        this.emit("error", <Error>e);
                        this._loadingOperation!.retry(<Error>e);
                    }
                });
            });
            this._loadingOperation.stop();
            if (signal.aborted) return;
            this._initFromWireRecord(record, cid);
            this.emit("update", this);
        } finally {
            outerSignal?.removeEventListener("abort", onOuterAbort);
        }
    }

    private async _fetchAndVerifyOnce(cid: string, signal?: AbortSignal): Promise<CommunityListIpfsType> {
        let rawString: string;
        if (this._pkc._pkcRpcClient) {
            const res = await this._pkc._pkcRpcClient.fetchCommunityList({ cid });
            rawString = res.communityListRawString;
            // The RPC server is not trusted with record validity: check the bytes are the cid's bytes
            const calculatedCid = await calculateIpfsCidV0(rawString);
            if (calculatedCid !== cid) throw new PKCError("ERR_CALCULATED_CID_DOES_NOT_MATCH", { calculatedCid, cid });
        } else {
            rawString = await this._pkc._clientsManager.fetchCid(cid, {
                maxFileSizeBytes: MAX_COMMUNITY_LIST_SIZE_BYTES,
                abortSignal: signal
            });
        }
        const record = parseCommunityListSchemaWithPKCErrorIfItFails(parseJsonWithPKCErrorIfFails(rawString));
        const validity = await verifyCommunityList({ communityList: record });
        if (!validity.valid) throw new PKCError("ERR_COMMUNITY_LIST_SIGNATURE_IS_INVALID", { validity, cid });
        return record;
    }

    // The name of the author on the wire, only when it's a domain that can be resolved
    private _authorDomainToSettle(): string | undefined {
        const wireAuthorName = this.raw.communityList?.author?.name;
        if (typeof wireAuthorName !== "string" || !isStringDomain(wireAuthorName)) return undefined;
        return wireAuthorName;
    }

    private _nameResolvedCacheKey(authorDomain: string): string {
        return sha256(authorDomain + this.raw.communityList!.signature.publicKey);
    }

    // One resolution attempt. Returns a definitive verdict (boolean) or undefined for a transient
    // failure that should be retried. Definitive verdicts are cached pkc-wide, same as publications
    private async _resolveAuthorNameVerdictOnce(authorDomain: string): Promise<boolean | undefined> {
        const cache = this._pkc._memCaches.nameResolvedCache;
        const cacheKey = this._nameResolvedCacheKey(authorDomain);
        const cached = cache.get(cacheKey);
        if (typeof cached === "boolean") return cached;
        try {
            // Works over both transports: PKCWithRpcClient overrides resolveAuthorName to delegate to the RPC server
            const { resolvedAuthorName } = await this._pkc.resolveAuthorName({ name: authorDomain });
            if (typeof resolvedAuthorName !== "string") {
                // null: no TXT record OR all resolvers errored — indistinguishable today, so retry
                // rather than fail shut (same policy as resolveAuthorNamesInBackground)
                return undefined;
            }
            const signerAddress = getPKCAddressFromPublicKeySync(this.raw.communityList!.signature.publicKey);
            const verdict = resolvedAuthorName === signerAddress;
            cache.set(cacheKey, verdict);
            return verdict;
        } catch (e) {
            // Classified by code, not instanceof: over RPC the rejection is a plain object carrying the code
            if ((<{ code?: unknown }>e)?.code === "ERR_NO_RESOLVER_FOR_NAME") {
                // Definitive: no resolver in this PKC instance (or its RPC server) handles this TLD
                cache.set(cacheKey, false);
                return false;
            }
            return undefined; // transient
        }
    }

    // Fire-and-forget cache warmup, used by the one-shot getCommunityList path which does not wait
    // for the verdict: evented instances pick it up from the pkc-wide cache
    _kickOffBackgroundAuthorNameResolution(): void {
        const log = Logger("pkc-js:community-list:resolve-author-name");
        const authorDomain = this._authorDomainToSettle();
        if (!authorDomain || !this._pkc.resolveAuthorNames) return;
        this._resolveAuthorNameVerdictOnce(authorDomain).catch((e) =>
            log.error("Failed background author name resolution", authorDomain, e)
        );
    }

    private async _settleAuthorNameResolvedIfNeeded(signal: AbortSignal): Promise<void> {
        const authorDomain = this._authorDomainToSettle();
        if (!authorDomain || !this.author || !this._pkc.resolveAuthorNames) return;
        let attempt = 0;
        while (!signal.aborted) {
            const verdict = await this._resolveAuthorNameVerdictOnce(authorDomain);
            if (signal.aborted) return;
            if (typeof verdict === "boolean") {
                this.author.nameResolved = verdict;
                this.emit("update", this);
                return;
            }
            attempt++;
            await this._delayWithAbort(Math.min(1000 * 2 ** attempt, 60_000), signal);
        }
    }

    private async _delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timeout);
                resolve();
            };
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    // Aborts an in-flight publish(), update(), or getCommunityList() load
    async stop(): Promise<void> {
        this._pkc._updatingCommunityLists.delete(this);
        this._stopAbortController?.abort();
        this._loadingAbortController?.abort();
        this._loadingOperation?.stop();
        if (this.state === "stopped") return;
        this._setState("stopped");
    }
}
