import { z } from "zod";
import {
    FlairSchema,
    AuthorPubsubSchema,
    CidStringSchema,
    CreatePublicationUserOptionsSchema,
    JsonSignatureSchema,
    PKCTimestampSchema,
    ProtocolVersionSchema,
    PublicationBaseBeforeSigning,
    SignerWithAddressPublicKeySchema,
    CommunityAuthorSchema,
    hasAtLeastOneCommunityIdentifier,
    atLeastOneCommunityIdentifierMessage
} from "../../schema/schema.js";
import { CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema } from "../comment-edit/schema.js";
import { difference, keys, mapToObj, omit, unique } from "remeda";
import { messages } from "../../errors.js";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";
import { RepliesPagesIpfsSchema } from "../../pages/schema.js";
import type { CommentIpfsType, CommentJson, CommentPubsubMessagePublication } from "./types.js";

// Comment schemas here

const CommentContentSchema = z.string();

// Create Comment schemas here

// Need to validate if post.link is valid
// Also add a limitation of 2000 characters to link
// Need to have multiple types of schema for posts with or without link
// link posts have no content

// Crossposts embed the full CommentIpfs of the comment being reposted, so the crossposting
// community's mods can moderate it as if it were the original, and so the text survives the
// original author editing or deleting it, or the original community disappearing.
//
// This makes CommentIpfs self-recursive (a crosspost of a crosspost nests records), which TypeScript
// cannot infer on its own: CommentIpfsSchema is derived from CreateCommentOptionsSchema, so a plain
// z.lazy getter here collapses CommentSignedPropertyNames, the pick key record, and CommentIpfsSchema
// itself to `any`. That is why this differs from the z.lazy-only idiom used by CommentUpdate.replies,
// whose cycle runs through the pages schema rather than through the shape the pubsub schema is
// pick()ed from. The cycle is severed by annotating CrosspostSchema with an explicit z.ZodType; the
// interface below stays honest via the structural assertion at the bottom of this file.
export interface Crosspost {
    cid: string; // dedup/index key and the pointer to the canonical record. Never a second source of truth: acceptance requires cid === CID(deterministicStringify(comment))
    comment: Omit<CommentIpfsType, "crosspost"> & { crosspost?: Crosspost };
}

// .loose() is load-bearing, not stylistic. crosspost.cid hashes the entire embedded record, so any
// normalization of it breaks the crosspost. Zod's strip behavior is per-schema, so leaving this at
// the default would let the CommentIpfsSchema.strip().parse() in storePublication silently delete
// author-signed extra props from the embedded record — changing the CID that
// deriveCommentIpfsFromCommentTableRow reconstructs, breaking page generation, and getting the
// comment purged by the post-migration signature sweep.
// Both generic params are pinned: zod 4's ZodType defaults Input to `unknown` (zod 3 defaulted it to
// Output), and leaving it inferred makes z.input of any schema containing a crosspost degrade to
// `unknown`, which breaks the z.input/z.infer equivalence the RPC parse helpers rely on.
const CrosspostSchema: z.ZodType<Crosspost, Crosspost> = z.object({
    cid: CidStringSchema,
    comment: z.lazy(() => CommentIpfsSchema.loose() as unknown as z.ZodType<Crosspost["comment"], Crosspost["comment"]>)
});

export const CreateCommentOptionsSchema = z
    .object({
        flairs: FlairSchema.array().optional(), // Author chosen colored labels for the comment
        spoiler: z.boolean().optional(), // Hide the comment thumbnail behind spoiler warning
        nsfw: z.boolean().optional(),
        content: CommentContentSchema.optional(),
        title: z.string().optional(),
        link: z.string().min(1).max(2000, messages.COMMENT_LINK_LENGTH_IS_OVER_LIMIT).optional(),
        linkWidth: z.number().positive().optional(), // author can optionally provide dimensions of image/video link which helps UI clients with infinite scrolling feeds
        linkHeight: z.number().positive().optional(),
        linkHtmlTagName: z.string().min(1).optional(),
        parentCid: CidStringSchema.optional(), // The parent comment CID
        postCid: CidStringSchema.optional(), // the post cid, required if the comment is reply
        quotedCids: z.array(CidStringSchema).optional(), // CIDs of comments being quoted/referenced in this reply
        crosspost: CrosspostSchema.optional() // this comment IS a repost of the embedded comment. Distinct from quotedCids, which only references comments the text refers to
    })
    .merge(CreatePublicationUserOptionsSchema)
    .strict();

