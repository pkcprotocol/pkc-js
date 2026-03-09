import {
    getPeerIdFromPublicKey,
    getPeerIdFromPublicKeyBuffer,
    getPlebbitAddressFromPrivateKey,
    getPlebbitAddressFromPublicKey,
    getPlebbitAddressFromPublicKeyBuffer
} from "./util.js";
import * as cborg from "cborg";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import * as ed from "@noble/ed25519";

import PeerId from "peer-id";
import {
    areEquivalentSubplebbitAddresses,
    isStringDomain,
    removeNullUndefinedEmptyObjectsValuesRecursively,
    throwWithErrorCode,
    timestamp
} from "../util.js";
import { Plebbit } from "../plebbit/plebbit.js";

import type {
    ChallengeAnswerMessageSignature,
    ChallengeAnswerMessageType,
    ChallengeMessageSignature,
    ChallengeMessageType,
    ChallengeRequestMessageSignature,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageSignature,
    ChallengeVerificationMessageType,
    DecryptedChallengeVerification,
    PublicationFromDecryptedChallengeRequest,
    PubsubMessage
} from "../pubsub-messages/types.js";
import Logger from "@plebbit/plebbit-logger";
import { messages } from "../errors.js";
import assert from "assert";
import { BaseClientsManager } from "../clients/base-client-manager.js";
import type { SubplebbitIpfsType, SubplebbitSignature } from "../subplebbit/types.js";
import { sha256 } from "js-sha256";
import * as remeda from "remeda"; // tree-shaking supported!
import type { JsonSignature, PlebbitRecordToVerify, PubsubMsgToSign, PubsubSignature, SignerType } from "./types.js";
import type {
    CommentEditOptionsToSign,
    CommentEditPubsubMessagePublication,
    CommentEditSignature
} from "../publications/comment-edit/types.js";
import type { VoteOptionsToSign, VotePubsubMessagePublication, VoteSignature } from "../publications/vote/types.js";
import type {
    CommentIpfsType,
    CommentIpfsWithCidDefined,
    CommentIpfsWithCidPostCidDefined,
    CommentOptionsToSign,
    CommentPubsubMessagePublication,
    CommentPubsubMessagPublicationSignature,
    CommentUpdateForChallengeVerification,
    CommentUpdateForChallengeVerificationSignature,
    CommentUpdateSignature,
    CommentUpdateType
} from "../publications/comment/types.js";
import { CommentEditSignedPropertyNames } from "../publications/comment-edit/schema.js";
import { VoteSignedPropertyNames } from "../publications/vote/schema.js";
import {
    CommentSignedPropertyNames,
    CommentUpdateForChallengeVerificationSignedPropertyNames,
    CommentUpdateReservedFields,
    CommentUpdateSignedPropertyNames
} from "../publications/comment/schema.js";
import type { ModQueuePageIpfs, PageIpfs } from "../pages/types.js";
import { SubplebbitIpfsReservedFields, SubplebbitSignedPropertyNames } from "../subplebbit/schema.js";
import {
    ChallengeRequestMessageSignedPropertyNames,
    ChallengeMessageSignedPropertyNames,
    ChallengeAnswerMessageSignedPropertyNames,
    ChallengeVerificationMessageSignedPropertyNames
} from "../pubsub-messages/schema.js";
import type {
    CommentModerationOptionsToSign,
    CommentModerationPubsubMessagePublication,
    CommentModerationSignature
} from "../publications/comment-moderation/types.js";
import { CommentModerationSignedPropertyNames } from "../publications/comment-moderation/schema.js";
import type {
    SubplebbitEditPublicationOptionsToSign,
    SubplebbitEditPublicationSignature,
    SubplebbitEditPubsubMessagePublication
} from "../publications/subplebbit-edit/types.js";
import { SubplebbitEditPublicationSignedPropertyNames } from "../publications/subplebbit-edit/schema.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { RemoteSubplebbit } from "../subplebbit/remote-subplebbit.js";

export type ValidationResult = { valid: true } | { valid: false; reason: string };

const cborgEncodeOptions = {
    typeEncoders: {
        undefined: () => {
            throw Error("Object to be encoded through cborg should not have undefined"); // we're not disallowing undefined, this is merely to catch bugs
        }
    }
};

const isProbablyBuffer = (arg: any) => arg && typeof arg !== "string" && typeof arg !== "number";

export const signBufferEd25519 = async (bufferToSign: Uint8Array, privateKeyBase64: string) => {
    if (!isProbablyBuffer(bufferToSign)) throw Error(`signBufferEd25519 invalid bufferToSign '${bufferToSign}' not buffer`);
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string") throw Error(`signBufferEd25519 privateKeyBase64 not a string`);
    const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
    if (privateKeyBuffer.length !== 32)
        throw Error(`verifyBufferEd25519 publicKeyBase64 ed25519 public key length not 32 bytes (${privateKeyBuffer.length} bytes)`);
    // do not use to sign strings, it doesn't encode properly in the browser
    const signature = await ed.sign(bufferToSign, privateKeyBuffer);
    return signature;
};

