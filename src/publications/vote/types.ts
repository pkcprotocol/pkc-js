import { z } from "zod";
import {
    CreateVoteUserOptionsSchema,
    VoteChallengeRequestToEncryptSchema,
    VotePubsubMessagePublicationSchema,
    VoteSignedPropertyNames,
    VoteTablesRowSchema
} from "./schema.js";
import Vote from "./vote.js";
import type { JsonOfClass, RuntimeAuthorWithCommentUpdateType } from "../../types.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";

export type CreateVoteOptions = z.infer<typeof CreateVoteUserOptionsSchema>;

export type VoteChallengeRequestToEncryptType = z.infer<typeof VoteChallengeRequestToEncryptSchema>;

export type VoteJson = JsonOfClass<Vote>;

export interface VoteOptionsToSign extends Omit<VotePubsubMessagePublication, "signature"> {
    signer: SignerType;
    communityAddress: string;
}

export interface VoteSignature extends JsonSignature {
    signedPropertyNames: typeof VoteSignedPropertyNames;
}

export type VotePubsubMessagePublication = z.infer<typeof VotePubsubMessagePublicationSchema>;

export interface VotePubsubMessageWithCommunityAuthor extends VotePubsubMessagePublication {
    author: RuntimeAuthorWithCommentUpdateType;
}

export type VotesTableRow = z.infer<typeof VoteTablesRowSchema>;

export type VotesTableRowInsert = VotesTableRow;
