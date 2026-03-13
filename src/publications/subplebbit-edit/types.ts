import { z } from "zod";
import {
    CreateSubplebbitEditPublicationOptionsSchema,
    SubplebbitEditPublicationChallengeRequestToEncryptSchema,
    SubplebbitEditPublicationSignedPropertyNames,
    SubplebbitEditPubsubMessagePublicationSchema
} from "./schema.js";
import type { JsonSignature, SignerType } from "../../signer/types.js";
import type { JsonOfClass, RuntimeAuthorWithCommentUpdateType } from "../../types.js";
import SubplebbitEdit from "./subplebbit-edit.js";

export type CreateSubplebbitEditPublicationOptions = z.infer<typeof CreateSubplebbitEditPublicationOptionsSchema>;

export type SubplebbitEditChallengeRequestToEncryptType = z.infer<typeof SubplebbitEditPublicationChallengeRequestToEncryptSchema>;

export type SubplebbitEditJson = JsonOfClass<SubplebbitEdit>;

export interface SubplebbitEditPublicationOptionsToSign extends Omit<SubplebbitEditPubsubMessagePublication, "signature"> {
    signer: SignerType;
}

export interface SubplebbitEditPublicationSignature extends JsonSignature {
    signedPropertyNames: typeof SubplebbitEditPublicationSignedPropertyNames;
}

export type SubplebbitEditPubsubMessagePublication = z.infer<typeof SubplebbitEditPubsubMessagePublicationSchema>;

export interface SubplebbitEditPublicationPubsubMessageWithSubplebbitAuthor extends SubplebbitEditPubsubMessagePublication {
    author: RuntimeAuthorWithCommentUpdateType;
}