// This one is used for parsing user's input
// crosspost counts as payload on its own: a comment that only reposts another comment (a
// "retweet") is valid with no content, link or title. See docs/protocol/crossposts.md.
export const CreateCommentOptionsWithRefinementSchema = CreateCommentOptionsSchema.refine(
    (arg) => arg.link || arg.content || arg.title || arg.crosspost,
    messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE
)
    .refine((arg) => (arg.parentCid ? arg.postCid : true), messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID)
    .refine(hasAtLeastOneCommunityIdentifier, atLeastOneCommunityIdentifierMessage);

// Below is what's used to initialize a local publication to be published

export const CommentSignedPropertyNames = keys(omit(CreateCommentOptionsSchema.shape, keysToOmitFromSignedPropertyNames));

const commentPubsubKeys = <Record<(typeof CommentSignedPropertyNames)[number] | "signature", true>>(
    mapToObj([...CommentSignedPropertyNames, "signature"], (x) => [x, true])
);

export const CommentPubsubMessagePublicationSchema = CreateCommentOptionsSchema.merge(PublicationBaseBeforeSigning)
    .extend({ signature: JsonSignatureSchema })
    .pick(commentPubsubKeys)
    .strict();

export const CommentPubsubMessageWithFlexibleAuthorSchema = CommentPubsubMessagePublicationSchema.merge(
    z.object({ author: AuthorPubsubSchema.loose().optional() })
).strict();

// This is used by the community when parsing request.comment
export const CommentPubsubMessageWithFlexibleAuthorRefinementSchema = CommentPubsubMessageWithFlexibleAuthorSchema.loose().refine(
    (arg) => arg.link || arg.content || arg.title || arg.crosspost,
    messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE
);

export const CommentPubsubMessageWithRefinementSchema = CommentPubsubMessagePublicationSchema.refine(
    (arg) => arg.link || arg.content || arg.title || arg.crosspost,
    messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE
).refine((arg) => (arg.parentCid ? arg.postCid : true), messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID);

export const CommentChallengeRequestToEncryptSchema = CreateCommentOptionsSchema.shape.challengeRequest
    .unwrap()
    .extend({
        comment: CommentPubsubMessageWithFlexibleAuthorSchema.loose()
    })
    .strict();

// Remote comments

// These are the props added by the community before adding the comment to ipfs
export const CommentIpfsSchema = CommentPubsubMessageWithFlexibleAuthorSchema.extend({
    depth: z.number().nonnegative().int(),
    thumbnailUrl: z.string().min(1).optional(),
    thumbnailUrlWidth: z.number().positive().optional(),
    thumbnailUrlHeight: z.number().positive().optional(),
    previousCid: CidStringSchema.optional(),
    pseudonymityMode: z.enum(["per-post", "per-reply", "per-author"]).optional()
}).strict();

// This one should be used for parsing user's input or from gateway/p2p etc
export const CommentIpfsWithRefinmentSchema = CommentIpfsSchema.refine(
    (arg) => arg.link || arg.content || arg.title || arg.crosspost,
    messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE
);

// Comment update schemas

export const AuthorWithCommentUpdateSchema = CommentPubsubMessagePublicationSchema.shape.author
    .unwrap()
    .extend({
        community: CommunityAuthorSchema.optional()
    })
    .loose();

export const CommentUpdateSchema = z
    .object({
        cid: CidStringSchema, // cid of the comment, need it in signature to prevent attack
        upvoteCount: z.number().nonnegative().int(),
        downvoteCount: z.number().nonnegative().int(),
        replyCount: z.number().nonnegative().int(), // the total of reply trees underneath this comment, which includes direct and indirect children
        childCount: z.number().nonnegative().int().optional(), // the total of direct children of the comment, does not include indirect children
        number: z.number().int().positive().optional(),
        postNumber: z.number().int().positive().optional(),
        edit: CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.optional(), // most recent edit by comment author, commentUpdate.edit.content, commentUpdate.edit.deleted, commentUpdate.edit.flairs override Comment instance props. Validate commentUpdate.edit.signature
        flairs: FlairSchema.array().optional(), // arbitrary colored strings to describe the comment, added by mods, override comment.flairs and comment.edit.flairs (which are added by author)
        spoiler: z.boolean().optional(),
        nsfw: z.boolean().optional(),
        pinned: z.boolean().optional(),
        locked: z.boolean().optional(), // mod locked a post
        archived: z.boolean().optional(), // mod archived a post
        removed: z.boolean().optional(), // mod deleted a comment
        reason: z.string().optional(), // reason the mod took a mood action,
        approved: z.boolean().optional(), // if comment was pending approval and it got approved or disapproved. Does not apply to comments pending approvals, you need to use moderation.pageCids.pendingApproval to fetch pending comments
        updatedAt: PKCTimestampSchema, // timestamp in seconds the CommentUpdate was updated
        author: AuthorWithCommentUpdateSchema.pick({ community: true }).optional(), // add commentUpdate.author.community to comment.author.community, override comment.author.flairs with commentUpdate.author.community.flairs if any
        lastChildCid: CidStringSchema.optional(), // The cid of the most recent direct child of the comment
        lastReplyTimestamp: PKCTimestampSchema.optional(), // The timestamp of the most recent direct or indirect child of the comment
        signature: JsonSignatureSchema, // signature of the CommentUpdate by the community owner to protect against malicious gateway
        protocolVersion: ProtocolVersionSchema,
        // The getter defers TypeScript inference of the comment-schema <-> pages-schema cycle; the
        // z.lazy inside defers the *runtime* dereference too: .strict() materializes the shape (and
        // thus runs this getter) at module-eval time, and a bundler that orders the cycle
        // differently than Node's per-file ESM loader would otherwise read RepliesPagesIpfsSchema
        // before its module body ran. Same idiom as PageIpfsSchema's comments field in
        // src/pages/schema.ts.
        get replies() {
            return z.lazy(() => RepliesPagesIpfsSchema).optional();
        }
    })
    .strict();

