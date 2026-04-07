import { z } from "zod";
import {
    ChallengeAnswersSchema,
    CreatePublicationUserOptionsSchema,
    PKCTimestampSchema,
    ProtocolVersionSchema,
    UserAgentSchema
} from "../schema/schema.js";
import { VotePubsubMessagePublicationSchema } from "../publications/vote/schema.js";
import { CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema } from "../publications/comment-edit/schema.js";
import {
    CommentIpfsSchema,
    CommentPubsubMessageWithFlexibleAuthorRefinementSchema,
    CommentUpdateForChallengeVerificationSchema
} from "../publications/comment/schema.js";
import { ChallengeFileSchema, ChallengeFromGetChallengeSchema } from "../community/schema.js";
import * as remeda from "remeda";
import { CommentModerationPubsubMessagePublicationSchema } from "../publications/comment-moderation/schema.js";
import { CommunityEditPubsubMessagePublicationSchema } from "../publications/community-edit/schema.js";
import { Uint8ArraySchema, nonNegativeIntStringSchema } from "../schema.js";

const AcceptedChallengeTypeSchema = z.string().min(1);

export const PubsubMessageSignatureSchema = z
    .object({
        signature: Uint8ArraySchema, // (byte string in cbor)
        publicKey: Uint8ArraySchema, // (byte string in cbor) 32 bytes
        type: z.string().min(1),
        signedPropertyNames: z.string().array()
    })
    .strict();

const PubsubMessageBaseSchema = z.object({
    challengeRequestId: Uint8ArraySchema, // (byte string in cbor) // multihash of pubsubmessage.signature.publicKey, each challengeRequestMessage must use a new public key
    signature: PubsubMessageSignatureSchema,
    protocolVersion: ProtocolVersionSchema,
    userAgent: UserAgentSchema,
    timestamp: PKCTimestampSchema
});

export const EncryptedSchema = z
    .object({
        // examples available at https://github.com/plebbit/plebbit-js/blob/master/docs/encryption.md
        ciphertext: Uint8ArraySchema,
        iv: Uint8ArraySchema,
        tag: Uint8ArraySchema,
        type: z.string().min(1)
    })
    .strict();

// publication with community author that are added by community when they respond to publication, or emit an event

// Challenge Request message

export const ChallengeRequestMessageSchema = PubsubMessageBaseSchema.extend({
    type: z.literal("CHALLENGEREQUEST"),
    encrypted: EncryptedSchema, // Will decrypt to DecryptedChallengeRequestSchema
    acceptedChallengeTypes: AcceptedChallengeTypeSchema.array().optional()
}).strict();

export const DecryptedChallengeRequestPublicationSchema = z.object({
    comment: CommentPubsubMessageWithFlexibleAuthorRefinementSchema.optional(),
    vote: VotePubsubMessagePublicationSchema.loose().optional(),
    commentEdit: CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.loose().optional(),
    commentModeration: CommentModerationPubsubMessagePublicationSchema.loose().optional(),
    communityEdit: CommunityEditPubsubMessagePublicationSchema.loose().optional()
});

// ChallengeRequestMessage.encrypted.ciphertext decrypts to JSON, with these props
export const DecryptedChallengeRequestSchema = DecryptedChallengeRequestPublicationSchema.merge(
    CreatePublicationUserOptionsSchema.shape.challengeRequest.unwrap()
);

export const ChallengeRequestMessageSignedPropertyNames = remeda.keys.strict(
    remeda.omit(ChallengeRequestMessageSchema.shape, ["signature"])
);
// Challenge message

export const ChallengeInChallengePubsubMessageSchema = z
    .object({
        challenge: z.string(),
        type: z.lazy(() => ChallengeFromGetChallengeSchema.shape.type),
        caseInsensitive: z.lazy(() => ChallengeFileSchema.shape.caseInsensitive)
    })
    .strict();

export const ChallengeMessageSchema = PubsubMessageBaseSchema.extend({
    type: z.literal("CHALLENGE"),
    encrypted: EncryptedSchema // Will decrypt to DecryptedChallengeSchema
}).strict();

export const DecryptedChallengeSchema = z
    .object({
        challenges: ChallengeInChallengePubsubMessageSchema.array()
    })
    .strict();
export const ChallengeMessageSignedPropertyNames = remeda.keys.strict(remeda.omit(ChallengeMessageSchema.shape, ["signature"]));

// Challenge answer

export const ChallengeAnswerMessageSchema = PubsubMessageBaseSchema.extend({
    type: z.literal("CHALLENGEANSWER"),
    encrypted: EncryptedSchema // Will decrypt to DecryptedChallengeAnswerSchema
}).strict();

export const DecryptedChallengeAnswerSchema = z
    .object({
        challengeAnswers: ChallengeAnswersSchema // for example ['2+2=4', '1+7=8']
    })
    .strict();

export const ChallengeAnswerMessageSignedPropertyNames = remeda.keys.strict(remeda.omit(ChallengeAnswerMessageSchema.shape, ["signature"]));

// Challenge Verification

export const ChallengeVerificationMessageSchema = PubsubMessageBaseSchema.extend({
    type: z.literal("CHALLENGEVERIFICATION"),
    challengeSuccess: z.boolean(),
    challengeErrors: z.record(nonNegativeIntStringSchema, z.string()).optional(), // challenge index => challenge error
    reason: z.string().optional(),
    encrypted: EncryptedSchema.optional() // Will decrypt to DecryptedChallengeVerificationSchema
}).strict();

export const DecryptedChallengeVerificationSchema = z
    .object({
        comment: CommentIpfsSchema.loose(),
        commentUpdate: CommentUpdateForChallengeVerificationSchema.loose()
    })
    .strict();

export const ChallengeVerificationMessageSignedPropertyNames = remeda.keys.strict(
    remeda.omit(ChallengeVerificationMessageSchema.shape, ["signature"])
);

// Handling challenges for community
