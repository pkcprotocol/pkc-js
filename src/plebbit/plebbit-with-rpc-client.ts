import Logger from "@plebbit/plebbit-logger";
import { Plebbit } from "./plebbit.js";
import type { InputPlebbitOptions } from "../types.js";
import { parseCreateRpcSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails } from "../schema/schema-util.js";
import { CreateRpcSubplebbitFunctionArgumentSchema } from "../subplebbit/schema.js";
import { RpcLocalSubplebbit } from "../subplebbit/rpc-local-subplebbit.js";
import { RpcRemoteSubplebbit } from "../subplebbit/rpc-remote-subplebbit.js";
import type {
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType,
    RpcLocalSubplebbitJson,
    RpcRemoteSubplebbitJson,
    SubplebbitIpfsType
} from "../subplebbit/types.js";
import { z } from "zod";
import { PlebbitError } from "../plebbit-error.js";
import type { AuthorNameRpcParam, CidRpcParam } from "../clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam } from "../clients/rpc-client/rpc-schema-util.js";

// This is a helper class for separating RPC-client logic from main Plebbit
// Not meant to be used with end users
export class PlebbitWithRpcClient extends Plebbit {
    override _plebbitRpcClient!: NonNullable<Plebbit["_plebbitRpcClient"]>;
    override plebbitRpcClientsOptions!: NonNullable<Plebbit["plebbitRpcClientsOptions"]>;
    override _startedSubplebbits: Record<string, RpcLocalSubplebbit> = {}; // storing subplebbit instance that are started rn
    override _updatingSubplebbits: Record<string, RpcLocalSubplebbit | RpcRemoteSubplebbit> = {};

    constructor(options: InputPlebbitOptions) {
        super(options);
        this._plebbitRpcClient = this.clients.plebbitRpcClients[Object.keys(this.clients.plebbitRpcClients)[0]]; // will change later once we start supporting multiple RPCs
    }

    override async _init(): Promise<void> {
        await super._init();
        const log = Logger("plebbit-js:plebbit-with-rpc-client:_init");

        this.subplebbits = [];

        this._plebbitRpcClient.on("subplebbitschange", (newSubs) => this.emit("subplebbitschange", newSubs));

        for (const rpcUrl of Object.keys(this.clients.plebbitRpcClients)) {
            const rpcClient = this.clients.plebbitRpcClients[rpcUrl];
            rpcClient.on("error", (err) => this.emit("error", err));
            rpcClient.initalizeSubplebbitschangeEvent().catch((err) => {
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
        for (const startedSubplebbit of Object.values(this._startedSubplebbits)) {
            await startedSubplebbit.stopWithoutRpcCall();
        }
        await super.destroy();
        await this._plebbitRpcClient.destroy();
    }

    override async getComment(commentCid: CidRpcParam) {
        const parsedArgs = parseRpcCidParam(commentCid);

        const commentIpfs = await this._plebbitRpcClient.getComment(parsedArgs);
        return this.createComment({ raw: { comment: commentIpfs }, cid: parsedArgs.cid });
    }

    override async createSubplebbit(
        options: z.infer<typeof CreateRpcSubplebbitFunctionArgumentSchema> | RpcRemoteSubplebbitJson | RpcLocalSubplebbitJson = {}
    ): Promise<RpcLocalSubplebbit | RpcRemoteSubplebbit> {
        const log = Logger("plebbit-js:plebbit-with-rpc-client:createSubplebbit");

        if (options instanceof RpcRemoteSubplebbit) return options; // not sure why somebody would call createSubplebbit with an instance, will probably change later

        // No need to parse if it's a jsonified instance
        const parsedRpcOptions =
            "clients" in options ? options : parseCreateRpcSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails(options);

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
            await this._waitForSubplebbitsToBeDefined();
            const rpcSubs = this.subplebbits; // should probably be replaced with a direct call for subs
            const isSubRpcLocal = rpcSubs.includes(effectiveAddress);

            if ("clients" in options && isSubRpcLocal) {
                // Jsonified local sub — rehydrate from provided data instead of doing a fresh RPC fetch
                const sub = new RpcLocalSubplebbit(this);
                const jsonified = parsedRpcOptions as unknown as RpcLocalSubplebbitJson;
                if (jsonified.signature) {
                    sub.initRpcInternalSubplebbitAfterFirstUpdateNoMerge({
                        ...jsonified,
                        runtimeFields: { updateCid: jsonified.updateCid }
                    } as unknown as RpcInternalSubplebbitRecordAfterFirstUpdateType);
                } else {
                    sub.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(
                        jsonified as unknown as RpcInternalSubplebbitRecordBeforeFirstUpdateType
                    );
                }
                return sub;
            } else if (isSubRpcLocal) {
                // No jsonified data — do a fresh fetch
                const sub = new RpcLocalSubplebbit(this);
                sub.setAddress(effectiveAddress!);
                // wait for one update here, and then stop
                const updatePromise = new Promise((resolve) => sub.once("update", resolve));
                let error: PlebbitError | Error | undefined;
                const errorPromise = new Promise((resolve) => sub.once("error", (err) => resolve((error = err))));
                await sub._createAndSubscribeToNewUpdatingSubplebbit(sub);
                await sub.update();
                await Promise.race([updatePromise, errorPromise]);
                await sub.stop();
                if (error) throw error;

                return sub;
            } else {
                log.trace("Creating a remote RPC subplebbit instance with address", effectiveAddress);
                const remoteSub = new RpcRemoteSubplebbit(this);
                await this._setSubplebbitIpfsOnInstanceIfPossible(remoteSub, parsedRpcOptions);

                return remoteSub;
            }
        } else if (!hasIdentifier) {
            // We're creating a new local sub
            const subPropsAfterCreation = await this._plebbitRpcClient!.createSubplebbit(parsedRpcOptions);
            log(
                `Created new local-RPC subplebbit (${subPropsAfterCreation.address}) with props:`,
                JSON.parse(JSON.stringify(subPropsAfterCreation))
            );
            const sub = new RpcLocalSubplebbit(this);
            await sub.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge(subPropsAfterCreation);
            sub.emit("update", sub);
            await this._awaitSubplebbitsToIncludeSub(subPropsAfterCreation.address);
            return sub;
        } else throw Error("Failed to create subplebbit rpc instance, are you sure you provided the correct args?");
    }
}
