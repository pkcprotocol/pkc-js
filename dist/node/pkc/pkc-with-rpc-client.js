import Logger from "../logger.js";
import { PKC } from "./pkc.js";
import { parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails } from "../schema/schema-util.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "../clients/rpc-client/rpc-schema-util.js";
import { listStartedCommunities } from "./tracked-instance-registry-util.js";
// This is a helper class for separating RPC-client logic from main PKC
// Not meant to be used with end users
export class PKCWithRpcClient extends PKC {
    constructor(options) {
        super(options);
        this._pkcRpcClient = this.clients.pkcRpcClients[Object.keys(this.clients.pkcRpcClients)[0]]; // will change later once we start supporting multiple RPCs
    }
    async _init() {
        await super._init();
        const log = Logger("pkc-js:pkc-with-rpc-client:_init");
        this.communities = [];
        this._pkcRpcClient.on("communitieschange", (newSubs) => this.emit("communitieschange", newSubs));
        for (const rpcUrl of Object.keys(this.clients.pkcRpcClients)) {
            const rpcClient = this.clients.pkcRpcClients[rpcUrl];
            rpcClient.on("error", (err) => this.emit("error", err));
            rpcClient.initalizeCommunitieschangeEvent().catch((err) => {
                log.error("Failed to initialize RPC", rpcUrl, "communitieschange event", err);
            });
            rpcClient.initalizeSettingschangeEvent().catch((err) => {
                log.error("Failed to initialize RPC", rpcUrl, "settingschange event", err);
            });
        }
        // TODO merge different pkcRpcClient.communities
        this._pkcRpcClient.on("settingschange", (newSettings) => {
            this.emit("settingschange", newSettings.pkcOptions);
        });
    }
    async fetchCid(cid) {
        const parsedCid = parseRpcCidParam(cid).cid;
        return this._pkcRpcClient.fetchCid({ cid: parsedCid });
    }
    async resolveAuthorName(args) {
        const parsedArgs = parseRpcAuthorNameParam(args);
        return this._pkcRpcClient.resolveAuthorName(parsedArgs);
    }
    async destroy() {
        for (const startedCommunity of listStartedCommunities(this)) {
            await startedCommunity.stopWithoutRpcCall();
        }
        await super.destroy();
        await this._pkcRpcClient.destroy();
    }
    async getComment(commentCid) {
        const parsedArgs = parseRpcCidParam(commentCid);
        const commentIpfs = await this._pkcRpcClient.getComment(parsedArgs);
        return this.createComment({ raw: { comment: commentIpfs }, cid: parsedArgs.cid });
    }
    async createCommunity(options = {}) {
        const log = Logger("pkc-js:pkc-with-rpc-client:createCommunity");
        // No need to parse if it's a jsonified instance
        const parsedRpcOptions = "clients" in options ? options : parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(options);
        log.trace("Received community options to create a community instance over RPC:", options);
        const hasIdentifier = ("address" in parsedRpcOptions && typeof parsedRpcOptions.address === "string") ||
            ("name" in parsedRpcOptions && typeof parsedRpcOptions.name === "string") ||
            ("publicKey" in parsedRpcOptions && typeof parsedRpcOptions.publicKey === "string");
        const effectiveAddress = parsedRpcOptions.address ||
            parsedRpcOptions.name ||
            parsedRpcOptions.publicKey;
        if (hasIdentifier && effectiveAddress) {
            await this._waitForCommunitiesToBeDefined();
            const rpcCommunities = this.communities; // should probably be replaced with a direct call for communities
            const isCommunityRpcLocal = rpcCommunities.includes(effectiveAddress);
            if ("clients" in options && isCommunityRpcLocal) {
                // Jsonified local community — rehydrate from raw.localCommunity instead of doing a fresh RPC fetch
                const community = new RpcLocalCommunity(this);
                const jsonified = parsedRpcOptions;
                const rawRecord = jsonified.raw?.localCommunity;
                if (rawRecord) {
                    if ("community" in rawRecord)
                        community.initRpcInternalCommunityAfterFirstUpdateNoMerge(rawRecord);
                    else
                        community.initRpcInternalCommunityBeforeFirstUpdateNoMerge(rawRecord);
                }
                if (jsonified.raw)
                    Object.assign(community.raw, jsonified.raw);
                return community;
            }
            else if (isCommunityRpcLocal) {
                // No jsonified data — do a fresh fetch
                const community = new RpcLocalCommunity(this);
                community.setAddress(effectiveAddress);
                // wait for one update here, and then stop
                const updatePromise = new Promise((resolve) => community.once("update", resolve));
                let error;
                const errorPromise = new Promise((resolve) => community.once("error", (err) => resolve((error = err))));
                await community._createAndSubscribeToNewUpdatingCommunity(community);
                await community.update();
                await Promise.race([updatePromise, errorPromise]);
                await community.stop();
                if (error)
                    throw error;
                return community;
            }
            else {
                log.trace("Creating a remote RPC community instance with address", effectiveAddress);
                const remoteCommunity = new RpcRemoteCommunity(this);
                await this._setCommunityIpfsOnInstanceIfPossible(remoteCommunity, parsedRpcOptions);
                return remoteCommunity;
            }
        }
        else if (!hasIdentifier) {
            // Check if this looks like a CommunityIpfs record — handle as remote community init
            if ("signature" in parsedRpcOptions) {
                const remoteCommunity = new RpcRemoteCommunity(this);
                await this._setCommunityIpfsOnInstanceIfPossible(remoteCommunity, parsedRpcOptions);
                return remoteCommunity;
            }
            // We're creating a new local community
            const communityPropsAfterCreation = await this._pkcRpcClient.createCommunity(parsedRpcOptions);
            log(`Created new local-RPC community (${communityPropsAfterCreation.localCommunity.address}) with props:`, JSON.parse(JSON.stringify(communityPropsAfterCreation)));
            const community = new RpcLocalCommunity(this);
            await community.initRpcInternalCommunityBeforeFirstUpdateNoMerge(communityPropsAfterCreation);
            community.emit("update", community);
            await this._awaitCommunitiesToIncludeCommunity(communityPropsAfterCreation.localCommunity.address);
            return community;
        }
        else
            throw Error("Failed to create community rpc instance, are you sure you provided the correct args?");
    }
}
//# sourceMappingURL=pkc-with-rpc-client.js.map