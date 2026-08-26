import { z } from "zod";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import { AuthorAddressSchema, ChallengeAnswersSchema, CidStringSchema } from "../../schema/schema.js";
import {
    CommunityEditOptionsSchema,
    CommunityExportRecordsSchema,
    CommunityIncludeFieldsSchema,
    ExportCommunityModLogsOptionsSchema
} from "../../community/schema.js";
import { CommentModerationsTableRowSchema } from "../../publications/comment-moderation/schema.js";
import { NameResolveCacheOptionsSchema } from "../../schema.js";
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
        publicKey: z.string().min(1).optional(),
        include: CommunityIncludeFieldsSchema.optional() // request only cheap fields (fast started-only fetch)
    })
    .refine((args) => args.name || args.publicKey, "At least one of name or publicKey must be provided");
export const RpcFetchCidParamSchema = z.object({ cid: CidStringSchema });
export const RpcAuthorNameParamSchema = z.object({
    name: AuthorAddressSchema,
    cache: NameResolveCacheOptionsSchema.optional()
});
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
export const RpcCommunityStartedResultSchema = z.object({ address: z.string(), started: z.boolean() }); // createCommunity({ include: ["started"] }) fast-path result
export const RpcResolveAuthorNameResultSchema = z.object({ resolvedAuthorName: z.string().nullable() });
export const RpcSuccessResultSchema = z.object({ success: z.literal(true) });

// Delegation setup (#234). The signed record crosses the wire base64-encoded because JSON has no bytes,
// and sequences cross as decimal strings because JSON numbers cannot hold a uint64 without rounding.
// The anchor's PRIVATE key is not in either shape, and never is: the client signs, the node publishes.
export const RpcPublishAnchorRecordParamSchema = z
    .object({
        name: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional(),
        recordBase64: z.string().min(1)
    })
    .refine((args) => args.name || args.publicKey, "At least one of name or publicKey must be provided");
export const RpcAnchorPublishPreparationResultSchema = z.object({
    nextSequence: z.string().min(1),
    currentAnchorRecordSequence: z.string().min(1),
    hasPersistedAnchorRecord: z.boolean()
});
export const RpcPublishedAnchorRecordResultSchema = z.object({
    sequence: z.string().min(1),
    value: z.string().min(1),
    anchorPublicKey: z.string().min(1)
});
export const RpcSubscriptionIdResultSchema = z.object({ subscriptionId: SubscriptionIdSchema }); // parsed with .loose() in rpc-schema-util.ts

// community.export() — wire params and results
export const RpcExportCommunityParamSchema = z
    .object({
        name: z.string().min(1).optional(),
        publicKey: z.string().min(1).optional(),
        includePrivateKey: z.boolean().optional()
    })
    .refine((args) => args.name || args.publicKey, "At least one of name or publicKey must be provided");

export const RpcCancelExportParamSchema = z.object({ exportId: z.string().uuid() });

export const RpcExportCommunityResultSchema = z.object({ exportId: z.string().uuid() });

export const RpcExportschangeResultSchema = z.object({ records: CommunityExportRecordsSchema });

// community.exportCommunityModLogs() — wire params and results
export const RpcExportCommunityModLogsParamSchema = ExportCommunityModLogsOptionsSchema.extend({
    name: z.string().min(1).optional(),
    publicKey: z.string().min(1).optional()
}).refine((args) => args.name || args.publicKey, "At least one of name or publicKey must be provided");

export const RpcExportCommunityModLogsResultSchema = z.object({
    moderations: z.array(CommentModerationsTableRowSchema.loose()) // .loose() element preserves extraProps / future fields
});
