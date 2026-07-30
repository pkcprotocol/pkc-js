import Logger from "../../../logger.js";
import { PKC } from "../../../pkc/pkc.js";
import type {
    CommunityEditOptions,
    CreateNewLocalCommunityParsedOptions,
    InternalCommunityRecordBeforeFirstUpdateType,
    InternalCommunityRecordAfterFirstUpdateType,
    ParsedCommunityEditOptions,
    CommunityChallengeSetting,
    CommunityIpfsType,
    RpcInternalCommunityRecordBeforeFirstUpdateType,
    RpcInternalCommunityRecordAfterFirstUpdateType,
    CommunityEvents
} from "../../../community/types.js";
import { LRUCache } from "lru-cache";
import { PageGenerator } from "./page-generator.js";
import { DbHandler } from "./db-handler.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import {
    calculateStringSizeSameAsIpfsAddCidV0,
    hideClassPrivateProps,
    ipnsNameToIpnsOverPubsubTopic,
    isStringDomain,
    pubsubTopicToDhtKey,
    retryKuboIpfsAddAndProvide
} from "../../../util.js";
import { communityIdentityPublicKey } from "./local-community/identity.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { PKCError } from "../../../pkc-error.js";
import type {
    ChallengeAnswerMessageType,
    ChallengeRequestMessageType,
    DecryptedChallengeAnswer,
    DecryptedChallengeRequestMessageType
} from "../../../pubsub-messages/types.js";
import { storePublication } from "./local-community/publication-store.js";
import type { IpfsHttpClientPubsubMessage } from "../../../types.js";
import { verifyCommunity } from "../../../signer/signatures.js";
import { deriveCommentIpfsFromCommentTableRow } from "../util.js";
import { SignerWithPublicKeyAddress } from "../../../signer/index.js";
import { RpcLocalCommunity } from "../../../community/rpc-local-community.js";
import { omit, pick } from "remeda";
import type { CommentsTableRow } from "../../../publications/comment/types.js";
import { CommunityIpfsSchema } from "../../../community/schema.js";
import { MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS } from "../../../community/community-client-manager.js";
import { sha256 } from "js-sha256";
import { AllPageCids } from "../../../pages/types.js";
import { generateDefaultChallenges } from "./local-community/defaults.js";
import {
    createNewLocalCommunityDb,
    getDbInternalState,
    initDbHandlerIfNeeded,
    initInternalCommunityAfterFirstUpdateNoMerge,
    initInternalCommunityBeforeFirstUpdateNoMerge,
    initNewLocalCommunityPropsNoMerge,
    updateDbInternalState,
    updateInstancePropsWithStartedCommunityOrDb
} from "./local-community/db-state.js";

export { createNewLocalCommunityDb, updateInstancePropsWithStartedCommunityOrDb };
import { listenToIncomingRequests } from "./local-community/pubsub.js";
import { repinCommentsIPFSIfNeeded } from "./local-community/cleanup.js";
import {
    handleChallengeAnswer as handleChallengeAnswerFreeFunction,
    handleChallengeExchange as handleChallengeExchangeFreeFunction,
    handleChallengeRequest as handleChallengeRequestFreeFunction,
    publishChallengeVerification,
    publishIdempotentDuplicateVerification
} from "./local-community/challenges.js";
import { checkPublicationValidity } from "./local-community/publication-validation.js";
import { calculateLocalMfsPathForCommentUpdate, updateCommentsThatNeedToBeUpdated } from "./local-community/comment-updates.js";
import { purgeDisapprovedCommentsOlderThan } from "./local-community/cleanup.js";
import {
    addOldPageCidsToCidsToUnpin,
    calculateLatestUpdateTrigger,
    calculateNewPostUpdates,
    resolveIpnsAndLogIfPotentialProblematicSequence,
    shouldResolveDomainForVerification,
    updateCommunityIpnsIfNeeded
} from "./local-community/ipns-publishing.js";
import { deleteCommunity, start as lifecycleStart, stop as lifecycleStop, update as lifecycleUpdate } from "./local-community/lifecycle.js";
import { edit as editCommunity } from "./local-community/editing.js";
import {
    cancelExportEmbedded,
    cloneExportRecord,
    deleteExportRecord,
    exportCommunityEmbedded,
    loadAndPruneExportsFromKeyv
} from "./local-community/export.js";
import type { InternalExportHandle } from "./local-community/export.js";
import type { CommunityExportRecord, ExportCommunityUserOptions, ExportCommunityModLogsOptions } from "../../../community/types.js";
import type { CommentModerationTableRow } from "../../../publications/comment-moderation/types.js";

