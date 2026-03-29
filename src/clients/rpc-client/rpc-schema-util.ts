import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcEditSubplebbitParamSchema,
    RpcPublishChallengeAnswersParamSchema,
    RpcSubplebbitAddressParamSchema,
    RpcSubplebbitLookupParamSchema,
    RpcSubplebbitPageParamSchema,
    RpcUnsubscribeParamSchema
} from "./schema.js";

export const parseRpcCidParam = (params: unknown) => RpcCidParamSchema.loose().parse(params);
export const parseRpcSubplebbitAddressParam = (params: unknown) => RpcSubplebbitAddressParamSchema.loose().parse(params);
export const parseRpcSubplebbitLookupParam = (params: unknown) => RpcSubplebbitLookupParamSchema.loose().parse(params);
export const parseRpcAuthorNameParam = (params: unknown) => RpcAuthorNameParamSchema.loose().parse(params);
export const parseRpcSubplebbitPageParam = (params: unknown) => RpcSubplebbitPageParamSchema.loose().parse(params);
export const parseRpcCommentRepliesPageParam = (params: unknown) => RpcCommentRepliesPageParamSchema.loose().parse(params);
export const parseRpcEditSubplebbitParam = (params: unknown) => RpcEditSubplebbitParamSchema.parse(params);
export const parseRpcPublishChallengeAnswersParam = (params: unknown) => RpcPublishChallengeAnswersParamSchema.parse(params);
export const parseRpcUnsubscribeParam = (params: unknown) => RpcUnsubscribeParamSchema.parse(params);
