import { z } from "zod";
import { CidStringSchema, CreatePublicationUserOptionsSchema, FlairSchema, JsonSignatureSchema, PKCTimestampSchema, PublicationBaseBeforeSigning, SignerWithAddressPublicKeySchema, CommunityAuthorSchema } from "../../schema/schema.js";
import * as remeda from "remeda";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";
export const ModeratorOptionsSchema = z
    .object({
    flairs: FlairSchema.array().optional(),
    spoiler: z.boolean().optional(),
    nsfw: z.boolean().optional(),
    pinned: z.boolean().optional(),
    locked: z.boolean().optional(),
    archived: z.boolean().optional(),
    approved: z.boolean().optional(), // approving a comment that's pending approval
    removed: z.boolean().optional(),
    purged: z.boolean().optional(),
    reason: z.string().optional(),
    author: CommunityAuthorSchema.pick({ banExpiresAt: true, flairs: true }).loose().optional()
})
    .strict();
export const CreateCommentModerationOptionsSchema = CreatePublicationUserOptionsSchema.extend({
    commentModeration: ModeratorOptionsSchema.loose(),
    commentCid: CidStringSchema
}).strict();
// ChallengeRequest.publication
export const CommentModerationSignedPropertyNames = remeda.keys.strict(remeda.omit(CreateCommentModerationOptionsSchema.shape, keysToOmitFromSignedPropertyNames));
const commentModerationPickOptions = (remeda.mapToObj([...CommentModerationSignedPropertyNames, "signature"], (x) => [x, true]));
// Will be used by the community when parsing request.publication
export const CommentModerationPubsubMessagePublicationSchema = CreateCommentModerationOptionsSchema.merge(PublicationBaseBeforeSigning)
    .extend({
    signature: JsonSignatureSchema,
    author: PublicationBaseBeforeSigning.shape.author.unwrap().loose().optional()
})
    .pick(commentModerationPickOptions)
    .strict();
export const CommentModerationsTableRowSchema = CommentModerationPubsubMessagePublicationSchema.extend({
    insertedAt: PKCTimestampSchema,
    modSignerAddress: SignerWithAddressPublicKeySchema.shape.address,
    extraProps: z.looseObject({}).optional(),
    targetAuthorSignerAddress: SignerWithAddressPublicKeySchema.shape.address.optional(), // the signer address of the comment author being moderated (for bans/flairs)
    targetAuthorDomain: z.string().optional() // the domain address (e.g., spammer.bso) of the comment author being moderated
});
export const CommentModerationChallengeRequestToEncryptSchema = CreateCommentModerationOptionsSchema.shape.challengeRequest
    .unwrap()
    .extend({
    commentModeration: CommentModerationPubsubMessagePublicationSchema.loose()
});
export const CommentModerationReservedFields = remeda.difference([
    ...remeda.keys.strict(CommentModerationsTableRowSchema.shape),
    ...remeda.keys.strict(CommentModerationChallengeRequestToEncryptSchema.shape),
    "shortCommunityAddress",
    "shortCommunityAddress",
    "communityAddress",
    "communityPublicKey",
    "communityName",
    "shortCommentCid",
    "state",
    "publishingState",
    "signer",
    "clients",
    "nameResolved"
], remeda.keys.strict(CommentModerationPubsubMessagePublicationSchema.shape));
//# sourceMappingURL=schema.js.map