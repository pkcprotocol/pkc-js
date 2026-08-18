import Logger from "../logger.js";
import { PKC } from "./pkc.js";
import type { InputPKCOptions, GetCommunityArgs, GetCommentArgs } from "../types.js";
import { parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails } from "../schema/schema-util.js";
import { CreateRpcCommunityFunctionArgumentSchema } from "../community/schema.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import type { RpcLocalCommunityJson, RpcLocalCommunityUpdateResultType, RpcRemoteCommunityJson } from "../community/types.js";
import { z } from "zod";
import { PKCError } from "../pkc-error.js";
import { rejectWhenAbortSignalFires, rejectWhenCommunityStopsOrAborts, throwIfAbortSignalAborted } from "../util.js";
import type { AuthorNameRpcParam, CidRpcParam } from "../clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam, parseRpcFetchCidParam } from "../clients/rpc-client/rpc-schema-util.js";
import { listStartedCommunities } from "./tracked-instance-registry-util.js";
import { CommentJson } from "../publications/comment/types.js";
import type PKCRpcClient from "../clients/rpc-client/pkc-rpc-client.js";

// This is a helper class for separating RPC-client logic from main PKC
// Not meant to be used with end users
export class PKCWithRpcClient extends PKC {
    override _pkcRpcClient!: NonNullable<PKC["_pkcRpcClient"]>;
    override pkcRpcClientsOptions!: NonNullable<PKC["pkcRpcClientsOptions"]>;

    constructor(options: InputPKCOptions) {
        super(options);
        this._pkcRpcClient = this.clients.pkcRpcClients[Object.keys(this.clients.pkcRpcClients)[0]]; // will change later once we start supporting multiple RPCs
    }

