import { z } from "zod";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import { AuthorAddressSchema, ChallengeAnswersSchema, CidStringSchema, SubplebbitAddressSchema } from "../../schema/schema.js";
import { SubplebbitEditOptionsSchema } from "../../subplebbit/schema.js";
import type { EncodedDecryptedChallengeVerificationMessageType } from "../../pubsub-messages/types.js";
export const SubscriptionIdSchema = z.number().positive().int();

export const RpcCommentEventResultSchema = z.object({
    comment: CommentIpfsSchema,
    runtimeFields: z.object({}).passthrough().optional()
});
export const RpcCommentUpdateResultSchema = z.object({
    commentUpdate: CommentUpdateSchema,
    runtimeFields: z.object({}).passthrough().optional()
});
export const RpcChallengeVerificationEventResultSchema = z.object({
    challengeVerification: z.custom<EncodedDecryptedChallengeVerificationMessageType>(),
    runtimeFields: z.object({}).passthrough().optional()
});

export const RpcCidParamSchema = z.object({ cid: CidStringSchema }).loose();
export const RpcSubplebbitAddressParamSchema = z.object({ address: SubplebbitAddressSchema });
export const RpcSubplebbitLookupParamSchema = z
    .object({
        address: SubplebbitAddressSchema.optional(),
        name: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional()
    })
    .refine((args) => args.address || args.name || args.publicKey, "At least one of address, name, or publicKey must be provided");
export const RpcAuthorNameParamSchema = z.object({ address: AuthorAddressSchema });
export const RpcSubplebbitPageParamSchema = RpcCidParamSchema.extend({
    subplebbitAddress: SubplebbitAddressSchema,
    type: z.enum(["posts", "modqueue"]),
    pageMaxSize: z.number().positive().int()
});
export const RpcCommentRepliesPageParamSchema = RpcSubplebbitPageParamSchema.omit({ type: true }).extend({ commentCid: CidStringSchema });

// Params for methods that previously used multiple positional args
export const RpcEditSubplebbitParamSchema = z.object({
    address: SubplebbitAddressSchema,
    editOptions: SubplebbitEditOptionsSchema
});
export const RpcPublishChallengeAnswersParamSchema = z.object({
    subscriptionId: SubscriptionIdSchema,
    challengeAnswers: ChallengeAnswersSchema
});
export const RpcUnsubscribeParamSchema = z.object({ subscriptionId: SubscriptionIdSchema });

// Result schemas for events that were previously bare values
export const RpcStateChangeEventResultSchema = z.object({ state: z.string() });
export const RpcSubplebbitsChangeEventResultSchema = z.object({ subplebbits: z.array(z.string()) });
export const RpcFetchCidResultSchema = z.object({ content: z.string() });
export const RpcResolveAuthorNameResultSchema = z.object({ resolvedAddress: z.string().nullable() });
