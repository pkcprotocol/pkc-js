import { z } from "zod";
import { RpcAuthorNameParamSchema, RpcCidParamSchema, RpcCommentRepliesPageParamSchema, RpcCommunityAddressParamSchema, RpcCommunityLookupParamSchema, RpcCommunityPageParamSchema } from "./schema.js";
export type CidRpcParam = z.infer<typeof RpcCidParamSchema>;
export type CommunityAddressRpcParam = z.infer<typeof RpcCommunityAddressParamSchema>;
export type CommunityLookupRpcParam = z.infer<typeof RpcCommunityLookupParamSchema>;
export type AuthorNameRpcParam = z.infer<typeof RpcAuthorNameParamSchema>;
export type CommentPageRpcParam = z.infer<typeof RpcCommentRepliesPageParamSchema>;
export type CommunityPageRpcParam = z.infer<typeof RpcCommunityPageParamSchema>;
