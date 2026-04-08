import { z } from "zod";
import { CreateCommentModerationOptionsSchema, CommentModerationPubsubMessagePublicationSchema, CommentModerationChallengeRequestToEncryptSchema, CommentModerationSignedPropertyNames, CommentModerationsTableRowSchema } from "./schema.js";
import type { JsonOfClass, RuntimeAuthorWithCommentUpdateType } from "../../types.js";
import type { CommentModeration } from "./comment-moderation.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";
export type CreateCommentModerationOptions = z.infer<typeof CreateCommentModerationOptionsSchema>;
export type CommentModerationTypeJson = JsonOfClass<CommentModeration>;
export type CommentModerationChallengeRequestToEncrypt = z.infer<typeof CommentModerationChallengeRequestToEncryptSchema>;
export interface CommentModerationOptionsToSign extends Omit<CommentModerationPubsubMessagePublication, "signature"> {
    signer: SignerType;
    communityAddress: string;
}
export interface CommentModerationSignature extends JsonSignature {
    signedPropertyNames: typeof CommentModerationSignedPropertyNames;
}
export type CommentModerationPubsubMessagePublication = z.infer<typeof CommentModerationPubsubMessagePublicationSchema>;
export interface CommentModerationPubsubMessagePublicationWithCommunityAuthor extends CommentModerationPubsubMessagePublication {
    author: RuntimeAuthorWithCommentUpdateType;
}
export type CommentModerationTableRow = z.infer<typeof CommentModerationsTableRowSchema>;
export interface CommentModerationsTableRowInsert extends Omit<CommentModerationTableRow, "rowid"> {
}
