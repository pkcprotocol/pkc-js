import Logger from "../logger.js";
import { RemoteCommunity } from "./remote-community.js";
import type { RpcRemoteCommunityType, CommunityEvents, CommunityRpcErrorToTransmit } from "./types.js";
import * as remeda from "remeda";
import { PKCError } from "../pkc-error.js";
import { parseRpcRemoteCommunityUpdateEventWithPKCErrorIfItFails } from "../schema/schema-util.js";
import { deepMergeRuntimeFields } from "../util.js";
import { RpcLocalCommunity } from "./rpc-local-community.js";
import {
    findStartedCommunity,
    findUpdatingCommunity,
    trackUpdatingCommunity,
    untrackUpdatingCommunity
} from "../pkc/tracked-instance-registry-util.js";

export class RpcRemoteCommunity extends RemoteCommunity {
    private _updateRpcSubscriptionId?: number = undefined;
    private _updatingRpcSubInstanceWithListeners?: { subplebbit: RpcRemoteCommunity | RpcLocalCommunity } & Pick<
        CommunityEvents,
        | "error"
        | "updatingstatechange"
        | "startedstatechange"
        | "update"
        | "statechange"
        | "challengerequest"
        | "challengeverification"
        | "challengeanswer"
        | "challenge"
    > = undefined; // The plebbit._updatingCommunitys we're subscribed to

    protected _setRpcClientStateWithoutEmission(newState: RemoteCommunity["clients"]["plebbitRpcClients"][""]["state"]) {
        const currentRpcUrl = remeda.keys.strict(this.clients.plebbitRpcClients)[0];
        const currentState = this.clients.plebbitRpcClients[currentRpcUrl].state;
        if (newState === currentState) return;
        this.clients.plebbitRpcClients[currentRpcUrl].state = newState;
    }

    protected _setRpcClientStateWithEmission(newState: RemoteCommunity["clients"]["plebbitRpcClients"][""]["state"]) {
        const currentRpcUrl = remeda.keys.strict(this.clients.plebbitRpcClients)[0];
        const currentState = this.clients.plebbitRpcClients[currentRpcUrl].state;
        if (newState === currentState) return;
        this.clients.plebbitRpcClients[currentRpcUrl].state = newState;
        this.clients.plebbitRpcClients[currentRpcUrl].emit("statechange", newState);
    }

    override get updatingState(): RemoteCommunity["updatingState"] {
        if (this._updatingRpcSubInstanceWithListeners) {
            return this._updatingRpcSubInstanceWithListeners.subplebbit.updatingState;
        } else return this._updatingState;
    }

    protected _updateRpcClientStateFromUpdatingState(updatingState: RpcRemoteCommunity["updatingState"]) {
        // We're deriving the the rpc state from updating state

        const mapper: Record<RpcRemoteCommunity["updatingState"], RemoteCommunity["clients"]["plebbitRpcClients"][0]["state"][]> = {
            failed: ["stopped"],
            "fetching-ipfs": ["fetching-ipfs"],
            "fetching-ipns": ["fetching-ipns"],
            "waiting-retry": ["stopped"],
            "publishing-ipns": ["publishing-ipns"],
            "resolving-name": ["resolving-community-name"],
            stopped: ["stopped"],
            succeeded: ["stopped"]
        };

        const newRpcClientState = mapper[updatingState] || [updatingState]; // There may be a case where the rpc server transmits a new state that is not part of mapper
        newRpcClientState.forEach(this._setRpcClientStateWithEmission.bind(this));
    }