export const CommentUpdateSignedPropertyNames = keys(omit(CommentUpdateSchema.shape, ["signature"]));

// Community-computed fields on CommentUpdate. Challenges may not set these via the `commentUpdate`
// field on a ChallengeResult; any other key (including new unknown ones invented by external
// challenges) is allowed and shallow-merged with lowest priority. `satisfies` ties each entry to a
// real CommentUpdate key so renaming a field on CommentUpdateSchema surfaces a stale entry at compile time.
// NOTE: `author` is allowed here but validated separately by validateChallengeResultExtras — only
// `author.community.<key>` is permitted. Non-`community` author keys are rejected, and schema-defined
// `author.community` keys are rejected EXCEPT the ones intentionally left out of
// CommunityAuthorChallengeReservedFieldNames (currently `flairs`, which a challenge may seed as
// lowest priority and a mod's commentModeration.author.flairs overrides).
export const CommentUpdateChallengeReservedFieldNames = [
    "signature",
    "cid",
    "upvoteCount",
    "downvoteCount",
    "replyCount",
    "childCount",
    "number",
    "postNumber",
    "updatedAt",
    "lastChildCid",
    "lastReplyTimestamp",
    "replies",
    "edit",
    "protocolVersion"
] as const satisfies readonly (keyof z.infer<typeof CommentUpdateSchema>)[];

export const CommentUpdateForDisapprovedPendingComment = CommentUpdateSchema.pick({
    author: true,
    cid: true,
    signature: true,
    protocolVersion: true,
    reason: true,
    removed: true,
    nsfw: true,
    locked: true,
    archived: true,
    spoiler: true,
    flairs: true,
    updatedAt: true,
    approved: true
}).strict();

export const CommentUpdateForDisapprovedPendingCommentSignedPropertyNames = keys(
    omit(CommentUpdateForDisapprovedPendingComment.shape, ["signature"])
);

// Strict for declared fields; challenge-supplied unknown keys (e.g. `reason`, `countryCode`) are
// merged in at runtime by storePublicationAndEncryptForChallengeVerification and the dynamic
// signedPropertyNames is computed at sign time as the union of these picked fields plus the actual
// extra keys present on the merged object.
export const CommentUpdateForChallengeVerificationSchema = CommentUpdateSchema.pick({
    author: true,
    cid: true,
    signature: true,
    protocolVersion: true,
    number: true,
    postNumber: true
})
    .merge(z.object({ pendingApproval: z.boolean().optional() }))
    .strict();

export const CommentUpdateForChallengeVerificationSignedPropertyNames = keys(
    omit(CommentUpdateForChallengeVerificationSchema.shape, ["signature"])
);

// Comment table here

export const CommentsTableRowSchema = CommentIpfsSchema.extend({
    cid: CidStringSchema, // cid of CommentIpfs, cid v0
    postCid: CidStringSchema,
    insertedAt: PKCTimestampSchema,
    authorSignerAddress: SignerWithAddressPublicKeySchema.shape.address,
    originalCommentSignatureEncoded: CommentPubsubMessagePublicationSchema.shape.signature.shape.signature.optional(),
    extraProps: z.looseObject({}).optional(),
    // challenge-supplied partial CommentUpdate, shallow-merged across successful challenges, seeded
    // into queryCalculatedCommentUpdate with lowest priority (per-field overridden by mod queries).
    challengeCommentUpdate: z.looseObject({}).optional(),
    pendingApproval: z.boolean().optional(),
    number: z.number().int().positive().optional(),
    postNumber: z.number().int().positive().optional()
}).strict();

