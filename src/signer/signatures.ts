import {
    getPeerIdFromPublicKey,
    getPeerIdFromPublicKeyBuffer,
    getPKCAddressFromPrivateKey,
    getPKCAddressFromPublicKey,
    getPKCAddressFromPublicKeyBuffer,
    getPKCAddressFromPublicKeySync
} from "./util.js";
import * as cborg from "cborg";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import { ed25519 } from "@noble/curves/ed25519.js";

import { peerIdFromString } from "@libp2p/peer-id";
import { areEquivalentCommunityAddresses, isStringDomain, removeNullUndefinedEmptyObjectsValuesRecursively, timestamp } from "../util.js";
import { getCommunityNameFromWire, getCommunityPublicKeyFromWire } from "../publications/publication-community.js";
import { PKCError } from "../pkc-error.js";
import { PKC } from "../pkc/pkc.js";

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
import Logger from "../logger.js";
import { messages } from "../errors.js";
import assert from "assert";
import { BaseClientsManager } from "../clients/base-client-manager.js";
import type { CommunityIpfsType, CommunitySignature } from "../community/types.js";
import { sha256 } from "js-sha256";
import * as remeda from "remeda"; // tree-shaking supported!
import type { JsonSignature, PKCRecordToVerify, PubsubMsgToSign, PubsubSignature, SignerType } from "./types.js";
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
    CommentIpfsReservedFields,
    CommentSignedPropertyNames,
    CommentUpdateForChallengeVerificationSignedPropertyNames,
    CommentUpdateReservedFields,
    CommentUpdateSignedPropertyNames
} from "../publications/comment/schema.js";
import type { ModQueuePageIpfs, PageIpfs } from "../pages/types.js";
import { CommunityIpfsReservedFields, CommunitySignedPropertyNames } from "../community/schema.js";
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
    CommunityEditPublicationOptionsToSign,
    CommunityEditPublicationSignature,
    CommunityEditPubsubMessagePublication
} from "../publications/community-edit/types.js";
import { CommunityEditPublicationSignedPropertyNames } from "../publications/community-edit/schema.js";
import { AuthorCommentIpfsReservedFields } from "../schema/schema.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { RemoteCommunity } from "../community/remote-community.js";
import { getAuthorNameFromWire } from "../publications/publication-author.js";

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
    const signature = ed25519.sign(bufferToSign, privateKeyBuffer);
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
    const isValid = ed25519.verify(bufferSignature, bufferToSign, publicKeyBuffer);
    return isValid;
};

async function _validateAuthorAddressBeforeSigning(author: CommentOptionsToSign["author"], signer: SignerType, pkc: PKC) {
    const authorName = getAuthorNameFromWire(author);
    if (!authorName) return;
    if (isStringDomain(authorName)) return;
    throw new PKCError("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58", {
        authorAddress: authorName,
        signerAddress: signer.address,
        author
    });
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
    //  removing values that are empty objects recursively, like community.roles.name: {} or community.posts: {}
    // We may add other steps in the future

    return removeNullUndefinedEmptyObjectsValuesRecursively(msg);
}

export async function signComment({
    comment,
    pkc
}: {
    comment: CommentOptionsToSign;
    pkc: PKC;
}): Promise<CommentPubsubMessagPublicationSignature> {
    const log = Logger("pkc-js:signatures:signComment");
    await _validateAuthorAddressBeforeSigning(comment.author, comment.signer, pkc);
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
    const log = Logger("pkc-js:signatures:signCommentUpdate");
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
    const log = Logger("pkc-js:signatures:signCommentUpdateForChallengeVerification");
    // Not sure, should we validate update.authorEdit here?
    return <CommentUpdateForChallengeVerificationSignature>(
        await _signJson(CommentUpdateForChallengeVerificationSignedPropertyNames, update, signer, log)
    );
}

