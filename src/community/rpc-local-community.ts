import Logger from "../logger.js";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import type {
    AnchorPublishPreparation,
    PublishedAnchorRecord,
    RpcInternalCommunityRecordAfterFirstUpdateType,
    RpcInternalCommunityRecordBeforeFirstUpdateType,
    RpcLocalCommunityLocalProps,
    RpcLocalCommunityUpdateResultType,
    CommunityEditOptions,
    CommunityExportRecord,
    CommunityIpfsType,
    CommunityStartedState,
    ExportCommunityUserOptions,
    ExportCommunityModLogsOptions
} from "./types.js";
import type { CommentModerationTableRow } from "../publications/comment-moderation/types.js";
import { RpcRemoteCommunity } from "./rpc-remote-community.js";
import { z } from "zod";
import { messages } from "../errors.js";
import { keys, pick } from "remeda";
import { PKC } from "../pkc/pkc.js";
import { PKCError } from "../pkc-error.js";

import { CommunityEditOptionsSchema } from "./schema.js";
import {
    decodeRpcChallengeAnswerPubsubMsg,
    decodeRpcChallengePubsubMsg,
    decodeRpcChallengeRequestPubsubMsg,
    decodeRpcChallengeVerificationPubsubMsg
} from "../clients/rpc-client/decode-rpc-response-util.js";
import { SubscriptionIdSchema } from "../clients/rpc-client/schema.js";
import type {
    EncodedDecryptedChallengeAnswerMessageType,
    EncodedDecryptedChallengeMessageType,
    EncodedDecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    EncodedDecryptedChallengeVerificationMessageType
} from "../pubsub-messages/types.js";
import { deepMergeRuntimeFields, hideClassPrivateProps } from "../util.js";
import { findStartedCommunity, trackStartedCommunity, untrackStartedCommunity } from "../pkc/tracked-instance-registry-util.js";

// Shallow clone preserving the nested error object so consumers can mutate without
// affecting cached state. Local copy because `local-community/export.ts` is node-only and
// RpcLocalCommunity must work in the browser.
function cloneExportRecord(record: CommunityExportRecord): CommunityExportRecord {
    return { ...record, ...(record.error ? { error: { ...record.error } } : {}) };
}

// This class is for communities that are running and publishing, over RPC. Can be used for both browser and node
export class RpcLocalCommunity extends RpcRemoteCommunity {
    override started: boolean; // Is the community started and running? This is not specific to this instance, and applies to all instances of community with this address
    override startedState!: CommunityStartedState;
    override signer!: RpcLocalCommunityLocalProps["signer"];
    // Set only on a delegated community, where signer above is the minter (Mn) and this is the
    // anchor (An) the community is addressed by. Since #257 this is also a signed wire field on the
    // record itself (declared on RemoteCommunity); on a local community it exists before the first
    // record is minted. See docs/protocol/delegated-ipns.md.
    override anchor?: RpcLocalCommunityLocalProps["anchor"];
    // Highest anchor sequence this community's node has accepted. Undefined on a delegated community
    // means no anchor record has ever been published for it, which is exactly when the owner signs
    // sequence 0 rather than asking prepareAnchorPublish (which refuses to guess). It also means the
    // community is not resolvable yet and will refuse to start. See docs/protocol/delegated-ipns.md.
    anchorRecordSequence?: RpcLocalCommunityLocalProps["anchorRecordSequence"];
    override settings!: RpcLocalCommunityLocalProps["settings"];
    override editable!: Pick<RpcLocalCommunity, keyof CommunityEditOptions>;

    // mandating props
    override challenges!: CommunityIpfsType["challenges"];
    override encryption!: CommunityIpfsType["encryption"];
    override createdAt!: CommunityIpfsType["createdAt"];
    override protocolVersion!: CommunityIpfsType["protocolVersion"];

    override raw: {
        communityIpfs?: CommunityIpfsType;
        runtimeFieldsFromRpc?: Record<string, any>;
        localCommunity?: RpcLocalCommunityUpdateResultType;
    } = {};

    // Private stuff
    private _startRpcSubscriptionId?: z.infer<typeof SubscriptionIdSchema> = undefined;
    _usingDefaultChallenge!: RpcLocalCommunityLocalProps["_usingDefaultChallenge"];

