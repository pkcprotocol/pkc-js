import { z } from "zod";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import { AuthorAddressSchema, ChallengeAnswersSchema, CidStringSchema } from "../../schema/schema.js";
import { CommunityEditOptionsSchema } from "../../community/schema.js";
import type { EncodedDecryptedChallengeVerificationMessageType } from "../../pubsub-messages/types.js";
export const SubscriptionIdSchema = z.number().positive().int();

export const RpcCommentEventResultSchema = z.object({
    comment: CommentIpfsSchema.loose(),
    runtimeFields: z.object({}).loose().optional()
});
export const RpcCommentUpdateResultSchema = z.object({
    commentUpdate: CommentUpdateSchema,
    runtimeFields: z.object({}).loose().optional()
});
export const RpcChallengeVerificationEventResultSchema = z.object({
    challengeVerification: z.custom<EncodedDecryptedChallengeVerificationMessageType>(),
    runtimeFields: z.object({}).loose().optional()
});

export const RpcCidParamSchema = z
    .object({
        cid: CidStringSchema,
        communityPublicKey: z.string().min(1).optional(),
        communityName: z.string().min(1).optional()
    })
    .loose();
export const RpcCommunityIdentifierParamSchema = z
    .object({
        name: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional()
    })
    .refine((args) => args.name || args.publicKey, "At least one of name or publicKey must be provided");
export const RpcFetchCidParamSchema = z.object({ cid: CidStringSchema });
export const RpcAuthorNameParamSchema = z.object({ name: AuthorAddressSchema });
export const RpcCommunityPageParamSchema = RpcCidParamSchema.extend({
    type: z.enum(["posts", "modqueue"]),
    pageMaxSize: z.number().positive().int()
});
export const RpcCommentRepliesPageParamSchema = RpcCommunityPageParamSchema.omit({ type: true }).extend({ commentCid: CidStringSchema });

// Params for methods that previously used multiple positional args
export const RpcEditCommunityParamSchema = z
    .object({
        name: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional(),
        editOptions: CommunityEditOptionsSchema
    })
    .refine((args) => args.name || args.publicKey, "At least one of name or publicKey must be provided");
export const RpcPublishChallengeAnswersParamSchema = z.object({
    subscriptionId: SubscriptionIdSchema,
    challengeAnswers: ChallengeAnswersSchema
});
export const RpcUnsubscribeParamSchema = z.object({ subscriptionId: SubscriptionIdSchema });

// Result schemas for events that were previously bare values
export const RpcStateChangeEventResultSchema = z.object({ state: z.string() });
export const RpcCommunitiesChangeEventResultSchema = z.object({ communities: z.array(z.string()) });
export const RpcFetchCidResultSchema = z.object({ content: z.string() });
export const RpcResolveAuthorNameResultSchema = z.object({ resolvedAuthorName: z.string().nullable() });
export const RpcSuccessResultSchema = z.object({ success: z.literal(true) });
export const RpcSubscriptionIdResultSchema = z.object({ subscriptionId: SubscriptionIdSchema }); // parsed with .loose() in rpc-schema-util.ts
