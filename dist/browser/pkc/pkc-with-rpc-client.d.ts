import { PKC } from "./pkc.js";
import type { InputPKCOptions } from "../types.js";
import { CreateRpcCommunityFunctionArgumentSchema } from "../community/schema.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import type { RpcLocalCommunityJson, RpcRemoteCommunityJson } from "../community/types.js";
import { z } from "zod";
import type { AuthorNameRpcParam, CidRpcParam } from "../clients/rpc-client/types.js";
export declare class PKCWithRpcClient extends PKC {
    _pkcRpcClient: NonNullable<PKC["_pkcRpcClient"]>;
    pkcRpcClientsOptions: NonNullable<PKC["pkcRpcClientsOptions"]>;
    constructor(options: InputPKCOptions);
    _init(): Promise<void>;
    fetchCid(cid: CidRpcParam): Promise<string>;
    resolveAuthorName(args: AuthorNameRpcParam): Promise<string | null>;
    destroy(): Promise<void>;
    getComment(commentCid: CidRpcParam): Promise<import("../publications/comment/comment.js").Comment>;
    createCommunity(options?: z.infer<typeof CreateRpcCommunityFunctionArgumentSchema> | RpcRemoteCommunityJson | RpcLocalCommunityJson): Promise<RpcLocalCommunity | RpcRemoteCommunity>;
}