    // community.export() over RPC. The subscription is attached eagerly during createCommunity
    // so consumers see prior exports (including ones still in flight from earlier client sessions)
    // immediately, without having to call community.export() first.
    private _exportsSubscriptionId?: number = undefined;
    private _exportsCache: CommunityExportRecord[] = [];
    // exportId → detach AbortSignal listener. Cleared when the export reaches a terminal state.
    private _exportSignalDetachers: Map<string, () => void> = new Map();

    constructor(pkc: PKC) {
        super(pkc);
        this.started = false;
        //@ts-expect-error
        this._usingDefaultChallenge = undefined;
        this.start = this.start.bind(this);
        this.edit = this.edit.bind(this);
        this._setStartedStateWithEmission("stopped");
        this.on("update", () => {
            this.editable = pick(this, keys(CommunityEditOptionsSchema.shape)) as Pick<RpcLocalCommunity, keyof CommunityEditOptions>;
        });
        hideClassPrivateProps(this);
    }

    toJSONInternalRpcAfterFirstUpdate(): RpcInternalCommunityRecordAfterFirstUpdateType {
        if (!this.updateCid) throw Error("rpcLocalCommunity.cid should be defined before calling toJSONInternalRpcAfterFirstUpdate");
        return {
            community: this.raw.communityIpfs!,
            localCommunity: {
                signer: this.signer,
                anchor: this.anchor,
                anchorRecordSequence: this.anchorRecordSequence,
                settings: this.settings,
                _usingDefaultChallenge: this._usingDefaultChallenge,
                address: this.address,
                started: this.started,
                startedState: this.startedState
            },
            runtimeFields: {
                updateCid: this.updateCid,
                updatingState: this.updatingState,
                nameResolved: this.nameResolved
            }
        };
    }

    toJSONInternalRpcBeforeFirstUpdate(): RpcInternalCommunityRecordBeforeFirstUpdateType {
        if (!this.settings) throw Error("Attempting to transmit InternalRpc record without defining settings");
        return {
            localCommunity: {
                ...this._toJSONIpfsBaseNoPosts(),
                address: this.address,
                signer: this.signer,
                anchor: this.anchor,
                anchorRecordSequence: this.anchorRecordSequence,
                settings: this.settings,
                _usingDefaultChallenge: this._usingDefaultChallenge,
                started: this.started,
                startedState: this.startedState
            }
        };
    }

    // A delegated community's identity is its anchor, never the minter that signs its records. Both
    // initRemoteCommunityPropsNoMerge and initCommunityIpfsPropsNoMerge derive publicKey/ipnsName from
    // signature.publicKey unless ipnsHops[0] is already known, so the chain has to be replayed BEFORE
    // either of them runs. See docs/protocol/delegated-ipns.md.
    private _replayAnchorIntoIpnsHops(localProps: RpcLocalCommunityLocalProps) {
        this.anchor = localProps.anchor;
        this.anchorRecordSequence = localProps.anchorRecordSequence;
        if (localProps.anchor) this.ipnsHops = [localProps.anchor.publicKey, localProps.signer.address];
    }

    initRpcInternalCommunityBeforeFirstUpdateNoMerge(newProps: RpcInternalCommunityRecordBeforeFirstUpdateType) {
        this._replayAnchorIntoIpnsHops(newProps.localCommunity);
        this.initRemoteCommunityPropsNoMerge(newProps.localCommunity);
        // Apply address from localCommunity — may differ after edit (same as afterFirstUpdate variant)
        if (newProps.localCommunity.address) this.setAddress(newProps.localCommunity.address);
        this.signer = newProps.localCommunity.signer;
        this.settings = newProps.localCommunity.settings;
        this._usingDefaultChallenge = newProps.localCommunity._usingDefaultChallenge;
        this.started = newProps.localCommunity.started;
        this.raw.localCommunity = newProps;
    }

