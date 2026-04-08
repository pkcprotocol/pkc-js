import { hideClassPrivateProps, isIpfsCid, isIpfsPath } from "../util.js";
import { PKCError } from "../pkc-error.js";
import assert from "assert";
import * as remeda from "remeda";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import { BaseClientsManager } from "../clients/base-client-manager.js";
import Logger from "../logger.js";
import { PKCIpfsGatewayClient, PKCKuboRpcClient, PKCLibp2pJsClient } from "./pkc-clients.js";
import { GenericStateClient } from "../generic-state-client.js";
export class PKCClientsManager extends BaseClientsManager {
    constructor(pkc) {
        super(pkc);
        this._pkc = pkc;
        //@ts-expect-error
        this.clients = {};
        this._initIpfsGateways();
        this._initKuboRpcClients();
        this._initPubsubKuboRpcClients();
        this._initLibp2pJsClients();
        this._initNameResolvers();
        hideClassPrivateProps(this);
    }
    _initIpfsGateways() {
        this.clients.ipfsGateways = {};
        for (const gatewayUrl of remeda.keys.strict(this._pkc.clients.ipfsGateways))
            this.clients.ipfsGateways = { ...this.clients.ipfsGateways, [gatewayUrl]: new PKCIpfsGatewayClient("stopped") };
    }
    _initKuboRpcClients() {
        this.clients.kuboRpcClients = {};
        for (const kuboRpcUrl of remeda.keys.strict(this._pkc.clients.kuboRpcClients))
            this.clients.kuboRpcClients = { ...this.clients.kuboRpcClients, [kuboRpcUrl]: new PKCKuboRpcClient("stopped") };
    }
    _initPubsubKuboRpcClients() {
        this.clients.pubsubKuboRpcClients = {};
        for (const pubsubUrl of remeda.keys.strict(this._pkc.clients.pubsubKuboRpcClients))
            this.clients.pubsubKuboRpcClients = {
                ...this.clients.pubsubKuboRpcClients,
                [pubsubUrl]: new GenericStateClient("stopped")
            };
    }
    _initLibp2pJsClients() {
        this.clients.libp2pJsClients = {};
        for (const libp2pJsClientKey of remeda.keys.strict(this._pkc.clients.libp2pJsClients))
            this.clients.libp2pJsClients = { ...this.clients.libp2pJsClients, [libp2pJsClientKey]: new PKCLibp2pJsClient("stopped") };
    }
    _initNameResolvers() {
        this.clients.nameResolvers = {};
        if (this._pkc.nameResolvers) {
            for (const resolver of this._pkc.nameResolvers) {
                this.clients.nameResolvers[resolver.key] = new NameResolverClient("stopped");
            }
        }
    }
    // Overriding functions from base client manager here
    preFetchGateway(gatewayUrl, loadOpts) {
        const gatewayState = loadOpts.recordPKCType === "community"
            ? this._getStatePriorToResolvingCommunityIpns()
            : loadOpts.recordPKCType === "comment-update"
                ? "fetching-update-ipfs"
                : loadOpts.recordPKCType === "comment" ||
                    loadOpts.recordPKCType === "generic-ipfs" ||
                    loadOpts.recordPKCType === "page-ipfs"
                    ? "fetching-ipfs"
                    : undefined;
        assert(gatewayState, "unable to compute the new gateway state");
        this.updateGatewayState(gatewayState, gatewayUrl);
    }
    postFetchGatewayFailure(gatewayUrl, loadOpts) {
        this.updateGatewayState("stopped", gatewayUrl);
    }
    postFetchGatewaySuccess(gatewayUrl, loadOpts) {
        this.updateGatewayState("stopped", gatewayUrl);
    }
    postFetchGatewayAborted(gatewayUrl, loadOpts) {
        this.postFetchGatewaySuccess(gatewayUrl, loadOpts);
    }
    preResolveNameResolver({ resolveType, resolverKey }) {
        const newState = resolveType === "community" ? "resolving-community-name" : "resolving-author-name";
        this.updateNameResolverState(newState, resolverKey);
    }
    postResolveNameResolverSuccess({ resolverKey }) {
        this.updateNameResolverState("stopped", resolverKey);
    }
    postResolveNameResolverFailure({ resolverKey }) {
        this.updateNameResolverState("stopped", resolverKey);
    }
    // State methods here
    updateKuboRpcPubsubState(newState, pubsubProvider) {
        assert(typeof pubsubProvider === "string", "Can't update pubsub state to undefined");
        assert(typeof newState === "string", "Can't update pubsub state to undefined");
        if (this.clients.pubsubKuboRpcClients[pubsubProvider].state === newState)
            return;
        this.clients.pubsubKuboRpcClients[pubsubProvider].state = newState;
        this.clients.pubsubKuboRpcClients[pubsubProvider].emit("statechange", newState);
    }
    updateKuboRpcState(newState, kuboRpcClientUrl) {
        assert(typeof newState === "string", "Can't update ipfs state to undefined");
        assert(typeof kuboRpcClientUrl === "string", "Can't update ipfs state to undefined");
        if (this.clients.kuboRpcClients[kuboRpcClientUrl].state === newState)
            return;
        this.clients.kuboRpcClients[kuboRpcClientUrl].state = newState;
        this.clients.kuboRpcClients[kuboRpcClientUrl].emit("statechange", newState);
    }
    updateLibp2pJsClientState(newState, libp2pJsClientKey) {
        assert(typeof newState === "string", "Can't update libp2p js client state to undefined");
        assert(typeof libp2pJsClientKey === "string", "Can't update libp2p js client state to undefined");
        if (this.clients.libp2pJsClients[libp2pJsClientKey].state === newState)
            return;
        this.clients.libp2pJsClients[libp2pJsClientKey].state = newState;
        this.clients.libp2pJsClients[libp2pJsClientKey].emit("statechange", newState);
    }
    updateGatewayState(newState, gateway) {
        assert(typeof newState === "string", "Can't update gateway state to undefined");
        if (this.clients.ipfsGateways[gateway].state === newState)
            return;
        this.clients.ipfsGateways[gateway].state = newState;
        this.clients.ipfsGateways[gateway].emit("statechange", newState);
    }
    updateNameResolverState(newState, resolverKey) {
        assert(typeof newState === "string", "Can't update name resolver state to undefined");
        if (!this.clients.nameResolvers[resolverKey])
            return;
        if (this.clients.nameResolvers[resolverKey].state === newState)
            return;
        this.clients.nameResolvers[resolverKey].state = newState;
        this.clients.nameResolvers[resolverKey].emit("statechange", newState);
    }
    async fetchCid(cid) {
        let finalCid = remeda.clone(cid);
        if (!isIpfsCid(finalCid) && isIpfsPath(finalCid))
            finalCid = finalCid.split("/")[2];
        if (!isIpfsCid(finalCid))
            throw new PKCError("ERR_CID_IS_INVALID", { cid });
        const timeoutMs = this._pkc._timeouts["generic-ipfs"];
        if (Object.keys(this.clients.kuboRpcClients).length > 0 || Object.keys(this.clients.libp2pJsClients).length > 0)
            return this._fetchCidP2P(cid, { maxFileSizeBytes: 1024 * 1024, timeoutMs });
        else {
            const log = Logger("pkc-js:clients-manager:fetchCid");
            const resObj = await this.fetchFromMultipleGateways({
                root: cid,
                recordIpfsType: "ipfs",
                recordPKCType: "generic-ipfs",
                validateGatewayResponseFunc: async () => { }, // no need to validate body against cid here, fetchFromMultipleGateways already does it
                log,
                maxFileSizeBytes: 1024 * 1024,
                timeoutMs
            });
            return resObj.resText;
        }
    }
    // fetchCommunity should be here
    _getStatePriorToResolvingCommunityIpns() {
        return "fetching-community-ipns";
    }
}
//# sourceMappingURL=pkc-client-manager.js.map