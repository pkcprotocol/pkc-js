import Logger from "../logger.js";
import type {
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType,
    RpcLocalSubplebbitLocalProps,
    RpcLocalSubplebbitUpdateResultType,
    SubplebbitEditOptions,
    SubplebbitIpfsType,
    SubplebbitStartedState
} from "./types.js";
import { RpcRemoteSubplebbit } from "./rpc-remote-subplebbit.js";
import { z } from "zod";
import { messages } from "../errors.js";
import * as remeda from "remeda";
import { Plebbit } from "../plebbit/plebbit.js";
import { PlebbitError } from "../plebbit-error.js";

import { SubplebbitEditOptionsSchema } from "./schema.js";
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
    EncodedDecryptedChallengeRequestMessageTypeWithSubplebbitAuthor,
    EncodedDecryptedChallengeVerificationMessageType
} from "../pubsub-messages/types.js";
import { deepMergeRuntimeFields, hideClassPrivateProps } from "../util.js";
import { findStartedSubplebbit, trackStartedSubplebbit, untrackStartedSubplebbit } from "../plebbit/tracked-instance-registry-util.js";

// This class is for subs that are running and publishing, over RPC. Can be used for both browser and node
export class RpcLocalSubplebbit extends RpcRemoteSubplebbit {
    override started: boolean; // Is the sub started and running? This is not specific to this instance, and applies to all instances of sub with this address
    override startedState!: SubplebbitStartedState;
    override signer!: RpcLocalSubplebbitLocalProps["signer"];
    override settings!: RpcLocalSubplebbitLocalProps["settings"];
    override editable!: Pick<RpcLocalSubplebbit, keyof SubplebbitEditOptions>;

    // mandating props
    override challenges!: SubplebbitIpfsType["challenges"];
    override encryption!: SubplebbitIpfsType["encryption"];
    override createdAt!: SubplebbitIpfsType["createdAt"];
    override protocolVersion!: SubplebbitIpfsType["protocolVersion"];

    override raw: {
        subplebbitIpfs?: SubplebbitIpfsType;
        runtimeFieldsFromRpc?: Record<string, any>;
        localSubplebbit?: RpcLocalSubplebbitUpdateResultType;
    } = {};

    // Private stuff
    private _startRpcSubscriptionId?: z.infer<typeof SubscriptionIdSchema> = undefined;
    _usingDefaultChallenge!: RpcLocalSubplebbitLocalProps["_usingDefaultChallenge"];

    constructor(plebbit: Plebbit) {
        super(plebbit);
        this.started = false;
        //@ts-expect-error
        this._usingDefaultChallenge = undefined;
        this.start = this.start.bind(this);
        this.edit = this.edit.bind(this);
        this._setStartedStateWithEmission("stopped");
        this.on("update", () => {
            this.editable = remeda.pick(this, remeda.keys.strict(SubplebbitEditOptionsSchema.shape));
        });
        hideClassPrivateProps(this);
    }

