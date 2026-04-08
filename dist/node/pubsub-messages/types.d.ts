import type { CommentEditPubsubMessagePublication, CommentEditPubsubMessagePublicationWithCommunityAuthor } from "../publications/comment-edit/types.js";
import type { CommentModerationPubsubMessagePublication, CommentModerationPubsubMessagePublicationWithCommunityAuthor } from "../publications/comment-moderation/types.js";
import type { CommentPubsubMessagePublication, CommentPubsubMessageWithCommunityAuthor, PostPubsubMessageWithCommunityAuthor, ReplyPubsubMessageWithCommunityAuthor } from "../publications/comment/types.js";
import type { CommunityEditPublicationPubsubMessageWithCommunityAuthor, CommunityEditPubsubMessagePublication } from "../publications/community-edit/types.js";
import type { VotePubsubMessagePublication, VotePubsubMessageWithCommunityAuthor } from "../publications/vote/types.js";
import type { PubsubSignature } from "../signer/types.js";
import type { RuntimeAuthorWithCommentUpdateType } from "../types.js";
import { ChallengeAnswerMessageSchema, ChallengeAnswerMessageSignedPropertyNames, ChallengeInChallengePubsubMessageSchema, ChallengeMessageSchema, ChallengeMessageSignedPropertyNames, ChallengeRequestMessageSchema, ChallengeRequestMessageSignedPropertyNames, ChallengeVerificationMessageSchema, ChallengeVerificationMessageSignedPropertyNames, DecryptedChallengeAnswerSchema, DecryptedChallengeRequestPublicationSchema, DecryptedChallengeRequestSchema, DecryptedChallengeSchema, DecryptedChallengeVerificationSchema } from "./schema.js";
import { z } from "zod";
export type ChallengeRequestMessageType = z.infer<typeof ChallengeRequestMessageSchema>;
export type DecryptedChallengeRequestPublication = z.infer<typeof DecryptedChallengeRequestPublicationSchema>;
export type DecryptedChallengeRequest = z.infer<typeof DecryptedChallengeRequestSchema>;
export type DecryptedChallengeRequestMessageType = DecryptedChallengeRequest & ChallengeRequestMessageType;
export interface DecryptedChallengeRequestMessageTypeWithCommunityAuthor extends Omit<DecryptedChallengeRequestMessageType, "comment" | "vote" | "commentEdit" | "commentModeration" | "communityEdit"> {
    vote?: VotePubsubMessageWithCommunityAuthor;
    comment?: CommentPubsubMessageWithCommunityAuthor;
    commentEdit?: CommentEditPubsubMessagePublicationWithCommunityAuthor;
    commentModeration?: CommentModerationPubsubMessagePublicationWithCommunityAuthor;
    communityEdit?: CommunityEditPublicationPubsubMessageWithCommunityAuthor;
}
export type PublicationFromDecryptedChallengeRequest = NonNullable<VotePubsubMessagePublication | CommentPubsubMessagePublication | CommentEditPubsubMessagePublication | CommentModerationPubsubMessagePublication | CommunityEditPubsubMessagePublication>;
export type PublicationWithCommunityAuthorFromDecryptedChallengeRequest = PublicationFromDecryptedChallengeRequest & {
    author: RuntimeAuthorWithCommentUpdateType;
};
export interface DecryptedChallengeRequestMessageWithReplyCommunityAuthor extends DecryptedChallengeRequestMessageTypeWithCommunityAuthor {
    comment: ReplyPubsubMessageWithCommunityAuthor;
}
export interface DecryptedChallengeRequestMessageWithPostCommunityAuthor extends DecryptedChallengeRequestMessageTypeWithCommunityAuthor {
    comment: PostPubsubMessageWithCommunityAuthor;
}
export type ChallengeType = z.infer<typeof ChallengeInChallengePubsubMessageSchema>;
export type ChallengeMessageType = z.infer<typeof ChallengeMessageSchema>;
export type DecryptedChallenge = z.infer<typeof DecryptedChallengeSchema>;
export type DecryptedChallengeMessageType = ChallengeMessageType & DecryptedChallenge;
export type ChallengeAnswerMessageType = z.infer<typeof ChallengeAnswerMessageSchema>;
export type DecryptedChallengeAnswer = z.infer<typeof DecryptedChallengeAnswerSchema>;
export type DecryptedChallengeAnswerMessageType = ChallengeAnswerMessageType & DecryptedChallengeAnswer;
export type ChallengeVerificationMessageType = z.infer<typeof ChallengeVerificationMessageSchema>;
export type DecryptedChallengeVerification = z.infer<typeof DecryptedChallengeVerificationSchema>;
export type DecryptedChallengeVerificationMessageType = ChallengeVerificationMessageType & Partial<DecryptedChallengeVerification>;
export type PubsubMessage = ChallengeRequestMessageType | ChallengeMessageType | ChallengeAnswerMessageType | ChallengeVerificationMessageType;
export type EncryptedEncoded = {
    ciphertext: string;
    iv: string;
    tag: string;
    type: string;
};
export interface EncodedPubsubSignature extends Omit<PubsubSignature, "signature" | "publicKey"> {
    signature: string;
    publicKey: string;
}
export interface BaseEncodedPubsubMessage {
    challengeRequestId: string;
    signature: EncodedPubsubSignature;
}
export interface EncodedDecryptedChallengeRequestMessageType extends Omit<DecryptedChallengeRequestMessageType, "challengeRequestId" | "encrypted" | "signature">, BaseEncodedPubsubMessage {
    encrypted: EncryptedEncoded;
}
export interface EncodedDecryptedChallengeRequestMessageTypeWithCommunityAuthor extends Omit<EncodedDecryptedChallengeRequestMessageType, keyof DecryptedChallengeRequestPublication>, Pick<DecryptedChallengeRequestMessageTypeWithCommunityAuthor, keyof DecryptedChallengeRequestPublication> {
}
export interface EncodedDecryptedChallengeMessageType extends Omit<DecryptedChallengeMessageType, "challengeRequestId" | "encrypted" | "signature">, BaseEncodedPubsubMessage {
    encrypted: EncryptedEncoded;
}
export interface EncodedDecryptedChallengeAnswerMessageType extends Omit<DecryptedChallengeAnswerMessageType, "challengeRequestId" | "encrypted" | "signature">, BaseEncodedPubsubMessage {
    encrypted: EncryptedEncoded;
}
export interface EncodedDecryptedChallengeVerificationMessageType extends Omit<DecryptedChallengeVerificationMessageType, "challengeRequestId" | "encrypted" | "signature">, BaseEncodedPubsubMessage {
    encrypted?: EncryptedEncoded;
}
export interface ChallengeRequestMessageSignature extends PubsubSignature {
    signedPropertyNames: typeof ChallengeRequestMessageSignedPropertyNames;
}
export interface ChallengeMessageSignature extends PubsubSignature {
    signedPropertyNames: typeof ChallengeMessageSignedPropertyNames;
}
export interface ChallengeAnswerMessageSignature extends PubsubSignature {
    signedPropertyNames: typeof ChallengeAnswerMessageSignedPropertyNames;
}
export interface ChallengeVerificationMessageSignature extends PubsubSignature {
    signedPropertyNames: typeof ChallengeVerificationMessageSignedPropertyNames;
}