export const verifyBufferEd25519 = async (bufferToSign: Uint8Array, bufferSignature: Uint8Array, publicKeyBase64: string) => {
    if (!isProbablyBuffer(bufferToSign)) throw Error(`verifyBufferEd25519 invalid bufferSignature '${bufferToSign}' not buffer`);
    if (!isProbablyBuffer(bufferSignature)) throw Error(`verifyBufferEd25519 invalid bufferSignature '${bufferSignature}' not buffer`);
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string")
        throw Error(`verifyBufferEd25519 publicKeyBase64 '${publicKeyBase64}' not a string`);
    const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");
    if (publicKeyBuffer.length !== 32)
        throw Error(
            `verifyBufferEd25519 publicKeyBase64 '${publicKeyBase64}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`
        );
    const isValid = await ed.verify(bufferSignature, bufferToSign, publicKeyBuffer);
    return isValid;
};

async function _validateAuthorAddressBeforeSigning(author: CommentOptionsToSign["author"], signer: SignerType, plebbit: Plebbit) {
    if (!author?.address)
        throwWithErrorCode("ERR_AUTHOR_ADDRESS_UNDEFINED", { authorAddress: author.address, signerAddress: signer.address });
    if (isStringDomain(author.address)) {
        // As of now do nothing to verify authors with domain as addresses
        // This may change in the future
    } else {
        const derivedAddress = await getPlebbitAddressFromPrivateKey(signer.privateKey);
        if (derivedAddress !== author.address)
            throwWithErrorCode("ERR_AUTHOR_ADDRESS_NOT_MATCHING_SIGNER", {
                authorAddress: author.address,
                signerAddress: derivedAddress,
                author
            });
    }
}

export async function _signJson(
    signedPropertyNames: JsonSignature["signedPropertyNames"],
    cleanedPublication: Object, // should call cleanUpBeforePublish before calling _signJson
    signer: SignerType,
    log: Logger
): Promise<JsonSignature> {
    assert(signer.publicKey && typeof signer.type === "string" && signer.privateKey, "Signer props need to be defined befoe signing");

    // we assume here that publication already has been cleaned
    //@ts-expect-error
    const propsToSign = remeda.pick(cleanedPublication, signedPropertyNames);
    let publicationEncoded: ReturnType<(typeof cborg)["encode"]>;
    try {
        publicationEncoded = cborg.encode(propsToSign, cborgEncodeOptions);
    } catch (e) {
        (<any>e).objectToEncode = propsToSign;
        log.error("Failed to sign encode json with cborg", e);
        throw e;
    }
    const signatureData = uint8ArrayToString(await signBufferEd25519(publicationEncoded, signer.privateKey), "base64");
    return {
        signature: signatureData,
        publicKey: signer.publicKey,
        type: signer.type,
        signedPropertyNames: remeda.keys.strict(propsToSign)
    };
}

export async function _signPubsubMsg({
    signedPropertyNames,
    msg, // should call cleanUpBeforePublish before calling _signPubsubMsg
    signer,
    log
}: {
    signedPropertyNames: PubsubSignature["signedPropertyNames"];
    msg: PubsubMsgToSign;
    signer: SignerType;
    log: Logger;
}): Promise<PubsubSignature> {
    assert(signer.publicKey && typeof signer.type === "string" && signer.privateKey, "Signer props need to be defined befoe signing");

    // we assume here that pubsub msg already has been cleaned
    //@ts-expect-error
    const propsToSign = remeda.pick(msg, signedPropertyNames);
    let publicationEncoded;
    try {
        publicationEncoded = cborg.encode(propsToSign, cborgEncodeOptions); // The comment instances get jsoned over the pubsub, so it makes sense that we would json them before signing, to make sure the data is the same before and after getting jsoned
    } catch (e) {
        log.error("Failed to encode pubsub message due to cborg error", e, propsToSign);
        throw e;
    }
    const signatureData = await signBufferEd25519(publicationEncoded, signer.privateKey);
    const publicKeyBuffer = uint8ArrayFromString(signer.publicKey, "base64");
    return {
        signature: signatureData,
        publicKey: publicKeyBuffer,
        type: signer.type,
        signedPropertyNames: remeda.keys.strict(propsToSign)
    };
}

export function cleanUpBeforePublishing<T>(msg: T): T {
    // removing values that are undefined/null recursively
    //  removing values that are empty objects recursively, like subplebbit.roles.name: {} or subplebbit.posts: {}
    // We may add other steps in the future

    return removeNullUndefinedEmptyObjectsValuesRecursively(msg);
}

export async function signComment({
    comment,
    plebbit
}: {
    comment: CommentOptionsToSign;
    plebbit: Plebbit;
}): Promise<CommentPubsubMessagPublicationSignature> {
    const log = Logger("plebbit-js:signatures:signComment");
    await _validateAuthorAddressBeforeSigning(comment.author, comment.signer, plebbit);
    return <CommentPubsubMessagPublicationSignature>(
        await _signJson(<JsonSignature["signedPropertyNames"]>CommentSignedPropertyNames, comment, comment.signer, log)
    );
}

export async function signCommentUpdate({
    update,
    signer
}: {
    update: Omit<CommentUpdateType, "signature">;
    signer: SignerType;
}): Promise<CommentUpdateSignature> {
    const log = Logger("plebbit-js:signatures:signCommentUpdate");
    // Not sure, should we validate update.authorEdit here?
    return <CommentUpdateSignature>(
        await _signJson(<JsonSignature["signedPropertyNames"]>CommentUpdateSignedPropertyNames, update, signer, log)
    );
}

