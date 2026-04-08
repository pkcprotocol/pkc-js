import Logger from "../logger.js";
import { RpcRemoteCommunity } from "./rpc-remote-community.js";
import * as remeda from "remeda";
import { PKCError } from "../pkc-error.js";
import { CommunityEditOptionsSchema } from "./schema.js";
import { decodeRpcChallengeAnswerPubsubMsg, decodeRpcChallengePubsubMsg, decodeRpcChallengeRequestPubsubMsg, decodeRpcChallengeVerificationPubsubMsg } from "../clients/rpc-client/decode-rpc-response-util.js";
import { deepMergeRuntimeFields, hideClassPrivateProps } from "../util.js";
import { findStartedCommunity, trackStartedCommunity, untrackStartedCommunity } from "../pkc/tracked-instance-registry-util.js";
// This class is for communities that are running and publishing, over RPC. Can be used for both browser and node
export class RpcLocalCommunity extends RpcRemoteCommunity {
    constructor(pkc) {
        super(pkc);
        this.raw = {};
        // Private stuff
        this._startRpcSubscriptionId = undefined;
        this.started = false;
        //@ts-expect-error
        this._usingDefaultChallenge = undefined;
        this.start = this.start.bind(this);
        this.edit = this.edit.bind(this);
        this._setStartedStateWithEmission("stopped");
        this.on("update", () => {
            this.editable = remeda.pick(this, remeda.keys.strict(CommunityEditOptionsSchema.shape));
        });
        hideClassPrivateProps(this);
    }
    toJSONInternalRpcAfterFirstUpdate() {
        if (!this.updateCid)
            throw Error("rpcLocalCommunity.cid should be defined before calling toJSONInternalRpcAfterFirstUpdate");
        return {
            community: this.raw.communityIpfs,
            localCommunity: {
                signer: this.signer,
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
    toJSONInternalRpcBeforeFirstUpdate() {
        if (!this.settings)
            throw Error("Attempting to transmit InternalRpc record without defining settings");
        return {
            localCommunity: {
                ...this._toJSONIpfsBaseNoPosts(),
                address: this.address,
                signer: this.signer,
                settings: this.settings,
                _usingDefaultChallenge: this._usingDefaultChallenge,
                started: this.started,
                startedState: this.startedState
            }
        };
    }
    initRpcInternalCommunityBeforeFirstUpdateNoMerge(newProps) {
        this.initRemoteCommunityPropsNoMerge(newProps.localCommunity);
        // Apply address from localCommunity — may differ after edit (same as afterFirstUpdate variant)
        if (newProps.localCommunity.address)
            this.setAddress(newProps.localCommunity.address);
        this.signer = newProps.localCommunity.signer;
        this.settings = newProps.localCommunity.settings;
        this._usingDefaultChallenge = newProps.localCommunity._usingDefaultChallenge;
        this.started = newProps.localCommunity.started;
        this.raw.localCommunity = newProps;
    }
    initRpcInternalCommunityAfterFirstUpdateNoMerge(newProps) {
        super.initCommunityIpfsPropsNoMerge(newProps.community);
        // Apply address from localCommunity — may differ from community record's name (e.g. .bso/.eth before ENS propagation)
        if (newProps.localCommunity.address)
            this.setAddress(newProps.localCommunity.address);
        this.signer = newProps.localCommunity.signer;
        this.settings = newProps.localCommunity.settings;
        this._usingDefaultChallenge = newProps.localCommunity._usingDefaultChallenge;
        this.started = newProps.localCommunity.started;
        this.updateCid = newProps.runtimeFields.updateCid;
        this.raw.localCommunity = newProps;
        this.editable = remeda.pick(this, remeda.keys.strict(CommunityEditOptionsSchema.shape));
    }
    _updateRpcClientStateFromStartedState(startedState) {
        const mapper = {
            failed: ["stopped"],
            "publishing-ipns": ["publishing-ipns"],
            stopped: ["stopped"],
            succeeded: ["stopped"]
        };
        const newClientState = mapper[startedState] || [startedState]; // in case rpc server transmits a startedState we don't know about, default to startedState
        newClientState.forEach(this._setRpcClientStateWithEmission.bind(this));
    }
    _processUpdateEventFromRpcUpdate(args) {
        // This function is gonna be called with every update event from rpcLocalCommunity.update()
        const log = Logger("pkc-js:rpc-local-community:_processUpdateEventFromRpcUpdate");
        log("Received an update event from rpc within rpcLocalCommunity.update for community " + this.address);
        const updateRecord = args.params.result; // we're being optimistic here and hoping the rpc server sent the correct update
        if ("community" in updateRecord)
            this.initRpcInternalCommunityAfterFirstUpdateNoMerge(updateRecord);
        else
            this.initRpcInternalCommunityBeforeFirstUpdateNoMerge(updateRecord);
        const runtimeFields = "runtimeFields" in updateRecord ? updateRecord.runtimeFields : undefined;
        if (runtimeFields) {
            this.raw.runtimeFieldsFromRpc = runtimeFields;
            deepMergeRuntimeFields(this, runtimeFields);
        }
        if (updateRecord.localCommunity.startedState)
            this._setStartedStateNoEmission(updateRecord.localCommunity.startedState);
        this.emit("update", this);
    }
    _handleRpcUpdateEventFromStart(args) {
        // This function is gonna be called with every update event from rpcLocalCommunity.start()
        const log = Logger("pkc-js:rpc-local-community:_handleRpcUpdateEventFromStart");
        const updateRecord = args.params.result;
        log("Received an update event from rpc within rpcLocalCommunity.start for community " + this.address);
        if ("community" in updateRecord) {
            this.initRpcInternalCommunityAfterFirstUpdateNoMerge(updateRecord);
        }
        else
            this.initRpcInternalCommunityBeforeFirstUpdateNoMerge(updateRecord);
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
    _handleRpcStartedStateChangeEvent(args) {
        const log = Logger("pkc-js:rpc-local-community:_handleRpcStartedStateChangeEvent");
        const newStartedState = args.params.result.state; // we're being optimistic that the rpc server transmitted a valid string here
        log("Received a startedstatechange for community " + this.address, "new started state is", newStartedState);
        if (newStartedState !== this.startedState)
            this._setStartedStateWithEmission(newStartedState);
        else
            this.emit("startedstatechange", newStartedState);
        this._updateRpcClientStateFromStartedState(newStartedState);
    }
    _handleRpcChallengeRequestEvent(args) {
        const encodedRequest = args.params.result;
        const request = decodeRpcChallengeRequestPubsubMsg(encodedRequest);
        this._setRpcClientStateWithEmission("waiting-challenge-requests");
        this.emit("challengerequest", request);
    }
    _handleRpcChallengeEvent(args) {
        const encodedChallenge = args.params.result;
        const challenge = decodeRpcChallengePubsubMsg(encodedChallenge);
        this._setRpcClientStateWithEmission("publishing-challenge");
        this.emit("challenge", challenge);
        this._setRpcClientStateWithEmission("waiting-challenge-answers");
    }
    _handleRpcChallengeAnswerEvent(args) {
        const encodedChallengeAnswer = args.params.result;
        const challengeAnswer = decodeRpcChallengeAnswerPubsubMsg(encodedChallengeAnswer);
        this.emit("challengeanswer", challengeAnswer);
    }
    _handleRpcChallengeVerificationEvent(args) {
        const { challengeVerification: encodedChallengeVerification } = args.params.result;
        const challengeVerification = decodeRpcChallengeVerificationPubsubMsg(encodedChallengeVerification);
        this._setRpcClientStateWithEmission("publishing-challenge-verification");
        this.emit("challengeverification", challengeVerification);
        this._setRpcClientStateWithEmission("waiting-challenge-requests");
    }
    async start() {
        const log = Logger("pkc-js:rpc-local-community:start");
        if (this.state === "updating")
            throw new PKCError("ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING", { address: this.address });
        // we can't start the same instance multiple times
        if (typeof this._startRpcSubscriptionId === "number")
            throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { communityAddress: this.address });
        if (findStartedCommunity(this._pkc, { address: this.address }))
            throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE", { communityAddress: this.address });
        try {
            this._startRpcSubscriptionId = await this._pkc._pkcRpcClient.startCommunity({ address: this.address });
            this._setState("started");
        }
        catch (e) {
            log.error(`Failed to start community (${this.address}) from RPC due to error`, e);
            this._setState("stopped");
            this._setStartedStateWithEmission("failed");
            throw e;
        }
        trackStartedCommunity(this._pkc, this);
        this.started = true;
        this._pkc
            ._pkcRpcClient.getSubscription(this._startRpcSubscriptionId)
            .on("update", this._handleRpcUpdateEventFromStart.bind(this))
            .on("startedstatechange", this._handleRpcStartedStateChangeEvent.bind(this))
            .on("challengerequest", this._handleRpcChallengeRequestEvent.bind(this))
            .on("challenge", this._handleRpcChallengeEvent.bind(this))
            .on("challengeanswer", this._handleRpcChallengeAnswerEvent.bind(this))
            .on("challengeverification", this._handleRpcChallengeVerificationEvent.bind(this))
            .on("error", this._handleRpcErrorEvent.bind(this));
        this._pkc._pkcRpcClient.emitAllPendingMessages(this._startRpcSubscriptionId);
    }
    async _cleanUpRpcConnection(log) {
        if (this._startRpcSubscriptionId) {
            try {
                await this._pkc._pkcRpcClient.unsubscribe(this._startRpcSubscriptionId);
            }
            catch (e) {
                log.error("Failed to unsubscribe from communityStart", e);
            }
        }
        this._setStartedStateWithEmission("stopped");
        this._setRpcClientStateWithEmission("stopped");
        this.started = false;
        this._startRpcSubscriptionId = undefined;
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
    async stop() {
        this.posts._stop();
        if (this.state === "updating") {
            return super.stop();
        }
        else if (this.state === "started") {
            // Need to be careful not to stop an already running community
            const log = Logger("pkc-js:rpc-local-community:stop");
            try {
                await this._pkc._pkcRpcClient.stopCommunity({ address: this.address });
            }
            catch (e) {
                log.error("RPC client received an error when asking rpc server to stop community", e);
            }
            await this._cleanUpRpcConnection(log);
            untrackStartedCommunity(this._pkc, this);
        }
    }
    async edit(newCommunityOptions) {
        if (newCommunityOptions.settings?.challenges) {
            const serverChallenges = this._pkc._pkcRpcClient.settings?.challenges;
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
        const subPropsAfterEdit = await this._pkc._pkcRpcClient.editCommunity(this.address, newCommunityOptions);
        if ("community" in subPropsAfterEdit)
            this.initRpcInternalCommunityAfterFirstUpdateNoMerge(subPropsAfterEdit);
        else
            this.initRpcInternalCommunityBeforeFirstUpdateNoMerge(subPropsAfterEdit);
        this.emit("update", this);
        return this;
    }
    async update() {
        if (this.state === "started")
            throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });
        return super.update();
    }
    async delete() {
        // Make sure to stop updating or starting first
        const startedCommunity = findStartedCommunity(this._pkc, { address: this.address });
        if (startedCommunity && startedCommunity !== this) {
            await startedCommunity.delete();
        }
        else {
            if (this.state === "started" || this.state === "updating")
                await this.stop();
            await this._pkc._pkcRpcClient.deleteCommunity({ address: this.address });
        }
        this.started = false;
        this._setRpcClientStateWithEmission("stopped");
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
    }
}
//# sourceMappingURL=rpc-local-community.js.map