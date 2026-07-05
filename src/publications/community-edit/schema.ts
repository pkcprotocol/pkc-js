import { CommunityEditOptionsSchema } from "../../community/schema.js";
import {
    CreatePublicationUserOptionsSchema,
    JsonSignatureSchema,
    PublicationBaseBeforeSigning,
    hasAtLeastOneCommunityIdentifier,
    atLeastOneCommunityIdentifierMessage
} from "../../schema/schema.js";
import { difference, keys, mapToObj, omit } from "remeda";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";

export const CreateCommunityEditPublicationOptionsSchema = CreatePublicationUserOptionsSchema.extend({
    communityEdit: CommunityEditOptionsSchema.strict()
}).strict();

export const CreateCommunityEditPublicationOptionsWithRefinementSchema = CreateCommunityEditPublicationOptionsSchema.refine(
    hasAtLeastOneCommunityIdentifier,
    atLeastOneCommunityIdentifierMessage
);

export const CommunityEditPublicationSignedPropertyNames = keys(
    omit(CreateCommunityEditPublicationOptionsSchema.shape, keysToOmitFromSignedPropertyNames)
);

const communityEditPublicationPickOptions = <Record<(typeof CommunityEditPublicationSignedPropertyNames)[number] | "signature", true>>(
    mapToObj([...CommunityEditPublicationSignedPropertyNames, "signature"], (x) => [x, true])
);

// Will be used by the community when parsing request.communityEdit
export const CommunityEditPubsubMessagePublicationSchema = CreateCommunityEditPublicationOptionsSchema.merge(PublicationBaseBeforeSigning)
    .extend({
        signature: JsonSignatureSchema,
        author: PublicationBaseBeforeSigning.shape.author.unwrap().loose().optional()
    })
    .pick(communityEditPublicationPickOptions)
    .strict();

export const CommunityEditPublicationChallengeRequestToEncryptSchema = CreateCommunityEditPublicationOptionsSchema.shape.challengeRequest
    .unwrap()
    .extend({
        communityEdit: CommunityEditPubsubMessagePublicationSchema.loose()
    });

export const CommunityEditPublicationPubsubReservedFields = difference(
    [
        ...keys(CommunityEditPublicationChallengeRequestToEncryptSchema.shape),
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
    ],
    keys(CommunityEditPubsubMessagePublicationSchema.shape)
);
