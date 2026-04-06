import Logger from "../logger.js";
import { PKC } from "./pkc.js";
import type { InputPKCOptions } from "../types.js";
import { parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails } from "../schema/schema-util.js";
import { CreateRpcCommunityFunctionArgumentSchema } from "../community/schema.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import type { RpcLocalCommunityJson, RpcLocalCommunityUpdateResultType, RpcRemoteCommunityJson } from "../community/types.js";
import { z } from "zod";
import { PKCError } from "../pkc-error.js";
import type { AuthorNameRpcParam, CidRpcParam } from "../clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "../clients/rpc-client/rpc-schema-util.js";
import { listStartedCommunitys } from "./tracked-instance-registry-util.js";

// This is a helper class for separating RPC-client logic from main PKC
// Not meant to be used with end users
export class PKCWithRpcClient extends PKC {
    override _plebbitRpcClient!: NonNullable<PKC["_plebbitRpcClient"]>;
    override pkcRpcClientsOptions!: NonNullable<PKC["pkcRpcClientsOptions"]>;

    constructor(options: InputPKCOptions) {
        super(options);
        this._plebbitRpcClient = this.clients.plebbitRpcClients[Object.keys(this.clients.plebbitRpcClients)[0]]; // will change later once we start supporting multiple RPCs
    }

    override async _init(): Promise<void> {
        await super._init();
        const log = Logger("pkc-js:pkc-with-rpc-client:_init");

        this.subplebbits = [];

        this._plebbitRpcClient.on("subplebbitschange", (newSubs) => this.emit("subplebbitschange", newSubs));

        for (const rpcUrl of Object.keys(this.clients.plebbitRpcClients)) {
            const rpcClient = this.clients.plebbitRpcClients[rpcUrl];
            rpcClient.on("error", (err) => this.emit("error", err));
            rpcClient.initalizeCommunityschangeEvent().catch((err) => {
                log.error("Failed to initialize RPC", rpcUrl, "subplebbitschange event", err);
            });
            rpcClient.initalizeSettingschangeEvent().catch((err) => {
                log.error("Failed to initialize RPC", rpcUrl, "settingschange event", err);
            });
        }
        // TODO merge different plebbitRpcClient.subplebbits

        this._plebbitRpcClient.on("settingschange", (newSettings) => {
            this.emit("settingschange", newSettings.plebbitOptions);
        });
    }

    override async fetchCid(cid: CidRpcParam) {
        const parsedCid = parseRpcCidParam(cid).cid;
        return this._plebbitRpcClient.fetchCid({ cid: parsedCid });
    }

    override async resolveAuthorName(args: AuthorNameRpcParam) {
        const parsedArgs = parseRpcAuthorNameParam(args);
        return this._plebbitRpcClient.resolveAuthorName(parsedArgs);
    }

    override async destroy() {
        for (const startedCommunity of listStartedCommunitys(this)) {
            await startedCommunity.stopWithoutRpcCall();
        }
        await super.destroy();
        await this._plebbitRpcClient.destroy();
    }

    override async getComment(commentCid: CidRpcParam) {
        const parsedArgs = parseRpcCidParam(commentCid);

        const commentIpfs = await this._plebbitRpcClient.getComment(parsedArgs);
        return this.createComment({ raw: { comment: commentIpfs }, cid: parsedArgs.cid });
    }

    override async createCommunity(
        options: z.infer<typeof CreateRpcCommunityFunctionArgumentSchema> | RpcRemoteCommunityJson | RpcLocalCommunityJson = {}
    ): Promise<RpcLocalCommunity | RpcRemoteCommunity> {
        const log = Logger("pkc-js:pkc-with-rpc-client:createCommunity");

        // No need to parse if it's a jsonified instance
        const parsedRpcOptions =
            "clients" in options ? options : parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(options);

        log.trace("Received subplebbit options to create a subplebbit instance over RPC:", options);

        const hasIdentifier =
            ("address" in parsedRpcOptions && typeof parsedRpcOptions.address === "string") ||
            ("name" in parsedRpcOptions && typeof parsedRpcOptions.name === "string") ||
            ("publicKey" in parsedRpcOptions && typeof parsedRpcOptions.publicKey === "string");
        const effectiveAddress =
            ((parsedRpcOptions as Record<string, unknown>).address as string | undefined) ||
            ((parsedRpcOptions as Record<string, unknown>).name as string | undefined) ||
            ((parsedRpcOptions as Record<string, unknown>).publicKey as string | undefined);

        if (hasIdentifier && effectiveAddress) {
            await this._waitForCommunitysToBeDefined();
            const rpcSubs = this.subplebbits; // should probably be replaced with a direct call for subs
            const isSubRpcLocal = rpcSubs.includes(effectiveAddress);

            if ("clients" in options && isSubRpcLocal) {
                // Jsonified local sub — rehydrate from raw.localCommunity instead of doing a fresh RPC fetch
                const sub = new RpcLocalCommunity(this);
                const jsonified = parsedRpcOptions as unknown as RpcLocalCommunityJson;
                const rawRecord = (jsonified.raw as RpcLocalCommunity["raw"] | undefined)?.localCommunity as
                    | RpcLocalCommunityUpdateResultType
                    | undefined;
                if (rawRecord) {
                    if ("subplebbit" in rawRecord) sub.initRpcInternalCommunityAfterFirstUpdateNoMerge(rawRecord);
                    else sub.initRpcInternalCommunityBeforeFirstUpdateNoMerge(rawRecord);
                }
                if (jsonified.raw) Object.assign(sub.raw, jsonified.raw);
                return sub;
            } else if (isSubRpcLocal) {
                // No jsonified data — do a fresh fetch
                const sub = new RpcLocalCommunity(this);
                sub.setAddress(effectiveAddress!);
                // wait for one update here, and then stop
                const updatePromise = new Promise((resolve) => sub.once("update", resolve));
                let error: PKCError | Error | undefined;
                const errorPromise = new Promise((resolve) => sub.once("error", (err) => resolve((error = err))));
                await sub._createAndSubscribeToNewUpdatingCommunity(sub);
                await sub.update();
                await Promise.race([updatePromise, errorPromise]);
                await sub.stop();
                if (error) throw error;

                return sub;
            } else {
                log.trace("Creating a remote RPC subplebbit instance with address", effectiveAddress);
                const remoteSub = new RpcRemoteCommunity(this);
                await this._setCommunityIpfsOnInstanceIfPossible(remoteSub, parsedRpcOptions);

                return remoteSub;
            }
        } else if (!hasIdentifier) {
            // Check if this looks like a CommunityIpfs record — handle as remote sub init
            if ("signature" in parsedRpcOptions) {
                const remoteSub = new RpcRemoteCommunity(this);
                await this._setCommunityIpfsOnInstanceIfPossible(remoteSub, parsedRpcOptions);
                return remoteSub;
            }
            // We're creating a new local sub
            const subPropsAfterCreation = await this._plebbitRpcClient!.createCommunity(parsedRpcOptions);
            log(
                `Created new local-RPC subplebbit (${subPropsAfterCreation.localCommunity.address}) with props:`,
                JSON.parse(JSON.stringify(subPropsAfterCreation))
            );
            const sub = new RpcLocalCommunity(this);
            await sub.initRpcInternalCommunityBeforeFirstUpdateNoMerge(subPropsAfterCreation);
            sub.emit("update", sub);
            await this._awaitCommunitysToIncludeSub(subPropsAfterCreation.localCommunity.address);
            return sub;
        } else throw Error("Failed to create subplebbit rpc instance, are you sure you provided the correct args?");
    }
}
