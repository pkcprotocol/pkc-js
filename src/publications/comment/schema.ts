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
import * as remeda from "remeda";
import { messages } from "../../errors.js";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";
import { RepliesPagesIpfsSchema } from "../../pages/schema.js";
import type { CommentJson, CommentPubsubMessagePublication } from "./types.js";

// Comment schemas here

const CommentContentSchema = z.string();

// Create Comment schemas here

// Need to validate if post.link is valid
// Also add a limitation of 2000 characters to link
// Need to have multiple types of schema for posts with or without link
// link posts have no content

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
        quotedCids: z.array(CidStringSchema).optional() // CIDs of comments being quoted/referenced in this reply
    })
    .merge(CreatePublicationUserOptionsSchema)
    .strict();

// This one is used for parsing user's input
export const CreateCommentOptionsWithRefinementSchema = CreateCommentOptionsSchema.refine(
    (arg) => arg.link || arg.content || arg.title,
    messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE
)
    .refine((arg) => (arg.parentCid ? arg.postCid : true), messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID)
    .refine(hasAtLeastOneCommunityIdentifier, atLeastOneCommunityIdentifierMessage);

// Below is what's used to initialize a local publication to be published

export const CommentSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CreateCommentOptionsSchema.shape, keysToOmitFromSignedPropertyNames)
);

const commentPubsubKeys = <Record<(typeof CommentSignedPropertyNames)[number] | "signature", true>>(
    remeda.mapToObj([...CommentSignedPropertyNames, "signature"], (x) => [x, true])
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
    (arg) => arg.link || arg.content || arg.title,
    messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE
);

export const CommentPubsubMessageWithRefinementSchema = CommentPubsubMessagePublicationSchema.refine(
    (arg) => arg.link || arg.content || arg.title,
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
    (arg) => arg.link || arg.content || arg.title,
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
        get replies() {
            return RepliesPagesIpfsSchema.optional();
        }
    })
    .strict();

export const CommentUpdateSignedPropertyNames = remeda.keys.strict(remeda.omit(CommentUpdateSchema.shape, ["signature"]));

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

export const CommentUpdateForDisapprovedPendingCommentSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CommentUpdateForDisapprovedPendingComment.shape, ["signature"])
);

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

export const CommentUpdateForChallengeVerificationSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CommentUpdateForChallengeVerificationSchema.shape, ["signature"])
);

// Comment table here

export const CommentsTableRowSchema = CommentIpfsSchema.extend({
    cid: CidStringSchema, // cid of CommentIpfs, cid v0
    postCid: CidStringSchema,
    insertedAt: PKCTimestampSchema,
    authorSignerAddress: SignerWithAddressPublicKeySchema.shape.address,
    originalCommentSignatureEncoded: CommentPubsubMessagePublicationSchema.shape.signature.shape.signature.optional(),
    extraProps: z.looseObject({}).optional(),
    pendingApproval: z.boolean().optional(),
    number: z.number().int().positive().optional(),
    postNumber: z.number().int().positive().optional()
}).strict();

// DB replies format: flat per-sort CID references instead of full inline page data
export const DbRepliesSortEntrySchema = z.object({
    commentCids: z.array(CidStringSchema).optional(), // sorted child CIDs (preloaded sorts only)
    nextCid: CidStringSchema.optional(), // link to page 2 (preloaded sorts only)
    allPageCids: z.array(CidStringSchema).optional() // ALL IPFS page CIDs for this sort
});

export const DbRepliesSchema = z.record(z.string().min(1), DbRepliesSortEntrySchema);

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

const commentReservedFieldCandidates = remeda.unique<CommentReservedFieldCandidate>([
    ...remeda.keys.strict(CommentIpfsSchema.shape),
    ...remeda.keys.strict(CommentsTableRowSchema.shape),
    ...remeda.keys.strict(CommentUpdateTableRowSchema.shape),
    ...remeda.keys.strict(CommentChallengeRequestToEncryptSchema.shape),
    ...remeda.keys.strict(CreateCommentOptionsSchema.shape),
    ...CommentUpdateForChallengeVerificationSignedPropertyNames,
    ...CommentUpdateSignedPropertyNames,
    ...CommentUpdateForDisapprovedPendingCommentSignedPropertyNames,
    ...additionalCommentReservedFields
]);

export const CommentPubsubMessageReservedFields = remeda.difference<CommentReservedFieldCandidate>(
    commentReservedFieldCandidates,
    remeda.keys.strict(CommentPubsubMessagePublicationSchema.shape) as CommentReservedFieldCandidate[]
);

type AssertTrue<T extends true> = T;

type CommentJsonFields = Extract<keyof CommentJson, string>;
type CommentPublicationFields = Extract<keyof CommentPubsubMessagePublication, string>;
type CommentReservedFields = (typeof CommentPubsubMessageReservedFields)[number];

type MissingCommentReservedField = Exclude<CommentJsonFields, CommentPublicationFields | CommentReservedFields>;

type _EnsureAllCommentFieldsAreReserved = AssertTrue<MissingCommentReservedField extends never ? true : false>;

// Reserved fields for CommentIpfs — CommentPubsubMessage reserved fields minus fields that are legitimate in CommentIpfs
export const CommentIpfsReservedFields = remeda.difference(
    CommentPubsubMessageReservedFields,
    remeda.keys.strict(CommentIpfsSchema.shape) as typeof CommentPubsubMessageReservedFields
);

export const CommentUpdateReservedFields = remeda.difference(CommentPubsubMessageReservedFields, [
    ...remeda.keys.strict(CommentUpdateSchema.shape),
    ...remeda.keys.strict(CommentUpdateTableRowSchema.shape),
    "pendingApproval"
]);

// CommentUpdates Table row here