    protected _processUpdateEventFromRpcUpdate(args: any) {
        // This function is to handle "update" event emitted after calling rpcRemoteCommunity.update()
        // It's overidden in rpc-local-subplebbit
        const log = Logger("pkc-js:rpc-remote-community:_processUpdateEventFromRpcUpdate");
        let updateRecord: RpcRemoteCommunityType;
        try {
            updateRecord = parseRpcRemoteCommunityUpdateEventWithPKCErrorIfItFails(args.params.result);
        } catch (e) {
            log.error("Failed to parse the schema of remote subplebbit sent by rpc", e);
            this.emit("error", <PKCError>e);
            throw e;
        }

        // Key migration: server cleared its state, client should do the same
        if (updateRecord.resetInstance && updateRecord.runtimeFields.newPublicKey) {
            this._clearDataForKeyMigration(updateRecord.runtimeFields.newPublicKey);
            if (typeof updateRecord.runtimeFields.nameResolved === "boolean") this.nameResolved = updateRecord.runtimeFields.nameResolved;
            this.emit("update", this);
            return;
        }

        this.initCommunityIpfsPropsNoMerge(updateRecord.subplebbit!);
        this.updateCid = updateRecord.runtimeFields.updateCid!;
        this._setUpdatingStateNoEmission(updateRecord.runtimeFields.updatingState || "succeeded");
        this.raw.runtimeFieldsFromRpc = updateRecord.runtimeFields;
        deepMergeRuntimeFields(this, updateRecord.runtimeFields);

        this.emit("update", this);
    }

    private _handleUpdatingStateChangeFromRpcUpdate(args: any) {
        const newUpdatingState: RpcRemoteCommunity["updatingState"] = args.params.result.state; // we're being optimistic that RPC server sent an appropiate updating state string

        this._setUpdatingStateWithEventEmissionIfNewState(newUpdatingState);
        this._updateRpcClientStateFromUpdatingState(newUpdatingState);
    }

    private async _initMirroringUpdatingCommunity(updatingCommunity: RpcRemoteCommunity) {
        if (updatingCommunity === this) return; // avoid mirroring to itself
        this._updatingRpcSubInstanceWithListeners = {
            subplebbit: updatingCommunity,
            error: (err) => this.emit("error", err),
            updatingstatechange: (updatingState) => this._setUpdatingStateWithEventEmissionIfNewState.bind(this)(updatingState),
            update: (updatingCommunity) => {
                const keyChanged = updatingCommunity.publicKey && updatingCommunity.publicKey !== this.publicKey;
                if (!updatingCommunity.raw.subplebbitIpfs || !updatingCommunity.updateCid) {
                    if (updatingCommunity.publicKey) this._clearDataForKeyMigration(updatingCommunity.publicKey);
                } else {
                    this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.subplebbitIpfs);
                    this.updateCid = updatingCommunity.updateCid;
                    if (updatingCommunity.raw.runtimeFieldsFromRpc)
                        deepMergeRuntimeFields(this, updatingCommunity.raw.runtimeFieldsFromRpc);
                }
                if (typeof updatingCommunity.nameResolved === "boolean") this.nameResolved = updatingCommunity.nameResolved;
                // Only emit when there's actual data or a key migration — avoid spurious updates for empty subs
                if ((updatingCommunity.raw.subplebbitIpfs && updatingCommunity.updateCid) || keyChanged) {
                    this.emit("update", this);
                }
            },
            statechange: async (newState) => {
                if (newState === "stopped" && this.state !== "stopped")
                    // plebbit._updatingCommunitys[address].stop() has been called, we need to clean up the subscription
                    // or plebbit._startedCommunitys[address].stop has been called
                    await this.stop();
            },
            challengerequest: (challengeRequest) => this.emit("challengerequest", challengeRequest),
            challengeverification: (challengeVerification) => this.emit("challengeverification", challengeVerification),
            challengeanswer: (challengeAnswer) => this.emit("challengeanswer", challengeAnswer),
            challenge: (challenge) => this.emit("challenge", challenge),
            startedstatechange: (startedState) => this._setStartedStateWithEmission.bind(this)(startedState)
        };

