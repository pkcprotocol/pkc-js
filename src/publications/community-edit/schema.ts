import { CommunityEditOptionsSchema } from "../../community/schema.js";
import { CreatePublicationUserOptionsSchema, JsonSignatureSchema, PublicationBaseBeforeSigning } from "../../schema/schema.js";
import * as remeda from "remeda";
import { keysToOmitFromSignedPropertyNames } from "../../signer/constants.js";

export const CreateCommunityEditPublicationOptionsSchema = CreatePublicationUserOptionsSchema.extend({
    subplebbitEdit: CommunityEditOptionsSchema.strict()
}).strict();

export const CommunityEditPublicationSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CreateCommunityEditPublicationOptionsSchema.shape, keysToOmitFromSignedPropertyNames)
);

const subplebbitEditPublicationPickOptions = <Record<(typeof CommunityEditPublicationSignedPropertyNames)[number] | "signature", true>>(
    remeda.mapToObj([...CommunityEditPublicationSignedPropertyNames, "signature"], (x) => [x, true])
);

// Will be used by the sub when parsing request.subplebbitEdit
export const CommunityEditPubsubMessagePublicationSchema = CreateCommunityEditPublicationOptionsSchema.merge(PublicationBaseBeforeSigning)
    .extend({
        signature: JsonSignatureSchema,
        author: PublicationBaseBeforeSigning.shape.author.unwrap().loose().optional()
    })
    .pick(subplebbitEditPublicationPickOptions)
    .strict();

export const CommunityEditPublicationChallengeRequestToEncryptSchema = CreateCommunityEditPublicationOptionsSchema.shape.challengeRequest
    .unwrap()
    .extend({
        subplebbitEdit: CommunityEditPubsubMessagePublicationSchema.loose()
    });

export const CommunityEditPublicationPubsubReservedFields = remeda.difference(
    [
        ...remeda.keys.strict(CommunityEditPublicationChallengeRequestToEncryptSchema.shape),
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
    remeda.keys.strict(CommunityEditPubsubMessagePublicationSchema.shape)
);