// DB replies format: flat per-sort CID references instead of full inline page data
export const DbRepliesSortEntrySchema = z.object({
    commentCids: z.array(CidStringSchema).optional(), // sorted child CIDs (preloaded sorts only)
    allPageCids: z.array(CidStringSchema).optional() // ALL IPFS page CIDs for this sort (first element = pageCid for that sort)
});

export const DbRepliesSchema = z.record(z.string().min(1), DbRepliesSortEntrySchema);

// DB posts format: same CID-ref structure as replies, used for community.posts in internal state
export const DbPostsSchema = z.record(z.string().min(1), DbRepliesSortEntrySchema);

export const CommentUpdateTableRowSchema = CommentUpdateSchema.extend({
    insertedAt: PKCTimestampSchema,
    postUpdatesBucket: z.int().nonnegative().optional(), // the post updates bucket of post CommentUpdate, not applicable to replies
    publishedToPostUpdatesMFS: z.boolean(), // whether the comment latest update has been published
    replies: DbRepliesSchema.optional() // Override: DB stores CID refs, not wire format
});

// Comment pubsub reserved fields

const additionalCommentReservedFields = [
    "original",
    "shortCid",
    "shortCommunityAddress",
    "shortCommunityAddress",
    "communityPublicKey",
    "communityName",
    "deleted",
    "raw",
    "comment",
    "commentUpdate",
    "state",
    "clients",
    "publishingState",
    "updatingState",
    "rowid",
    "nameResolved"
] as const;

type AdditionalCommentReservedField = (typeof additionalCommentReservedFields)[number];

type CommentReservedFieldCandidate =
    | keyof typeof CommentIpfsSchema.shape
    | keyof typeof CommentsTableRowSchema.shape
    | keyof typeof CommentUpdateTableRowSchema.shape
    | keyof typeof CommentChallengeRequestToEncryptSchema.shape
    | keyof typeof CreateCommentOptionsSchema.shape
    | (typeof CommentUpdateForChallengeVerificationSignedPropertyNames)[number]
    | (typeof CommentUpdateSignedPropertyNames)[number]
    | (typeof CommentUpdateForDisapprovedPendingCommentSignedPropertyNames)[number]
    | AdditionalCommentReservedField;

const commentReservedFieldCandidates = unique([
    ...keys(CommentIpfsSchema.shape),
    ...keys(CommentsTableRowSchema.shape),
    ...keys(CommentUpdateTableRowSchema.shape),
    ...keys(CommentChallengeRequestToEncryptSchema.shape),
    ...keys(CreateCommentOptionsSchema.shape),
    ...CommentUpdateForChallengeVerificationSignedPropertyNames,
    ...CommentUpdateSignedPropertyNames,
    ...CommentUpdateForDisapprovedPendingCommentSignedPropertyNames,
    ...additionalCommentReservedFields
] as CommentReservedFieldCandidate[]);

export const CommentPubsubMessageReservedFields = difference(
    commentReservedFieldCandidates,
    keys(CommentPubsubMessagePublicationSchema.shape) as CommentReservedFieldCandidate[]
);

type AssertTrue<T extends true> = T;

type CommentJsonFields = Extract<keyof CommentJson, string>;
type CommentPublicationFields = Extract<keyof CommentPubsubMessagePublication, string>;
type CommentReservedFields = (typeof CommentPubsubMessageReservedFields)[number];

type MissingCommentReservedField = Exclude<CommentJsonFields, CommentPublicationFields | CommentReservedFields>;

type _EnsureAllCommentFieldsAreReserved = AssertTrue<MissingCommentReservedField extends never ? true : false>;

// The Crosspost interface above is hand-written to sever the inference cycle, so nothing else keeps
// it in step with the schema. This asserts the embedded record really is a CommentIpfs: if a field
// is added to CommentIpfsSchema and the interface stops matching, this fails at compile time rather
// than silently letting the crosspost branch drift from the rest of the record.
type _EnsureCrosspostEmbedsACommentIpfs = AssertTrue<
    [Crosspost["comment"]] extends [CommentIpfsType] ? ([CommentIpfsType] extends [Crosspost["comment"]] ? true : false) : false
>;

// Reserved fields for CommentIpfs — CommentPubsubMessage reserved fields minus fields that are legitimate in CommentIpfs
export const CommentIpfsReservedFields = difference(
    CommentPubsubMessageReservedFields,
    keys(CommentIpfsSchema.shape) as typeof CommentPubsubMessageReservedFields
);

export const CommentUpdateReservedFields = difference(CommentPubsubMessageReservedFields, [
    ...keys(CommentUpdateSchema.shape),
    ...keys(CommentUpdateTableRowSchema.shape),
    "pendingApproval"
]);

// CommentUpdates Table row here