    override async _init(): Promise<void> {
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

    override async fetchCid(cid: CidRpcParam) {
        const parsedCid = parseRpcFetchCidParam(cid).cid;
        return this._pkcRpcClient.fetchCid({ cid: parsedCid });
    }

    override async resolveAuthorName(args: AuthorNameRpcParam) {
        const parsedArgs = parseRpcAuthorNameParam(args);
        return this._pkcRpcClient.resolveAuthorName(parsedArgs);
    }

    override async destroy() {
        for (const startedCommunity of listStartedCommunities(this)) {
            await startedCommunity.stopWithoutRpcCall();
        }
        await super.destroy();
        await this._pkcRpcClient.destroy();
    }

    // The RPC call below has no cancellation of its own, so an aborting caller (and pkc.destroy(),
    // which cannot reach into this function) would be left waiting on it. Racing the combined signal
    // gives them a way out, matching the direct path in PKC.getComment (issue #278).
    override async getComment(getCommentArgs: GetCommentArgs) {
        const { abortSignal, ...cidArgs } = getCommentArgs;
        const parsedArgs = parseRpcCidParam(cidArgs);
        const cancellation = rejectWhenAbortSignalFires({
            abortSignal: this._combineWithDestroyAbortSignal(abortSignal),
            error: () => new PKCError("ERR_GET_COMMENT_ABORTED", { getCommentArgs: parsedArgs, abortReason: abortSignal?.reason })
        });
        let commentIpfs: Awaited<ReturnType<PKCRpcClient["getComment"]>>;
        try {
            commentIpfs = await Promise.race([this._pkcRpcClient.getComment(parsedArgs), cancellation.promise]);
        } finally {
            cancellation.cleanup();
        }
        return this.createComment({ ...parsedArgs, raw: { ...(parsedArgs as CommentJson)?.raw, comment: commentIpfs } });
    }

    override async getCommunity(getCommunityArgs: GetCommunityArgs) {
        if (!getCommunityArgs.address && !getCommunityArgs.name && !getCommunityArgs.publicKey) {
            throw new Error("At least one of address, name, or publicKey must be provided");
        }
        return super.getCommunity(getCommunityArgs);
    }

    override async createCommunity(
        options: z.infer<typeof CreateRpcCommunityFunctionArgumentSchema> | RpcRemoteCommunityJson | RpcLocalCommunityJson = {},
        opts?: { abortSignal?: AbortSignal }
    ): Promise<RpcLocalCommunity | RpcRemoteCommunity> {
        const log = Logger("pkc-js:pkc-with-rpc-client:createCommunity");
        throwIfAbortSignalAborted(opts?.abortSignal);

        // No need to parse if it's a jsonified instance
        const parsedRpcOptions =
            "clients" in options ? options : parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(options);

        log.trace("Received community options to create a community instance over RPC:", options);

        const hasIdentifier =
            ("address" in parsedRpcOptions && typeof parsedRpcOptions.address === "string") ||
            ("name" in parsedRpcOptions && typeof parsedRpcOptions.name === "string") ||
            ("publicKey" in parsedRpcOptions && typeof parsedRpcOptions.publicKey === "string");
        const effectiveAddress =
            ((parsedRpcOptions as Record<string, unknown>).address as string | undefined) ||
            ((parsedRpcOptions as Record<string, unknown>).name as string | undefined) ||
            ((parsedRpcOptions as Record<string, unknown>).publicKey as string | undefined);

        if (hasIdentifier && effectiveAddress) {
            await this._waitForCommunitiesToBeDefined();
            const rpcCommunities = this.communities; // should probably be replaced with a direct call for communities
            const isCommunityRpcLocal = rpcCommunities.includes(effectiveAddress);

            if ("clients" in options && isCommunityRpcLocal) {
                // Jsonified local community — rehydrate from raw.localCommunity instead of doing a fresh RPC fetch
                const community = new RpcLocalCommunity(this);
                const jsonified = parsedRpcOptions as unknown as RpcLocalCommunityJson;
                const rawRecord = (jsonified.raw as RpcLocalCommunity["raw"] | undefined)?.localCommunity as
                    | RpcLocalCommunityUpdateResultType
                    | undefined;
                if (rawRecord) {
                    if ("community" in rawRecord) community.initRpcInternalCommunityAfterFirstUpdateNoMerge(rawRecord);
                    else community.initRpcInternalCommunityBeforeFirstUpdateNoMerge(rawRecord);
                }
                if (jsonified.raw) Object.assign(community.raw, jsonified.raw);
                await community._attachExportsSubscription();
                return community;
            } else if (isCommunityRpcLocal) {
                // No jsonified data — do a fresh fetch
                const community = new RpcLocalCommunity(this);
                community.setAddress(effectiveAddress!);
                // wait for one update here, and then stop
                const updatePromise = new Promise((resolve) => community.once("update", resolve));
                let error: PKCError | Error | undefined;
                const errorPromise = new Promise((resolve) => community.once("error", (err) => resolve((error = err))));
                // Every wait below is unbounded: the subscribe call may never be answered, and the
                // server may never push an update for a community it hosts. Without something to
                // lose to, an aborting caller (and pkc.destroy(), which cannot reach into this
                // function) is left with a promise that never settles — issue #277. The instance is
                // tracked in _updatingCommunities before the first wait, so a third-party stop()
                // reaches it too, and that is the second way out.
                const cancellation = rejectWhenCommunityStopsOrAborts({
                    community,
                    abortSignal: this._combineWithDestroyAbortSignal(opts?.abortSignal)
                });
                try {
                    await Promise.race([community._createAndSubscribeToNewUpdatingCommunity(community), cancellation.promise]);
                    await Promise.race([community.update(), cancellation.promise]);
                    await Promise.race([updatePromise, errorPromise, cancellation.promise]);
                } catch (e) {
                    // stop() is a no-op on an instance that is already stopped, which is exactly the
                    // case when we lost to a stop rather than to an abort.
                    await community.stop().catch((stopErr) => log.error("Failed to stop a cancelled community instance", stopErr));
                    throw e;
                } finally {
                    cancellation.cleanup();
                }
                await community.stop();
                if (error) throw error;
                await community._attachExportsSubscription();
                return community;
            } else {
                log.trace("Creating a remote RPC community instance with address", effectiveAddress);
                const remoteCommunity = new RpcRemoteCommunity(this);
                await this._setCommunityIpfsOnInstanceIfPossible(remoteCommunity, parsedRpcOptions);

                return remoteCommunity;
            }
        } else if (!hasIdentifier) {
            // Check if this looks like a CommunityIpfs record — handle as remote community init
            if ("signature" in parsedRpcOptions) {
                const remoteCommunity = new RpcRemoteCommunity(this);
                await this._setCommunityIpfsOnInstanceIfPossible(remoteCommunity, parsedRpcOptions);
                return remoteCommunity;
            }
            // We're creating a new local community
            const communityPropsAfterCreation = await this._pkcRpcClient!.createCommunity(parsedRpcOptions);
            log(
                `Created new local-RPC community (${communityPropsAfterCreation.localCommunity.address}) with props:`,
                JSON.parse(JSON.stringify(communityPropsAfterCreation))
            );
            const community = new RpcLocalCommunity(this);
            await community.initRpcInternalCommunityBeforeFirstUpdateNoMerge(communityPropsAfterCreation);
            community.emit("update", community);
            await this._awaitCommunitiesToIncludeCommunity(communityPropsAfterCreation.localCommunity.address);
            await community._attachExportsSubscription();
            return community;
        } else throw Error("Failed to create community rpc instance, are you sure you provided the correct args?");
    }
}