export async function signVote({ vote, pkc }: { vote: VoteOptionsToSign; pkc: PKC }): Promise<VoteSignature> {
    const log = Logger("pkc-js:signatures:signVote");
    await _validateAuthorAddressBeforeSigning(vote.author, vote.signer, pkc);
    return <VoteSignature>await _signJson(VoteSignedPropertyNames, vote, vote.signer, log);
}

export async function signCommunityEdit({
    communityEdit,
    pkc
}: {
    communityEdit: CommunityEditPublicationOptionsToSign;
    pkc: PKC;
}): Promise<CommunityEditPublicationSignature> {
    const log = Logger("pkc-js:signatures:signCommunityEdit");
    await _validateAuthorAddressBeforeSigning(communityEdit.author, communityEdit.signer, pkc);
    return <CommunityEditPublicationSignature>(
        await _signJson(CommunityEditPublicationSignedPropertyNames, communityEdit, communityEdit.signer, log)
    );
}

export async function signCommentEdit({ edit, pkc }: { edit: CommentEditOptionsToSign; pkc: PKC }): Promise<CommentEditSignature> {
    const log = Logger("pkc-js:signatures:signCommentEdit");
    await _validateAuthorAddressBeforeSigning(edit.author, edit.signer, pkc);
    return <CommentEditSignature>(
        await _signJson(<JsonSignature["signedPropertyNames"]>CommentEditSignedPropertyNames, edit, edit.signer, log)
    );
}

export async function signCommentModeration({
    commentMod,
    pkc
}: {
    commentMod: CommentModerationOptionsToSign;
    pkc: PKC;
}): Promise<CommentModerationSignature> {
    const log = Logger("pkc-js:signatures:signCommentModeration");
    await _validateAuthorAddressBeforeSigning(commentMod.author, commentMod.signer, pkc);
    return <CommentModerationSignature>await _signJson(CommentModerationSignedPropertyNames, commentMod, commentMod.signer, log);
}

export async function signCommunity({
    community,
    signer
}: {
    community: Omit<CommunityIpfsType, "signature">;
    signer: SignerType;
}): Promise<CommunitySignature> {
    const log = Logger("pkc-js:signatures:signCommunity");
    return <CommunitySignature>await _signJson(<JsonSignature["signedPropertyNames"]>CommunitySignedPropertyNames, community, signer, log);
}

export async function signChallengeRequest({
    request,
    signer
}: {
    request: Omit<ChallengeRequestMessageType, "signature">;
    signer: SignerType;
}): Promise<ChallengeRequestMessageSignature> {
    const log = Logger("pkc-js:signatures:signChallengeRequest");
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
    const log = Logger("pkc-js:signatures:signChallengeMessage");
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
    const log = Logger("pkc-js:signatures:signChallengeAnswer");
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
    const log = Logger("pkc-js:signatures:signChallengeVerification");
    return <ChallengeVerificationMessageSignature>await _signPubsubMsg({
        signedPropertyNames: <PubsubSignature["signedPropertyNames"]>ChallengeVerificationMessageSignedPropertyNames,
        msg: challengeVerification,
        signer,
        log
    });
}

// Verify functions

// DO NOT MODIFY THIS FUNCTION, OTHERWISE YOU RISK BREAKING BACKWARD COMPATIBILITY
const _verifyJsonSignature = async (publicationToBeVerified: PKCRecordToVerify): Promise<boolean> => {
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

const _verifyPublicationSignatureAndAuthor = async ({
    publicationJson
}: {
    publicationJson: PublicationFromDecryptedChallengeRequest;
}): Promise<ValidationResult> => {
    const signatureValidity = await _verifyJsonSignature(publicationJson);
    if (!signatureValidity) return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };

    return { valid: true };
};

