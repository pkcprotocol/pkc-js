import { z } from "zod";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import { AuthorAddressSchema, CidStringSchema, SubplebbitAddressSchema } from "../../schema/schema.js";
export const SubscriptionIdSchema = z.number().positive().int();

export const RpcCommentEventResultSchema = CommentIpfsSchema.loose();
export const RpcCommentUpdateResultSchema = CommentUpdateSchema;

export const RpcCidParamSchema = z.object({ cid: CidStringSchema }).loose();
export const RpcSubplebbitAddressParamSchema = z.object({ address: SubplebbitAddressSchema });
export const RpcAuthorNameParamSchema = z.object({ address: AuthorAddressSchema });
export const RpcSubplebbitPageParamSchema = RpcCidParamSchema.extend({
    subplebbitAddress: SubplebbitAddressSchema,
    type: z.enum(["posts", "modqueue"]),
    pageMaxSize: z.number().positive().int()
});
export const RpcCommentRepliesPageParamSchema = RpcSubplebbitPageParamSchema.omit({ type: true }).extend({ commentCid: CidStringSchema });