// This is a sub we have locally in our pkc datapath, in a NodeJS environment
export class LocalCommunity extends RpcLocalCommunity implements CreateNewLocalCommunityParsedOptions {
    override signer!: SignerWithPublicKeyAddress;
    override raw: RpcLocalCommunity["raw"] = {};
    _postUpdatesBuckets = [86400, 604800, 2592000, 3153600000]; // 1 day, 1 week, 1 month, 100 years. Expecting to be sorted from smallest to largest

    _defaultCommunityChallenges: CommunityChallengeSetting[] = generateDefaultChallenges();

    // These caches below will be used to facilitate challenges exchange with authors, they will expire after 10 minutes
    // Most of the time they will be delete and cleaned up automatically
    _challengeAnswerPromises!: LRUCache<string, Promise<DecryptedChallengeAnswer["challengeAnswers"]>>;
    _challengeAnswerResolveReject!: LRUCache<
        string,
        { resolve: (answers: DecryptedChallengeAnswer["challengeAnswers"]) => void; reject: (error: Error) => void }
    >;
    _ongoingChallengeExchanges!: LRUCache<string, boolean>;
    _duplicatePublicationAttempts!: LRUCache<string, number>;
    _challengeExchangesFromLocalPublishers: Record<string, boolean> = {}; // key is stringified challengeRequestId and value is true if the challenge exchange is ongoing

    _cidsToUnPin: Set<string> = new Set<string>();
    _mfsPathsToRemove: Set<string> = new Set<string>();
    _communityUpdateTrigger: boolean = false;
    _combinedHashOfPendingCommentsCids: string = sha256("");

    _pageGenerator!: PageGenerator;
    _dbHandler!: DbHandler;
    _stopHasBeenCalled: boolean; // we use this to track if community.stop() has been called after community.start() or community.update()
    _publishLoopPromise?: Promise<void> = undefined;
    _updateLoopPromise?: Promise<void> = undefined;
    _updateLoopAbortController?: AbortController;
    _firstUpdateAfterStart: boolean = true;
    _internalStateUpdateId: InternalCommunityRecordBeforeFirstUpdateType["_internalStateUpdateId"] = "";
    _lastPubsubTopicRoutingProvideAt?: number = undefined;
    // The challenge exchange topic we last subscribed to. pubsubTopic can change while the community is
    // started, and the kubo node is shared with other communities, so this is the only safe way to know
    // which subscription is ours to drop (see listenToIncomingRequests).
    _subscribedChallengePubsubTopic?: string = undefined;
    // Browser-dialable (WSS/WebRTC) self-addresses last announced for the connection-critical CIDs.
    // When this set changes (checked once per publish-loop cycle, throttled) we re-provide so HTTP routers
    // stop serving stale addresses (see reprovide-on-address-change.ts).
    _lastProvidedBrowserDialableSelfAddrs?: string[] = undefined;
    _lastAddressReprovideCheckAt?: number = undefined;
    _mirroredStartedOrUpdatingCommunity?: { community: LocalCommunity } & Pick<
        CommunityEvents,
        | "error"
        | "updatingstatechange"
        | "update"
        | "statechange"
        | "startedstatechange"
        | "challengerequest"
        | "challengeverification"
        | "challenge"
        | "challengeanswer"
    > = undefined; // The pkc._startedCommunities we're subscribed to
    _pendingEditProps: Partial<ParsedCommunityEditOptions & { editId: string }>[] = [];
    _blocksToRm: string[] = [];
    _postsAllPageCids: AllPageCids | undefined = undefined;

    // Community export (issue #79). _exports is the public list surfaced through
    // `community.exports`; _activeExports tracks in-flight backups so pkc.destroy() can cancel
    // them; _exportQueue serializes back-to-back exports on the same community per spec.
    _exports: CommunityExportRecord[] = [];
    _activeExports: Map<string, InternalExportHandle> = new Map();
    _exportQueue: Promise<void> = Promise.resolve();