    initRpcInternalCommunityAfterFirstUpdateNoMerge(newProps: RpcInternalCommunityRecordAfterFirstUpdateType) {
        this._replayAnchorIntoIpnsHops(newProps.localCommunity);
        super.initCommunityIpfsPropsNoMerge(newProps.community);
        // Apply address from localCommunity — may differ from community record's name (e.g. .bso/.eth before ENS propagation)
        if (newProps.localCommunity.address) this.setAddress(newProps.localCommunity.address);

        this.signer = newProps.localCommunity.signer;
        this.settings = newProps.localCommunity.settings;
        this._usingDefaultChallenge = newProps.localCommunity._usingDefaultChallenge;
        this.started = newProps.localCommunity.started;
        this.updateCid = newProps.runtimeFields.updateCid;
        this.raw.localCommunity = newProps;
        this.editable = pick(this, keys(CommunityEditOptionsSchema.shape)) as Pick<RpcLocalCommunity, keyof CommunityEditOptions>;
    }

    protected _updateRpcClientStateFromStartedState(startedState: RpcLocalCommunity["startedState"]) {
        const mapper: Record<RpcLocalCommunity["startedState"], RpcLocalCommunity["clients"]["pkcRpcClients"][0]["state"][]> = {
            failed: ["stopped"],
            "publishing-ipns": ["publishing-ipns"],
            stopped: ["stopped"],
            succeeded: ["stopped"]
        };

        const newClientState = mapper[startedState] || [startedState]; // in case rpc server transmits a startedState we don't know about, default to startedState

        newClientState.forEach(this._setRpcClientStateWithEmission.bind(this));
    }

    protected override _processUpdateEventFromRpcUpdate(args: any) {
        // This function is gonna be called with every update event from rpcLocalCommunity.update()
        const log = Logger("pkc-js:rpc-local-community:_processUpdateEventFromRpcUpdate");
        log("Received an update event from rpc within rpcLocalCommunity.update for community " + this.address);

        const updateRecord: RpcLocalCommunityUpdateResultType = args.params.result; // we're being optimistic here and hoping the rpc server sent the correct update
        if ("community" in updateRecord) this.initRpcInternalCommunityAfterFirstUpdateNoMerge(updateRecord);
        else this.initRpcInternalCommunityBeforeFirstUpdateNoMerge(updateRecord);

        const runtimeFields = "runtimeFields" in updateRecord ? updateRecord.runtimeFields : undefined;
        if (runtimeFields) {
            this.raw.runtimeFieldsFromRpc = runtimeFields;
            deepMergeRuntimeFields(this, runtimeFields);
        }

        if (updateRecord.localCommunity.startedState) this._setStartedStateNoEmission(updateRecord.localCommunity.startedState);
        this.emit("update", this);
    }

    private _handleRpcUpdateEventFromStart(args: any) {
        // This function is gonna be called with every update event from rpcLocalCommunity.start()

        const log = Logger("pkc-js:rpc-local-community:_handleRpcUpdateEventFromStart");
        const updateRecord: RpcLocalCommunityUpdateResultType = args.params.result;
        log("Received an update event from rpc within rpcLocalCommunity.start for community " + this.address);

        if ("community" in updateRecord) {
            this.initRpcInternalCommunityAfterFirstUpdateNoMerge(updateRecord);
        } else this.initRpcInternalCommunityBeforeFirstUpdateNoMerge(updateRecord);

        const runtimeFields = "runtimeFields" in updateRecord ? updateRecord.runtimeFields : undefined;
        if (runtimeFields) {
            this.raw.runtimeFieldsFromRpc = runtimeFields;
            deepMergeRuntimeFields(this, runtimeFields);
        }

        if (updateRecord.localCommunity.startedState) {
            this._setStartedStateNoEmission(updateRecord.localCommunity.startedState);
        }
        this.emit("update", this);
    }

    private _handleRpcStartedStateChangeEvent(args: any) {
        const log = Logger("pkc-js:rpc-local-community:_handleRpcStartedStateChangeEvent");

        const newStartedState: RpcLocalCommunity["startedState"] = args.params.result.state; // we're being optimistic that the rpc server transmitted a valid string here
        log("Received a startedstatechange for community " + this.address, "new started state is", newStartedState);

        if (newStartedState !== this.startedState) this._setStartedStateWithEmission(newStartedState);
        else this.emit("startedstatechange", newStartedState);

        this._updateRpcClientStateFromStartedState(newStartedState);
    }

