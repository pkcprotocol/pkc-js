import { Plebbit } from "./plebbit.js";
import { hideClassPrivateProps, isIpfsCid, isIpfsPath } from "../util.js";
import { PlebbitError } from "../plebbit-error.js";
import assert from "assert";
import * as remeda from "remeda";
import { NameResolverClient } from "../clients/name-resolver-client.js";

import {
    BaseClientsManager,
    OptionsToLoadFromGateway,
    PreResolveNameResolverOptions,
    PostResolveNameResolverSuccessOptions,
    PostResolveNameResolverFailureOptions
} from "../clients/base-client-manager.js";

import Logger from "../logger.js";
import { PlebbitIpfsGatewayClient, PlebbitKuboRpcClient, PlebbitLibp2pJsClient } from "./plebbit-clients.js";
import { GenericStateClient } from "../generic-state-client.js";

export class PlebbitClientsManager extends BaseClientsManager {
    clients: {
        ipfsGateways: { [ipfsGatewayUrl: string]: PlebbitIpfsGatewayClient };
        kuboRpcClients: { [kuboRpcClientUrl: string]: PlebbitKuboRpcClient };
        pubsubKuboRpcClients: { [pubsubKuboClientUrl: string]: GenericStateClient<string> }; // plebbit will never use this, but we're keeping it for compatibility
        libp2pJsClients: { [libp2pJsClientKey: string]: PlebbitLibp2pJsClient };
        nameResolvers: { [resolverKey: string]: NameResolverClient };
    };

    constructor(plebbit: Plebbit) {
        super(plebbit);
        this._plebbit = plebbit;
        //@ts-expect-error
        this.clients = {};
        this._initIpfsGateways();
        this._initKuboRpcClients();
        this._initPubsubKuboRpcClients();
        this._initLibp2pJsClients();
        this._initNameResolvers();
        hideClassPrivateProps(this);
    }

    protected _initIpfsGateways() {
        this.clients.ipfsGateways = {};
        for (const gatewayUrl of remeda.keys.strict(this._plebbit.clients.ipfsGateways))
            this.clients.ipfsGateways = { ...this.clients.ipfsGateways, [gatewayUrl]: new PlebbitIpfsGatewayClient("stopped") };
    }

    protected _initKuboRpcClients() {
        this.clients.kuboRpcClients = {};
        for (const kuboRpcUrl of remeda.keys.strict(this._plebbit.clients.kuboRpcClients))
            this.clients.kuboRpcClients = { ...this.clients.kuboRpcClients, [kuboRpcUrl]: new PlebbitKuboRpcClient("stopped") };
    }

    protected _initPubsubKuboRpcClients() {
        this.clients.pubsubKuboRpcClients = {};
        for (const pubsubUrl of remeda.keys.strict(this._plebbit.clients.pubsubKuboRpcClients))
            this.clients.pubsubKuboRpcClients = {
                ...this.clients.pubsubKuboRpcClients,
                [pubsubUrl]: new GenericStateClient<string>("stopped")
            };
    }

    protected _initLibp2pJsClients() {
        this.clients.libp2pJsClients = {};
        for (const libp2pJsClientKey of remeda.keys.strict(this._plebbit.clients.libp2pJsClients))
            this.clients.libp2pJsClients = { ...this.clients.libp2pJsClients, [libp2pJsClientKey]: new PlebbitLibp2pJsClient("stopped") };
    }

    protected _initNameResolvers() {
        this.clients.nameResolvers = {};
        if (this._plebbit.nameResolvers) {
            for (const resolver of this._plebbit.nameResolvers) {
                this.clients.nameResolvers[resolver.key] = new NameResolverClient("stopped");
            }
        }
    }

    // Overriding functions from base client manager here

