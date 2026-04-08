import { z } from "zod";
import { CreateCommunityEditPublicationOptionsSchema, CommunityEditPublicationChallengeRequestToEncryptSchema, CommunityEditPublicationSignedPropertyNames, CommunityEditPubsubMessagePublicationSchema } from "./schema.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";
import type { JsonOfClass, RuntimeAuthorWithCommentUpdateType } from "../../types.js";
import CommunityEdit from "./community-edit.js";
export type CreateCommunityEditPublicationOptions = z.infer<typeof CreateCommunityEditPublicationOptionsSchema>;
export type CommunityEditChallengeRequestToEncryptType = z.infer<typeof CommunityEditPublicationChallengeRequestToEncryptSchema>;
export type CommunityEditJson = JsonOfClass<CommunityEdit>;
export interface CommunityEditPublicationOptionsToSign extends Omit<CommunityEditPubsubMessagePublication, "signature"> {
    signer: SignerType;
    communityAddress: string;
}
export interface CommunityEditPublicationSignature extends JsonSignature {
    signedPropertyNames: typeof CommunityEditPublicationSignedPropertyNames;
}
export type CommunityEditPubsubMessagePublication = z.infer<typeof CommunityEditPubsubMessagePublicationSchema>;
export interface CommunityEditPublicationPubsubMessageWithCommunityAuthor extends CommunityEditPubsubMessagePublication {
    author: RuntimeAuthorWithCommentUpdateType;
}
