import type {
    CommentEditPubsubMessagePublication,
    CommentEditPubsubMessagePublicationWithSubplebbitAuthor
} from "../publications/comment-edit/types.js";
import type {
    CommentModerationPubsubMessagePublication,
    CommentModerationPubsubMessagePublicationWithSubplebbitAuthor
} from "../publications/comment-moderation/types.js";
import type {
    CommentPubsubMessagePublication,
    CommentPubsubMessageWithSubplebbitAuthor,
    PostPubsubMessageWithSubplebbitAuthor,
    ReplyPubsubMessageWithSubplebbitAuthor
} from "../publications/comment/types.js";
import type {
    SubplebbitEditPublicationPubsubMessageWithSubplebbitAuthor,
    SubplebbitEditPubsubMessagePublication
} from "../publications/subplebbit-edit/types.js";
import type { VotePubsubMessagePublication, VotePubsubMessageWithSubplebbitAuthor } from "../publications/vote/types.js";
import type { PubsubSignature } from "../signer/types.js";
import type { RuntimeAuthorWithCommentUpdateType } from "../types.js";
import {
    ChallengeAnswerMessageSchema,
    ChallengeAnswerMessageSignedPropertyNames,
    ChallengeInChallengePubsubMessageSchema,
    ChallengeMessageSchema,
    ChallengeMessageSignedPropertyNames,
    ChallengeRequestMessageSchema,
    ChallengeRequestMessageSignedPropertyNames,
    ChallengeVerificationMessageSchema,
    ChallengeVerificationMessageSignedPropertyNames,
    DecryptedChallengeAnswerSchema,
    DecryptedChallengeRequestPublicationSchema,
    DecryptedChallengeRequestSchema,
    DecryptedChallengeSchema,
    DecryptedChallengeVerificationSchema
} from "./schema.js";

import { z } from "zod";

// Challenge requests here

export type ChallengeRequestMessageType = z.infer<typeof ChallengeRequestMessageSchema>;

export type DecryptedChallengeRequestPublication = z.infer<typeof DecryptedChallengeRequestPublicationSchema>;
export type DecryptedChallengeRequest = z.infer<typeof DecryptedChallengeRequestSchema>;

export type DecryptedChallengeRequestMessageType = DecryptedChallengeRequest & ChallengeRequestMessageType;

export interface DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor
    extends Omit<DecryptedChallengeRequestMessageType, "comment" | "vote" | "commentEdit" | "commentModeration" | "subplebbitEdit"> {
    vote?: VotePubsubMessageWithSubplebbitAuthor;
    comment?: CommentPubsubMessageWithSubplebbitAuthor;
    commentEdit?: CommentEditPubsubMessagePublicationWithSubplebbitAuthor;
    commentModeration?: CommentModerationPubsubMessagePublicationWithSubplebbitAuthor;
    subplebbitEdit?: SubplebbitEditPublicationPubsubMessageWithSubplebbitAuthor;
}

export type PublicationFromDecryptedChallengeRequest = NonNullable<
    | VotePubsubMessagePublication
    | CommentPubsubMessagePublication
    | CommentEditPubsubMessagePublication
    | CommentModerationPubsubMessagePublication
    | SubplebbitEditPubsubMessagePublication
>;

export type PublicationWithSubplebbitAuthorFromDecryptedChallengeRequest = PublicationFromDecryptedChallengeRequest & {
    author: RuntimeAuthorWithCommentUpdateType;
};

export interface DecryptedChallengeRequestMessageWithReplySubplebbitAuthor
    extends DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor {
    comment: ReplyPubsubMessageWithSubplebbitAuthor;
}

export interface DecryptedChallengeRequestMessageWithPostSubplebbitAuthor extends DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor {
    comment: PostPubsubMessageWithSubplebbitAuthor;
}

// Challenge message here

export type ChallengeType = z.infer<typeof ChallengeInChallengePubsubMessageSchema>;

export type ChallengeMessageType = z.infer<typeof ChallengeMessageSchema>;

export type DecryptedChallenge = z.infer<typeof DecryptedChallengeSchema>;

export type DecryptedChallengeMessageType = ChallengeMessageType & DecryptedChallenge;

// Challenge answer here
export type ChallengeAnswerMessageType = z.infer<typeof ChallengeAnswerMessageSchema>;

export type DecryptedChallengeAnswer = z.infer<typeof DecryptedChallengeAnswerSchema>;

export type DecryptedChallengeAnswerMessageType = ChallengeAnswerMessageType & DecryptedChallengeAnswer;

// challenge verification

export type ChallengeVerificationMessageType = z.infer<typeof ChallengeVerificationMessageSchema>;

export type DecryptedChallengeVerification = z.infer<typeof DecryptedChallengeVerificationSchema>;

export type DecryptedChallengeVerificationMessageType = ChallengeVerificationMessageType & Partial<DecryptedChallengeVerification>;

// Challenge verification native types

// Misc challenge pubsub message

export type PubsubMessage =
    | ChallengeRequestMessageType
    | ChallengeMessageType
    | ChallengeAnswerMessageType
    | ChallengeVerificationMessageType;

// encoded for rpc here

export type EncryptedEncoded = {
    ciphertext: string; // base64
    iv: string; // base64
    tag: string; // base64
    type: string; // ed25519-aes-gcm for now
};

export interface EncodedPubsubSignature extends Omit<PubsubSignature, "signature" | "publicKey"> {
    signature: string; // base64
    publicKey: string; // base64
}

export interface BaseEncodedPubsubMessage {
    challengeRequestId: string; // base64 string
    signature: EncodedPubsubSignature;
}
export interface EncodedDecryptedChallengeRequestMessageType
    extends Omit<DecryptedChallengeRequestMessageType, "challengeRequestId" | "encrypted" | "signature">,
        BaseEncodedPubsubMessage {
    encrypted: EncryptedEncoded; // all base64 strings
}

export interface EncodedDecryptedChallengeRequestMessageTypeWithSubplebbitAuthor
    extends Omit<EncodedDecryptedChallengeRequestMessageType, keyof DecryptedChallengeRequestPublication>,
        Pick<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor, keyof DecryptedChallengeRequestPublication> {}

export interface EncodedDecryptedChallengeMessageType
    extends Omit<DecryptedChallengeMessageType, "challengeRequestId" | "encrypted" | "signature">,
        BaseEncodedPubsubMessage {
    encrypted: EncryptedEncoded; // all base64 strings
}

export interface EncodedDecryptedChallengeAnswerMessageType
    extends Omit<DecryptedChallengeAnswerMessageType, "challengeRequestId" | "encrypted" | "signature">,
        BaseEncodedPubsubMessage {
    encrypted: EncryptedEncoded; // all base64 strings
}

export interface EncodedDecryptedChallengeVerificationMessageType
    extends Omit<DecryptedChallengeVerificationMessageType, "challengeRequestId" | "encrypted" | "signature">,
        BaseEncodedPubsubMessage {
    encrypted?: EncryptedEncoded; // all base64 strings
}

// Signatures here

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