    toJSONInternalRpcAfterFirstUpdate(): RpcInternalSubplebbitRecordAfterFirstUpdateType {
        if (!this.updateCid) throw Error("rpcLocalSubplebbit.cid should be defined before calling toJSONInternalRpcAfterFirstUpdate");
        return {
            subplebbit: this.raw.subplebbitIpfs!,
            localSubplebbit: {
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

    toJSONInternalRpcBeforeFirstUpdate(): RpcInternalSubplebbitRecordBeforeFirstUpdateType {
        if (!this.settings) throw Error("Attempting to transmit InternalRpc record without defining settings");
        return {
            localSubplebbit: {
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

    initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(newProps: RpcInternalSubplebbitRecordBeforeFirstUpdateType) {
        this.initRemoteSubplebbitPropsNoMerge(newProps.localSubplebbit);
        // Apply address from localSubplebbit — may differ after edit (same as afterFirstUpdate variant)
        if (newProps.localSubplebbit.address) this.setAddress(newProps.localSubplebbit.address);
        this.signer = newProps.localSubplebbit.signer;
        this.settings = newProps.localSubplebbit.settings;
        this._usingDefaultChallenge = newProps.localSubplebbit._usingDefaultChallenge;
        this.started = newProps.localSubplebbit.started;
        this.raw.localSubplebbit = newProps;
    }

    initRpcInternalSubplebbitAfterFirstUpdateNoMerge(newProps: RpcInternalSubplebbitRecordAfterFirstUpdateType) {
        super.initSubplebbitIpfsPropsNoMerge(newProps.subplebbit);
        // Apply address from localSubplebbit — may differ from subplebbit record's name (e.g. .bso/.eth before ENS propagation)
        if (newProps.localSubplebbit.address) this.setAddress(newProps.localSubplebbit.address);

        this.signer = newProps.localSubplebbit.signer;
        this.settings = newProps.localSubplebbit.settings;
        this._usingDefaultChallenge = newProps.localSubplebbit._usingDefaultChallenge;
        this.started = newProps.localSubplebbit.started;
        this.updateCid = newProps.runtimeFields.updateCid;
        this.raw.localSubplebbit = newProps;
        this.editable = remeda.pick(this, remeda.keys.strict(SubplebbitEditOptionsSchema.shape));
    }

    protected _updateRpcClientStateFromStartedState(startedState: RpcLocalSubplebbit["startedState"]) {
        const mapper: Record<RpcLocalSubplebbit["startedState"], RpcLocalSubplebbit["clients"]["plebbitRpcClients"][0]["state"][]> = {
            failed: ["stopped"],
            "publishing-ipns": ["publishing-ipns"],
            stopped: ["stopped"],
            succeeded: ["stopped"]
        };

        const newClientState = mapper[startedState] || [startedState]; // in case rpc server transmits a startedState we don't know about, default to startedState

        newClientState.forEach(this._setRpcClientStateWithEmission.bind(this));
    }

    protected override _processUpdateEventFromRpcUpdate(args: any) {
        // This function is gonna be called with every update event from rpcLocalSubplebbit.update()
        const log = Logger("pkc-js:rpc-local-community:_processUpdateEventFromRpcUpdate");
        log("Received an update event from rpc within rpcLocalSubplebbit.update for sub " + this.address);

        const updateRecord: RpcLocalSubplebbitUpdateResultType = args.params.result; // we're being optimistic here and hoping the rpc server sent the correct update
        if ("subplebbit" in updateRecord) this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge(updateRecord);
        else this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(updateRecord);

        const runtimeFields = "runtimeFields" in updateRecord ? updateRecord.runtimeFields : undefined;
        if (runtimeFields) {
            this.raw.runtimeFieldsFromRpc = runtimeFields;
            deepMergeRuntimeFields(this, runtimeFields);
        }

        if (updateRecord.localSubplebbit.startedState) this._setStartedStateNoEmission(updateRecord.localSubplebbit.startedState);
        this.emit("update", this);
    }

    private _handleRpcUpdateEventFromStart(args: any) {
        // This function is gonna be called with every update event from rpcLocalSubplebbit.start()

        const log = Logger("pkc-js:rpc-local-community:_handleRpcUpdateEventFromStart");
        const updateRecord: RpcLocalSubplebbitUpdateResultType = args.params.result;
        log("Received an update event from rpc within rpcLocalSubplebbit.start for sub " + this.address);

        if ("subplebbit" in updateRecord) {
            this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge(updateRecord);
        } else this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(updateRecord);

        const runtimeFields = "runtimeFields" in updateRecord ? updateRecord.runtimeFields : undefined;
        if (runtimeFields) {
            this.raw.runtimeFieldsFromRpc = runtimeFields;
            deepMergeRuntimeFields(this, runtimeFields);
        }

        if (updateRecord.localSubplebbit.startedState) {
            this._setStartedStateNoEmission(updateRecord.localSubplebbit.startedState);
        }
        this.emit("update", this);
    }

    private _handleRpcStartedStateChangeEvent(args: any) {
        const log = Logger("pkc-js:rpc-local-community:_handleRpcStartedStateChangeEvent");

        const newStartedState: RpcLocalSubplebbit["startedState"] = args.params.result.state; // we're being optimistic that the rpc server transmitted a valid string here
        log("Received a startedstatechange for sub " + this.address, "new started state is", newStartedState);

        if (newStartedState !== this.startedState) this._setStartedStateWithEmission(newStartedState);
        else this.emit("startedstatechange", newStartedState);

        this._updateRpcClientStateFromStartedState(newStartedState);
    }

    private _handleRpcChallengeRequestEvent(args: any) {
        const encodedRequest: EncodedDecryptedChallengeRequestMessageTypeWithSubplebbitAuthor = args.params.result;
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
        if (this.state === "updating")
            throw new PlebbitError("ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING", { address: this.address });
        // we can't start the same instance multiple times
        if (typeof this._startRpcSubscriptionId === "number")
            throw new PlebbitError("ERR_COMMUNITY_ALREADY_STARTED", { subplebbitAddress: this.address });

        if (findStartedSubplebbit(this._plebbit, { address: this.address }))
            throw new PlebbitError("ERR_COMMUNITY_ALREADY_STARTED_IN_SAME_PKC_INSTANCE", { subplebbitAddress: this.address });
        try {
            this._startRpcSubscriptionId = await this._plebbit._plebbitRpcClient!.startSubplebbit({ address: this.address });
            this._setState("started");
        } catch (e) {
            log.error(`Failed to start subplebbit (${this.address}) from RPC due to error`, e);
            this._setState("stopped");
            this._setStartedStateWithEmission("failed");
            throw e;
        }
        trackStartedSubplebbit(this._plebbit, this);
        this.started = true;
        this._plebbit
            ._plebbitRpcClient!.getSubscription(this._startRpcSubscriptionId)
            .on("update", this._handleRpcUpdateEventFromStart.bind(this))
            .on("startedstatechange", this._handleRpcStartedStateChangeEvent.bind(this))
            .on("challengerequest", this._handleRpcChallengeRequestEvent.bind(this))
            .on("challenge", this._handleRpcChallengeEvent.bind(this))
            .on("challengeanswer", this._handleRpcChallengeAnswerEvent.bind(this))
            .on("challengeverification", this._handleRpcChallengeVerificationEvent.bind(this))
            .on("error", this._handleRpcErrorEvent.bind(this));

        this._plebbit._plebbitRpcClient!.emitAllPendingMessages(this._startRpcSubscriptionId);
    }

    private async _cleanUpRpcConnection(log: Logger) {
        if (this._startRpcSubscriptionId) {
            try {
                await this._plebbit._plebbitRpcClient!.unsubscribe(this._startRpcSubscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from subplebbitStart", e);
            }
        }
        this._setStartedStateWithEmission("stopped");
        this._setRpcClientStateWithEmission("stopped");
        this.started = false;
        this._startRpcSubscriptionId = undefined;
        log(`Stopped the running of local subplebbit (${this.address}) via RPC`);
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
        untrackStartedSubplebbit(this._plebbit, this);
    }

    override async stop() {
        this.posts._stop();
        if (this.state === "updating") {
            return super.stop();
        } else if (this.state === "started") {
            // Need to be careful not to stop an already running sub
            const log = Logger("pkc-js:rpc-local-community:stop");
            try {
                await this._plebbit._plebbitRpcClient!.stopSubplebbit({ address: this.address });
            } catch (e) {
                log.error("RPC client received an error when asking rpc server to stop subplebbit", e);
            }
            await this._cleanUpRpcConnection(log);
            untrackStartedSubplebbit(this._plebbit, this);
        }
    }

    override async edit(newSubplebbitOptions: SubplebbitEditOptions): Promise<typeof this> {
        if (newSubplebbitOptions.settings?.challenges) {
            const serverChallenges = this._plebbit._plebbitRpcClient!.settings?.challenges;
            if (serverChallenges) {
                for (const challengeSetting of newSubplebbitOptions.settings.challenges) {
                    if (challengeSetting.name && !challengeSetting.path && !(challengeSetting.name in serverChallenges)) {
                        throw new PlebbitError("ERR_RPC_CLIENT_CHALLENGE_NAME_NOT_AVAILABLE_ON_SERVER", {
                            challengeName: challengeSetting.name,
                            availableChallenges: Object.keys(serverChallenges)
                        });
                    }
                }
            }
        }
        const subPropsAfterEdit = await this._plebbit._plebbitRpcClient!.editSubplebbit(this.address, newSubplebbitOptions);
        if ("subplebbit" in subPropsAfterEdit) this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge(subPropsAfterEdit);
        else this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(subPropsAfterEdit);
        this.emit("update", this);
        return this;
    }

    override async update() {
        if (this.state === "started") throw new PlebbitError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });

        return super.update();
    }

    override async delete() {
        // Make sure to stop updating or starting first
        const startedSubplebbit = findStartedSubplebbit(this._plebbit, { address: this.address });
        if (startedSubplebbit && startedSubplebbit !== this) {
            await startedSubplebbit.delete();
        } else {
            if (this.state === "started" || this.state === "updating") await this.stop();

            await this._plebbit._plebbitRpcClient!.deleteSubplebbit({ address: this.address });
        }

        this.started = false;
        this._setRpcClientStateWithEmission("stopped");
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
    }
}