export async function verifyVote({
    vote,
    resolveAuthorNames,
    clientsManager
}: {
    vote: VotePubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(vote))
        return { valid: false, reason: messages.ERR_VOTE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: vote });
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommunityEdit({
    communityEdit,
    resolveAuthorNames,
    clientsManager
}: {
    communityEdit: CommunityEditPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(communityEdit))
        return { valid: false, reason: messages.ERR_COMMUNITY_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: communityEdit });
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommentEdit({
    edit,
    resolveAuthorNames,
    clientsManager
}: {
    edit: CommentEditPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(edit))
        return { valid: false, reason: messages.ERR_COMMENT_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: edit });
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommentModeration({
    moderation,
    resolveAuthorNames,
    clientsManager
}: {
    moderation: CommentModerationPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(moderation))
        return { valid: false, reason: messages.ERR_COMMENT_MODERATION_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };

    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: moderation });
    if (!res.valid) return res;
    return { valid: true };
}

export async function verifyCommentPubsubMessage({
    comment,
    resolveAuthorNames,
    clientsManager,
    abortSignal
}: {
    comment: CommentPubsubMessagePublication;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    abortSignal?: AbortSignal;
}) {
    if (!_allFieldsOfRecordInSignedPropertyNames(comment))
        return { valid: false, reason: messages.ERR_COMMENT_PUBSUB_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const validation = await _verifyPublicationSignatureAndAuthor({
        publicationJson: comment
    });
    if (!validation.valid) return validation;

    return validation;
}

export async function verifyCommentIpfs(opts: {
    comment: CommentIpfsType;
    calculatedCommentCid: string;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    communityPublicKeyFromInstance?: string;
    communityNameFromInstance?: string;
    abortSignal?: AbortSignal;
}): ReturnType<typeof verifyCommentPubsubMessage> {
    const cacheKey = sha256(
        opts.comment.signature.signature +
            opts.comment.signature.publicKey +
            opts.calculatedCommentCid +
            (opts.communityPublicKeyFromInstance || "") +
            (opts.communityNameFromInstance || "")
    );
    if (opts.clientsManager._pkc._memCaches.commentVerificationCache.get(cacheKey)) return { valid: true };

    // Only check communityName mismatch — communityPublicKey mismatch is intentionally not an error (key rotation)
    const communityNameFromRecord = getCommunityNameFromWire(opts.comment as unknown as Record<string, unknown>);
    if (
        opts.communityNameFromInstance &&
        communityNameFromRecord &&
        !areEquivalentCommunityAddresses(communityNameFromRecord, opts.communityNameFromInstance)
    )
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_COMMUNITY_NAME_MISMATCH };

    // Reject CommentIpfs records that contain reserved (runtime-only) fields
    if (_isThereReservedFieldInRecord(opts.comment, CommentIpfsReservedFields))
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_RESERVED_FIELD };

    // Reject CommentIpfs records where author contains reserved fields (e.g. nameResolved)
    if (opts.comment.author && remeda.intersection(Object.keys(opts.comment.author), AuthorCommentIpfsReservedFields).length > 0)
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_AUTHOR_INCLUDES_RESERVED_FIELD };

    const keysCasted = <(keyof CommentPubsubMessagePublication)[]>opts.comment.signature.signedPropertyNames;

    const validRes = await verifyCommentPubsubMessage({
        comment: remeda.pick(opts.comment, ["signature", ...keysCasted]),
        resolveAuthorNames: opts.resolveAuthorNames,
        clientsManager: opts.clientsManager,
        abortSignal: opts.abortSignal
    });

    if (!validRes.valid) return validRes;

    opts.clientsManager._pkc._memCaches.commentVerificationCache.set(cacheKey, true);
    return validRes;
}