    constructor(pkc: PKC) {
        super(pkc);
        this.handleChallengeExchange = this.handleChallengeExchange.bind(this);
        this._setState("stopped");
        this.started = false;
        this._stopHasBeenCalled = false;

        // need to make sure these props are undefined on the constructor level, so they wouldn't show while logging

        //@ts-expect-error
        this._pageGenerator = undefined;
        //@ts-expect-error
        this._challengeAnswerPromises = undefined;
        //@ts-expect-error
        this._challengeAnswerResolveReject = undefined;
        //@ts-expect-error
        this._ongoingChallengeExchanges = undefined;
        //@ts-expect-error
        this._duplicatePublicationAttempts = undefined;
        //@ts-expect-error
        this._internalStateUpdateId = undefined;

        //@ts-expect-error
        this._dbHandler = undefined;

        hideClassPrivateProps(this);
    }

    // This will be stored in DB and also shared between instances via _updateInstancePropsWithStartedCommunityOrDb.
    // Must NOT convert posts to CID-ref format here — that's only for DB storage (done in _updateDbInternalState).
    // CID-ref conversion strips preloaded page data which breaks reply CommentUpdate resolution
    // when other instances read the shared state.
    toJSONInternalAfterFirstUpdate(): InternalCommunityRecordAfterFirstUpdateType {
        const rpcJson = this.toJSONInternalRpcAfterFirstUpdate();
        return {
            ...rpcJson.community,
            ...omit(rpcJson.localCommunity, ["started", "startedState"]),
            updateCid: rpcJson.runtimeFields.updateCid,
            signer: pick(this.signer, ["privateKey", "type", "address", "shortAddress", "publicKey"]),
            _internalStateUpdateId: this._internalStateUpdateId,
            _cidsToUnPin: [...this._cidsToUnPin],
            _mfsPathsToRemove: [...this._mfsPathsToRemove],
            _pendingEditProps: this._pendingEditProps,
            // rpcJson.community is the published record, which omits pubsubTopic entirely while
            // settings.disablePubsubChallengeExchange is on (issue #229). Carry the configured topic
            // separately so reloading internal state, in this process or after a restart, does not
            // silently replace it with the signer-address default the next record would fall back to.
            _configuredPubsubTopic: this.pubsubTopic
        };
    }

    toJSONInternalBeforeFirstUpdate(): InternalCommunityRecordBeforeFirstUpdateType {
        const rpcJson = this.toJSONInternalRpcBeforeFirstUpdate();
        return {
            ...omit(rpcJson.localCommunity, ["started", "startedState"]),
            signer: pick(this.signer, ["privateKey", "type", "address", "shortAddress", "publicKey"]),
            _internalStateUpdateId: this._internalStateUpdateId,
            _pendingEditProps: this._pendingEditProps
        };
    }

    override toJSONInternalRpcAfterFirstUpdate(): RpcInternalCommunityRecordAfterFirstUpdateType {
        const base = super.toJSONInternalRpcAfterFirstUpdate();
        return {
            ...base,
            localCommunity: {
                ...base.localCommunity,
                signer: pick(this.signer, ["publicKey", "address", "shortAddress", "type"])
            }
        };
    }

    override toJSONInternalRpcBeforeFirstUpdate(): RpcInternalCommunityRecordBeforeFirstUpdateType {
        const base = super.toJSONInternalRpcBeforeFirstUpdate();
        return {
            localCommunity: {
                ...base.localCommunity,
                signer: pick(this.signer, ["publicKey", "address", "shortAddress", "type"])
            }
        };
    }

    // A publisher never resolves itself, so unlike a reader it always mints under its own key: the
    // record it publishes lives at signer.address, and so do its ipns-over-pubsub topic and that
    // topic's routing CID. The inherited implementation prefers ipnsHops[0], which is correct for a
    // reader and wrong here — on a delegated community it would move this node's own record topic to
    // the anchor, whose record is signed by a key this node does not have. Overriding once covers
    // every init path (see db-state.ts). #234 adds the anchor's topic as a second subscription
    // instead of moving this one. See docs/protocol/delegated-ipns.md.
    override _updateIpnsPubsubPropsIfNeeded(_newProps: Parameters<RpcLocalCommunity["_updateIpnsPubsubPropsIfNeeded"]>[0]) {
        if (!this.signer?.address) return;
        this.ipnsName = this.signer.address;
        this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
        this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
    }

