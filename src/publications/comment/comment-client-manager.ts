import { OptionsToLoadFromGateway, PreResolveNameResolverOptions } from "../../clients/base-client-manager.js";
import type { PageIpfs, PageTypeJson } from "../../pages/types.js";
import type { SubplebbitIpfsType } from "../../subplebbit/types.js";
import { NameResolverClient } from "../../clients/name-resolver-client.js";
import { Comment } from "./comment.js";
import * as remeda from "remeda";
import type { CommentIpfsType, CommentUpdateType } from "./types.js";
import {
    parseCommentIpfsSchemaWithPlebbitErrorIfItFails,
    parseCommentUpdateSchemaWithPlebbitErrorIfItFails,
    parseJsonWithPlebbitErrorIfFails
} from "../../schema/schema-util.js";
import { FailedToFetchCommentUpdateFromGatewaysError, PlebbitError } from "../../plebbit-error.js";
import { verifyCommentIpfs, verifyCommentUpdate } from "../../signer/signatures.js";
import Logger from "@pkc/pkc-logger";
import { getPostUpdateTimestampRange, hideClassPrivateProps, isAbortError, resolveWhenPredicateIsTrue } from "../../util.js";
import { PublicationClientsManager } from "../publication-client-manager.js";
import { RemoteSubplebbit } from "../../subplebbit/remote-subplebbit.js";
import { findCommentInPageInstance, findCommentInPageInstanceRecursively, findCommentInParsedPages } from "../../pages/util.js";
import {
    CommentIpfsGatewayClient,
    CommentKuboPubsubClient,
    CommentKuboRpcClient,
    CommentLibp2pJsClient,
    CommentPlebbitRpcStateClient
} from "./comment-clients.js";
import { Plebbit } from "../../plebbit/plebbit.js";
import type { PublicationEvents } from "../types.js";
import { InflightResourceTypes } from "../../util/inflight-fetch-manager.js";
import { loadAllPagesUnderSubplebbitToFindComment } from "./comment-util.js";
import { findStartedSubplebbit, findUpdatingComment, findUpdatingSubplebbit } from "../../plebbit/tracked-instance-registry-util.js";

const fetchCommentLogger = Logger("plebbit-js:comment:client-manager:fetchAndVerifyCommentCid");

type NewCommentUpdate =
    | { commentUpdate: CommentUpdateType; commentUpdateIpfsPath: NonNullable<Comment["_commentUpdateIpfsPath"]> }
    | undefined;

export const MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE = 1024 * 1024;
export class CommentClientsManager extends PublicationClientsManager {
    override clients!: {
        ipfsGateways: { [ipfsGatewayUrl: string]: CommentIpfsGatewayClient };
        kuboRpcClients: { [ipfsClientUrl: string]: CommentKuboRpcClient };
        pubsubKuboRpcClients: { [pubsubClientUrl: string]: CommentKuboPubsubClient };
        plebbitRpcClients: Record<string, CommentPlebbitRpcStateClient>;
        libp2pJsClients: { [libp2pJsClientKey: string]: CommentLibp2pJsClient };
        nameResolvers: { [resolverKey: string]: NameResolverClient };
    };
    private _postForUpdating?: {
        comment: Comment;
        ipfsGatewayListeners?: Record<string, Parameters<Comment["clients"]["ipfsGateways"][string]["on"]>[1]>;
        kuboRpcListeners?: Record<string, Parameters<Comment["clients"]["kuboRpcClients"][string]["on"]>[1]>;
        libp2pJsClientListeners?: Record<string, Parameters<Comment["clients"]["libp2pJsClients"][string]["on"]>[1]>;
        nameResolverListeners?: Record<string, Parameters<Comment["clients"]["nameResolvers"][string]["on"]>[1]>;
    } & Pick<PublicationEvents, "error" | "updatingstatechange" | "update"> = undefined;
    private _comment: Comment;
    private _parentFirstPageCidsAlreadyLoaded: Set<string>;
    private _fetchingUpdateForReplyUsingPageCidsPromise?:
        | ReturnType<CommentClientsManager["usePageCidsOfParentToFetchCommentUpdateForReply"]>
        | undefined;

    constructor(comment: Comment) {
        super(comment);
        this._comment = comment;
        this._fetchingUpdateForReplyUsingPageCidsPromise = undefined;
        this._parentFirstPageCidsAlreadyLoaded = new Set<string>();
        hideClassPrivateProps(this);
    }

    protected override _initKuboRpcClients(): void {
        if (this._plebbit.clients.kuboRpcClients)
            for (const ipfsUrl of remeda.keys.strict(this._plebbit.clients.kuboRpcClients))
                this.clients.kuboRpcClients = { ...this.clients.kuboRpcClients, [ipfsUrl]: new CommentKuboRpcClient("stopped") };
    }

    protected override _initLibp2pJsClients(): void {
        for (const libp2pJsClientKey of remeda.keys.strict(this._plebbit.clients.libp2pJsClients))
            this.clients.libp2pJsClients = { ...this.clients.libp2pJsClients, [libp2pJsClientKey]: new CommentLibp2pJsClient("stopped") };
    }

    protected override _initPlebbitRpcClients() {
        for (const rpcUrl of remeda.keys.strict(this._plebbit.clients.plebbitRpcClients))
            this.clients.plebbitRpcClients = { ...this.clients.plebbitRpcClients, [rpcUrl]: new CommentPlebbitRpcStateClient("stopped") };
    }

    override updateLibp2pJsClientState(newState: CommentLibp2pJsClient["state"], libp2pJsClientKey: string) {
        super.updateLibp2pJsClientState(newState, libp2pJsClientKey);
    }

    override updateKuboRpcState(newState: CommentKuboRpcClient["state"], kuboRpcClientUrl: string) {
        super.updateKuboRpcState(newState, kuboRpcClientUrl);
    }

    override updateGatewayState(newState: CommentIpfsGatewayClient["state"], ipfsGatewayClientUrl: string) {
        super.updateGatewayState(newState, ipfsGatewayClientUrl);
    }

    override updateKuboRpcPubsubState(newState: CommentKuboPubsubClient["state"], pubsubKuboRpcClientUrl: string) {
        super.updateKuboRpcPubsubState(newState, pubsubKuboRpcClientUrl);
    }

    // Resolver methods here
    override preResolveNameResolver(opts: PreResolveNameResolverOptions): void {
        super.preResolveNameResolver(opts);
        if (this._comment.state === "updating") this._comment._setUpdatingStateWithEmissionIfNewState("resolving-author-name"); // Resolving for CommentIpfs and author.address is a domain
    }

    _calculatePathForPostCommentUpdate(folderCid: string, postCid: string) {
        return `${folderCid}/` + postCid + "/update";
    }