    private _handleRpcChallengeRequestEvent(args: any) {
        const encodedRequest: EncodedDecryptedChallengeRequestMessageTypeWithCommunityAuthor = args.params.result;
        const request = decodeRpcChallengeRequestPubsubMsg(encodedRequest);
        this._setRpcClientStateWithEmission("waiting-challenge-requests");
        this.emit("challengerequest", request);
    }

    private _handleRpcChallengeEvent(args: any) {
        const encodedChallenge: EncodedDecryptedChallengeMessageType = args.params.result;
        const challenge = decodeRpcChallengePubsubMsg(encodedChallenge);

        this._setRpcClientStateWithEmission("publishing-challenge");
        this.emit("challenge", challenge);
        this._setRpcClientStateWithEmission("waiting-challenge-answers");
    }

    private _handleRpcChallengeAnswerEvent(args: any) {
        const encodedChallengeAnswer: EncodedDecryptedChallengeAnswerMessageType = args.params.result;

        const challengeAnswer = decodeRpcChallengeAnswerPubsubMsg(encodedChallengeAnswer);
        this.emit("challengeanswer", challengeAnswer);
    }

    private _handleRpcChallengeVerificationEvent(args: any) {
        const { challengeVerification: encodedChallengeVerification } = args.params.result;

        const challengeVerification = decodeRpcChallengeVerificationPubsubMsg(encodedChallengeVerification);
        this._setRpcClientStateWithEmission("publishing-challenge-verification");
        this.emit("challengeverification", challengeVerification);
        this._setRpcClientStateWithEmission("waiting-challenge-requests");
    }

    override async start() {
        const log = Logger("pkc-js:rpc-local-community:start");
        if (this.state === "updating") throw new PKCError("ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING", { address: this.address });
        // we can't start the same instance multiple times
        if (typeof this._startRpcSubscriptionId === "number")
            throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { communityAddress: this.address });