function _allFieldsOfRecordInSignedPropertyNames(
    record:
        | PublicationFromDecryptedChallengeRequest
        | CommunityIpfsType
        | PubsubMessage
        | CommentUpdateType
        | CommentUpdateForChallengeVerification
): boolean {
    const fieldsOfRecord = remeda.keys.strict(remeda.omit(record, ["signature"]));
    for (const field of fieldsOfRecord) if (!record.signature.signedPropertyNames.includes(field)) return false;

    return true;
}
export async function verifyCommunity({
    community,
    communityIpnsName,
    resolveAuthorNames,
    clientsManager,
    validatePages,
    cacheIfValid,
    abortSignal
}: {
    community: CommunityIpfsType;
    communityIpnsName: string;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    validatePages: boolean;
    cacheIfValid?: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult> {
    const log = Logger("pkc-js:signatures:verifyCommunity");
    if (!_allFieldsOfRecordInSignedPropertyNames(community))
        return { valid: false, reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    if (_isThereReservedFieldInRecord(community, CommunityIpfsReservedFields))
        return { valid: false, reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD };
    const signatureValidity = await _verifyJsonSignature(community);
    if (!signatureValidity) return { valid: false, reason: messages.ERR_COMMUNITY_SIGNATURE_IS_INVALID };
    const cacheIfValidWithDefault = typeof cacheIfValid === "boolean" ? cacheIfValid : true;
    const cacheKey = sha256(community.signature.signature + validatePages + communityIpnsName);
    if (cacheIfValidWithDefault && clientsManager._pkc._memCaches.communityVerificationCache.get(cacheKey)) return { valid: true };

    const communityAddress = community.name || getPKCAddressFromPublicKeySync(community.signature.publicKey);
    const communityForPages: CommunityForVerifyingPages = {
        publicKey: getPKCAddressFromPublicKeySync(community.signature.publicKey),
        name: community.name,
        signature: community.signature
    };

    if (community.posts?.pages && validatePages)
        for (const preloadedPageSortName of remeda.keys.strict(community.posts.pages)) {
            const pageCid: string | undefined = community.posts.pageCids?.[preloadedPageSortName];
            const preloadedPage = community.posts.pages[preloadedPageSortName];
            if (!remeda.isPlainObject(preloadedPage)) throw Error("failed to find page ipfs of community to verify");
            const pageValidity = await verifyPage({
                pageCid,
                page: preloadedPage,
                pageSortName: preloadedPageSortName,
                resolveAuthorNames,
                clientsManager,
                community: communityForPages,
                parentComment: { cid: undefined, depth: -1, postCid: undefined },
                validatePages,
                validateUpdateSignature: false, // no need because we already verified community signature
                abortSignal
            });

            if (!pageValidity.valid) {
                log.error(
                    `Community (${communityAddress}) page (${preloadedPageSortName} - ${community.posts.pageCids?.[preloadedPageSortName]}) has an invalid signature due to reason (${pageValidity.reason})`
                );
                return { valid: false, reason: messages.ERR_COMMUNITY_POSTS_INVALID };
            }
        }

    const communityPeerId = peerIdFromString(communityIpnsName);
    const signaturePeerId = getPeerIdFromPublicKey(community.signature.publicKey);
    if (!communityPeerId.equals(signaturePeerId))
        return { valid: false, reason: messages.ERR_COMMUNITY_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY };
    clientsManager._pkc._memCaches.communityVerificationCache.set(cacheKey, true);
    return { valid: true };
}

async function _validateSignatureOfPKCRecord(publication: PKCRecordToVerify): Promise<ValidationResult> {
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
    record: CommentUpdateType | CommunityIpfsType | CommentUpdateForChallengeVerification | CommentIpfsType,
    reservedFields: readonly string[]
) {
    return remeda.intersection(Object.keys(record), reservedFields).length > 0;
}

export async function verifyCommentUpdate({
    update,
    resolveAuthorNames,
    clientsManager,
    community,
    comment,
    validatePages,
    validateUpdateSignature,
    abortSignal
}: {
    update: CommentUpdateType | CommentUpdateForChallengeVerification | ModQueuePageIpfs["comments"][0]["commentUpdate"];
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    community: CommunityForVerifyingPages;
    comment: Pick<CommentIpfsWithCidPostCidDefined, "signature" | "cid" | "depth" | "postCid">;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult> {
    if (!_allFieldsOfRecordInSignedPropertyNames(update))
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    if (_isThereReservedFieldInRecord(update, CommentUpdateReservedFields))
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_RESERVED_FIELD };

    const log = Logger("pkc-js:signatures:verifyCommentUpdate");

    if (validateUpdateSignature) {
        const jsonValidation = await _validateSignatureOfPKCRecord(update);

        if (!jsonValidation.valid) return jsonValidation;
    }

    const cacheKey = sha256(
        update.signature.signature +
            community.publicKey +
            community.name +
            JSON.stringify(comment) +
            validatePages +
            validateUpdateSignature
    );

    if (clientsManager._pkc._memCaches.commentUpdateVerificationCache.get(cacheKey)) return { valid: true };
    if ("edit" in update && update.edit) {
        if (update.edit.signature.publicKey !== comment.signature.publicKey)
            return { valid: false, reason: messages.ERR_AUTHOR_EDIT_IS_NOT_SIGNED_BY_AUTHOR };
        const editSignatureValidation = await _validateSignatureOfPKCRecord(update.edit);
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
                community,
                parentComment: comment,
                validatePages,
                validateUpdateSignature,
                abortSignal
            });
            if (!validity.valid) return validity;
        }
    }

    if (community.signature && update.signature.publicKey !== community.signature.publicKey)
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_IS_NOT_SIGNED_BY_COMMUNITY };

    clientsManager._pkc._memCaches.commentUpdateVerificationCache.set(cacheKey, true);

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
    const signaturePublicKeyPeerId = getPeerIdFromPublicKeyBuffer(msg.signature.publicKey);
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

    const msgSignerAddress = await getPKCAddressFromPublicKeyBuffer(challenge.signature.publicKey);
    if (msgSignerAddress !== pubsubTopic) return { valid: false, reason: messages.ERR_CHALLENGE_MSG_SIGNER_IS_NOT_COMMUNITY };
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

    const msgSignerAddress = await getPKCAddressFromPublicKeyBuffer(verification.signature.publicKey);
    if (msgSignerAddress !== pubsubTopic) return { valid: false, reason: messages.ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_COMMUNITY };
    if ((validateTimestampRange && _minimumTimestamp() > verification.timestamp) || _maximumTimestamp() < verification.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };

    return _validateSignatureOfPubsubMsg(verification);
}