    async _updateStartedValue() {
        this.started = await this._dbHandler.isCommunityStartLocked(this.address);
    }

    async initNewLocalCommunityPropsNoMerge(newProps: CreateNewLocalCommunityParsedOptions) {
        return initNewLocalCommunityPropsNoMerge(this, newProps);
    }

    async initInternalCommunityAfterFirstUpdateNoMerge(newProps: InternalCommunityRecordAfterFirstUpdateType) {
        return initInternalCommunityAfterFirstUpdateNoMerge(this, newProps);
    }

    async initInternalCommunityBeforeFirstUpdateNoMerge(newProps: InternalCommunityRecordBeforeFirstUpdateType) {
        return initInternalCommunityBeforeFirstUpdateNoMerge(this, newProps);
    }

    async initDbHandlerIfNeeded() {
        return initDbHandlerIfNeeded(this);
    }

    async _validateCommunitySizeSchemaAndSignatureBeforePublishing(recordToPublishRaw: CommunityIpfsType) {
        const log = Logger("pkc-js:local-community:_validateCommunitySchemaAndSignatureBeforePublishing");

        const stringifiedNewCommunityRecord = deterministicStringify(recordToPublishRaw);
        const calculatedSizeOfNewCommunityRecord = await calculateStringSizeSameAsIpfsAddCidV0(stringifiedNewCommunityRecord);

        // Check if the community record size is less than 1MB
        if (calculatedSizeOfNewCommunityRecord > MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS) {
            const error = new PKCError("ERR_LOCAL_COMMUNITY_RECORD_TOO_LARGE", {
                calculatedSizeOfNewCommunityRecord,
                maxSize: MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS,
                recordToPublishRaw,
                address: this.address
            });
            log.error(
                `Local community (${this.address}) produced a record that is too large (${calculatedSizeOfNewCommunityRecord.toFixed(2)} bytes). Maximum size is ${MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS} bytes.`,
                error
            );
            throw error;
        }

        const parseRes = CommunityIpfsSchema.safeParse(recordToPublishRaw);
        if (!parseRes.success) {
            const error = new PKCError("ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SCHEMA", {
                invalidRecord: recordToPublishRaw,
                err: parseRes.error
            });
            log.error(`Local community (${this.address}) produced an invalid CommunityIpfs schema`, error);
            throw error;
        }

        const verificationOpts = {
            community: recordToPublishRaw,
            // The record we are about to publish is signed by our own key, which on a delegated
            // community is the minter, not the identity. This mirrors the read side, which verifies
            // content against ipnsHops.at(-1). See docs/protocol/delegated-ipns.md.
            communityIpnsName: this.signer.address,
            resolveAuthorNames: false,
            clientsManager: this._clientsManager,
            validatePages: true,
            cacheIfValid: false
        };
        try {
            const validation = await verifyCommunity(verificationOpts);
            if (!validation.valid) {
                throw new PKCError("ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE", {
                    validation,
                    verificationOpts
                });
            }
        } catch (e) {
            log.error(`Local community (${this.address}) produced an invalid signature`, e);
            throw e;
        }

        verificationOpts.community = JSON.parse(stringifiedNewCommunityRecord); // let's stringify and parse again to make sure we're not using any invalid data
        try {
            const validation = await verifyCommunity(verificationOpts);
            if (!validation.valid) {
                throw new PKCError("ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE", {
                    validation,
                    verificationOpts
                });
            }
        } catch (e) {
            log.error(
                `Local community (${this.address}) produced an invalid signature after stringifying and parsing again. This is a critical bug.`,
                e
            );
            throw e;
        }

        if (this.shouldResolveDomainForVerification()) {
            try {
                log(`Resolving domain ${this.address} to make sure it's the same as ${communityIdentityPublicKey(this)}`);
                await this._assertDomainResolvesCorrectly(this.address);
            } catch (e) {
                log.error(e);
                this.emit("error", e as PKCError);
            }
        }
    }

    async handleChallengeRequest(request: ChallengeRequestMessageType, isLocalPublisher: boolean) {
        return handleChallengeRequestFreeFunction(this, request, isLocalPublisher);
    }

