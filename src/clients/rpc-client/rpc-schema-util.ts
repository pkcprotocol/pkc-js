import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcSubplebbitAddressParamSchema,
    RpcSubplebbitPageParamSchema
} from "./schema.js";

export const parseRpcCidParam = (params: unknown) => RpcCidParamSchema.loose().parse(params);
export const parseRpcSubplebbitAddressParam = (params: unknown) => RpcSubplebbitAddressParamSchema.loose().parse(params);
export const parseRpcAuthorNameParam = (params: unknown) => RpcAuthorNameParamSchema.loose().parse(params);
export const parseRpcSubplebbitPageParam = (params: unknown) => RpcSubplebbitPageParamSchema.loose().parse(params);
export const parseRpcCommentRepliesPageParam = (params: unknown) => RpcCommentRepliesPageParamSchema.loose().parse(params);
