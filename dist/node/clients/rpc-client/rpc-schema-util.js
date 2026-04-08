import { RpcAuthorNameParamSchema, RpcCidParamSchema, RpcCommentRepliesPageParamSchema, RpcEditCommunityParamSchema, RpcPublishChallengeAnswersParamSchema, RpcCommunityAddressParamSchema, RpcCommunityLookupParamSchema, RpcCommunityPageParamSchema, RpcUnsubscribeParamSchema } from "./schema.js";
export const parseRpcCidParam = (params) => RpcCidParamSchema.loose().parse(params);
export const parseRpcCommunityAddressParam = (params) => RpcCommunityAddressParamSchema.loose().parse(params);
export const parseRpcCommunityLookupParam = (params) => RpcCommunityLookupParamSchema.loose().parse(params);
export const parseRpcAuthorNameParam = (params) => RpcAuthorNameParamSchema.loose().parse(params);
export const parseRpcCommunityPageParam = (params) => RpcCommunityPageParamSchema.loose().parse(params);
export const parseRpcCommentRepliesPageParam = (params) => RpcCommentRepliesPageParamSchema.loose().parse(params);
export const parseRpcEditCommunityParam = (params) => RpcEditCommunityParamSchema.parse(params);
export const parseRpcPublishChallengeAnswersParam = (params) => RpcPublishChallengeAnswersParamSchema.parse(params);
export const parseRpcUnsubscribeParam = (params) => RpcUnsubscribeParamSchema.parse(params);
//# sourceMappingURL=rpc-schema-util.js.map