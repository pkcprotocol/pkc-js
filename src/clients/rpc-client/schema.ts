import { z } from "zod";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import { AuthorAddressSchema, ChallengeAnswersSchema, CidStringSchema, CommunityAddressSchema } from "../../schema/schema.js";
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
export const RpcCommunityAddressParamSchema = z.object({ address: CommunityAddressSchema }); // TODO remove address and replace it with `{name, publicKey}`
export const RpcCommunityLookupParamSchema = z
    .object({
        address: CommunityAddressSchema.optional(), // Why do we need address here? For backward compatibility?
        name: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional()
    })
    .refine((args) => args.address || args.name || args.publicKey, "At least one of address, name, or publicKey must be provided");
export const RpcAuthorNameParamSchema = z.object({ name: AuthorAddressSchema });
export const RpcCommunityPageParamSchema = RpcCidParamSchema.extend({
    type: z.enum(["posts", "modqueue"]),
    pageMaxSize: z.number().positive().int()
});
export const RpcCommentRepliesPageParamSchema = RpcCommunityPageParamSchema.omit({ type: true }).extend({ commentCid: CidStringSchema });

// Params for methods that previously used multiple positional args
export const RpcEditCommunityParamSchema = z.object({
    // TODO we should not send address to RPC server
    // instead send both name and publicKey
    address: CommunityAddressSchema,
    editOptions: CommunityEditOptionsSchema
});
export const RpcPublishChallengeAnswersParamSchema = z.object({
    subscriptionId: SubscriptionIdSchema,
    challengeAnswers: ChallengeAnswersSchema
});
export const RpcUnsubscribeParamSchema = z.object({ subscriptionId: SubscriptionIdSchema });

// Result schemas for events that were previously bare values
export const RpcStateChangeEventResultSchema = z.object({ state: z.string() });
export const RpcCommunitiesChangeEventResultSchema = z.object({ communities: z.array(z.string()) });
export const RpcFetchCidResultSchema = z.object({ content: z.string() });
export const RpcResolveAuthorNameResultSchema = z.object({ resolvedAddress: z.string().nullable() }); // TODO here rename to resolvedName instead
