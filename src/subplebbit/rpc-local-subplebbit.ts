import Logger from "@plebbit/plebbit-logger";
import type {
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType,
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

import { SubplebbitEditOptionsSchema, SubplebbitIpfsSchema } from "./schema.js";
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
import { hideClassPrivateProps } from "../util.js";

// This class is for subs that are running and publishing, over RPC. Can be used for both browser and node
export class RpcLocalSubplebbit extends RpcRemoteSubplebbit implements RpcInternalSubplebbitRecordBeforeFirstUpdateType {
    override started: boolean; // Is the sub started and running? This is not specific to this instance, and applies to all instances of sub with this address
    override startedState!: SubplebbitStartedState;
    override signer!: RpcInternalSubplebbitRecordAfterFirstUpdateType["signer"];
    override settings!: RpcInternalSubplebbitRecordAfterFirstUpdateType["settings"];
    override editable!: Pick<RpcLocalSubplebbit, keyof SubplebbitEditOptions>;

    // mandating props
    override challenges!: RpcInternalSubplebbitRecordBeforeFirstUpdateType["challenges"];
    override encryption!: RpcInternalSubplebbitRecordBeforeFirstUpdateType["encryption"];
    override createdAt!: RpcInternalSubplebbitRecordBeforeFirstUpdateType["createdAt"];
    override protocolVersion!: RpcInternalSubplebbitRecordBeforeFirstUpdateType["protocolVersion"];

    // Private stuff
    private _startRpcSubscriptionId?: z.infer<typeof SubscriptionIdSchema> = undefined;
    _usingDefaultChallenge!: RpcInternalSubplebbitRecordAfterFirstUpdateType["_usingDefaultChallenge"];

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
            ...this.raw.subplebbitIpfs!,
            ...this.toJSONInternalRpcBeforeFirstUpdate(),
            updateCid: this.updateCid
        };
    }

    toJSONInternalRpcBeforeFirstUpdate(): RpcInternalSubplebbitRecordBeforeFirstUpdateType {
        if (!this.settings) throw Error("Attempting to transmit InternalRpc record without defining settings");
        return {
            ...this._toJSONIpfsBaseNoPosts(),
            signer: this.signer,
            settings: this.settings,
            _usingDefaultChallenge: this._usingDefaultChallenge,
            started: this.started,
            startedState: this.startedState
        };
    }

    initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(newProps: RpcInternalSubplebbitRecordBeforeFirstUpdateType) {
        this.initRemoteSubplebbitPropsNoMerge(newProps);
        this.signer = newProps.signer;
        this.settings = newProps.settings;
        this._usingDefaultChallenge = newProps._usingDefaultChallenge;
        this.started = newProps.started;
    }

    initRpcInternalSubplebbitAfterFirstUpdateNoMerge(newProps: RpcInternalSubplebbitRecordAfterFirstUpdateType) {
        const keysOfSubplebbitIpfs = <(keyof SubplebbitIpfsType)[]>[...newProps.signature.signedPropertyNames, "signature"];
        const subplebbitIpfsParseRes = SubplebbitIpfsSchema.loose().safeParse(remeda.pick(newProps, keysOfSubplebbitIpfs));
        if (subplebbitIpfsParseRes.success) {
            super.initSubplebbitIpfsPropsNoMerge(subplebbitIpfsParseRes.data);
        } else super.initRemoteSubplebbitPropsNoMerge(newProps);

        this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(newProps);
        this.updateCid = newProps.updateCid;
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
        const log = Logger("plebbit-js:rpc-local-subplebbit:_processUpdateEventFromRpcUpdate");
        log("Received an update event from rpc within rpcLocalSubplebbit.update for sub " + this.address);

        const updateRecord: RpcLocalSubplebbitUpdateResultType = args.params.result; // we're being optimistic here and hoping the rpc server sent the correct update
        if ("updatedAt" in updateRecord) this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge(updateRecord);
        else this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(updateRecord);

        if (updateRecord.startedState) this._setStartedStateNoEmission(updateRecord.startedState);
        this.emit("update", this);
    }

    private _handleRpcUpdateEventFromStart(args: any) {
        // This function is gonna be called with every update event from rpcLocalSubplebbit.start()

        const log = Logger("plebbit-js:rpc-local-subplebbit:_handleRpcUpdateEventFromStart");
        const updateRecord: RpcLocalSubplebbitUpdateResultType = args.params.result;
        log("Received an update event from rpc within rpcLocalSubplebbit.start for sub " + this.address);

        if ("updatedAt" in updateRecord) {
            this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge(updateRecord);
        } else this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(updateRecord);

        if (updateRecord.startedState) {
            this._setStartedStateNoEmission(updateRecord.startedState);
        }
        this.emit("update", this);
    }

    private _handleRpcStartedStateChangeEvent(args: any) {
        const log = Logger("plebbit-js:rpc-local-subplebbit:_handleRpcStartedStateChangeEvent");

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
        const log = Logger("plebbit-js:rpc-local-subplebbit:start");
        if (this.state === "updating") throw new PlebbitError("ERR_NEED_TO_STOP_UPDATING_SUB_BEFORE_STARTING", { address: this.address });
        // we can't start the same instance multiple times
        if (typeof this._startRpcSubscriptionId === "number")
            throw new PlebbitError("ERR_SUB_ALREADY_STARTED", { subplebbitAddress: this.address });

        if (this._plebbit._startedSubplebbits[this.address])
            throw new PlebbitError("ERR_SUB_ALREADY_STARTED_IN_SAME_PLEBBIT_INSTANCE", { subplebbitAddress: this.address });
        try {
            this._startRpcSubscriptionId = await this._plebbit._plebbitRpcClient!.startSubplebbit({ address: this.address });
            this._setState("started");
        } catch (e) {
            log.error(`Failed to start subplebbit (${this.address}) from RPC due to error`, e);
            this._setState("stopped");
            this._setStartedStateWithEmission("failed");
            throw e;
        }
        this._plebbit._startedSubplebbits[this.address] = this;
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
        const log = Logger("plebbit-js:rpc-local-subplebbit:stop");
        await this._cleanUpRpcConnection(log);
        this.posts._stop();
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
        this._setRpcClientStateWithEmission("stopped");
        this.started = false;
        delete this._plebbit._startedSubplebbits[this.address];
    }

    override async stop() {
        this.posts._stop();
        if (this.state === "updating") {
            return super.stop();
        } else if (this.state === "started") {
            // Need to be careful not to stop an already running sub
            const log = Logger("plebbit-js:rpc-local-subplebbit:stop");
            try {
                await this._plebbit._plebbitRpcClient!.stopSubplebbit({ address: this.address });
            } catch (e) {
                log.error("RPC client received an error when asking rpc server to stop subplebbit", e);
            }
            await this._cleanUpRpcConnection(log);
            delete this._plebbit._startedSubplebbits[this.address];
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
        if ("updatedAt" in subPropsAfterEdit) this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge(subPropsAfterEdit);
        else this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(subPropsAfterEdit);
        this.emit("update", this);
        return this;
    }

    override async update() {
        if (this.state === "started") throw new PlebbitError("ERR_SUB_ALREADY_STARTED", { address: this.address });

        return super.update();
    }

    override async delete() {
        // Make sure to stop updating or starting first
        if (this._plebbit._startedSubplebbits[this.address] && this._plebbit._startedSubplebbits[this.address] !== this) {
            await this._plebbit._startedSubplebbits[this.address].delete();
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
