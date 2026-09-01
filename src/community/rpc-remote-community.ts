import Logger from "../logger.js";
import { RemoteCommunity } from "./remote-community.js";
import type { RpcRemoteCommunityType, CommunityEvents, CommunityRpcErrorToTransmit } from "./types.js";
import { keys } from "remeda";
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
        const currentRpcUrl = keys(this.clients.pkcRpcClients)[0];
        const currentState = this.clients.pkcRpcClients[currentRpcUrl].state;
        if (newState === currentState) return;
        this.clients.pkcRpcClients[currentRpcUrl].state = newState;
    }

    protected _setRpcClientStateWithEmission(newState: RemoteCommunity["clients"]["pkcRpcClients"][""]["state"]) {
        const currentRpcUrl = keys(this.clients.pkcRpcClients)[0];
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

        // Apply the resolved IPNS chain BEFORE initializing the community record. For a delegated
        // community the content is signed by the terminal (minter) key, so publicKey/address must be
        // derived from ipnsHops[0] (the anchor) inside initCommunityIpfsPropsNoMerge. Merging ipnsHops
        // afterwards (via deepMergeRuntimeFields) would be too late — publicKey would already have been
        // derived from the minter signature and address is immutable once set. See docs/protocol/delegated-ipns.md.
        if (Array.isArray(updateRecord.runtimeFields.ipnsHops)) this._ipnsHops = updateRecord.runtimeFields.ipnsHops;
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
                const nameResolvedBeforeMirror = this.nameResolved;
                if (!updatingCommunity.raw.communityIpfs || !updatingCommunity.updateCid) {
                    if (updatingCommunity.publicKey) this._clearDataForKeyMigration(updatingCommunity.publicKey);
                } else {
                    // Mirror the resolved IPNS chain before initializing the record so publicKey/address
                    // anchor to ipnsHops[0] rather than the minter signature. See docs/protocol/delegated-ipns.md.
                    if (Array.isArray(updatingCommunity.ipnsHops)) this._ipnsHops = updatingCommunity.ipnsHops;
                    this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.communityIpfs);
                    this.updateCid = updatingCommunity.updateCid;
                    if (updatingCommunity.raw.runtimeFieldsFromRpc)
                        deepMergeRuntimeFields(this, updatingCommunity.raw.runtimeFieldsFromRpc);
                }
                this._adoptMirroredNameResolved(updatingCommunity, nameResolvedBeforeMirror);
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

        const clientKeys = keys(this.clients);

        for (const clientType of clientKeys)
            if (updatingCommunity.clients[clientType])
                for (const clientUrl of Object.keys(updatingCommunity.clients[clientType]))
                    this.clients[clientType][clientUrl].mirror(updatingCommunity.clients[clientType][clientUrl]);

        this._updatingRpcCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance++;
        const nameResolvedBeforeMirror = this.nameResolved;
        if (!updatingCommunity.raw.communityIpfs || !updatingCommunity.updateCid) {
            if (updatingCommunity.publicKey) this._clearDataForKeyMigration(updatingCommunity.publicKey);
        } else {
            // Mirror the resolved IPNS chain before initializing the record so publicKey/address
            // anchor to ipnsHops[0] rather than the minter signature. See docs/protocol/delegated-ipns.md.
            if (Array.isArray(updatingCommunity.ipnsHops)) this._ipnsHops = updatingCommunity.ipnsHops;
            this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.communityIpfs);
            this.updateCid = updatingCommunity.updateCid;
            if (updatingCommunity.raw.runtimeFieldsFromRpc) deepMergeRuntimeFields(this, updatingCommunity.raw.runtimeFieldsFromRpc);
        }
        this._adoptMirroredNameResolved(updatingCommunity, nameResolvedBeforeMirror);
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
        let subscriptionId: number;
        try {
            ({ subscriptionId } = await this._pkc._pkcRpcClient!.communityUpdateSubscribe({
                name: this.name,
                publicKey: this.publicKey
            }));
            this._updateRpcSubscriptionId = subscriptionId;
        } catch (e) {
            log.error("Failed to receive communityUpdate from RPC due to error", e);
            this._setState("stopped");
            this._setUpdatingStateWithEventEmissionIfNewState("failed");
            throw e;
        }
        // Attach the notification handlers and replay the buffered notifications in a macrotask so
        // a listener attached synchronously after `await update()` resolves still receives events
        // the server emitted at subscribe time (#299). A microtask is not enough: it is enqueued
        // before the promise-resolution jobs that unwind the awaits, so it would still run before
        // the caller's continuation. Attaching the handlers inside the same deferred task keeps
        // delivery ordered: notifications arriving in the window find no listeners, so the client
        // buffers them and the replay drains everything in arrival order.
        setTimeout(() => {
            const rpcClient = this._pkc._pkcRpcClient;
            // The community may have been stopped, restarted, or the RPC client destroyed in the meantime
            if (this._updateRpcSubscriptionId !== subscriptionId || !rpcClient?.subscriptionActive(subscriptionId)) return;
            try {
                rpcClient
                    .getSubscription(subscriptionId)
                    .on("update", this._processUpdateEventFromRpcUpdate.bind(this))
                    .on("updatingstatechange", this._handleUpdatingStateChangeFromRpcUpdate.bind(this))
                    .on("error", this._handleRpcErrorEvent.bind(this));
                rpcClient.emitAllPendingMessages(subscriptionId);
            } catch (e) {
                // A handler throw during the replay (e.g. a replayed "error" event that bubbled to a
                // pkc instance with no "error" listeners) used to reject update() when the replay was
                // synchronous; update() has already resolved here, so contain the throw (it would
                // otherwise escape the timer as an uncaughtException and crash the process) and stop
                // the community so it does not stay "updating" with a half-initialized subscription
                log.error("Error thrown while replaying buffered subscribe-time notifications, stopping the community", e);
                this.stop().catch((stopError) => log.error("Failed to stop the community after a replay error", stopError));
            }
        }, 0);
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
        const clientKeys = keys(this.clients);

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
            // Untrack before stop() to prevent findUpdatingCommunity from returning a dying entry
            // during the async stop window (stop() awaits RPC unsubscribe)
            untrackUpdatingCommunity(this._pkc, this._updatingRpcCommunityInstanceWithListeners.community);
            await this._updatingRpcCommunityInstanceWithListeners.community.stop();
        }
        this._updatingRpcCommunityInstanceWithListeners = undefined;
    }

    override async stop() {
        const log = Logger("pkc-js:rpc-remote-community:stop");
        if (this.state === "stopped") return;

        if (this._updatingRpcCommunityInstanceWithListeners) {
            await this._cleanupMirroringUpdatingCommunity();
        } else {
            if (this._updateRpcSubscriptionId) {
                // Clear the id synchronously, before the awaited unsubscribe round trip, so the
                // deferred attach-and-replay timer from _initRpcUpdateSubscription (#299) sees the
                // stop immediately. Clearing it after the await left a window where the timer fired
                // mid-stop and replayed buffered events into a stopping community
                const subscriptionId = this._updateRpcSubscriptionId;
                this._updateRpcSubscriptionId = undefined;
                try {
                    await this._pkc._pkcRpcClient!.unsubscribe(subscriptionId);
                } catch (e) {
                    log.error("Failed to unsubscribe from communityUpdate", e);
                }
                log.trace(`Stopped the update of remote community (${this.address}) via RPC`);
            }
            // Untracked even without a subscription id. _createAndSubscribeToNewUpdatingCommunity
            // tracks the instance BEFORE _initRpcUpdateSubscription assigns that id, so a subscribe
            // that fails or is cancelled used to leave a stopped instance sitting in
            // _updatingCommunities for findUpdatingCommunity to hand out (issue #277). untrack() is
            // identity-keyed and a no-op for an instance that was never tracked.
            untrackUpdatingCommunity(this._pkc, this);
        }
        this._setRpcClientStateWithEmission("stopped");
        this._setUpdatingStateWithEventEmissionIfNewState("stopped");
        this._setState("stopped");
        this._setStartedStateWithEmission("stopped");
        this.posts._stop();
    }
}