    override preFetchGateway(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void {
        const gatewayState =
            loadOpts.recordPlebbitType === "subplebbit"
                ? this._getStatePriorToResolvingSubplebbitIpns()
                : loadOpts.recordPlebbitType === "comment-update"
                  ? "fetching-update-ipfs"
                  : loadOpts.recordPlebbitType === "comment" ||
                      loadOpts.recordPlebbitType === "generic-ipfs" ||
                      loadOpts.recordPlebbitType === "page-ipfs"
                    ? "fetching-ipfs"
                    : undefined;
        assert(gatewayState, "unable to compute the new gateway state");
        this.updateGatewayState(gatewayState, gatewayUrl);
    }

    override postFetchGatewayFailure(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {
        this.updateGatewayState("stopped", gatewayUrl);
    }

    override postFetchGatewaySuccess(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {
        this.updateGatewayState("stopped", gatewayUrl);
    }

    override postFetchGatewayAborted(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {
        this.postFetchGatewaySuccess(gatewayUrl, loadOpts);
    }

    override preResolveNameResolver({ resolveType, resolverKey }: PreResolveNameResolverOptions) {
        const newState = resolveType === "community" ? "resolving-community-name" : "resolving-author-name";
        this.updateNameResolverState(newState, resolverKey);
    }

    override postResolveNameResolverSuccess({ resolverKey }: PostResolveNameResolverSuccessOptions) {
        this.updateNameResolverState("stopped", resolverKey);
    }

    override postResolveNameResolverFailure({ resolverKey }: PostResolveNameResolverFailureOptions) {
        this.updateNameResolverState("stopped", resolverKey);
    }

    // State methods here

    updateKuboRpcPubsubState(newState: PlebbitClientsManager["clients"]["pubsubKuboRpcClients"][string]["state"], pubsubProvider: string) {
        assert(typeof pubsubProvider === "string", "Can't update pubsub state to undefined");
        assert(typeof newState === "string", "Can't update pubsub state to undefined");
        if (this.clients.pubsubKuboRpcClients[pubsubProvider].state === newState) return;
        this.clients.pubsubKuboRpcClients[pubsubProvider].state = newState;
        this.clients.pubsubKuboRpcClients[pubsubProvider].emit("statechange", newState);
    }

    updateKuboRpcState(newState: PlebbitClientsManager["clients"]["kuboRpcClients"][string]["state"], kuboRpcClientUrl: string) {
        assert(typeof newState === "string", "Can't update ipfs state to undefined");
        assert(typeof kuboRpcClientUrl === "string", "Can't update ipfs state to undefined");
        if (this.clients.kuboRpcClients[kuboRpcClientUrl].state === newState) return;
        this.clients.kuboRpcClients[kuboRpcClientUrl].state = newState;
        this.clients.kuboRpcClients[kuboRpcClientUrl].emit("statechange", newState);
    }

    updateLibp2pJsClientState(newState: PlebbitClientsManager["clients"]["libp2pJsClients"][string]["state"], libp2pJsClientKey: string) {
        assert(typeof newState === "string", "Can't update libp2p js client state to undefined");
        assert(typeof libp2pJsClientKey === "string", "Can't update libp2p js client state to undefined");
        if (this.clients.libp2pJsClients[libp2pJsClientKey].state === newState) return;
        this.clients.libp2pJsClients[libp2pJsClientKey].state = newState;
        this.clients.libp2pJsClients[libp2pJsClientKey].emit("statechange", newState);
    }

    updateGatewayState(newState: PlebbitClientsManager["clients"]["ipfsGateways"][string]["state"], gateway: string) {
        assert(typeof newState === "string", "Can't update gateway state to undefined");
        if (this.clients.ipfsGateways[gateway].state === newState) return;
        this.clients.ipfsGateways[gateway].state = newState;
        this.clients.ipfsGateways[gateway].emit("statechange", newState);
    }

    updateNameResolverState(newState: NameResolverClient["state"], resolverKey: string) {
        assert(typeof newState === "string", "Can't update name resolver state to undefined");
        if (!this.clients.nameResolvers[resolverKey]) return;
        if (this.clients.nameResolvers[resolverKey].state === newState) return;
        this.clients.nameResolvers[resolverKey].state = newState;
        this.clients.nameResolvers[resolverKey].emit("statechange", newState);
    }

    async fetchCid(cid: string): Promise<string> {
        let finalCid = remeda.clone(cid);
        if (!isIpfsCid(finalCid) && isIpfsPath(finalCid)) finalCid = finalCid.split("/")[2];
        if (!isIpfsCid(finalCid)) throw new PlebbitError("ERR_CID_IS_INVALID", { cid });
        const timeoutMs = this._plebbit._timeouts["generic-ipfs"];
        if (Object.keys(this.clients.kuboRpcClients).length > 0 || Object.keys(this.clients.libp2pJsClients).length > 0)
            return this._fetchCidP2P(cid, { maxFileSizeBytes: 1024 * 1024, timeoutMs });
        else {
            const log = Logger("plebbit-js:clients-manager:fetchCid");
            const resObj = await this.fetchFromMultipleGateways({
                root: cid,
                recordIpfsType: "ipfs",
                recordPlebbitType: "generic-ipfs",
                validateGatewayResponseFunc: async () => {}, // no need to validate body against cid here, fetchFromMultipleGateways already does it
                log,
                maxFileSizeBytes: 1024 * 1024,
                timeoutMs
            });
            return resObj.resText;
        }
    }

    // fetchSubplebbit should be here

    protected _getStatePriorToResolvingSubplebbitIpns(): "fetching-subplebbit-ipns" | "fetching-ipns" {
        return "fetching-subplebbit-ipns";
    }
}
