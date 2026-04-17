import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcFetchCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcEditCommunityParamSchema,
    RpcPublishChallengeAnswersParamSchema,
    RpcCommunityIdentifierParamSchema,
    RpcCommunityPageParamSchema,
    RpcUnsubscribeParamSchema,
    RpcResolveAuthorNameResultSchema,
    RpcFetchCidResultSchema,
    RpcSuccessResultSchema,
    RpcSubscriptionIdResultSchema
} from "./schema.js";

// Param parsers — all use .loose() so newer clients can send extra fields
export const parseRpcCidParam = (params: unknown) => RpcCidParamSchema.loose().parse(params);
export const parseRpcFetchCidParam = (params: unknown) => RpcFetchCidParamSchema.loose().parse(params);
export const parseRpcCommunityIdentifierParam = (params: unknown) => RpcCommunityIdentifierParamSchema.loose().parse(params);
export const parseRpcAuthorNameParam = (params: unknown) => RpcAuthorNameParamSchema.loose().parse(params);
export const parseRpcCommunityPageParam = (params: unknown) => RpcCommunityPageParamSchema.loose().parse(params);
export const parseRpcCommentRepliesPageParam = (params: unknown) => RpcCommentRepliesPageParamSchema.loose().parse(params);
export const parseRpcEditCommunityParam = (params: unknown) => RpcEditCommunityParamSchema.loose().parse(params);
export const parseRpcPublishChallengeAnswersParam = (params: unknown) => RpcPublishChallengeAnswersParamSchema.loose().parse(params);
export const parseRpcUnsubscribeParam = (params: unknown) => RpcUnsubscribeParamSchema.loose().parse(params);

// Result parsers — all use .loose() so newer servers can send extra fields
export const parseRpcResolveAuthorNameResult = (result: unknown) => RpcResolveAuthorNameResultSchema.loose().parse(result);
export const parseRpcFetchCidResult = (result: unknown) => RpcFetchCidResultSchema.loose().parse(result);
export const parseRpcSuccessResult = (result: unknown) => RpcSuccessResultSchema.loose().parse(result);
export const parseRpcSubscriptionIdResult = (result: unknown) => RpcSubscriptionIdResultSchema.loose().parse(result);
