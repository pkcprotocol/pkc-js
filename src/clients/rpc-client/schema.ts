import { z } from "zod";
import { MAX_QUERY_LIMIT } from "@pkcprotocol/pkc-logger";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../publications/comment/schema.js";
import { AuthorAddressSchema, ChallengeAnswersSchema, CidStringSchema } from "../../schema/schema.js";
import { CommunityEditOptionsSchema, CommunityExportRecordsSchema, ExportCommunityModLogsOptionsSchema } from "../../community/schema.js";
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
        publicKey: z.string().min(1).optional()
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
// One entry of pkc.communities as it crosses the RPC wire (issue #455). `started` is whether the community's start lock
// is held, the same check as community.started. The runtime-only `address` is not sent: each side computes it
export const PKCCommunitiesWireEntrySchema = z.object({
    name: z.string().min(1).optional(),
    publicKey: z.string().min(1),
    started: z.boolean()
});
export const RpcCommunitiesChangeEventResultSchema = z.object({ communities: PKCCommunitiesWireEntrySchema.loose().array() });
export const RpcFetchCidResultSchema = z.object({ content: z.string() });
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

// pkc.getLogs() and the getLogs RPC method (issue #493). One query schema on both sides: the client parses it before
// the wire and the server before the scan, and both compile `regex` here so a bad pattern throws ERR_INVALID_LOG_QUERY
// without touching the buffer. Strict: a typo in a filter must not silently widen the query to the whole buffer.
// `rpcUrl` is a pkc.getLogs() concern only; the server's param schema inherits this strictness and so rejects it, which
// is what keeps a call from ever being chained to a third daemon.
export const LogQuerySchema = z
    .object({
        tags: z.record(z.string().min(1), z.string().min(1)).optional(),
        regex: z.object({ source: z.string(), flags: z.string().optional() }).strict().optional(),
        since: z.number().optional(),
        until: z.number().optional(),
        limit: z.number().int().positive().max(MAX_QUERY_LIMIT).optional(),
        cursor: z.number().int().optional(),
        order: z.enum(["asc", "desc"]).optional()
    })
    .strict()
    .superRefine((query, ctx) => {
        if (!query.regex) return;
        try {
            new RegExp(query.regex.source, query.regex.flags);
        } catch (e) {
            ctx.addIssue({ code: "custom", path: ["regex"], message: `invalid regex: ${e instanceof Error ? e.message : String(e)}` });
        }
    });

export const RpcGetLogsParamSchema = LogQuerySchema;

export const LogEntrySchema = z.object({
    seq: z.number().int(),
    time: z.number(),
    level: z.enum(["log", "error", "trace"]),
    namespace: z.string(),
    msg: z.string(),
    tags: z.record(z.string(), z.string())
});

export const RpcGetLogsResultSchema = z.object({
    entries: LogEntrySchema.array(),
    nextCursor: z.number().int().optional()
});

// CommunityList (docs/protocol/community-lists.md). The client signs locally; the server only adds
// the signed JSON to IPFS and returns the cid. Fetch returns the raw string so the client can check
// the bytes against the cid and verify the signature locally.
// The publish param is the raw signed string (not a parsed object): the server must add the exact
// bytes the client signed, and object round-trips through JSON-RPC/zod may reorder keys
export const RpcPublishCommunityListParamSchema = z.object({ communityListRawString: z.string() });
export const RpcPublishCommunityListResultSchema = z.object({ cid: CidStringSchema });
export const RpcFetchCommunityListParamSchema = z.object({ cid: CidStringSchema });
export const RpcFetchCommunityListResultSchema = z.object({ communityListRawString: z.string() });