export async function signCommentUpdateForChallengeVerification({
    update,
    signer
}: {
    update: Omit<DecryptedChallengeVerification["commentUpdate"], "signature">;
    signer: SignerType;
}): Promise<CommentUpdateForChallengeVerificationSignature> {
    const log = Logger("plebbit-js:signatures:signCommentUpdateForChallengeVerification");
    // Not sure, should we validate update.authorEdit here?
    return <CommentUpdateForChallengeVerificationSignature>(
        await _signJson(CommentUpdateForChallengeVerificationSignedPropertyNames, update, signer, log)
    );
}

export async function signVote({ vote, plebbit }: { vote: VoteOptionsToSign; plebbit: Plebbit }): Promise<VoteSignature> {
    const log = Logger("plebbit-js:signatures:signVote");
    await _validateAuthorAddressBeforeSigning(vote.author, vote.signer, plebbit);
    return <VoteSignature>await _signJson(VoteSignedPropertyNames, vote, vote.signer, log);
}

export async function signSubplebbitEdit({
    subplebbitEdit,
    plebbit
}: {
    subplebbitEdit: SubplebbitEditPublicationOptionsToSign;
    plebbit: Plebbit;
}): Promise<SubplebbitEditPublicationSignature> {
    const log = Logger("plebbit-js:signatures:signSubplebbitEdit");
    await _validateAuthorAddressBeforeSigning(subplebbitEdit.author, subplebbitEdit.signer, plebbit);
    return <SubplebbitEditPublicationSignature>(
        await _signJson(SubplebbitEditPublicationSignedPropertyNames, subplebbitEdit, subplebbitEdit.signer, log)
    );
}

export async function signCommentEdit({
    edit,
    plebbit
}: {
    edit: CommentEditOptionsToSign;
    plebbit: Plebbit;
}): Promise<CommentEditSignature> {
    const log = Logger("plebbit-js:signatures:signCommentEdit");
    await _validateAuthorAddressBeforeSigning(edit.author, edit.signer, plebbit);
    return <CommentEditSignature>(
        await _signJson(<JsonSignature["signedPropertyNames"]>CommentEditSignedPropertyNames, edit, edit.signer, log)
    );
}

export async function signCommentModeration({
    commentMod,
    plebbit
}: {
    commentMod: CommentModerationOptionsToSign;
    plebbit: Plebbit;
}): Promise<CommentModerationSignature> {
    const log = Logger("plebbit-js:signatures:signCommentModeration");
    await _validateAuthorAddressBeforeSigning(commentMod.author, commentMod.signer, plebbit);
    return <CommentModerationSignature>await _signJson(CommentModerationSignedPropertyNames, commentMod, commentMod.signer, log);
}

export async function signSubplebbit({
    subplebbit,
    signer
}: {
    subplebbit: Omit<SubplebbitIpfsType, "signature">;
    signer: SignerType;
}): Promise<SubplebbitSignature> {
    const log = Logger("plebbit-js:signatures:signSubplebbit");
    return <SubplebbitSignature>(
        await _signJson(<JsonSignature["signedPropertyNames"]>SubplebbitSignedPropertyNames, subplebbit, signer, log)
    );
}