        this._updatingRpcSubInstanceWithListeners.subplebbit.on("update", this._updatingRpcSubInstanceWithListeners.update);
        this._updatingRpcSubInstanceWithListeners.subplebbit.on(
            "updatingstatechange",
            this._updatingRpcSubInstanceWithListeners.updatingstatechange
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.on("error", this._updatingRpcSubInstanceWithListeners.error);
        this._updatingRpcSubInstanceWithListeners.subplebbit.on("statechange", this._updatingRpcSubInstanceWithListeners.statechange);
        this._updatingRpcSubInstanceWithListeners.subplebbit.on(
            "challengerequest",
            this._updatingRpcSubInstanceWithListeners.challengerequest
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.on(
            "challengeverification",
            this._updatingRpcSubInstanceWithListeners.challengeverification
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.on(
            "challengeanswer",
            this._updatingRpcSubInstanceWithListeners.challengeanswer
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.on("challenge", this._updatingRpcSubInstanceWithListeners.challenge);
        this._updatingRpcSubInstanceWithListeners.subplebbit.on(
            "startedstatechange",
            this._updatingRpcSubInstanceWithListeners.startedstatechange
        );

        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (updatingCommunity.clients[clientType])
                for (const clientUrl of Object.keys(updatingCommunity.clients[clientType]))
                    this.clients[clientType][clientUrl].mirror(updatingCommunity.clients[clientType][clientUrl]);

        this._updatingRpcSubInstanceWithListeners.subplebbit._numOfListenersForUpdatingInstance++;
        if (!updatingCommunity.raw.subplebbitIpfs || !updatingCommunity.updateCid) {
            if (updatingCommunity.publicKey) this._clearDataForKeyMigration(updatingCommunity.publicKey);
        } else {
            this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.subplebbitIpfs);
            this.updateCid = updatingCommunity.updateCid;
            if (updatingCommunity.raw.runtimeFieldsFromRpc) deepMergeRuntimeFields(this, updatingCommunity.raw.runtimeFieldsFromRpc);
        }
        if (typeof updatingCommunity.nameResolved === "boolean") this.nameResolved = updatingCommunity.nameResolved;
        if (updatingCommunity.raw.subplebbitIpfs || updatingCommunity.updateCid) {
            this.emit("update", this);
        }
    }

    protected _handleRpcErrorEvent(args: any) {
        const error: CommunityRpcErrorToTransmit = args.params.result;
        if (error.details?.newUpdatingState) this._setUpdatingStateNoEmission(error.details.newUpdatingState);
        if (error.details?.newStartedState) this._setStartedStateNoEmission(error.details.newStartedState);
        if ("code" in error && error.code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY" && error.details?.newPublicKey) {
            this._clearDataForKeyMigration(error.details.newPublicKey);
            this.nameResolved = true;
            this.emit("update", this);
        }
        this.emit("error", error);
    }

    async _initRpcUpdateSubscription() {
        const log = Logger("pkc-js:rpc-remote-community:_initRpcUpdateSubscription");
        this._setState("updating");
        try {
            this._updateRpcSubscriptionId = await this._plebbit._plebbitRpcClient!.subplebbitUpdateSubscribe({
                address: this.address,
                ...(this.name ? { name: this.name } : undefined),
                ...(this.publicKey ? { publicKey: this.publicKey } : undefined)
            });
        } catch (e) {
            log.error("Failed to receive subplebbitUpdate from RPC due to error", e);
            this._setState("stopped");
            this._setUpdatingStateWithEventEmissionIfNewState("failed");
            throw e;
        }
        this._plebbit
            ._plebbitRpcClient!.getSubscription(this._updateRpcSubscriptionId)
            .on("update", this._processUpdateEventFromRpcUpdate.bind(this))
            .on("updatingstatechange", this._handleUpdatingStateChangeFromRpcUpdate.bind(this))
            .on("error", this._handleRpcErrorEvent.bind(this));

        this._plebbit._plebbitRpcClient!.emitAllPendingMessages(this._updateRpcSubscriptionId);
    }

    async _createAndSubscribeToNewUpdatingCommunity(updatingCommunity?: RpcRemoteCommunity) {
        const log = Logger("pkc-js:rpc-remote-community:_createNewUpdatingCommunity");
        const updatingSub =
            updatingCommunity ||
            ((await this._plebbit.createCommunity({
                address: this.address,
                ...(this.name ? { name: this.name } : undefined),
                ...(this.publicKey ? { publicKey: this.publicKey } : undefined)
            })) as RpcRemoteCommunity);
        trackUpdatingCommunity(this._plebbit, updatingSub);
        log("Creating a new entry for this._plebbit._updatingCommunitys", this.address);

        if (updatingSub !== this)
            // in plebbit.createCommunity() this function is called with the subplebbit instance itself
            await this._initMirroringUpdatingCommunity(updatingSub);
        await updatingSub._initRpcUpdateSubscription();
    }

    override async update() {
        const log = Logger("pkc-js:rpc-remote-community:update");

        if (this.state === "started") throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });
        if (this.state !== "stopped") return; // No need to do anything if subplebbit is already updating
        this._setState("updating");
        try {
            const existingSub = findUpdatingCommunity(this._plebbit, { address: this.address }) as RpcRemoteCommunity | undefined;
            if (existingSub) {
                if (existingSub === this) await this._initRpcUpdateSubscription();
                else await this._initMirroringUpdatingCommunity(existingSub);
            } else {
                const startedSub = findStartedCommunity(this._plebbit, { address: this.address });
                if (startedSub) await this._initMirroringUpdatingCommunity(startedSub as RpcLocalCommunity);
                else {
                    // creating a new entry in plebbit._updatingCommunitys
                    // poll updates from RPC
                    await this._createAndSubscribeToNewUpdatingCommunity();
                }
            }
        } catch (e) {
            await this.stop();
            throw e;
        }
    }