        if (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }))
            throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE", { communityAddress: this.address });
        try {
            const { subscriptionId } = await this._pkc._pkcRpcClient!.startCommunity({ name: this.name, publicKey: this.publicKey });
            this._startRpcSubscriptionId = subscriptionId;
            this._setState("started");
        } catch (e) {
            log.error(`Failed to start community (${this.address}) from RPC due to error`, e);
            this._setState("stopped");
            this._setStartedStateWithEmission("failed");
            throw e;
        }
        trackStartedCommunity(this._pkc, this);
        this.started = true;
        const subscriptionId = this._startRpcSubscriptionId;
        // Deferred so a listener attached synchronously after `await start()` resolves still
        // receives events the server emitted before the startCommunity response (#314); see
        // attachSubscriptionHandlersDeferred for the mechanism. The exports subscription below
        // deliberately keeps its synchronous replay and must NOT be migrated to this helper.
        this._pkc._pkcRpcClient!.attachSubscriptionHandlersDeferred({
            subscriptionId,
            isStale: () => this._startRpcSubscriptionId !== subscriptionId,
            attach: (subscription) =>
                subscription
                    .on("update", this._handleRpcUpdateEventFromStart.bind(this))
                    .on("startedstatechange", this._handleRpcStartedStateChangeEvent.bind(this))
                    .on("challengerequest", this._handleRpcChallengeRequestEvent.bind(this))
                    .on("challenge", this._handleRpcChallengeEvent.bind(this))
                    .on("challengeanswer", this._handleRpcChallengeAnswerEvent.bind(this))
                    .on("challengeverification", this._handleRpcChallengeVerificationEvent.bind(this))
                    .on("error", this._handleRpcErrorEvent.bind(this)),
            // Pre-deferral a replay throw rejected start(); the helper contains it (log, surface
            // as an "error" event, stop)
            replayErrorContainment: {
                entityName: "community",
                log,
                emitError: (error) => this.emit("error", error),
                // Client-local teardown only: full stop() would issue a stopCommunity RPC and halt
                // the community for every connected client, escalating a local replay throw
                // node-wide (pre-deferral it was a catchable, client-local start() rejection)
                stop: () => this.stopWithoutRpcCall()
            }
        });
    }

    // stop() pre-captures the subscription id before its awaited stopCommunity round trip and
    // passes it here; every other caller lets the default read it
    private async _cleanUpRpcConnection(log: Logger, subscriptionId: number | undefined = this._startRpcSubscriptionId) {
        // Cleared synchronously before the awaited unsubscribe so the deferred attach-and-replay
        // timer from start() (#314) sees the teardown immediately
        this._startRpcSubscriptionId = undefined;
        if (subscriptionId) {
            try {
                await this._pkc._pkcRpcClient!.unsubscribe(subscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from communityStart", e);
            }
        }
        this._setStartedStateWithEmission("stopped");
        this._setRpcClientStateWithEmission("stopped");
        this.started = false;
        log(`Stopped the running of local community (${this.address}) via RPC`);
        this._setState("stopped");
    }

    async stopWithoutRpcCall() {
        const log = Logger("pkc-js:rpc-local-community:stop");
        await this._cleanUpRpcConnection(log);
        this.posts._stop();
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
        this._setRpcClientStateWithEmission("stopped");
        this.started = false;
        untrackStartedCommunity(this._pkc, this);
    }

    // Delegation setup (#234), forwarded to the node running the community. The anchor's private key
    // stays here: prepareAnchorPublish sends nothing but this community's identifier, and
    // publishAnchorRecord sends bytes already signed on this side.
    async prepareAnchorPublish(): Promise<AnchorPublishPreparation> {
        return this._pkc._pkcRpcClient!.prepareAnchorPublish({ name: this.name, publicKey: this.publicKey });
    }

    async publishAnchorRecord(recordBytes: Uint8Array): Promise<PublishedAnchorRecord> {
        const result = await this._pkc._pkcRpcClient!.publishAnchorRecord({
            name: this.name,
            publicKey: this.publicKey,
            recordBase64: uint8ArrayToString(recordBytes, "base64")
        });
        this.anchorRecordSequence = result.sequence;
        return result;
    }

    override async stop() {
        this.posts._stop();
        if (this.state === "updating") {
            return super.stop();
        } else if (this.state === "started") {
            // Need to be careful not to stop an already running community
            const log = Logger("pkc-js:rpc-local-community:stop");
            // Capture and clear the subscription id synchronously before the awaited stopCommunity
            // round trip, so the deferred attach-and-replay timer from start() (#314) sees the stop
            // immediately instead of replaying buffered start notifications into a stopping
            // community mid-round-trip
            const subscriptionId = this._startRpcSubscriptionId;
            this._startRpcSubscriptionId = undefined;
            try {
                await this._pkc._pkcRpcClient!.stopCommunity({ name: this.name, publicKey: this.publicKey });
            } catch (e) {
                log.error("RPC client received an error when asking rpc server to stop community", e);
            }
            await this._cleanUpRpcConnection(log, subscriptionId);
            untrackStartedCommunity(this._pkc, this);
        }
    }

    override async edit(newCommunityOptions: CommunityEditOptions): Promise<typeof this> {
        if (newCommunityOptions.settings?.challenges) {
            const serverChallenges = this._pkc._pkcRpcClient!.settings?.challenges;
            if (serverChallenges) {
                for (const challengeSetting of newCommunityOptions.settings.challenges) {
                    if (challengeSetting.name && !challengeSetting.path && !(challengeSetting.name in serverChallenges)) {
                        throw new PKCError("ERR_RPC_CLIENT_CHALLENGE_NAME_NOT_AVAILABLE_ON_SERVER", {
                            challengeName: challengeSetting.name,
                            availableChallenges: Object.keys(serverChallenges)
                        });
                    }
                }
            }
        }
        const subPropsAfterEdit = await this._pkc._pkcRpcClient!.editCommunity({
            name: this.name,
            publicKey: this.publicKey,
            editOptions: newCommunityOptions
        });
        if ("community" in subPropsAfterEdit) this.initRpcInternalCommunityAfterFirstUpdateNoMerge(subPropsAfterEdit);
        else this.initRpcInternalCommunityBeforeFirstUpdateNoMerge(subPropsAfterEdit);
        this.emit("update", this);
        return this;
    }

    override async update() {
        if (this.state === "started") throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });

        return super.update();
    }

    // community.export() over RPC — see src/rpc/EXPORT_COMMUNITY_SPEC.md
    override get exports(): CommunityExportRecord[] {
        return this._exportsCache.map(cloneExportRecord);
    }

    override async export(options: ExportCommunityUserOptions = {}): Promise<{ exportId: string }> {
        // Sync validation — matches embedded path
        if (options.exportPath !== undefined) throw new PKCError("ERR_EXPORT_PATH_NOT_SUPPORTED_OVER_RPC", { address: this.address });
        if (options.signal?.aborted) {
            const reason = (options.signal as AbortSignal).reason;
            throw reason ?? new DOMException("The operation was aborted.", "AbortError");
        }

        const { exportId } = await this._pkc._pkcRpcClient!.exportCommunity({
            name: this.name,
            publicKey: this.publicKey,
            includePrivateKey: options.includePrivateKey
        });

        if (options.signal) {
            const userSignal = options.signal;
            const onAbort = () => {
                this._pkc._pkcRpcClient!.cancelExport({ exportId }).catch((e) => {
                    Logger("pkc-js:rpc-local-community:export").error("Failed to send cancelExport", exportId, e);
                });
            };
            // Aborted between sync validation and exportCommunity returning — route the cancel.
            if (userSignal.aborted) onAbort();
            else {
                userSignal.addEventListener("abort", onAbort, { once: true });
                this._exportSignalDetachers.set(exportId, () => userSignal.removeEventListener("abort", onAbort));
            }
        }
        return { exportId };
    }

    override async exportCommunityModLogs(opts?: ExportCommunityModLogsOptions): Promise<{ moderations: CommentModerationTableRow[] }> {
        return this._pkc._pkcRpcClient!.exportCommunityModLogs({ name: this.name, publicKey: this.publicKey, ...opts });
    }

    async _attachExportsSubscription(): Promise<void> {
        if (this._exportsSubscriptionId !== undefined) return;
        if (!this._pkc._pkcRpcClient) return; // not on an RPC PKC — should not happen for this class

        const { subscriptionId } = await this._pkc._pkcRpcClient.exportsSubscribe({
            name: this.name,
            publicKey: this.publicKey
        });
        this._exportsSubscriptionId = subscriptionId;

        const subscription = this._pkc._pkcRpcClient.getSubscription(subscriptionId);
        let resolveInitial!: () => void;
        let rejectInitial!: (e: Error) => void;
        const initialReceived = new Promise<void>((resolve, reject) => {
            resolveInitial = resolve;
            rejectInitial = reject;
        });
        let seenInitial = false;

        subscription.on("exportschange", (msg: any) => {
            const records = (msg?.params?.result?.records ?? []) as CommunityExportRecord[];
            this._absorbExportRecords(records);
            if (!seenInitial) {
                seenInitial = true;
                resolveInitial();
            }
        });
        subscription.on("error", (msg: any) => {
            if (!seenInitial) {
                seenInitial = true;
                rejectInitial(msg?.params?.result ?? new Error("exportsSubscribe error before initial notification"));
            }
        });

        this._pkc._pkcRpcClient.emitAllPendingMessages(subscriptionId);
        await initialReceived;
    }

    private _absorbExportRecords(wireRecords: CommunityExportRecord[]): void {
        const httpOrigin = this._pkc._pkcRpcClient!.rpcHttpOrigin;
        this._exportsCache = wireRecords.map((rec) => {
            // Wire-format url is relative (`/exports/<exportId>`) once the export completes; absolutize.
            if (rec.url && rec.url.startsWith("/")) return { ...rec, url: new URL(rec.url, httpOrigin).href };
            return rec;
        });
        // Detach signal listeners for terminal records — the server already finalized them.
        for (const rec of wireRecords) {
            if (rec.progress === 1 || rec.error) {
                const detach = this._exportSignalDetachers.get(rec.exportId);
                if (detach) {
                    detach();
                    this._exportSignalDetachers.delete(rec.exportId);
                }
            }
        }
        this.emit("exportschange", this._exportsCache.map(cloneExportRecord));
    }

    override async delete() {
        // Make sure to stop updating or starting first
        const startedCommunity = findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
        if (startedCommunity && startedCommunity !== this) {
            await startedCommunity.delete();
        } else {
            if (this.state === "started" || this.state === "updating") await this.stop();

            await this._pkc._pkcRpcClient!.deleteCommunity({ name: this.name, publicKey: this.publicKey });
        }

        this.started = false;
        this._setRpcClientStateWithEmission("stopped");
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
    }
}