export async function signChallengeRequest({
    request,
    signer
}: {
    request: Omit<ChallengeRequestMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeRequestMessageSignature> {
    const log = Logger("plebbit-js:signatures:signChallengeRequest");
    return <ChallengeRequestMessageSignature>await _signPubsubMsg({
        signedPropertyNames: <PubsubSignature["signedPropertyNames"]>ChallengeRequestMessageSignedPropertyNames,
        msg: request,
        signer,
        log
    });
}

export async function signChallengeMessage({
    challengeMessage,
    signer
}: {
    challengeMessage: Omit<ChallengeMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeMessageSignature> {
    const log = Logger("plebbit-js:signatures:signChallengeMessage");
    return <ChallengeMessageSignature>await _signPubsubMsg({
        signedPropertyNames: <PubsubSignature["signedPropertyNames"]>ChallengeMessageSignedPropertyNames,
        msg: challengeMessage,
        signer,
        log
    });
}

export async function signChallengeAnswer({
    challengeAnswer,
    signer
}: {
    challengeAnswer: Omit<ChallengeAnswerMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeAnswerMessageSignature> {
    const log = Logger("plebbit-js:signatures:signChallengeAnswer");
    return <ChallengeAnswerMessageSignature>await _signPubsubMsg({
        signedPropertyNames: <PubsubSignature["signedPropertyNames"]>ChallengeAnswerMessageSignedPropertyNames,
        msg: challengeAnswer,
        signer,
        log
    });
}

export async function signChallengeVerification({
    challengeVerification,
    signer
}: {
    challengeVerification: Omit<ChallengeVerificationMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeVerificationMessageSignature> {
    const log = Logger("plebbit-js:signatures:signChallengeVerification");
    return <ChallengeVerificationMessageSignature>await _signPubsubMsg({
        signedPropertyNames: <PubsubSignature["signedPropertyNames"]>ChallengeVerificationMessageSignedPropertyNames,
        msg: challengeVerification,
        signer,
        log
    });
}

type VerifyAuthorRes = { useDerivedAddress: false; reason?: string } | { useDerivedAddress: true; derivedAddress: string; reason: string };

// Verify functions
const _verifyAuthorDomainResolvesToSignatureAddress = async (
    publicationJson: PublicationFromDecryptedChallengeRequest,
    resolveAuthorNames: boolean,
    clientsManager: BaseClientsManager
): Promise<VerifyAuthorRes> => {
    const log = Logger("plebbit-js:signatures:verifyAuthor");
    const derivedAddress = await getPlebbitAddressFromPublicKey(publicationJson.signature.publicKey);

    if (!publicationJson.author?.address) return { useDerivedAddress: true, reason: messages.ERR_AUTHOR_ADDRESS_UNDEFINED, derivedAddress };

    // Is it a domain?
    if (publicationJson.author.address.includes(".")) {
        if (!resolveAuthorNames) return { useDerivedAddress: false };
        let resolvedAuthorAddress: string | null;
        try {
            resolvedAuthorAddress = await clientsManager.resolveAuthorNameIfNeeded(publicationJson.author.address);
        } catch (e) {
            log.error("Failed to resolve author address to verify author", e);
            return { useDerivedAddress: true, derivedAddress, reason: messages.ERR_FAILED_TO_RESOLVE_AUTHOR_DOMAIN };
        }
        if (resolvedAuthorAddress !== derivedAddress) {
            // Means plebbit-author-address text record is resolving to another address (outdated?)
            // Will always use address derived from publication.signature.publicKey as truth
            log.error(
                `author address (${publicationJson.author.address}) resolved address (${resolvedAuthorAddress}) does not match signature address (${derivedAddress}). `
            );
            return { useDerivedAddress: true, derivedAddress, reason: messages.ERR_AUTHOR_NOT_MATCHING_SIGNATURE };
        }
    } else {
        let authorPeerId: PeerId, signaturePeerId: PeerId;
        try {
            authorPeerId = PeerId.createFromB58String(publicationJson.author.address);
        } catch {
            return { useDerivedAddress: true, reason: messages.ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58, derivedAddress };
        }
        try {
            signaturePeerId = await getPeerIdFromPublicKey(publicationJson.signature.publicKey);
        } catch {
            return { useDerivedAddress: false, reason: messages.ERR_SIGNATURE_PUBLIC_KEY_IS_NOT_B58 };
        }
        if (!signaturePeerId.equals(authorPeerId))
            return { useDerivedAddress: true, reason: messages.ERR_AUTHOR_NOT_MATCHING_SIGNATURE, derivedAddress };
    }
    // Author
    return { useDerivedAddress: false };
};

// DO NOT MODIFY THIS FUNCTION, OTHERWISE YOU RISK BREAKING BACKWARD COMPATIBILITY
const _verifyJsonSignature = async (publicationToBeVerified: PlebbitRecordToVerify): Promise<boolean> => {
    const propsToSign = {};
    for (const propertyName of publicationToBeVerified.signature.signedPropertyNames) {
        //@ts-expect-error
        if (publicationToBeVerified[propertyName] !== undefined && publicationToBeVerified[propertyName] !== null) {
            //@ts-expect-error
            propsToSign[propertyName] = publicationToBeVerified[propertyName];
        }
    }

    try {
        return await verifyBufferEd25519(
            cborg.encode(propsToSign, cborgEncodeOptions),
            uint8ArrayFromString(publicationToBeVerified.signature.signature, "base64"),
            publicationToBeVerified.signature.publicKey
        );
    } catch (e) {
        return false;
    }
};
// DO NOT MODIFY THIS FUNCTION, OTHERWISE YOU RISK BREAKING BACKWARD COMPATIBILITY
const _verifyPubsubSignature = async (msg: PubsubMessage): Promise<boolean> => {
    const propsToSign = {};
    for (const propertyName of msg.signature.signedPropertyNames) {
        //@ts-expect-error
        if (msg[propertyName] !== undefined && msg[propertyName] !== null) propsToSign[propertyName] = msg[propertyName];
    }

    try {
        const publicKeyBase64 = uint8ArrayToString(msg.signature.publicKey, "base64");
        return await verifyBufferEd25519(cborg.encode(propsToSign, cborgEncodeOptions), msg.signature.signature, publicKeyBase64);
    } catch (e) {
        return false;
    }
};

const _verifyPublicationSignatureAndAuthor = async (
    publicationJson: PublicationFromDecryptedChallengeRequest,
    resolveAuthorNames: boolean,
    clientsManager: BaseClientsManager,
    overrideAuthorAddressIfInvalid: boolean
): Promise<ValidationResult & { derivedAddress?: string }> => {
    // Validate author
    const log = Logger("plebbit-js:signatures:verifyPublicationWithAUthor");
    const authorSignatureValidity = await _verifyAuthorDomainResolvesToSignatureAddress(
        publicationJson,
        resolveAuthorNames,
        clientsManager
    );

    if (authorSignatureValidity.useDerivedAddress && !overrideAuthorAddressIfInvalid)
        return { valid: false, reason: authorSignatureValidity.reason };

    // Validate signature
    const signatureValidity = await _verifyJsonSignature(publicationJson);
    if (!signatureValidity) return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };

    if (overrideAuthorAddressIfInvalid && authorSignatureValidity.useDerivedAddress) {
        log.trace(
            `Will override publication.author.address (${publicationJson.author.address}) with signer address (${authorSignatureValidity.derivedAddress})`,
            publicationJson
        );
        publicationJson.author.address = authorSignatureValidity.derivedAddress;
    }

    const res: ValidationResult & { derivedAddress?: string } = { valid: true };
    if (authorSignatureValidity.useDerivedAddress) res.derivedAddress = authorSignatureValidity.derivedAddress;
    return res;
};

export async function verifyVote({
    vote,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid
}: {
    vote: VotePubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(vote))
        return { valid: false, reason: messages.ERR_VOTE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor(vote, resolveAuthorNames, clientsManager, overrideAuthorAddressIfInvalid);
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifySubplebbitEdit({
    subplebbitEdit,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid
}: {
    subplebbitEdit: SubplebbitEditPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(subplebbitEdit))
        return { valid: false, reason: messages.ERR_SUBPLEBBIT_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor(
        subplebbitEdit,
        resolveAuthorNames,
        clientsManager,
        overrideAuthorAddressIfInvalid
    );
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommentEdit({
    edit,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid
}: {
    edit: CommentEditPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(edit))
        return { valid: false, reason: messages.ERR_COMMENT_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor(edit, resolveAuthorNames, clientsManager, overrideAuthorAddressIfInvalid);
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommentModeration({
    moderation,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid
}: {
    moderation: CommentModerationPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(moderation))
        return { valid: false, reason: messages.ERR_COMMENT_MODERATION_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor(moderation, resolveAuthorNames, clientsManager, overrideAuthorAddressIfInvalid);
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommentPubsubMessage({
    comment,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid
}: {
    comment: CommentPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
}) {
    if (!_allFieldsOfRecordInSignedPropertyNames(comment))
        return { valid: false, reason: messages.ERR_COMMENT_PUBSUB_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const validation = await _verifyPublicationSignatureAndAuthor(
        comment,
        resolveAuthorNames,
        clientsManager,
        overrideAuthorAddressIfInvalid
    );
    if (!validation.valid) return validation;

    return validation;
}

export async function verifyCommentIpfs(opts: {
    comment: CommentIpfsType;
    calculatedCommentCid: string;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
    subplebbitAddressFromInstance?: CommentIpfsType["subplebbitAddress"];
}): ReturnType<typeof verifyCommentPubsubMessage> {
    const cacheKey = sha256(
        opts.calculatedCommentCid +
            Number(opts.resolveAuthorNames) +
            Number(opts.overrideAuthorAddressIfInvalid) +
            opts.subplebbitAddressFromInstance || ""
    );
    if (opts.clientsManager._plebbit._memCaches.commentVerificationCache.get(cacheKey)) return { valid: true };

    if (
        opts.subplebbitAddressFromInstance &&
        !areEquivalentSubplebbitAddresses(opts.comment.subplebbitAddress, opts.subplebbitAddressFromInstance)
    )
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_SUBPLEBBIT_ADDRESS_MISMATCH };

    const keysCasted = <(keyof CommentPubsubMessagePublication)[]>opts.comment.signature.signedPropertyNames;

    const validRes = await verifyCommentPubsubMessage({
        comment: remeda.pick(opts.comment, ["signature", ...keysCasted]),
        resolveAuthorNames: opts.resolveAuthorNames,
        clientsManager: opts.clientsManager,
        overrideAuthorAddressIfInvalid: opts.overrideAuthorAddressIfInvalid
    });

    if (!validRes.valid) return validRes;
    const shouldCache = !("derivedAddress" in validRes && opts.overrideAuthorAddressIfInvalid);

    if (shouldCache) opts.clientsManager._plebbit._memCaches.commentVerificationCache.set(cacheKey, true);
    return validRes;
}

function _allFieldsOfRecordInSignedPropertyNames(
    record:
        | PublicationFromDecryptedChallengeRequest
        | SubplebbitIpfsType
        | PubsubMessage
        | CommentUpdateType
        | CommentUpdateForChallengeVerification
): boolean {
    const fieldsOfRecord = remeda.keys.strict(remeda.omit(record, ["signature"]));
    for (const field of fieldsOfRecord) if (!record.signature.signedPropertyNames.includes(field)) return false;

    return true;
}
export async function verifySubplebbit({
    subplebbit,
    subplebbitIpnsName,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid,
    validatePages,
    cacheIfValid
}: {
    subplebbit: SubplebbitIpfsType;
    subplebbitIpnsName: string;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
    validatePages: boolean;
    cacheIfValid?: boolean;
}): Promise<ValidationResult> {
    const log = Logger("plebbit-js:signatures:verifySubplebbit");
    if (!_allFieldsOfRecordInSignedPropertyNames(subplebbit))
        return { valid: false, reason: messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    if (_isThereReservedFieldInRecord(subplebbit, SubplebbitIpfsReservedFields))
        return { valid: false, reason: messages.ERR_SUBPLEBBIT_RECORD_INCLUDES_RESERVED_FIELD };
    const signatureValidity = await _verifyJsonSignature(subplebbit);
    if (!signatureValidity) return { valid: false, reason: messages.ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID };
    const cacheIfValidWithDefault = typeof cacheIfValid === "boolean" ? cacheIfValid : true;
    const cacheKey = sha256(
        subplebbit.signature.signature + resolveAuthorNames + overrideAuthorAddressIfInvalid + validatePages + subplebbitIpnsName
    );
    if (cacheIfValidWithDefault && clientsManager._plebbit._memCaches.subplebbitVerificationCache.get(cacheKey)) return { valid: true };

    if (subplebbit.posts?.pages && validatePages)
        for (const preloadedPageSortName of remeda.keys.strict(subplebbit.posts.pages)) {
            const pageCid: string | undefined = subplebbit.posts.pageCids?.[preloadedPageSortName];
            const preloadedPage = subplebbit.posts.pages[preloadedPageSortName];
            if (!remeda.isPlainObject(preloadedPage)) throw Error("failed to find page ipfs of subplebbit to verify");
            const pageValidity = await verifyPage({
                pageCid,
                page: preloadedPage,
                pageSortName: preloadedPageSortName,
                resolveAuthorNames,
                clientsManager,
                subplebbit,
                parentComment: { cid: undefined, depth: -1, postCid: undefined },
                overrideAuthorAddressIfInvalid,
                validatePages,
                validateUpdateSignature: false // no need because we already verified subplebbit signature
            });

            if (!pageValidity.valid) {
                log.error(
                    `Subplebbit (${subplebbit.address}) page (${preloadedPageSortName} - ${subplebbit.posts.pageCids?.[preloadedPageSortName]}) has an invalid signature due to reason (${pageValidity.reason})`
                );
                return { valid: false, reason: messages.ERR_SUBPLEBBIT_POSTS_INVALID };
            }
        }

    const subPeerId = PeerId.createFromB58String(subplebbitIpnsName);
    const signaturePeerId = await getPeerIdFromPublicKey(subplebbit.signature.publicKey);
    if (!subPeerId.equals(signaturePeerId))
        return { valid: false, reason: messages.ERR_SUBPLEBBIT_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY };
    clientsManager._plebbit._memCaches.subplebbitVerificationCache.set(cacheKey, true);
    return { valid: true };
}

async function _validateSignatureOfPlebbitRecord(publication: PlebbitRecordToVerify): Promise<ValidationResult> {
    if (typeof publication.signature.publicKey !== "string") return { valid: false, reason: messages.ERR_SIGNATURE_HAS_NO_PUBLIC_KEY };
    const signatureValidity = await _verifyJsonSignature(publication);
    if (!signatureValidity) return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };
    return { valid: true };
}

async function _validateSignatureOfPubsubMsg(publication: PubsubMessage): Promise<ValidationResult> {
    const signatureValidity = await _verifyPubsubSignature(publication);
    if (!signatureValidity) return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };
    return { valid: true };
}

function _isThereReservedFieldInRecord(
    record: CommentUpdateType | SubplebbitIpfsType | CommentUpdateForChallengeVerification,
    reservedFields: string[]
) {
    return remeda.intersection(Object.keys(record), reservedFields).length > 0;
}

export async function verifyCommentUpdate({
    update,
    resolveAuthorNames,
    clientsManager,
    subplebbit,
    comment,
    overrideAuthorAddressIfInvalid,
    validatePages,
    validateUpdateSignature
}: {
    update: CommentUpdateType | CommentUpdateForChallengeVerification | ModQueuePageIpfs["comments"][0]["commentUpdate"];
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    subplebbit: SubplebbitForVerifyingPages;
    comment: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "cid" | "depth" | "postCid">;
    overrideAuthorAddressIfInvalid: boolean;
    validatePages: boolean;
    validateUpdateSignature: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(update))
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    if (_isThereReservedFieldInRecord(update, CommentUpdateReservedFields))
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_RESERVED_FIELD };

    const log = Logger("plebbit-js:signatures:verifyCommentUpdate");

    if (validateUpdateSignature) {
        const jsonValidation = await _validateSignatureOfPlebbitRecord(update);

        if (!jsonValidation.valid) return jsonValidation;
    }

    const cacheKey = sha256(
        update.signature.signature +
            resolveAuthorNames +
            subplebbit.address +
            JSON.stringify(comment) +
            overrideAuthorAddressIfInvalid +
            validatePages +
            validateUpdateSignature
    );

    if (clientsManager._plebbit._memCaches.commentUpdateVerificationCache.get(cacheKey)) return { valid: true };
    if ("edit" in update && update.edit) {
        if (update.edit.signature.publicKey !== comment.signature.publicKey)
            return { valid: false, reason: messages.ERR_AUTHOR_EDIT_IS_NOT_SIGNED_BY_AUTHOR };
        const editSignatureValidation = await _validateSignatureOfPlebbitRecord(update.edit);
        if (!editSignatureValidation.valid) return { valid: false, reason: messages.ERR_COMMENT_UPDATE_EDIT_SIGNATURE_IS_INVALID };
    }
    if (update.cid !== comment.cid) return { valid: false, reason: messages.ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT };

    if ("replies" in update && update.replies && validatePages) {
        // Validate update.replies
        const replyPageKeys = remeda.keys.strict(update.replies.pages);
        for (const replySortName of replyPageKeys) {
            const pageCid: string | undefined = update.replies.pageCids?.[replySortName];
            const page = update.replies.pages[replySortName];
            if (!page) throw Error("Failed to find page to verify within comment update");
            const validity = await verifyPage({
                pageCid,
                page,
                pageSortName: replySortName,
                resolveAuthorNames,
                clientsManager,
                subplebbit,
                parentComment: comment,
                overrideAuthorAddressIfInvalid,
                validatePages,
                validateUpdateSignature
            });
            if (!validity.valid) return validity;
        }
    }

    if (subplebbit.signature && update.signature.publicKey !== subplebbit.signature.publicKey)
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_SUBPLEBBIT };

    clientsManager._plebbit._memCaches.commentUpdateVerificationCache.set(cacheKey, true);

    return { valid: true };
}

// -5 mins
function _minimumTimestamp() {
    return timestamp() - 5 * 60;
}

// +5mins
function _maximumTimestamp() {
    return timestamp() + 5 * 60;
}

async function _validateChallengeRequestId(msg: ChallengeRequestMessageType | ChallengeAnswerMessageType): Promise<ValidationResult> {
    const signaturePublicKeyPeerId = await getPeerIdFromPublicKeyBuffer(msg.signature.publicKey);
    if (!signaturePublicKeyPeerId.equals(msg.challengeRequestId))
        return { valid: false, reason: messages.ERR_CHALLENGE_REQUEST_ID_NOT_DERIVED_FROM_SIGNATURE };
    else return { valid: true };
}

export async function verifyChallengeRequest({
    request,
    validateTimestampRange
}: {
    request: ChallengeRequestMessageType;
    validateTimestampRange: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(request))
        return { valid: false, reason: messages.ERR_CHALLENGE_REQUEST_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const idValid = await _validateChallengeRequestId(request);
    if (!idValid.valid) return idValid;

    if ((validateTimestampRange && _minimumTimestamp() > request.timestamp) || _maximumTimestamp() < request.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };

    return _validateSignatureOfPubsubMsg(request);
}

export async function verifyChallengeMessage({
    challenge,
    pubsubTopic,
    validateTimestampRange
}: {
    challenge: ChallengeMessageType;
    pubsubTopic: string;
    validateTimestampRange: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(challenge))
        return { valid: false, reason: messages.ERR_CHALLENGE_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const msgSignerAddress = await getPlebbitAddressFromPublicKeyBuffer(challenge.signature.publicKey);
    if (msgSignerAddress !== pubsubTopic) return { valid: false, reason: messages.ERR_CHALLENGE_MSG_SIGNER_IS_NOT_SUBPLEBBIT };
    if ((validateTimestampRange && _minimumTimestamp() > challenge.timestamp) || _maximumTimestamp() < challenge.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };

    return _validateSignatureOfPubsubMsg(challenge);
}

export async function verifyChallengeAnswer({
    answer,
    validateTimestampRange
}: {
    answer: ChallengeAnswerMessageType;
    validateTimestampRange: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(answer))
        return { valid: false, reason: messages.ERR_CHALLENGE_ANSWER_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const idValid = await _validateChallengeRequestId(answer);
    if (!idValid.valid) return idValid;

    if ((validateTimestampRange && _minimumTimestamp() > answer.timestamp) || _maximumTimestamp() < answer.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };

    return _validateSignatureOfPubsubMsg(answer);
}

export async function verifyChallengeVerification({
    verification,
    pubsubTopic,
    validateTimestampRange
}: {
    verification: ChallengeVerificationMessageType;
    pubsubTopic: string;
    validateTimestampRange: boolean;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(verification))
        return { valid: false, reason: messages.ERR_CHALLENGE_VERIFICATION_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const msgSignerAddress = await getPlebbitAddressFromPublicKeyBuffer(verification.signature.publicKey);
    if (msgSignerAddress !== pubsubTopic) return { valid: false, reason: messages.ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_SUBPLEBBIT };
    if ((validateTimestampRange && _minimumTimestamp() > verification.timestamp) || _maximumTimestamp() < verification.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };

    return _validateSignatureOfPubsubMsg(verification);
}

type ParentCommentForVerifyingPages =
    | Pick<CommentIpfsWithCidPostCidDefined, "cid" | "depth" | "postCid"> // when we're verifying a nested page
    | Pick<CommentIpfsWithCidDefined, "postCid"> // when we're verifying a flat page
    | { cid: undefined; depth: -1; postCid: undefined }; // when we're verifying a subplebbit posts page

type SubplebbitForVerifyingPages = Pick<RemoteSubplebbit, "address" | "signature">;

export async function verifyPageComment({
    pageComment,
    subplebbit,
    parentComment,
    resolveAuthorNames,
    clientsManager,
    overrideAuthorAddressIfInvalid,
    validatePages,
    validateUpdateSignature
}: {
    pageComment: (PageIpfs | ModQueuePageIpfs)["comments"][0];
    subplebbit: SubplebbitForVerifyingPages;
    parentComment: ParentCommentForVerifyingPages | undefined;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    overrideAuthorAddressIfInvalid: boolean;
    validatePages: boolean;
    validateUpdateSignature: boolean;
}): Promise<ValidationResult> {
    // we need to account for multiple cases:
    // when we're verifying a page from a subplebbit.posts, that means there's no parent comment cid or any of its props
    // another sceneario is with a flat page, where we don't have the parent comment cid or prop, but we do have its postCid
    // another sceneario is when we're veriifying a nested page and we have the parent comment cid and all its props
    // another sceneario is when we're verifying a mod queue page that has comments with different depths with different parentCids and not necessarily a shared postCid
    if (!areEquivalentSubplebbitAddresses(pageComment.comment.subplebbitAddress, subplebbit.address))
        return { valid: false, reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_SUB };

    if (pageComment.comment.depth === 0 && pageComment.comment.postCid)
        return { valid: false, reason: messages.ERR_PAGE_COMMENT_POST_HAS_POST_CID_DEFINED_WITH_DEPTH_0 };
    if (parentComment) {
        if ("cid" in parentComment && parentComment.cid !== pageComment.comment.parentCid)
            return { valid: false, reason: messages.ERR_PARENT_CID_OF_COMMENT_IN_PAGE_IS_NOT_CORRECT };

        if (pageComment.comment.depth > 0 && "cid" in parentComment && !parentComment?.cid)
            return { valid: false, reason: messages.ERR_PAGE_COMMENT_IS_A_REPLY_BUT_HAS_NO_PARENT_COMMENT_INSTANCE };

        if ("depth" in parentComment && typeof parentComment.depth === "number" && parentComment.depth + 1 !== pageComment.comment.depth)
            return { valid: false, reason: messages.ERR_PAGE_COMMENT_DEPTH_VALUE_IS_NOT_RELATIVE_TO_ITS_PARENT };

        if (pageComment.comment.postCid !== parentComment.postCid)
            return { valid: false, reason: messages.ERR_PAGE_COMMENT_POST_CID_IS_NOT_SAME_AS_POST_CID_OF_COMMENT_INSTANCE };
    }
    const calculatedCommentCid = await calculateIpfsHash(deterministicStringify(pageComment.comment));

    const commentSignatureValidity = await verifyCommentIpfs({
        comment: pageComment.comment,
        resolveAuthorNames,
        clientsManager,
        overrideAuthorAddressIfInvalid,
        calculatedCommentCid
    });
    if (!commentSignatureValidity.valid) return commentSignatureValidity;
    const postCid =
        (parentComment && parentComment.postCid) || (pageComment.comment.depth === 0 ? calculatedCommentCid : pageComment.comment.postCid);
    if (!postCid) return { valid: false, reason: messages.ERR_PAGE_COMMENT_NO_WAY_TO_DERIVE_POST_CID };

    const commentUpdateSignatureValidity = await verifyCommentUpdate({
        update: pageComment.commentUpdate,
        resolveAuthorNames,
        clientsManager,
        subplebbit,
        comment: {
            signature: pageComment.comment.signature,
            cid: calculatedCommentCid,
            depth: pageComment.comment.depth,
            postCid
        },
        overrideAuthorAddressIfInvalid,
        validatePages,
        validateUpdateSignature
    });
    if (!commentUpdateSignatureValidity.valid) return commentUpdateSignatureValidity;

    return commentSignatureValidity;
}

export async function verifyPage({
    pageCid,
    pageSortName,
    page,
    resolveAuthorNames,
    clientsManager,
    subplebbit,
    parentComment,
    overrideAuthorAddressIfInvalid,
    validatePages,

    validateUpdateSignature
}: {
    pageCid: string | undefined;
    pageSortName: string | undefined;
    page: PageIpfs;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    subplebbit: SubplebbitForVerifyingPages;
    parentComment: ParentCommentForVerifyingPages;
    overrideAuthorAddressIfInvalid: boolean;
    validatePages: boolean;
    validateUpdateSignature: boolean;
}): Promise<ValidationResult> {
    const cacheKey =
        pageCid &&
        sha256(
            pageCid +
                resolveAuthorNames +
                overrideAuthorAddressIfInvalid +
                subplebbit.address +
                subplebbit.signature?.publicKey +
                JSON.stringify(parentComment) +
                validatePages +
                validateUpdateSignature
        );
    if (cacheKey) if (clientsManager._plebbit._memCaches.pageVerificationCache.get(cacheKey)) return { valid: true };

    for (const pageComment of page.comments) {
        const verifyRes = await verifyPageComment({
            pageComment,
            subplebbit,
            resolveAuthorNames,
            clientsManager,
            overrideAuthorAddressIfInvalid,
            parentComment,
            validatePages,
            validateUpdateSignature
        });
        if (!verifyRes.valid) return verifyRes;
    }

    if (cacheKey) clientsManager._plebbit._memCaches.pageVerificationCache.set(cacheKey, true);

    return { valid: true };
}

export async function verifyModQueuePage({
    pageCid,
    page,
    resolveAuthorNames,
    clientsManager,
    subplebbit,
    overrideAuthorAddressIfInvalid,
    validatePages,

    validateUpdateSignature
}: {
    pageCid: string | undefined;
    page: ModQueuePageIpfs;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    subplebbit: SubplebbitForVerifyingPages;
    overrideAuthorAddressIfInvalid: boolean;
    validatePages: boolean;
    validateUpdateSignature: boolean;
}): Promise<ValidationResult> {
    const cacheKey =
        pageCid &&
        sha256(
            pageCid +
                resolveAuthorNames +
                overrideAuthorAddressIfInvalid +
                subplebbit.address +
                subplebbit.signature?.publicKey +
                validatePages +
                validateUpdateSignature
        );
    if (cacheKey) if (clientsManager._plebbit._memCaches.pageVerificationCache.get(cacheKey)) return { valid: true };

    for (const pageComment of page.comments) {
        const verifyRes = await verifyPageComment({
            pageComment,
            subplebbit,
            resolveAuthorNames,
            clientsManager,
            overrideAuthorAddressIfInvalid,
            parentComment: undefined,
            validatePages,
            validateUpdateSignature
        });
        if (!verifyRes.valid) return verifyRes;
    }

    if (cacheKey) clientsManager._plebbit._memCaches.pageVerificationCache.set(cacheKey, true);

    return { valid: true };
}
