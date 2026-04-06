import { z } from "zod";
import {
    AuthorCommentEditOptionsSchema,
    CommentEditChallengeRequestToEncryptSchema,
    CreateCommentEditOptionsSchema,
    CommentEditPubsubMessagePublicationSchema,
    CommentEditSignedPropertyNames,
    CommentEditsTableRowSchema
} from "./schema.js";
import { CommentAuthorSchema } from "../../schema/schema.js";
import type { JsonOfClass, RuntimeAuthorWithCommentUpdateType } from "../../types.js";
import type { CommentEdit } from "./comment-edit.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";

export type CommentAuthorEditOptions = z.infer<typeof CommentAuthorSchema>;

// CommentEdit section

export type AuthorCommentEditOptions = z.infer<typeof AuthorCommentEditOptionsSchema>;

export type CreateCommentEditOptions = z.infer<typeof CreateCommentEditOptionsSchema>;

export type CommentEditChallengeRequestToEncryptType = z.infer<typeof CommentEditChallengeRequestToEncryptSchema>;

export type CommentEditTypeJson = JsonOfClass<CommentEdit>;

export interface CommentEditOptionsToSign extends Omit<CommentEditPubsubMessagePublication, "signature"> {
    signer: SignerType;
    communityAddress: string;
}

export interface CommentEditSignature extends JsonSignature {
    signedPropertyNames: typeof CommentEditSignedPropertyNames;
}

export type CommentEditPubsubMessagePublication = z.infer<typeof CommentEditPubsubMessagePublicationSchema>;

export interface CommentEditPubsubMessagePublicationWithCommunityAuthor extends CommentEditPubsubMessagePublication {
    author: RuntimeAuthorWithCommentUpdateType;
}

export type CommentEditsTableRow = z.infer<typeof CommentEditsTableRowSchema>;
export interface CommentEditsTableRowInsert extends Omit<CommentEditsTableRow, "rowid"> {}
