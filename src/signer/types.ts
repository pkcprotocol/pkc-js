import { z } from "zod";
import { CreateSignerSchema, JsonSignatureSchema } from "../schema/schema.js";
import type {
    ChallengeAnswerMessageType,
    ChallengeMessageType,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageType,
    PublicationFromDecryptedChallengeRequest
} from "../pubsub-messages/types.js";
import type { CommunityIpfsType } from "../community/types.js";

import type { CommentUpdateForChallengeVerification, CommentUpdateType } from "../publications/comment/types.js";
import { EncryptedSchema, PubsubMessageSignatureSchema } from "../pubsub-messages/schema.js";

export type CreateSignerOptions = z.infer<typeof CreateSignerSchema>;

export type JsonSignature = z.infer<typeof JsonSignatureSchema>;

export interface SignerType {
    type: "ed25519";
    privateKey: string;
    publicKey?: string;
    address: string;
    ipfsKey?: Uint8Array;
    ipnsKeyName?: string;
}

// ---------------------------

export type Encrypted = z.infer<typeof EncryptedSchema>;

// ---------------------------
// Signature

export type PubsubSignature = z.infer<typeof PubsubMessageSignatureSchema>;

// ---------------------------
// Signing

export type PubsubMsgToSign =
    | Omit<ChallengeAnswerMessageType, "signature">
    | Omit<ChallengeRequestMessageType, "signature">
    | Omit<ChallengeVerificationMessageType, "signature">
    | Omit<ChallengeMessageType, "signature">;

// ---------------------------
// Verifying
export type PKCRecordToVerify =
    | PublicationFromDecryptedChallengeRequest
    | CommunityIpfsType
    | CommentUpdateType
    | CommentUpdateForChallengeVerification;
