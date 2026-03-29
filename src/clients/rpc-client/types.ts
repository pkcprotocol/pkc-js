import { z } from "zod";
import {
    RpcAuthorNameParamSchema,
    RpcCidParamSchema,
    RpcCommentRepliesPageParamSchema,
    RpcSubplebbitAddressParamSchema,
    RpcSubplebbitLookupParamSchema,
    RpcSubplebbitPageParamSchema
} from "./schema.js";

export type CidRpcParam = z.infer<typeof RpcCidParamSchema>;
export type SubplebbitAddressRpcParam = z.infer<typeof RpcSubplebbitAddressParamSchema>;
export type SubplebbitLookupRpcParam = z.infer<typeof RpcSubplebbitLookupParamSchema>;
export type AuthorNameRpcParam = z.infer<typeof RpcAuthorNameParamSchema>;
export type CommentPageRpcParam = z.infer<typeof RpcCommentRepliesPageParamSchema>;
export type SubplebbitPageRpcParam = z.infer<typeof RpcSubplebbitPageParamSchema>;