    async handleChallengeAnswer(challengeAnswer: ChallengeAnswerMessageType) {
        return handleChallengeAnswerFreeFunction(this, challengeAnswer);
    }

    async handleChallengeExchange(pubsubMsg: IpfsHttpClientPubsubMessage) {
        return handleChallengeExchangeFreeFunction(this, pubsubMsg);
    }

    async _addCommentRowToIPFS(unpinnedCommentRow: CommentsTableRow, log: Logger) {
        const ipfsClient = this._clientsManager.getDefaultKuboRpcClient();

        const finalCommentIpfsJson = deriveCommentIpfsFromCommentTableRow(unpinnedCommentRow);
        const commentIpfsContent = deterministicStringify(finalCommentIpfsJson);
        const contentHash: string = await calculateIpfsHash(commentIpfsContent);
        if (contentHash !== unpinnedCommentRow.cid) {
            throw Error("Unable to recreate the CommentIpfs. This is a critical error");
        }

        const addRes = await retryKuboIpfsAddAndProvide({
            ipfsClient: ipfsClient._client,
            log,
            content: commentIpfsContent,
            addOptions: { pin: true },
            provideOptions: { recursive: true },
            provideInBackground: false
        });
        if (addRes.path !== unpinnedCommentRow.cid) throw Error("Unable to recreate the CommentIpfs. This is a critical error");
        log.trace("Pinned comment", unpinnedCommentRow.cid, "of community", this.address, "to IPFS node");
    }

    async _assertDomainResolvesCorrectly(newAddressAsDomain: string) {
        if (isStringDomain(newAddressAsDomain)) {
            const resolvedIpnsFromNewDomain = await this._clientsManager.resolveCommunityNameIfNeeded({
                communityName: newAddressAsDomain,
                // Admin domain edits don't need second-fresh data.
                cache: { maxAge: 600 }
            });
            // A domain's TXT record points at the name readers resolve, which on a delegated community
            // is the anchor and not the minter we sign with. Comparing against signer.address here
            // would make a correctly configured delegated community reject its own domain.
            const identityPublicKey = communityIdentityPublicKey(this);
            if (resolvedIpnsFromNewDomain !== identityPublicKey)
                throw new PKCError("ERR_DOMAIN_COMMUNITY_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS", {
                    currentCommunityAddress: this.address,
                    newAddressAsDomain,
                    resolvedIpnsFromNewDomain,
                    identityPublicKey,
                    signerAddress: this.signer.address,
                    started: this.started
                });
        }
    }

    override async start() {
        return lifecycleStart(this);
    }

    override async update() {
        return lifecycleUpdate(this);
    }

    override async stop() {
        return lifecycleStop(this);
    }

    override async delete() {
        return deleteCommunity(this);
    }

    override async edit(newCommunityOptions: CommunityEditOptions): Promise<typeof this> {
        return (await editCommunity(this, newCommunityOptions)) as typeof this;
    }

    override get exports(): CommunityExportRecord[] {
        return this._exports.map(cloneExportRecord);
    }

    override async export(options?: ExportCommunityUserOptions): Promise<{ exportId: string }> {
        return exportCommunityEmbedded(this, options);
    }

    override async exportCommunityModLogs(opts?: ExportCommunityModLogsOptions): Promise<{ moderations: CommentModerationTableRow[] }> {
        await this.initDbHandlerIfNeeded(); // create the handler if missing (never-started community)
        await this._dbHandler.initDbIfNeeded(); // re-open the connection if a prior stop() closed it
        try {
            return { moderations: this._dbHandler.queryAllCommentModerations(opts) };
        } finally {
            // Don't leave a DB connection open on a community that isn't running.
            if (this.state === "stopped") this._dbHandler.destoryConnection();
        }
    }

    async _cancelExport(exportId: string): Promise<void> {
        return cancelExportEmbedded(this, exportId);
    }

    async _deleteExport(exportId: string): Promise<void> {
        return deleteExportRecord(this, exportId);
    }

    async _loadExportsFromKeyv(): Promise<void> {
        return loadAndPruneExportsFromKeyv(this);
    }

