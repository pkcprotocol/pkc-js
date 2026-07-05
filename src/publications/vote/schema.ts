// Create Vote section here

import { z } from "zod";
import {
    CidStringSchema,
    CreatePublicationUserOptionsSchema,
    JsonSignatureSchema,
    PKCTimestampSchema,
    PublicationBaseBeforeSigning,
    SignerWithAddressPublicKeySchema,
    hasAtLeastOneCommunityIdentifier,
    atLeastOneCommunityIdentifierMessage
} from "../../schema/schema.js";
import { difference, keys, mapToObj, omit, unique } from "remeda";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";

export const CreateVoteUserOptionsSchema = CreatePublicationUserOptionsSchema.extend({
    commentCid: CidStringSchema,
    vote: z.union([z.literal(1), z.literal(0), z.literal(-1)])
}).strict();

export const CreateVoteUserOptionsWithRefinementSchema = CreateVoteUserOptionsSchema.refine(
    hasAtLeastOneCommunityIdentifier,
    atLeastOneCommunityIdentifierMessage
);

export const VoteSignedPropertyNames = keys(omit(CreateVoteUserOptionsSchema.shape, keysToOmitFromSignedPropertyNames));

const votePickOptions = <Record<(typeof VoteSignedPropertyNames)[number] | "signature", true>>(
    mapToObj([...VoteSignedPropertyNames, "signature"], (x) => [x, true])
);

// Will be used by the community when parsing request.publication
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
    insertedAt: PKCTimestampSchema,
    authorSignerAddress: SignerWithAddressPublicKeySchema.shape.address,
    extraProps: z.looseObject({}).optional()
});

export const VoteChallengeRequestToEncryptSchema = CreateVoteUserOptionsSchema.shape.challengeRequest.unwrap().extend({
    vote: VotePubsubMessagePublicationSchema.loose()
});

export const VotePubsubReservedFields = difference(
    // unique() because remeda v2's difference is multiset (removes each `other` element once, not
    // all occurrences); `vote` appears in both source schemas AND the pubsub schema and would
    // otherwise survive as reserved. v1's difference was set-based. (Matches comment-edit's guard.)
    unique([
        ...keys(VoteTablesRowSchema.shape),
        ...keys(VoteChallengeRequestToEncryptSchema.shape),
        "shortCommunityAddress",
        "shortCommunityAddress",
        "communityAddress",
        "communityPublicKey",
        "communityName",
        "state",
        "publishingState",
        "signer",
        "clients",
        "nameResolved"
    ]),
    keys(VotePubsubMessagePublicationSchema.shape)
);