type ParentCommentForVerifyingPages =
    | Pick<CommentIpfsWithCidPostCidDefined, "cid" | "depth" | "postCid"> // when we're verifying a nested page
    | Pick<CommentIpfsWithCidDefined, "postCid"> // when we're verifying a flat page
    | { cid: undefined; depth: -1; postCid: undefined }; // when we're verifying a community posts page

type CommunityForVerifyingPages = { publicKey?: string; name?: string; signature?: CommunityIpfsType["signature"] };

export async function verifyPageComment({
    pageComment,
    community,
    parentComment,
    resolveAuthorNames,
    clientsManager,
    validatePages,
    validateUpdateSignature,
    abortSignal
}: {
    pageComment: (PageIpfs | ModQueuePageIpfs)["comments"][0];
    community: CommunityForVerifyingPages;
    parentComment: ParentCommentForVerifyingPages | undefined;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult> {
    // we need to account for multiple cases:
    // when we're verifying a page from a community.posts, that means there's no parent comment cid or any of its props
    // another sceneario is with a flat page, where we don't have the parent comment cid or prop, but we do have its postCid
    // another sceneario is when we're veriifying a nested page and we have the parent comment cid and all its props
    // another sceneario is when we're verifying a mod queue page that has comments with different depths with different parentCids and not necessarily a shared postCid

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

    // Check that the comment belongs to the same community as the page
    const commentRecord = pageComment.comment;
    if (community.name) {
        // Domain-based community: only check name mismatch (key rotation is allowed)
        const communityNameFromRecord = getCommunityNameFromWire(commentRecord);
        if (communityNameFromRecord && !areEquivalentCommunityAddresses(communityNameFromRecord, community.name))
            return { valid: false, reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY };
    } else if (community.publicKey) {
        // Key-only community: check publicKey mismatch
        const communityPublicKeyFromRecord = getCommunityPublicKeyFromWire(commentRecord);
        if (communityPublicKeyFromRecord && !areEquivalentCommunityAddresses(communityPublicKeyFromRecord, community.publicKey))
            return { valid: false, reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY };
    }

    const calculatedCommentCid = await calculateIpfsHash(deterministicStringify(pageComment.comment));

    const commentSignatureValidity = await verifyCommentIpfs({
        comment: pageComment.comment,
        resolveAuthorNames,
        clientsManager,
        calculatedCommentCid,
        communityNameFromInstance: community.name,
        communityPublicKeyFromInstance: community.publicKey,
        abortSignal
    });
    if (!commentSignatureValidity.valid) return commentSignatureValidity;
    const postCid =
        (parentComment && parentComment.postCid) || (pageComment.comment.depth === 0 ? calculatedCommentCid : pageComment.comment.postCid);
    if (!postCid) return { valid: false, reason: messages.ERR_PAGE_COMMENT_NO_WAY_TO_DERIVE_POST_CID };

    const commentUpdateSignatureValidity = await verifyCommentUpdate({
        update: pageComment.commentUpdate,
        resolveAuthorNames,
        clientsManager,
        community,
        comment: {
            signature: pageComment.comment.signature,
            cid: calculatedCommentCid,
            depth: pageComment.comment.depth,
            postCid
        },
        validatePages,
        validateUpdateSignature,
        abortSignal
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
    community,
    parentComment,
    validatePages,

    validateUpdateSignature,
    abortSignal
}: {
    pageCid: string | undefined;
    pageSortName: string | undefined;
    page: PageIpfs;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    community: CommunityForVerifyingPages;
    parentComment: ParentCommentForVerifyingPages;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult> {
    const cacheKey =
        pageCid &&
        sha256(pageCid + community.publicKey + community.name + JSON.stringify(parentComment) + validatePages + validateUpdateSignature);
    if (cacheKey) if (clientsManager._pkc._memCaches.pageVerificationCache.get(cacheKey)) return { valid: true };

    for (const pageComment of page.comments) {
        const verifyRes = await verifyPageComment({
            pageComment,
            community,
            resolveAuthorNames,
            clientsManager,
            parentComment,
            validatePages,
            validateUpdateSignature,
            abortSignal
        });
        if (!verifyRes.valid) return verifyRes;
    }

    if (cacheKey) clientsManager._pkc._memCaches.pageVerificationCache.set(cacheKey, true);

    return { valid: true };
}

export async function verifyModQueuePage({
    pageCid,
    page,
    resolveAuthorNames,
    clientsManager,
    community,
    validatePages,

    validateUpdateSignature,
    abortSignal
}: {
    pageCid: string | undefined;
    page: ModQueuePageIpfs;
    resolveAuthorNames: boolean;
    clientsManager: BaseClientsManager;
    community: CommunityForVerifyingPages;
    validatePages: boolean;
    validateUpdateSignature: boolean;
    abortSignal?: AbortSignal;
}): Promise<ValidationResult> {
    const cacheKey = pageCid && sha256(pageCid + community.publicKey + community.name + validatePages + validateUpdateSignature);
    if (cacheKey) if (clientsManager._pkc._memCaches.pageVerificationCache.get(cacheKey)) return { valid: true };

    for (const pageComment of page.comments) {
        const verifyRes = await verifyPageComment({
            pageComment,
            community,
            resolveAuthorNames,
            clientsManager,
            parentComment: undefined,
            validatePages,
            validateUpdateSignature,
            abortSignal
        });
        if (!verifyRes.valid) return verifyRes;
    }

    if (cacheKey) clientsManager._pkc._memCaches.pageVerificationCache.set(cacheKey, true);

    return { valid: true };
}
