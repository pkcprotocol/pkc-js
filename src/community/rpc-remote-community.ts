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
    private _updatingRpcCommunityInstanceWithListeners?: { community: RpcRemoteCommunity | RpcLocalCommunity } & Pick<
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
    > = undefined; // The pkc._updatingCommunities we're subscribed to

    protected _setRpcClientStateWithoutEmission(newState: RemoteCommunity["clients"]["pkcRpcClients"][""]["state"]) {
        const currentRpcUrl = remeda.keys.strict(this.clients.pkcRpcClients)[0];
        const currentState = this.clients.pkcRpcClients[currentRpcUrl].state;
        if (newState === currentState) return;
        this.clients.pkcRpcClients[currentRpcUrl].state = newState;
    }

    protected _setRpcClientStateWithEmission(newState: RemoteCommunity["clients"]["pkcRpcClients"][""]["state"]) {
        const currentRpcUrl = remeda.keys.strict(this.clients.pkcRpcClients)[0];
        const currentState = this.clients.pkcRpcClients[currentRpcUrl].state;
        if (newState === currentState) return;
        this.clients.pkcRpcClients[currentRpcUrl].state = newState;
        this.clients.pkcRpcClients[currentRpcUrl].emit("statechange", newState);
    }

    override get updatingState(): RemoteCommunity["updatingState"] {
        if (this._updatingRpcCommunityInstanceWithListeners) {
            return this._updatingRpcCommunityInstanceWithListeners.community.updatingState;
        } else return this._updatingState;
    }

    protected _updateRpcClientStateFromUpdatingState(updatingState: RpcRemoteCommunity["updatingState"]) {
        // We're deriving the the rpc state from updating state

        const mapper: Record<RpcRemoteCommunity["updatingState"], RemoteCommunity["clients"]["pkcRpcClients"][0]["state"][]> = {
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
        // It's overidden in rpc-local-community
        const log = Logger("pkc-js:rpc-remote-community:_processUpdateEventFromRpcUpdate");
        let updateRecord: RpcRemoteCommunityType;
        try {
            updateRecord = parseRpcRemoteCommunityUpdateEventWithPKCErrorIfItFails(args.params.result);
        } catch (e) {
            log.error("Failed to parse the schema of remote community sent by rpc", e);
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

        this.initCommunityIpfsPropsNoMerge(updateRecord.community!);
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
        this._updatingRpcCommunityInstanceWithListeners = {
            community: updatingCommunity,
            error: (err) => this.emit("error", err),
            updatingstatechange: (updatingState) => this._setUpdatingStateWithEventEmissionIfNewState.bind(this)(updatingState),
            update: (updatingCommunity) => {
                const keyChanged = updatingCommunity.publicKey && updatingCommunity.publicKey !== this.publicKey;
                if (!updatingCommunity.raw.communityIpfs || !updatingCommunity.updateCid) {
                    if (updatingCommunity.publicKey) this._clearDataForKeyMigration(updatingCommunity.publicKey);
                } else {
                    this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.communityIpfs);
                    this.updateCid = updatingCommunity.updateCid;
                    if (updatingCommunity.raw.runtimeFieldsFromRpc)
                        deepMergeRuntimeFields(this, updatingCommunity.raw.runtimeFieldsFromRpc);
                }
                if (typeof updatingCommunity.nameResolved === "boolean") this.nameResolved = updatingCommunity.nameResolved;
                // Only emit when there's actual data or a key migration — avoid spurious updates for empty subs
                if ((updatingCommunity.raw.communityIpfs && updatingCommunity.updateCid) || keyChanged) {
                    this.emit("update", this);
                }
            },
            statechange: async (newState) => {
                if (newState === "stopped" && this.state !== "stopped")
                    // pkc._updatingCommunities[address].stop() has been called, we need to clean up the subscription
                    // or pkc._startedCommunities[address].stop has been called
                    await this.stop();
            },
            challengerequest: (challengeRequest) => this.emit("challengerequest", challengeRequest),
            challengeverification: (challengeVerification) => this.emit("challengeverification", challengeVerification),
            challengeanswer: (challengeAnswer) => this.emit("challengeanswer", challengeAnswer),
            challenge: (challenge) => this.emit("challenge", challenge),
            startedstatechange: (startedState) => this._setStartedStateWithEmission.bind(this)(startedState)
        };

        this._updatingRpcCommunityInstanceWithListeners.community.on("update", this._updatingRpcCommunityInstanceWithListeners.update);
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "updatingstatechange",
            this._updatingRpcCommunityInstanceWithListeners.updatingstatechange
        );
        this._updatingRpcCommunityInstanceWithListeners.community.on("error", this._updatingRpcCommunityInstanceWithListeners.error);
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "statechange",
            this._updatingRpcCommunityInstanceWithListeners.statechange
        );
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "challengerequest",
            this._updatingRpcCommunityInstanceWithListeners.challengerequest
        );
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "challengeverification",
            this._updatingRpcCommunityInstanceWithListeners.challengeverification
        );
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "challengeanswer",
            this._updatingRpcCommunityInstanceWithListeners.challengeanswer
        );
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "challenge",
            this._updatingRpcCommunityInstanceWithListeners.challenge
        );
        this._updatingRpcCommunityInstanceWithListeners.community.on(
            "startedstatechange",
            this._updatingRpcCommunityInstanceWithListeners.startedstatechange
        );

        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (updatingCommunity.clients[clientType])
                for (const clientUrl of Object.keys(updatingCommunity.clients[clientType]))
                    this.clients[clientType][clientUrl].mirror(updatingCommunity.clients[clientType][clientUrl]);

        this._updatingRpcCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance++;
        if (!updatingCommunity.raw.communityIpfs || !updatingCommunity.updateCid) {
            if (updatingCommunity.publicKey) this._clearDataForKeyMigration(updatingCommunity.publicKey);
        } else {
            this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.communityIpfs);
            this.updateCid = updatingCommunity.updateCid;
            if (updatingCommunity.raw.runtimeFieldsFromRpc) deepMergeRuntimeFields(this, updatingCommunity.raw.runtimeFieldsFromRpc);
        }
        if (typeof updatingCommunity.nameResolved === "boolean") this.nameResolved = updatingCommunity.nameResolved;
        if (updatingCommunity.raw.communityIpfs || updatingCommunity.updateCid) {
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
            this._updateRpcSubscriptionId = await this._pkc._pkcRpcClient!.communityUpdateSubscribe({
                address: this.address,
                ...(this.name ? { name: this.name } : undefined),
                ...(this.publicKey ? { publicKey: this.publicKey } : undefined)
            });
        } catch (e) {
            log.error("Failed to receive communityUpdate from RPC due to error", e);
            this._setState("stopped");
            this._setUpdatingStateWithEventEmissionIfNewState("failed");
            throw e;
        }
        this._pkc
            ._pkcRpcClient!.getSubscription(this._updateRpcSubscriptionId)
            .on("update", this._processUpdateEventFromRpcUpdate.bind(this))
            .on("updatingstatechange", this._handleUpdatingStateChangeFromRpcUpdate.bind(this))
            .on("error", this._handleRpcErrorEvent.bind(this));

        this._pkc._pkcRpcClient!.emitAllPendingMessages(this._updateRpcSubscriptionId);
    }

    async _createAndSubscribeToNewUpdatingCommunity(updatingCommunity?: RpcRemoteCommunity) {
        const log = Logger("pkc-js:rpc-remote-community:_createNewUpdatingCommunity");
        const updatingSub =
            updatingCommunity ||
            ((await this._pkc.createCommunity({
                name: this.name,
                publicKey: this.publicKey
            })) as RpcRemoteCommunity);
        trackUpdatingCommunity(this._pkc, updatingSub);
        log("Creating a new entry for this._pkc._updatingCommunities", this.address);

        if (updatingSub !== this)
            // in pkc.createCommunity() this function is called with the community instance itself
            await this._initMirroringUpdatingCommunity(updatingSub);
        await updatingSub._initRpcUpdateSubscription();
    }

    override async update() {
        const log = Logger("pkc-js:rpc-remote-community:update");

        if (this.state === "started") throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });
        if (this.state !== "stopped") return; // No need to do anything if community is already updating
        this._setState("updating");
        try {
            const existingSub = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) as
                | RpcRemoteCommunity
                | undefined;
            if (existingSub) {
                if (existingSub === this) await this._initRpcUpdateSubscription();
                else await this._initMirroringUpdatingCommunity(existingSub);
            } else {
                const startedSub = findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
                if (startedSub) await this._initMirroringUpdatingCommunity(startedSub as RpcLocalCommunity);
                else {
                    // creating a new entry in pkc._updatingCommunities
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
        if (!this._updatingRpcCommunityInstanceWithListeners)
            throw Error("rpcRemoteCommunity.state is updating but no mirroring updating community");
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "update",
            this._updatingRpcCommunityInstanceWithListeners.update
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "updatingstatechange",
            this._updatingRpcCommunityInstanceWithListeners.updatingstatechange
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "error",
            this._updatingRpcCommunityInstanceWithListeners.error
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "statechange",
            this._updatingRpcCommunityInstanceWithListeners.statechange
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "challengerequest",
            this._updatingRpcCommunityInstanceWithListeners.challengerequest
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "challengeverification",
            this._updatingRpcCommunityInstanceWithListeners.challengeverification
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "challengeanswer",
            this._updatingRpcCommunityInstanceWithListeners.challengeanswer
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "challenge",
            this._updatingRpcCommunityInstanceWithListeners.challenge
        );
        this._updatingRpcCommunityInstanceWithListeners.community.removeListener(
            "startedstatechange",
            this._updatingRpcCommunityInstanceWithListeners.startedstatechange
        );
        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();
        this._updatingRpcCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance--;

        if (
            this._updatingRpcCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance === 0 &&
            this._updatingRpcCommunityInstanceWithListeners.community.state === "updating"
        ) {
            const log = Logger("pkc-js:rpc-remote-community:_cleanupMirroringUpdatingCommunity");
            log("Cleaning up pkc._updatingCommunities", this.address, "There are no communities using it for updates");
            await this._updatingRpcCommunityInstanceWithListeners.community.stop();
        }
        this._updatingRpcCommunityInstanceWithListeners = undefined;
    }

    override async stop() {
        const log = Logger("pkc-js:rpc-remote-community:stop");
        if (this.state === "stopped") return;

        if (this._updatingRpcCommunityInstanceWithListeners) {
            await this._cleanupMirroringUpdatingCommunity();
        } else if (this._updateRpcSubscriptionId) {
            try {
                await this._pkc._pkcRpcClient!.unsubscribe(this._updateRpcSubscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from communityUpdate", e);
            }
            this._updateRpcSubscriptionId = undefined;
            log.trace(`Stopped the update of remote community (${this.address}) via RPC`);
            untrackUpdatingCommunity(this._pkc, this);
        }
        this._setRpcClientStateWithEmission("stopped");
        this._setUpdatingStateWithEventEmissionIfNewState("stopped");
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
        this.posts._stop();
    }
}