    _updateKuboRpcClientOrHeliaState(
        newState: CommentKuboRpcClient["state"] | CommentLibp2pJsClient["state"],
        kuboRpcOrHelia: Plebbit["clients"]["kuboRpcClients"][string] | Plebbit["clients"]["libp2pJsClients"][string]
    ) {
        if ("_helia" in kuboRpcOrHelia) this.updateLibp2pJsClientState(newState, kuboRpcOrHelia._libp2pJsClientsOptions.key);
        else this.updateKuboRpcState(newState as CommentKuboRpcClient["state"], kuboRpcOrHelia.url);
    }

    async _fetchPostCommentUpdateIpfsP2P(subIpns: SubplebbitIpfsType, timestampRanges: string[], log: Logger): Promise<NewCommentUpdate> {
        // only get new CommentUpdates
        // not interested in CommentUpdate we already fetched before
        const attemptedPathsToLoadErrors: Record<string, Error> = {};
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();

        const didLastPostUpdateRangeHaveSameFolderCid = timestampRanges.some((timestampRange) => {
            if (!this._comment._commentUpdateIpfsPath) return false;
            const folderCid = subIpns.postUpdates![timestampRange];
            const lastFolderCid = this._comment._commentUpdateIpfsPath.split("/")[0];
            return folderCid === lastFolderCid;
        });
        if (didLastPostUpdateRangeHaveSameFolderCid) {
            log(
                "Comment",
                this._comment.cid,
                "last post update range has same folder cid",
                this._comment._commentUpdateIpfsPath,
                "will be skipping loading CommentUpdate"
            );
            return undefined;
        }
        this._comment._setUpdatingStateWithEmissionIfNewState("fetching-update-ipfs");
        for (const timestampRange of timestampRanges) {
            const folderCid = subIpns.postUpdates![timestampRange];
            const path = this._calculatePathForPostCommentUpdate(folderCid, this._comment.postCid!);
            this._updateKuboRpcClientOrHeliaState("fetching-update-ipfs", kuboRpcOrHelia);
            let res: string;
            const commentUpdateTimeoutMs = this._plebbit._timeouts["comment-update-ipfs"];
            try {
                res = await this._fetchCidP2P(path, {
                    maxFileSizeBytes: MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE,
                    timeoutMs: commentUpdateTimeoutMs,
                    abortSignal: this._comment._getStopAbortSignal()
                });
            } catch (e) {
                // failed to load the record, maybe our node is offline or the content is unreachable
                log.trace(`Failed to fetch CommentUpdate from path (${path}) with IPFS P2P. Trying the next timestamp range`);
                attemptedPathsToLoadErrors[path] = <Error>e;
                continue;
            } finally {
                this._updateKuboRpcClientOrHeliaState("stopped", kuboRpcOrHelia);
            }
            try {
                const commentUpdate = parseCommentUpdateSchemaWithPlebbitErrorIfItFails(parseJsonWithPlebbitErrorIfFails(res));
                await this._throwIfCommentUpdateHasInvalidSignature(commentUpdate, subIpns);
                if (commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0))
                    return { commentUpdate, commentUpdateIpfsPath: path };
                else return undefined;
            } catch (e) {
                // there's a problem with the record itself, could be signature or schema or bad json
                this._comment._invalidCommentUpdateMfsPaths.add(path);
                if (e instanceof PlebbitError) e.details = { ...e.details, commentUpdatePath: path, postCid: this._comment.cid };
                throw e;
            }
        }
        throw new PlebbitError("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES", {
            timestampRanges,
            attemptedPathsToLoadErrors,
            postCid: this._comment.cid,
            commentDepth: this._comment.depth
        });
    }

    _shouldWeFetchCommentUpdateFromNextTimestamp(err: PlebbitError | Error): boolean {
        // Is there a problem with the record itself, or is this an issue with fetching?
        if (!(err instanceof PlebbitError)) return false; // If it's not a recognizable error, then we throw to notify the user
        if (
            err.code === "ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID" ||
            err.code === "ERR_INVALID_COMMENT_UPDATE_SCHEMA" ||
            err.code === "ERR_OVER_DOWNLOAD_LIMIT" ||
            err.code === "ERR_INVALID_JSON"
        )
            return false; // These errors means there's a problem with the record itself, not the loading

        if (err instanceof FailedToFetchCommentUpdateFromGatewaysError) {
            // If all gateway errors are due to the record itself, then we throw an error and don't jump to the next timestamp
            for (const gatewayError of Object.values(err.details.gatewayToError))
                if (this._shouldWeFetchCommentUpdateFromNextTimestamp(gatewayError)) return true; // if there's at least one gateway whose error is not due to the record
            return false; // if all gateways have issues with the record validity itself, then we stop fetching
        }

        return true;
    }

    private async _throwIfCommentUpdateHasInvalidSignature(commentUpdate: CommentUpdateType, subplebbitIpfs: SubplebbitIpfsType) {
        if (!this._comment.raw.comment) throw Error("Can't validate comment update when CommentIpfs hasn't been loaded");
        if (!this._comment.cid) throw Error("can't validate comment update when cid is not defined");
        if (!this._comment.postCid) throw Error("can't validate comment update when postCid is not defined");
        const verifyOptions = {
            update: commentUpdate,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this,
            subplebbit: { address: this._comment.communityAddress, signature: subplebbitIpfs.signature },
            comment: { ...this._comment.raw.comment, cid: this._comment.cid, postCid: this._comment.postCid },
            validatePages: this._plebbit.validatePages,
            validateUpdateSignature: true,
            abortSignal: this._comment._getStopAbortSignal()
        };
        const signatureValidity = await verifyCommentUpdate(verifyOptions);
        if (!signatureValidity.valid)
            throw new PlebbitError("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID", {
                signatureValidity,
                verifyOptions
            });
    }

    async _fetchPostCommentUpdateFromGateways(
        subIpns: SubplebbitIpfsType,
        timestampRanges: string[],
        log: Logger
    ): Promise<NewCommentUpdate> {
        const didLastPostUpdateRangeHaveSameFolderCid = timestampRanges.some((timestampRange) => {
            if (!this._comment._commentUpdateIpfsPath) return false;
            const folderCid = subIpns.postUpdates![timestampRange];
            const lastFolderCid = this._comment._commentUpdateIpfsPath.split("/")[0];
            return folderCid === lastFolderCid;
        });
        if (didLastPostUpdateRangeHaveSameFolderCid) {
            log(
                "Comment",
                this._comment.cid,
                "last post update range has same folder cid",
                this._comment._commentUpdateIpfsPath,
                "will be skipping loading CommentUpdate"
            );
            return undefined;
        }
        const attemptedPathsToLoadErrors: Record<string, Error> = {};

        let commentUpdate: CommentUpdateType | undefined;

        const validateCommentFromGateway: OptionsToLoadFromGateway["validateGatewayResponseFunc"] = async (res) => {
            if (typeof res.resText !== "string") throw Error("Gateway response has no body");
            const commentUpdateBeforeSignature = parseCommentUpdateSchemaWithPlebbitErrorIfItFails(
                parseJsonWithPlebbitErrorIfFails(res.resText)
            );
            await this._throwIfCommentUpdateHasInvalidSignature(commentUpdateBeforeSignature, subIpns);
            commentUpdate = commentUpdateBeforeSignature; // at this point, we know the gateway has provided a valid comment update and we can use it
        };

        this._comment._setUpdatingStateWithEmissionIfNewState("fetching-update-ipfs");

        for (const timestampRange of timestampRanges) {
            // We're validating schema and signature here for every gateway because it's not a regular cid whose content we can verify to match the cid

            const folderCid = subIpns.postUpdates![timestampRange];
            const path = this._calculatePathForPostCommentUpdate(folderCid, this._comment.postCid!);

            try {
                // Validate the Comment Update within the gateway fetching algo
                // fetchFromMultipleGateways will throw if all gateways failed to load the record
                await this.fetchFromMultipleGateways({
                    recordIpfsType: "ipfs",
                    root: folderCid,
                    path: path.replace(`${folderCid}/`, ""),
                    recordPlebbitType: "comment-update",
                    validateGatewayResponseFunc: validateCommentFromGateway,
                    log,
                    maxFileSizeBytes: MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE,
                    timeoutMs: this._plebbit._timeouts["comment-update-ipfs"],
                    abortSignal: this._comment._getStopAbortSignal()
                });
                if (!commentUpdate) throw Error("Failed to load comment update from gateways. This is a critical logic error");
                if (commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0))
                    return { commentUpdate, commentUpdateIpfsPath: path };
                else return undefined;
            } catch (e) {
                // We need to find out if it's loading error, and if it is we just move on to the next timestamp range
                // If it's a schema or signature error we should stop and throw
                if (this._shouldWeFetchCommentUpdateFromNextTimestamp(<PlebbitError>e)) {
                    attemptedPathsToLoadErrors[path] = <Error>e;
                    log.trace(`Failed to fetch CommentUpdate from path (${path}) from gateways. Trying the next timestamp range`);
                    continue;
                } else {
                    // non retriable error
                    // a problem with the record itself, bad signature/schema/etc
                    this._comment._invalidCommentUpdateMfsPaths.add(path);
                    throw e;
                }
            }
        }
        throw new PlebbitError("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES", {
            timestampRanges,
            attemptedPathsToLoadErrors,
            commentCid: this._comment.cid,
            commentDepth: this._comment.depth
        });
    }

    _useLoadedCommentUpdateIfNewInfo(
        loadedCommentUpdate: NonNullable<NewCommentUpdate> | Pick<NonNullable<NewCommentUpdate>, "commentUpdate">,
        subplebbit: Pick<SubplebbitIpfsType, "signature">,
        log: Logger
    ) {
        if ((this._comment.raw.commentUpdate?.updatedAt || 0) < loadedCommentUpdate.commentUpdate.updatedAt) {
            log(`${this._comment.depth === 0 ? "Post" : "Reply"} (${this._comment.cid}) received a new CommentUpdate`);
            this._comment._initCommentUpdate(loadedCommentUpdate.commentUpdate, subplebbit);
            if ("commentUpdateIpfsPath" in loadedCommentUpdate)
                this._comment._commentUpdateIpfsPath = loadedCommentUpdate.commentUpdateIpfsPath;
            this._comment._changeCommentStateEmitEventEmitStateChangeEvent({
                newUpdatingState: "succeeded",
                event: { name: "update", args: [this._comment] }
            });
            return true;
        } else return false;
    }

    async useSubplebbitPostUpdatesToFetchCommentUpdateForPost(subIpfs: SubplebbitIpfsType) {
        const log = Logger("plebbit-js:comment:useSubplebbitPostUpdatesToFetchCommentUpdate");
        if (!subIpfs.postUpdates) {
            throw new PlebbitError("ERR_SUBPLEBBIT_HAS_NO_POST_UPDATES", { subIpfs, postCid: this._comment.cid });
        }

        const postCid = this._comment.postCid;
        if (!postCid) throw Error("comment.postCid needs to be defined to fetch comment update");
        const postTimestamp = this._comment.timestamp;
        if (typeof postTimestamp !== "number") throw Error("Post timestamp is not defined by the time we're fetching from postUpdates");
        const timestampRanges = getPostUpdateTimestampRange(subIpfs.postUpdates, postTimestamp);
        if (timestampRanges.length === 0) throw Error("Post has no timestamp range bucket");

        let newCommentUpdate: NewCommentUpdate;
        try {
            if (
                Object.keys(this._plebbit.clients.kuboRpcClients).length > 0 ||
                Object.keys(this._plebbit.clients.libp2pJsClients).length > 0
            ) {
                newCommentUpdate = await this._fetchPostCommentUpdateIpfsP2P(subIpfs, timestampRanges, log);
            } else {
                newCommentUpdate = await this._fetchPostCommentUpdateFromGateways(subIpfs, timestampRanges, log);
            }
        } catch (e) {
            if (e instanceof Error) {
                if (isAbortError(e)) return;
                if (this._shouldWeFetchCommentUpdateFromNextTimestamp(<PlebbitError>e)) {
                    // this is a retriable error
                    // could be problems loading from the network or gateways
                    log.trace(`Post`, this._comment.cid, "Failed to load CommentUpdate. Will retry later", e);
                    this._comment._changeCommentStateEmitEventEmitStateChangeEvent({
                        newUpdatingState: "waiting-retry",
                        event: { name: "error", args: [e] }
                    });
                } else {
                    // non retriable error, problem with schema/signature
                    log.error(
                        "Received a non retriable error when attempting to load post commentUpdate. Will be emitting error",
                        this._comment.cid!,
                        e
                    );
                    this._comment._changeCommentStateEmitEventEmitStateChangeEvent({
                        newUpdatingState: "failed",
                        event: { name: "error", args: [e] }
                    });
                }
            }
            return;
        }
        if (newCommentUpdate) {
            this._useLoadedCommentUpdateIfNewInfo(newCommentUpdate, subIpfs, log);
        } else if (newCommentUpdate === undefined) {
            log.trace(`Comment`, this._comment.cid, "loaded an old comment update. Ignoring it");
            this._comment._setUpdatingStateWithEmissionIfNewState("waiting-retry");
        }
    }

    private async _fetchRawCommentCidIpfsP2P(cid: string): Promise<string> {
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();
        this._updateKuboRpcClientOrHeliaState("fetching-ipfs", kuboRpcOrHelia);
        let commentRawString: string;
        const commentTimeoutMs = this._plebbit._timeouts["comment-ipfs"];
        try {
            commentRawString = await this._fetchCidP2P(cid, {
                maxFileSizeBytes: 1024 * 1024,
                timeoutMs: commentTimeoutMs,
                abortSignal: this._comment._getStopAbortSignal()
            });
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, commentCid: cid, commentTimeoutMs };
            throw e;
        } finally {
            this._updateKuboRpcClientOrHeliaState("stopped", kuboRpcOrHelia);
        }

        return commentRawString;
    }

    private async _fetchCommentIpfsFromGateways(parentCid: string): Promise<string> {
        // We only need to validate once, because with Comment Ipfs the fetchFromMultipleGateways already validates if the response is the same as its cid

        const log = Logger("plebbit-js:comment:client-manager:_fetchCommentIpfsFromGateways");
        const res = await this.fetchFromMultipleGateways({
            recordIpfsType: "ipfs",
            recordPlebbitType: "comment",
            root: parentCid,
            validateGatewayResponseFunc: async () => {},
            log,
            maxFileSizeBytes: 1024 * 1024,
            timeoutMs: this._plebbit._timeouts["comment-ipfs"],
            abortSignal: this._comment._getStopAbortSignal()
        });
        return res.resText;
    }

    private async _throwIfCommentIpfsIsInvalid(commentIpfs: CommentIpfsType, commentCid: string) {
        // Can potentially throw if resolver if not working
        const verificationOpts = {
            comment: commentIpfs,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this,
            calculatedCommentCid: commentCid,
            communityAddressFromInstance: this._comment.communityAddress,
            abortSignal: this._comment._getStopAbortSignal()
        };
        const commentIpfsValidation = await verifyCommentIpfs(verificationOpts);
        if (!commentIpfsValidation.valid)
            throw new PlebbitError("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID", { commentIpfsValidation, verificationOpts });
    }

    async _fetchCommentIpfsFromPages() {
        // this code below won't be executed by a post, and instead it will be a reply
        // what do we do if we don't have parentCid?

        // - download all comments under a sub and look for our specific comment
        if (!this._comment.communityAddress) throw Error("Comment communityAddress should be defined");
        if (!this._comment.cid) throw Error("Comment cid should be defined");
        const sub = await this._plebbit.createSubplebbit({ address: this._comment.communityAddress });

        const abortController = new AbortController();
        const abortIfNeeded = async () => {
            if (!abortController.signal.aborted) abortController.abort();
            if (sub.state === "updating") await sub.stop();
        };
        const onCommentUpdate = async () => {
            if (this._comment.raw.comment) await abortIfNeeded();
        };
        const onStateChange = async (newState: Comment["state"]) => {
            if (newState === "stopped") await abortIfNeeded();
        };

        this._comment.on("update", onCommentUpdate);
        this._comment.on("statechange", onStateChange);

        if (this._comment.state === "stopped" || this._plebbit.destroyed) return;
        try {
            if (abortController.signal.aborted) return;
            await sub.update();
            await new Promise<void>((resolve, reject) => {
                const abortError = () => {
                    const error = new Error("The operation was aborted");
                    error.name = "AbortError";
                    return error;
                };
                const cleanup = () => {
                    sub.removeListener("update", onUpdate);
                    abortController.signal.removeEventListener("abort", onAbort);
                };
                const onAbort = () => {
                    cleanup();
                    reject(abortError());
                };
                const onUpdate = async () => {
                    try {
                        if (typeof sub.updatedAt === "number") {
                            cleanup();
                            resolve();
                        }
                    } catch (error) {
                        cleanup();
                        reject(error as Error);
                    }
                };
                if (abortController.signal.aborted) {
                    reject(abortError());
                    return;
                }
                abortController.signal.addEventListener("abort", onAbort);
                sub.on("update", onUpdate);
                void onUpdate();
            });

            await sub.stop();

            const commentAfterSearchingAllPages = await loadAllPagesUnderSubplebbitToFindComment({
                subplebbit: sub,
                commentCidToFind: this._comment.cid,
                postCid: this._comment.postCid,
                parentCid: this._comment.parentCid,
                signal: abortController.signal
            });
            if (commentAfterSearchingAllPages) {
                if (!this._comment.raw.comment) {
                    this._comment._initIpfsProps(commentAfterSearchingAllPages.comment);
                    this._comment.emit("update", this._comment);
                }
                if ((this._comment.updatedAt || 0) < commentAfterSearchingAllPages.commentUpdate.updatedAt)
                    this._comment._initCommentUpdate(commentAfterSearchingAllPages.commentUpdate, sub.raw.subplebbitIpfs);
            }
        } catch (err) {
            if ((err as Error)?.name !== "AbortError") throw err;
        } finally {
            this._comment.removeListener("update", onCommentUpdate);
            this._comment.removeListener("statechange", onStateChange);
        }
    }

    // We're gonna fetch Comment Ipfs, and verify its signature and schema
    async fetchAndVerifyCommentCid(cid: string): Promise<CommentIpfsType> {
        const cachedComment = this._plebbit._memCaches.commentIpfs.get(cid);
        if (cachedComment) {
            fetchCommentLogger.trace("Serving comment CID from cache", cid);
            return remeda.clone(cachedComment);
        }

        const verifiedComment = await this._plebbit._inflightFetchManager.withResource(
            InflightResourceTypes.COMMENT_IPFS,
            cid,
            async () => {
                fetchCommentLogger.trace("Fetching comment CID", cid);
                let commentRawString: string;
                if (
                    Object.keys(this._plebbit.clients.kuboRpcClients).length > 0 ||
                    Object.keys(this._plebbit.clients.libp2pJsClients).length > 0
                ) {
                    commentRawString = await this._fetchRawCommentCidIpfsP2P(cid);
                } else commentRawString = await this._fetchCommentIpfsFromGateways(cid);

                const commentIpfs = parseCommentIpfsSchemaWithPlebbitErrorIfItFails(parseJsonWithPlebbitErrorIfFails(commentRawString)); // could throw if schema is invalid
                await this._throwIfCommentIpfsIsInvalid(commentIpfs, cid);
                return commentIpfs;
            }
        );

        this._plebbit._memCaches.commentIpfs.set(cid, verifiedComment);
        return verifiedComment;
    }

    protected _isPublishing() {
        return this._comment.state === "publishing";
    }

    _findCommentInPagesOfUpdatingCommentsOrSubplebbit(opts?: {
        sub?: RemoteSubplebbit;
        post?: Comment;
        parent?: Comment;
    }): PageIpfs["comments"][0] | undefined {
        // TODO rewrite this to use updating comments and subplebbit
        if (typeof this._comment.cid !== "string") throw Error("Need to have defined cid");
        const sub: RemoteSubplebbit | undefined =
            findStartedSubplebbit(this._plebbit, { address: this._comment.communityAddress }) ||
            findUpdatingSubplebbit(this._plebbit, { address: this._comment.communityAddress }) ||
            opts?.sub;
        let updateFromSub: PageIpfs["comments"][0] | undefined;
        if (sub) updateFromSub = findCommentInPageInstanceRecursively(sub.posts, this._comment.cid);

        const post: Comment | undefined = this._comment.postCid
            ? findUpdatingComment(this._plebbit, { cid: this._comment.postCid })
            : opts?.post;
        let updateFromPost: PageIpfs["comments"][0] | undefined;
        if (post) updateFromPost = findCommentInPageInstanceRecursively(post.replies, this._comment.cid);

        const parent: Comment | undefined = this._comment.parentCid
            ? opts?.parent || findUpdatingComment(this._plebbit, { cid: this._comment.parentCid })
            : undefined;
        let updateFromParent: PageIpfs["comments"][0] | undefined;
        if (parent) {
            updateFromParent = parent.replies && findCommentInPageInstance(parent.replies, this._comment.cid);
        }

        const updates: PageIpfs["comments"][0][] = [updateFromSub, updateFromPost, updateFromParent].filter((update) => !!update);
        const latestUpdate = updates.sort((a, b) => b.commentUpdate.updatedAt - a.commentUpdate.updatedAt)[0];
        return latestUpdate;
    }

    // will handling sub states down here
    // this is for posts with depth === 0
    override async handleUpdateEventFromSub(sub: RemoteSubplebbit) {
        const log = Logger("plebbit-js:comment:update");
        if (!this._comment.cid) {
            log("comment.cid is not defined because comment is publishing, waiting until cid is defined");
            return;
        }
        // a new update has been emitted by sub
        if (this._comment.state === "stopped") {
            // there are async cases where we fetch a SubplebbitUpdate in the background and stop() is called midway
            await this._comment.stop();
            return;
        }

        if (!sub.raw.subplebbitIpfs) throw Error("Subplebbit IPFS should be defined when an update is emitted");
        // let's try to find a CommentUpdate in subplebbit pages, or _updatingComments
        // this._communityForUpdating!.subplebbit.raw.subplebbitIpfs?.posts.

        const postInUpdatingSubplebbit = this._findCommentInPagesOfUpdatingCommentsOrSubplebbit({ sub });

        if (
            postInUpdatingSubplebbit &&
            postInUpdatingSubplebbit.commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0)
        ) {
            const log = Logger("plebbit-js:comment:update:handleUpdateEventFromSub:find-comment-update-in-updating-sub-or-comments-pages");
            this._useLoadedCommentUpdateIfNewInfo({ commentUpdate: postInUpdatingSubplebbit.commentUpdate }, sub.raw.subplebbitIpfs, log);
        } else
            try {
                // this is only for posts with depth === 0
                await this.useSubplebbitPostUpdatesToFetchCommentUpdateForPost(sub.raw.subplebbitIpfs);
            } catch (e) {
                if (isAbortError(e)) return;
                log.error("Failed to use subplebbit update to fetch new CommentUpdate", e);
                this._comment._changeCommentStateEmitEventEmitStateChangeEvent({
                    newUpdatingState: "failed",
                    event: { name: "error", args: [e as PlebbitError] }
                });
            }
    }

    _chooseWhichPagesBasedOnParentAndReplyTimestamp(parentCommentTimestamp: number): "old" | "new" {
        // Choose which page type to search first based on our reply's timestamp
        const replyTimestamp = this._comment.timestamp;
        const currentTime = Math.floor(Date.now() / 1000);

        // Calculate if our reply is relatively newer or older within the reply timeline
        // The reply timeline spans from parentComment timestamp to current time
        const replyTimelineSpan = currentTime - parentCommentTimestamp;

        // Ensure our reply timestamp is at least the parentComment timestamp
        const adjustedReplyTimestamp = Math.max(replyTimestamp, parentCommentTimestamp);

        // Calculate how far along the timeline our reply is (0 = oldest possible, 1 = newest possible)
        const replyRelativeAge = (currentTime - adjustedReplyTimestamp) / replyTimelineSpan;

        // If replyRelativeAge is closer to 0, the reply is newer (less age)
        // If replyRelativeAge is closer to 1, the reply is older (more age)
        // So we start with 'new' pages if replyRelativeAge < 0.5
        const startWithNewPages = replyRelativeAge < 0.5;
        return startWithNewPages ? "new" : "old";
    }

    async usePageCidsOfParentToFetchCommentUpdateForReply(postCommentInstance: Comment) {
        const log = Logger("plebbit-js:comment:update:usePageCidsOfParentToFetchCommentUpdateForReply");
        if (!this._comment.cid) throw Error("comment.cid needs to be defined to fetch comment update of reply");
        if (!this._comment.parentCid) throw Error("comment.parentCid needs to be defined to fetch comment update of reply");
        const subplebbitWithSignature = <Required<Pick<RemoteSubplebbit, "signature">>>postCommentInstance.replies._subplebbit;
        if (!subplebbitWithSignature.signature)
            throw Error("comment.replies._subplebbit.signature needs to be defined to fetch comment update of reply");
        const parentCommentInstance =
            postCommentInstance.cid === this._comment.parentCid
                ? postCommentInstance
                : await this._plebbit.createComment({ cid: this._comment.parentCid });
        let startedUpdatingParentComment = false;
        if (parentCommentInstance.state === "stopped") {
            await parentCommentInstance.update();
            startedUpdatingParentComment = true;
        }
        await resolveWhenPredicateIsTrue({
            toUpdate: parentCommentInstance,
            predicate: () => typeof parentCommentInstance.updatedAt === "number"
        });
        if (startedUpdatingParentComment) await parentCommentInstance.stop();
        if (parentCommentInstance.updatedAt! < this._comment.timestamp) return; // if updatedAt is older then it doesn't include this comment yet
        const replyInPreloadedParentPages =
            parentCommentInstance.replies && findCommentInPageInstance(parentCommentInstance.replies, this._comment.cid);

        if (
            replyInPreloadedParentPages &&
            replyInPreloadedParentPages.commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0)
        ) {
            this._useLoadedCommentUpdateIfNewInfo(
                { commentUpdate: replyInPreloadedParentPages.commentUpdate },
                subplebbitWithSignature,
                log
            );
            return;
        }
        if (Object.keys(parentCommentInstance.replies.pageCids).length === 0) {
            // Parent has no pageCids - all replies fit in preloaded pages
            // If we found the reply in preloaded pages (line 675-676), use it even if not strictly "newer"
            if (replyInPreloadedParentPages) {
                log(
                    "Parent comment",
                    this._comment.parentCid,
                    "has no pageCids but reply",
                    this._comment.cid,
                    "found in preloaded pages - using it"
                );
                this._useLoadedCommentUpdateIfNewInfo(
                    { commentUpdate: replyInPreloadedParentPages.commentUpdate },
                    subplebbitWithSignature,
                    log
                );
                return;
            }

            // Reply not in preloaded pages and no pageCids to search - wait for update
            log(
                "Parent comment",
                this._comment.parentCid,
                "of reply",
                this._comment.cid,
                "does not have any pageCids and reply not in preloaded pages, will wait until another update event by post"
            );
            this._comment._setUpdatingStateWithEmissionIfNewState("waiting-retry");
            return;
        }
        const pageSortName = this._chooseWhichPagesBasedOnParentAndReplyTimestamp(parentCommentInstance.timestamp);

        let curPageCid: string | undefined = parentCommentInstance.replies.pageCids[pageSortName];
        if (!curPageCid) throw Error("Parent comment does not have any new or old pages");

        if (this._parentFirstPageCidsAlreadyLoaded.has(curPageCid)) {
            log(`Reply`, this._comment.cid, `:SKIPPING: Page CID ${curPageCid} already loaded parent page cid`);
            // we already loaded this page before and have its comment update, no need to do anything
            return;
        }

        this._comment._setUpdatingStateWithEmissionIfNewState("fetching-update-ipfs");
        let newCommentUpdate: PageIpfs["comments"][0] | undefined;
        const pageCidsSearchedForNewUpdate: {
            pageCid: string;
            error?: Error;
            replyWithinUpdatingPages?: boolean;
            replyWithinParentPage?: boolean;
        }[] = [];
        let replyFoundWithoutNewerUpdate = false;
        while (curPageCid && !newCommentUpdate) {
            let pageLoaded: PageTypeJson;
            try {
                pageLoaded = await parentCommentInstance.replies.getPage({ cid: curPageCid });
            } catch (e) {
                if (isAbortError(e)) throw e;
                pageCidsSearchedForNewUpdate.push({ pageCid: curPageCid, error: e as Error });
                break;
            }
            if (pageCidsSearchedForNewUpdate.length === 0) {
                this._parentFirstPageCidsAlreadyLoaded.add(curPageCid);
            }
            const replyWithinParentPage = findCommentInParsedPages(pageLoaded, this._comment.cid)?.raw;
            const replyWithinUpdatingPages = this._findCommentInPagesOfUpdatingCommentsOrSubplebbit({ parent: parentCommentInstance });

            pageCidsSearchedForNewUpdate.push({
                pageCid: curPageCid,
                replyWithinParentPage: Boolean(replyWithinParentPage),
                replyWithinUpdatingPages: Boolean(replyWithinUpdatingPages)
            });

            if (replyWithinParentPage) {
                const isNewUpdate = replyWithinParentPage.commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0);
                if (isNewUpdate) {
                    newCommentUpdate = replyWithinParentPage;
                } else {
                    replyFoundWithoutNewerUpdate = true;
                }
                break; // if we found the comment in parent pages, there's no point in continuing to look for it in updating pages
            } else if (replyWithinUpdatingPages) {
                const isNewUpdate = replyWithinUpdatingPages.commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0);
                if (isNewUpdate) newCommentUpdate = replyWithinUpdatingPages;
                else replyFoundWithoutNewerUpdate = true;
            }

            if (pageSortName === "new" && pageLoaded.comments.find((comment) => comment.timestamp < this._comment.timestamp)) {
                log(
                    "Reply",
                    this._comment.cid,
                    "we found a comment in the page that is older than our reply, stopping search for new comment update"
                );
                break;
            } else if (pageSortName === "old" && pageLoaded.comments.find((comment) => comment.timestamp > this._comment.timestamp)) {
                log(
                    "Reply",
                    this._comment.cid,
                    "we found a comment in the page that is newer than our reply, stopping search for old comment update"
                );
                break;
            }
            curPageCid = pageLoaded.nextCid;
        }
        log(
            "Searched for new comment update of comment",
            this._comment.cid,
            "in the following pageCids of page sort",
            pageSortName,
            "of parent comment:",
            parentCommentInstance.cid,
            pageCidsSearchedForNewUpdate,
            "and found",
            newCommentUpdate ? "a new comment update" : "no new comment update"
        );
        if (newCommentUpdate)
            this._useLoadedCommentUpdateIfNewInfo({ commentUpdate: newCommentUpdate.commentUpdate }, subplebbitWithSignature, log);
        else if (!replyFoundWithoutNewerUpdate)
            throw new PlebbitError("ERR_FAILED_TO_FIND_REPLY_COMMENT_UPDATE_WITHIN_PARENT_COMMENT_PAGE_CIDS", {
                replyCid: this._comment.cid,
                parentCommentCid: parentCommentInstance.cid,
                pageSortName,
                pageCidsSearchedForNewUpdate
            });
    }

    override async handleErrorEventFromSub(error: PlebbitError | Error) {
        // we received a non retriable error from sub instance
        if (this._comment.state === "publishing") return super.handleErrorEventFromSub(error);
        else if (this._communityForUpdating?.subplebbit?.updatingState === "failed") {
            // let's make sure
            // we're updating a comment
            const log = Logger("plebbit-js:comment:update");
            log.error(
                this._comment.depth === 0 ? "Post" : "Reply",
                this._comment.cid,
                "received a non retriable error from its subplebbit instance. Will stop comment updating",
                error
            );
            this._comment._changeCommentStateEmitEventEmitStateChangeEvent({
                newUpdatingState: "failed",
                event: { name: "error", args: [error] }
            });
            await this._comment.stop();
        }
    }

    override handleIpfsGatewaySubplebbitState(
        subplebbitNewGatewayState: RemoteSubplebbit["clients"]["ipfsGateways"][string]["state"],
        gatewayUrl: string
    ) {
        if (this._comment.state === "publishing") return super.handleIpfsGatewaySubplebbitState(subplebbitNewGatewayState, gatewayUrl);
        // we're updating
        else if (subplebbitNewGatewayState === "fetching-ipns") this.updateGatewayState("fetching-subplebbit-ipns", gatewayUrl);
    }

    _translateSubUpdatingStateToCommentUpdatingState(newSubUpdatingState: RemoteSubplebbit["updatingState"]) {
        const subUpdatingStateToCommentUpdatingState: Record<typeof newSubUpdatingState, Comment["updatingState"] | undefined> = {
            failed: "failed",
            "fetching-ipfs": "fetching-subplebbit-ipfs",
            "fetching-ipns": "fetching-subplebbit-ipns",
            "resolving-name": "resolving-community-name",
            "waiting-retry": "waiting-retry",
            stopped: "stopped",
            succeeded: undefined,
            "publishing-ipns": undefined
        };
        const translatedCommentUpdatingState = subUpdatingStateToCommentUpdatingState[newSubUpdatingState];
        if (translatedCommentUpdatingState) this._comment._setUpdatingStateWithEmissionIfNewState(translatedCommentUpdatingState);
    }

    override handleUpdatingStateChangeEventFromSub(newSubUpdatingState: RemoteSubplebbit["updatingState"]) {
        if (this._comment.state === "publishing") return super.handleUpdatingStateChangeEventFromSub(newSubUpdatingState);
        if (this._comment.updatingState === "fetching-update-ipfs") return;

        this._translateSubUpdatingStateToCommentUpdatingState(newSubUpdatingState);
    }

    handleErrorEventFromPost(error: PlebbitError | Error) {
        this._comment.emit("error", error);
    }

    handleUpdatingStateChangeEventFromPost(newState: Comment["updatingState"]) {
        const postUpdatingStateToReplyUpdatingState: Record<Comment["updatingState"], Comment["updatingState"] | undefined> = {
            failed: "failed",
            "fetching-subplebbit-ipfs": "fetching-subplebbit-ipfs",
            "fetching-subplebbit-ipns": "fetching-subplebbit-ipns",
            "resolving-community-name": "resolving-community-name",
            "waiting-retry": "waiting-retry",
            stopped: undefined,
            succeeded: undefined,
            "fetching-ipfs": undefined,
            "resolving-author-name": undefined,
            "fetching-update-ipfs": undefined
        };
        const replyState = postUpdatingStateToReplyUpdatingState[newState];
        if (replyState) {
            if (this._fetchingUpdateForReplyUsingPageCidsPromise)
                this._fetchingUpdateForReplyUsingPageCidsPromise.then(() =>
                    this._comment._setUpdatingStateWithEmissionIfNewState(replyState)
                );
            else this._comment._setUpdatingStateWithEmissionIfNewState(replyState);
        }
    }

    _handleIpfsGatewayPostState(newState: Comment["clients"]["ipfsGateways"][string]["state"], gatewayUrl: string) {
        this.updateGatewayState(newState, gatewayUrl);
    }

    _handleKuboRpcPostState(newState: Comment["clients"]["kuboRpcClients"][string]["state"], kuboRpcUrl: string) {
        this.updateKuboRpcState(newState, kuboRpcUrl);
    }

    _handleLibp2pJsClientPostState(newState: Comment["clients"]["libp2pJsClients"][string]["state"], libp2pJsClientKey: string) {
        this.updateLibp2pJsClientState(newState, libp2pJsClientKey);
    }

    _handleNameResolverPostState(newState: Comment["clients"]["nameResolvers"][string]["state"], resolverKey: string) {
        this.updateNameResolverState(newState, resolverKey);
    }

    async handleUpdateEventFromPostToFetchReplyCommentUpdate(postInstance: Comment) {
        if (!this._comment.cid) throw Error("comment.cid should be defined");
        const log = Logger("plebbit-js:comment:update:handleUpdateEventFromPost");
        log("Received update event from post", postInstance.cid, "for reply", this._comment.cid, "with depth", this._comment.depth);
        if (Object.keys(postInstance.replies.pageCids).length === 0 && Object.keys(postInstance.replies.pages).length === 0) {
            log(
                "Post",
                postInstance.cid,
                "has no replies, therefore reply",
                this._comment.cid,
                "will wait until another update event by post"
            );
            this._comment._setUpdatingStateWithEmissionIfNewState("waiting-retry");
            return;
        }
        const replyInPage = this._findCommentInPagesOfUpdatingCommentsOrSubplebbit({ post: postInstance });

        const updatingSubplebbit = findUpdatingSubplebbit(this._plebbit, { address: postInstance.communityAddress });
        const startedSubplebbit = findStartedSubplebbit(this._plebbit, { address: postInstance.communityAddress });
        const repliesSubplebbit = <Pick<SubplebbitIpfsType, "signature">>(
            (updatingSubplebbit?.raw?.subplebbitIpfs || startedSubplebbit?.raw?.subplebbitIpfs || postInstance.replies._subplebbit)
        );
        if (!repliesSubplebbit.signature) throw Error("repliesSubplebbit.signature needs to be defined to fetch comment update of reply");
        if (replyInPage && !this._comment.raw.comment) {
            this._comment._initIpfsProps(replyInPage.comment);
            this._comment.emit("update", this._comment);
        }
        if (replyInPage && replyInPage.commentUpdate.updatedAt > (this._comment.raw?.commentUpdate?.updatedAt || 0)) {
            const log = Logger(
                "plebbit-js:comment:update:handleUpdateEventFromPostToFetchReplyCommentUpdate:find-comment-update-in-updating-sub-or-comments-pages"
            );
            this._useLoadedCommentUpdateIfNewInfo({ commentUpdate: replyInPage.commentUpdate }, repliesSubplebbit, log);
            return; // we found an update from pages, no need to do anything else
        }

        if (this._fetchingUpdateForReplyUsingPageCidsPromise) await this._fetchingUpdateForReplyUsingPageCidsPromise;

        this._fetchingUpdateForReplyUsingPageCidsPromise = this.usePageCidsOfParentToFetchCommentUpdateForReply(postInstance)
            .catch((error) => {
                if (isAbortError(error)) return;
                log.error("Failed to fetch reply commentUpdate update from parent pages", error);
                this._comment._changeCommentStateEmitEventEmitStateChangeEvent({
                    newUpdatingState: "failed",
                    event: { name: "error", args: [error as PlebbitError | Error] }
                });
            })
            .finally(() => {
                this._fetchingUpdateForReplyUsingPageCidsPromise = undefined;
            });
        await this._fetchingUpdateForReplyUsingPageCidsPromise;
        this._fetchingUpdateForReplyUsingPageCidsPromise = undefined;
    }

    async _createPostInstanceWithStateTranslation(): Promise<CommentClientsManager["_postForUpdating"]> {
        // this function will be for translating between the states of the post and its clients to reply states
        if (!this._comment.postCid) throw Error("comment.postCid needs to be defined to fetch comment update of reply");
        const post =
            findUpdatingComment(this._plebbit, { cid: this._comment.postCid }) ||
            (await this._plebbit.createComment({ cid: this._comment.postCid }));

        this._postForUpdating = {
            comment: post,
            error: this.handleErrorEventFromPost.bind(this),
            update: this.handleUpdateEventFromPostToFetchReplyCommentUpdate.bind(this),
            updatingstatechange: this.handleUpdatingStateChangeEventFromPost.bind(this)
        };

        if (
            this._postForUpdating.comment.clients.ipfsGateways &&
            Object.keys(this._postForUpdating.comment.clients.ipfsGateways).length > 0
        ) {
            // we're using gateways
            const ipfsGatewayListeners: (typeof this._postForUpdating)["ipfsGatewayListeners"] = {};

            for (const gatewayUrl of Object.keys(this._postForUpdating.comment.clients.ipfsGateways)) {
                const ipfsStateListener = (postNewIpfsState: Comment["clients"]["ipfsGateways"][string]["state"]) =>
                    this._handleIpfsGatewayPostState(postNewIpfsState, gatewayUrl);

                this._postForUpdating.comment.clients.ipfsGateways[gatewayUrl].on("statechange", ipfsStateListener);
                ipfsGatewayListeners[gatewayUrl] = ipfsStateListener;
            }
            this._postForUpdating.ipfsGatewayListeners = ipfsGatewayListeners;
        }

        // Add Kubo RPC client state listeners
        if (
            this._postForUpdating.comment.clients.kuboRpcClients &&
            Object.keys(this._postForUpdating.comment.clients.kuboRpcClients).length > 0
        ) {
            const kuboRpcListeners: Record<string, Parameters<Comment["clients"]["kuboRpcClients"][string]["on"]>[1]> = {};

            for (const kuboRpcUrl of Object.keys(this._postForUpdating.comment.clients.kuboRpcClients)) {
                const kuboRpcStateListener = (postNewKuboRpcState: Comment["clients"]["kuboRpcClients"][string]["state"]) =>
                    this._handleKuboRpcPostState(postNewKuboRpcState, kuboRpcUrl);

                this._postForUpdating.comment.clients.kuboRpcClients[kuboRpcUrl].on("statechange", kuboRpcStateListener);
                kuboRpcListeners[kuboRpcUrl] = kuboRpcStateListener;
            }
            this._postForUpdating.kuboRpcListeners = kuboRpcListeners;
        }

        if (
            this._postForUpdating.comment.clients.libp2pJsClients &&
            Object.keys(this._postForUpdating.comment.clients.libp2pJsClients).length > 0
        ) {
            const libp2pJsClientListeners: Record<string, Parameters<Comment["clients"]["libp2pJsClients"][string]["on"]>[1]> = {};

            for (const libp2pJsClientKey of Object.keys(this._postForUpdating.comment.clients.libp2pJsClients)) {
                const libp2pJsStateListener = (postNewLibp2pJsState: Comment["clients"]["libp2pJsClients"][string]["state"]) =>
                    this._handleLibp2pJsClientPostState(postNewLibp2pJsState, libp2pJsClientKey);

                this._postForUpdating.comment.clients.libp2pJsClients[libp2pJsClientKey].on("statechange", libp2pJsStateListener);
                libp2pJsClientListeners[libp2pJsClientKey] = libp2pJsStateListener;
            }
            this._postForUpdating.libp2pJsClientListeners = libp2pJsClientListeners;
        }

        // Add name resolver state listeners
        if (
            this._postForUpdating.comment.clients.nameResolvers &&
            Object.keys(this._postForUpdating.comment.clients.nameResolvers).length > 0
        ) {
            const nameResolverListeners: Record<string, Parameters<Comment["clients"]["nameResolvers"][string]["on"]>[1]> = {};

            for (const resolverKey of Object.keys(this._postForUpdating.comment.clients.nameResolvers)) {
                const resolverStateListener = (postNewResolverState: Comment["clients"]["nameResolvers"][string]["state"]) =>
                    this._handleNameResolverPostState(postNewResolverState, resolverKey);

                this._postForUpdating.comment.clients.nameResolvers[resolverKey].on("statechange", resolverStateListener);
                nameResolverListeners[resolverKey] = resolverStateListener;
            }
            this._postForUpdating.nameResolverListeners = nameResolverListeners;
        }

        this._postForUpdating.comment.on("update", this._postForUpdating.update);

        this._postForUpdating.comment.on("updatingstatechange", this._postForUpdating.updatingstatechange);

        this._postForUpdating.comment.on("error", this._postForUpdating.error);
        return this._postForUpdating;
    }

    async cleanUpUpdatingPostInstance() {
        if (!this._postForUpdating) return; // it has been cleared out somewhere else

        // Clean up IPFS Gateway listeners
        if (this._postForUpdating.ipfsGatewayListeners) {
            for (const gatewayUrl of Object.keys(this._postForUpdating.ipfsGatewayListeners)) {
                this._postForUpdating.comment.clients.ipfsGateways[gatewayUrl].removeListener(
                    "statechange",
                    this._postForUpdating.ipfsGatewayListeners[gatewayUrl]
                );
                this.updateGatewayState("stopped", gatewayUrl); // need to reset all gateway states
            }
        }

        // Clean up Kubo RPC listeners
        if (this._postForUpdating.kuboRpcListeners) {
            for (const kuboRpcUrl of Object.keys(this._postForUpdating.kuboRpcListeners)) {
                this._postForUpdating.comment.clients.kuboRpcClients[kuboRpcUrl].removeListener(
                    "statechange",
                    this._postForUpdating.kuboRpcListeners[kuboRpcUrl]
                );
                this.updateKuboRpcState("stopped", kuboRpcUrl); // need to reset all Kubo RPC states
            }
        }

        // Clean up libp2pJs client listeners
        if (this._postForUpdating.libp2pJsClientListeners) {
            for (const libp2pJsClientKey of Object.keys(this._postForUpdating.libp2pJsClientListeners)) {
                this._postForUpdating.comment.clients.libp2pJsClients[libp2pJsClientKey].removeListener(
                    "statechange",
                    this._postForUpdating.libp2pJsClientListeners[libp2pJsClientKey]
                );
                this.updateLibp2pJsClientState("stopped", libp2pJsClientKey); // need to reset all libp2pJs client states
            }
        }

        // Clean up name resolver listeners
        if (this._postForUpdating.nameResolverListeners) {
            for (const resolverKey of Object.keys(this._postForUpdating.nameResolverListeners)) {
                this._postForUpdating.comment.clients.nameResolvers[resolverKey].removeListener(
                    "statechange",
                    this._postForUpdating.nameResolverListeners[resolverKey]
                );
                this.updateNameResolverState("stopped", resolverKey); // need to reset all name resolver states
            }
        }

        // Remove update event at the end
        this._postForUpdating.comment.removeListener("updatingstatechange", this._postForUpdating.updatingstatechange);
        this._postForUpdating.comment.removeListener("error", this._postForUpdating.error);
        this._postForUpdating.comment.removeListener("update", this._postForUpdating.update);

        // only stop if it's mirroring the actual comment instance updating at plebbit._updatingComments
        if (this._postForUpdating.comment._updatingCommentInstance) await this._postForUpdating.comment.stop();
        this._parentFirstPageCidsAlreadyLoaded.clear();
        this._postForUpdating = undefined;
    }
}
