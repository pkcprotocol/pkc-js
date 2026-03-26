// Create Vote section here

import { z } from "zod";
import {
    CidStringSchema,
    CreatePublicationUserOptionsSchema,
    JsonSignatureSchema,
    PlebbitTimestampSchema,
    PublicationBaseBeforeSigning,
    SignerWithAddressPublicKeySchema
} from "../../schema/schema.js";
import * as remeda from "remeda";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";

export const CreateVoteUserOptionsSchema = CreatePublicationUserOptionsSchema.extend({
    commentCid: CidStringSchema,
    vote: z.union([z.literal(1), z.literal(0), z.literal(-1)])
}).strict();

export const VoteSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CreateVoteUserOptionsSchema.shape, keysToOmitFromSignedPropertyNames)
);

const votePickOptions = <Record<(typeof VoteSignedPropertyNames)[number] | "signature", true>>(
    remeda.mapToObj([...VoteSignedPropertyNames, "signature"], (x) => [x, true])
);

// Will be used by the sub when parsing request.publication
export const VotePubsubMessagePublicationSchema = CreateVoteUserOptionsSchema.merge(PublicationBaseBeforeSigning)
    .extend({ signature: JsonSignatureSchema, author: PublicationBaseBeforeSigning.shape.author.unwrap().loose().optional() })
    .pick(votePickOptions)
    .strict();

export const VoteTablesRowSchema = VotePubsubMessagePublicationSchema.pick({
    commentCid: true,
    protocolVersion: true,
    timestamp: true,
    vote: true
}).extend({
    insertedAt: PlebbitTimestampSchema,
    authorSignerAddress: SignerWithAddressPublicKeySchema.shape.address,
    extraProps: z.looseObject({}).optional()
});

export const VoteChallengeRequestToEncryptSchema = CreateVoteUserOptionsSchema.shape.challengeRequest.unwrap().extend({
    vote: VotePubsubMessagePublicationSchema.loose()
});

export const VotePubsubReservedFields = remeda.difference(
    [
        ...remeda.keys.strict(VoteTablesRowSchema.shape),
        ...remeda.keys.strict(VoteChallengeRequestToEncryptSchema.shape),
        "shortSubplebbitAddress",
        "shortCommunityAddress",
        "communityAddress",
        "communityPublicKey",
        "communityName",
        "state",
        "publishingState",
        "signer",
        "clients"
    ],
    remeda.keys.strict(VotePubsubMessagePublicationSchema.shape)
);
