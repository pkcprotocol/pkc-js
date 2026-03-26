// Comment edit schemas here

import { z } from "zod";
import {
    FlairSchema,
    CidStringSchema,
    CreatePublicationUserOptionsSchema,
    JsonSignatureSchema,
    PublicationBaseBeforeSigning,
    PlebbitTimestampSchema,
    SignerWithAddressPublicKeySchema
} from "../../schema/schema.js";
import * as remeda from "remeda";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";

export const AuthorCommentEditOptionsSchema = z
    .object({
        commentCid: CidStringSchema,
        content: z.string().optional(), // TODO Should use CommentIpfsSchema.content later on
        deleted: z.boolean().optional(),
        flairs: FlairSchema.array().optional(),
        spoiler: z.boolean().optional(),
        nsfw: z.boolean().optional(),
        reason: z.string().optional()
    })
    .strict();

export const CreateCommentEditOptionsSchema = CreatePublicationUserOptionsSchema.merge(AuthorCommentEditOptionsSchema).strict();

export const CommentEditSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CreateCommentEditOptionsSchema.shape, keysToOmitFromSignedPropertyNames)
);
const editPubsubPickOptions = <Record<(typeof CommentEditSignedPropertyNames)[number] | "signature", true>>(
    remeda.mapToObj([...CommentEditSignedPropertyNames, "signature"], (x) => [x, true])
);

// ChallengeRequest.commentEdit

export const CommentEditPubsubMessagePublicationSchema = CreateCommentEditOptionsSchema.merge(PublicationBaseBeforeSigning)
    .extend({
        signature: JsonSignatureSchema
    })
    .pick(editPubsubPickOptions)
    .strict();

export const CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema = CommentEditPubsubMessagePublicationSchema.extend({
    author: CommentEditPubsubMessagePublicationSchema.shape.author.unwrap().loose().optional()
}).loose();

export const CommentEditsTableRowSchema = CommentEditPubsubMessagePublicationSchema.extend({
    insertedAt: PlebbitTimestampSchema,
    authorSignerAddress: SignerWithAddressPublicKeySchema.shape.address,
    isAuthorEdit: z.boolean(), // if true, then it was an author at the time of editing
    extraProps: z.looseObject({}).optional() // will hold unknown props,
}).strict();

export const CommentEditChallengeRequestToEncryptSchema = CreateCommentEditOptionsSchema.shape.challengeRequest.unwrap().extend({
    commentEdit: CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.loose()
});

export const CommentEditReservedFields = remeda.difference(
    remeda.unique([
        ...remeda.keys.strict(CommentEditsTableRowSchema.shape),
        ...remeda.keys.strict(CommentEditChallengeRequestToEncryptSchema.shape),
        "shortCommentCid",
        "shortSubplebbitAddress",
        "shortCommunityAddress",
        "communityAddress",
        "communityPublicKey",
        "communityName",
        "state",
        "publishingState",
        "signer",
        "clients",
        "commentEdit"
    ]),
    remeda.keys.strict(CommentEditPubsubMessagePublicationSchema.shape)
);
