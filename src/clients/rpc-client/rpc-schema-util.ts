import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcEditCommunityParamSchema,
    RpcPublishChallengeAnswersParamSchema,
    RpcCommunityAddressParamSchema,
    RpcCommunityLookupParamSchema,
    RpcCommunityPageParamSchema,
    RpcUnsubscribeParamSchema
} from "./schema.js";

export const parseRpcCidParam = (params: unknown) => RpcCidParamSchema.loose().parse(params);
export const parseRpcCommunityAddressParam = (params: unknown) => RpcCommunityAddressParamSchema.loose().parse(params);
export const parseRpcCommunityLookupParam = (params: unknown) => RpcCommunityLookupParamSchema.loose().parse(params);
export const parseRpcAuthorNameParam = (params: unknown) => RpcAuthorNameParamSchema.loose().parse(params);
export const parseRpcCommunityPageParam = (params: unknown) => RpcCommunityPageParamSchema.loose().parse(params);
export const parseRpcCommentRepliesPageParam = (params: unknown) => RpcCommentRepliesPageParamSchema.loose().parse(params);
export const parseRpcEditCommunityParam = (params: unknown) => RpcEditCommunityParamSchema.parse(params);
export const parseRpcPublishChallengeAnswersParam = (params: unknown) => RpcPublishChallengeAnswersParamSchema.parse(params);
export const parseRpcUnsubscribeParam = (params: unknown) => RpcUnsubscribeParamSchema.parse(params);