    // The three helpers below stay as methods (in addition to being free functions in their
    // respective modules) because integration tests in test/node/community/ monkey-patch
    // community._xxx = async () => { throw ... } to inject failures into the start/publish
    // loops. Production callers in lifecycle.ts/db-state.ts/etc. go through these methods
    // (not the bare imports) so the patches still take effect.
    async _getDbInternalState(includeMutable: boolean = false) {
        return getDbInternalState(this, includeMutable);
    }

    async _listenToIncomingRequests() {
        return listenToIncomingRequests(this);
    }

    async _repinCommentsIPFSIfNeeded() {
        return repinCommentsIPFSIfNeeded(this);
    }

    // Kept as a method (in addition to the free function) because the pseudonymityMode
    // integration tests in test/node/community/features/ invoke it directly on the
    // community instance to set up parent comments. Not on master's public API surface,
    // but treated as one by those tests.
    async storePublication(request: DecryptedChallengeRequestMessageType, pendingApproval?: boolean) {
        return storePublication(this, request, pendingApproval);
    }

    // Method facades for helpers stubbed/called as methods by garbage.collection and
    // start.community integration tests. Internal production callers in lifecycle.ts
    // and the facade above go through these methods (not the bare imports) so test
    // stubs intercept correctly.
    async updateCommunityIpnsIfNeeded(args: { commentUpdateRowsToPublishToIpfs: Parameters<typeof updateCommunityIpnsIfNeeded>[1] }) {
        return updateCommunityIpnsIfNeeded(this, args.commentUpdateRowsToPublishToIpfs);
    }

    async _addOldPageCidsToCidsToUnpin(
        curPages: Parameters<typeof addOldPageCidsToCidsToUnpin>[1],
        newPages: Parameters<typeof addOldPageCidsToCidsToUnpin>[2],
        addToBlockRm?: boolean
    ) {
        return addOldPageCidsToCidsToUnpin(this, curPages, newPages, addToBlockRm);
    }

    private shouldResolveDomainForVerification() {
        return shouldResolveDomainForVerification(this);
    }

    // Method facades for helpers stubbed by the garbage.collection.community test's
    // mock community (it relies on these being instance methods for vi.fn() overrides).
    // Production callers in ipns-publishing.ts/lifecycle.ts/editing.ts go through the
    // methods so the stubs intercept.
    async _calculateNewPostUpdates() {
        return calculateNewPostUpdates(this);
    }

    _calculateLatestUpdateTrigger() {
        return calculateLatestUpdateTrigger(this);
    }

    async _resolveIpnsAndLogIfPotentialProblematicSequence() {
        return resolveIpnsAndLogIfPotentialProblematicSequence(this);
    }

    async _updateDbInternalState(props: Parameters<typeof updateDbInternalState>[1]) {
        return updateDbInternalState(this, props);
    }

    // Method facades for additional private helpers that integration tests
    // (unique.publishing, purge.expire.rejection, edgecases.page.generation)
    // invoke directly on the instance via `(ctx.community as LocalCommunity)._foo(...)`.
    async _updateCommentsThatNeedToBeUpdated() {
        return updateCommentsThatNeedToBeUpdated(this);
    }

    async _purgeDisapprovedCommentsOlderThan() {
        return purgeDisapprovedCommentsOlderThan(this);
    }

    async _publishChallengeVerification(
        challengeResult: Parameters<typeof publishChallengeVerification>[1],
        request: Parameters<typeof publishChallengeVerification>[2]
    ) {
        return publishChallengeVerification(this, challengeResult, request);
    }

    async _publishIdempotentDuplicateVerification(
        ...args: Parameters<typeof publishIdempotentDuplicateVerification> extends [unknown, ...infer Rest] ? Rest : never
    ) {
        return publishIdempotentDuplicateVerification(this, ...args);
    }

    async _checkPublicationValidity(...args: Parameters<typeof checkPublicationValidity> extends [unknown, ...infer Rest] ? Rest : never) {
        return checkPublicationValidity(this, ...args);
    }

    _calculateLocalMfsPathForCommentUpdate(
        ...args: Parameters<typeof calculateLocalMfsPathForCommentUpdate> extends [unknown, ...infer Rest] ? Rest : never
    ) {
        return calculateLocalMfsPathForCommentUpdate(this, ...args);
    }
}