    private async _cleanupMirroringUpdatingCommunity() {
        if (!this._updatingRpcSubInstanceWithListeners)
            throw Error("rpcRemoteCommunity.state is updating but no mirroring updating subplebbit");
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener("update", this._updatingRpcSubInstanceWithListeners.update);
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "updatingstatechange",
            this._updatingRpcSubInstanceWithListeners.updatingstatechange
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener("error", this._updatingRpcSubInstanceWithListeners.error);
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "statechange",
            this._updatingRpcSubInstanceWithListeners.statechange
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "challengerequest",
            this._updatingRpcSubInstanceWithListeners.challengerequest
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "challengeverification",
            this._updatingRpcSubInstanceWithListeners.challengeverification
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "challengeanswer",
            this._updatingRpcSubInstanceWithListeners.challengeanswer
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "challenge",
            this._updatingRpcSubInstanceWithListeners.challenge
        );
        this._updatingRpcSubInstanceWithListeners.subplebbit.removeListener(
            "startedstatechange",
            this._updatingRpcSubInstanceWithListeners.startedstatechange
        );
        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();
        this._updatingRpcSubInstanceWithListeners.subplebbit._numOfListenersForUpdatingInstance--;

        if (
            this._updatingRpcSubInstanceWithListeners.subplebbit._numOfListenersForUpdatingInstance === 0 &&
            this._updatingRpcSubInstanceWithListeners.subplebbit.state === "updating"
        ) {
            const log = Logger("pkc-js:rpc-remote-community:_cleanupMirroringUpdatingCommunity");
            log("Cleaning up plebbit._updatingCommunitys", this.address, "There are no subplebbits using it for updates");
            await this._updatingRpcSubInstanceWithListeners.subplebbit.stop();
        }
        this._updatingRpcSubInstanceWithListeners = undefined;
    }

    override async stop() {
        const log = Logger("pkc-js:rpc-remote-community:stop");
        if (this.state === "stopped") return;

        if (this._updatingRpcSubInstanceWithListeners) {
            await this._cleanupMirroringUpdatingCommunity();
        } else if (this._updateRpcSubscriptionId) {
            try {
                await this._plebbit._plebbitRpcClient!.unsubscribe(this._updateRpcSubscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from subplebbitUpdate", e);
            }
            this._updateRpcSubscriptionId = undefined;
            log.trace(`Stopped the update of remote subplebbit (${this.address}) via RPC`);
            untrackUpdatingCommunity(this._plebbit, this);
        }
        this._setRpcClientStateWithEmission("stopped");
        this._setUpdatingStateWithEventEmissionIfNewState("stopped");
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
        this.posts._stop();
    }
}
