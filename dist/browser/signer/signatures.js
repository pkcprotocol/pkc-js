import { getPeerIdFromPublicKey, getPeerIdFromPublicKeyBuffer, getPKCAddressFromPublicKeyBuffer, getPKCAddressFromPublicKeySync } from "./util.js";
import * as cborg from "cborg";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import * as ed from "@noble/ed25519";
import PeerId from "peer-id";
import { areEquivalentCommunityAddresses, isStringDomain, removeNullUndefinedEmptyObjectsValuesRecursively, timestamp } from "../util.js";
import { getCommunityAddressFromRecord } from "../publications/publication-community.js";
import { PKCError } from "../pkc-error.js";
import Logger from "../logger.js";
import { messages } from "../errors.js";
import assert from "assert";
import { sha256 } from "js-sha256";
import * as remeda from "remeda"; // tree-shaking supported!
import { CommentEditSignedPropertyNames } from "../publications/comment-edit/schema.js";
import { VoteSignedPropertyNames } from "../publications/vote/schema.js";
import { CommentIpfsReservedFields, CommentSignedPropertyNames, CommentUpdateForChallengeVerificationSignedPropertyNames, CommentUpdateReservedFields, CommentUpdateSignedPropertyNames } from "../publications/comment/schema.js";
import { CommunityIpfsReservedFields, CommunitySignedPropertyNames } from "../community/schema.js";
import { ChallengeRequestMessageSignedPropertyNames, ChallengeMessageSignedPropertyNames, ChallengeAnswerMessageSignedPropertyNames, ChallengeVerificationMessageSignedPropertyNames } from "../pubsub-messages/schema.js";
import { CommentModerationSignedPropertyNames } from "../publications/comment-moderation/schema.js";
import { CommunityEditPublicationSignedPropertyNames } from "../publications/community-edit/schema.js";
import { AuthorCommentIpfsReservedFields } from "../schema/schema.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { getAuthorNameFromWire } from "../publications/publication-author.js";
const cborgEncodeOptions = {
    typeEncoders: {
        undefined: () => {
            throw Error("Object to be encoded through cborg should not have undefined"); // we're not disallowing undefined, this is merely to catch bugs
        }
    }
};
const isProbablyBuffer = (arg) => arg && typeof arg !== "string" && typeof arg !== "number";
export const signBufferEd25519 = async (bufferToSign, privateKeyBase64) => {
    if (!isProbablyBuffer(bufferToSign))
        throw Error(`signBufferEd25519 invalid bufferToSign '${bufferToSign}' not buffer`);
    if (!privateKeyBase64 || typeof privateKeyBase64 !== "string")
        throw Error(`signBufferEd25519 privateKeyBase64 not a string`);
    const privateKeyBuffer = uint8ArrayFromString(privateKeyBase64, "base64");
    if (privateKeyBuffer.length !== 32)
        throw Error(`verifyBufferEd25519 publicKeyBase64 ed25519 public key length not 32 bytes (${privateKeyBuffer.length} bytes)`);
    // do not use to sign strings, it doesn't encode properly in the browser
    const signature = await ed.sign(bufferToSign, privateKeyBuffer);
    return signature;
};
export const verifyBufferEd25519 = async (bufferToSign, bufferSignature, publicKeyBase64) => {
    if (!isProbablyBuffer(bufferToSign))
        throw Error(`verifyBufferEd25519 invalid bufferSignature '${bufferToSign}' not buffer`);
    if (!isProbablyBuffer(bufferSignature))
        throw Error(`verifyBufferEd25519 invalid bufferSignature '${bufferSignature}' not buffer`);
    if (!publicKeyBase64 || typeof publicKeyBase64 !== "string")
        throw Error(`verifyBufferEd25519 publicKeyBase64 '${publicKeyBase64}' not a string`);
    const publicKeyBuffer = uint8ArrayFromString(publicKeyBase64, "base64");
    if (publicKeyBuffer.length !== 32)
        throw Error(`verifyBufferEd25519 publicKeyBase64 '${publicKeyBase64}' ed25519 public key length not 32 bytes (${publicKeyBuffer.length} bytes)`);
    const isValid = await ed.verify(bufferSignature, bufferToSign, publicKeyBuffer);
    return isValid;
};
async function _validateAuthorAddressBeforeSigning(author, signer, pkc) {
    const authorName = getAuthorNameFromWire(author);
    if (!authorName)
        return;
    if (isStringDomain(authorName))
        return;
    throw new PKCError("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58", {
        authorAddress: authorName,
        signerAddress: signer.address,
        author
    });
}
export async function _signJson(signedPropertyNames, cleanedPublication, // should call cleanUpBeforePublish before calling _signJson
signer, log) {
    assert(signer.publicKey && typeof signer.type === "string" && signer.privateKey, "Signer props need to be defined befoe signing");
    // we assume here that publication already has been cleaned
    //@ts-expect-error
    const propsToSign = remeda.pick(cleanedPublication, signedPropertyNames);
    let publicationEncoded;
    try {
        publicationEncoded = cborg.encode(propsToSign, cborgEncodeOptions);
    }
    catch (e) {
        e.objectToEncode = propsToSign;
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
export async function _signPubsubMsg({ signedPropertyNames, msg, // should call cleanUpBeforePublish before calling _signPubsubMsg
signer, log }) {
    assert(signer.publicKey && typeof signer.type === "string" && signer.privateKey, "Signer props need to be defined befoe signing");
    // we assume here that pubsub msg already has been cleaned
    //@ts-expect-error
    const propsToSign = remeda.pick(msg, signedPropertyNames);
    let publicationEncoded;
    try {
        publicationEncoded = cborg.encode(propsToSign, cborgEncodeOptions); // The comment instances get jsoned over the pubsub, so it makes sense that we would json them before signing, to make sure the data is the same before and after getting jsoned
    }
    catch (e) {
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
export function cleanUpBeforePublishing(msg) {
    // removing values that are undefined/null recursively
    //  removing values that are empty objects recursively, like community.roles.name: {} or community.posts: {}
    // We may add other steps in the future
    return removeNullUndefinedEmptyObjectsValuesRecursively(msg);
}
export async function signComment({ comment, pkc }) {
    const log = Logger("pkc-js:signatures:signComment");
    await _validateAuthorAddressBeforeSigning(comment.author, comment.signer, pkc);
    return (await _signJson(CommentSignedPropertyNames, comment, comment.signer, log));
}
export async function signCommentUpdate({ update, signer }) {
    const log = Logger("pkc-js:signatures:signCommentUpdate");
    // Not sure, should we validate update.authorEdit here?
    return (await _signJson(CommentUpdateSignedPropertyNames, update, signer, log));
}
export async function signCommentUpdateForChallengeVerification({ update, signer }) {
    const log = Logger("pkc-js:signatures:signCommentUpdateForChallengeVerification");
    // Not sure, should we validate update.authorEdit here?
    return (await _signJson(CommentUpdateForChallengeVerificationSignedPropertyNames, update, signer, log));
}
export async function signVote({ vote, pkc }) {
    const log = Logger("pkc-js:signatures:signVote");
    await _validateAuthorAddressBeforeSigning(vote.author, vote.signer, pkc);
    return await _signJson(VoteSignedPropertyNames, vote, vote.signer, log);
}
export async function signCommunityEdit({ communityEdit, pkc }) {
    const log = Logger("pkc-js:signatures:signCommunityEdit");
    await _validateAuthorAddressBeforeSigning(communityEdit.author, communityEdit.signer, pkc);
    return (await _signJson(CommunityEditPublicationSignedPropertyNames, communityEdit, communityEdit.signer, log));
}
export async function signCommentEdit({ edit, pkc }) {
    const log = Logger("pkc-js:signatures:signCommentEdit");
    await _validateAuthorAddressBeforeSigning(edit.author, edit.signer, pkc);
    return (await _signJson(CommentEditSignedPropertyNames, edit, edit.signer, log));
}
export async function signCommentModeration({ commentMod, pkc }) {
    const log = Logger("pkc-js:signatures:signCommentModeration");
    await _validateAuthorAddressBeforeSigning(commentMod.author, commentMod.signer, pkc);
    return await _signJson(CommentModerationSignedPropertyNames, commentMod, commentMod.signer, log);
}
export async function signCommunity({ community, signer }) {
    const log = Logger("pkc-js:signatures:signCommunity");
    return await _signJson(CommunitySignedPropertyNames, community, signer, log);
}
export async function signChallengeRequest({ request, signer }) {
    const log = Logger("pkc-js:signatures:signChallengeRequest");
    return await _signPubsubMsg({
        signedPropertyNames: ChallengeRequestMessageSignedPropertyNames,
        msg: request,
        signer,
        log
    });
}
export async function signChallengeMessage({ challengeMessage, signer }) {
    const log = Logger("pkc-js:signatures:signChallengeMessage");
    return await _signPubsubMsg({
        signedPropertyNames: ChallengeMessageSignedPropertyNames,
        msg: challengeMessage,
        signer,
        log
    });
}
export async function signChallengeAnswer({ challengeAnswer, signer }) {
    const log = Logger("pkc-js:signatures:signChallengeAnswer");
    return await _signPubsubMsg({
        signedPropertyNames: ChallengeAnswerMessageSignedPropertyNames,
        msg: challengeAnswer,
        signer,
        log
    });
}
export async function signChallengeVerification({ challengeVerification, signer }) {
    const log = Logger("pkc-js:signatures:signChallengeVerification");
    return await _signPubsubMsg({
        signedPropertyNames: ChallengeVerificationMessageSignedPropertyNames,
        msg: challengeVerification,
        signer,
        log
    });
}
// Verify functions
// DO NOT MODIFY THIS FUNCTION, OTHERWISE YOU RISK BREAKING BACKWARD COMPATIBILITY
const _verifyJsonSignature = async (publicationToBeVerified) => {
    const propsToSign = {};
    for (const propertyName of publicationToBeVerified.signature.signedPropertyNames) {
        //@ts-expect-error
        if (publicationToBeVerified[propertyName] !== undefined && publicationToBeVerified[propertyName] !== null) {
            //@ts-expect-error
            propsToSign[propertyName] = publicationToBeVerified[propertyName];
        }
    }
    try {
        return await verifyBufferEd25519(cborg.encode(propsToSign, cborgEncodeOptions), uint8ArrayFromString(publicationToBeVerified.signature.signature, "base64"), publicationToBeVerified.signature.publicKey);
    }
    catch (e) {
        return false;
    }
};
// DO NOT MODIFY THIS FUNCTION, OTHERWISE YOU RISK BREAKING BACKWARD COMPATIBILITY
const _verifyPubsubSignature = async (msg) => {
    const propsToSign = {};
    for (const propertyName of msg.signature.signedPropertyNames) {
        //@ts-expect-error
        if (msg[propertyName] !== undefined && msg[propertyName] !== null)
            propsToSign[propertyName] = msg[propertyName];
    }
    try {
        const publicKeyBase64 = uint8ArrayToString(msg.signature.publicKey, "base64");
        return await verifyBufferEd25519(cborg.encode(propsToSign, cborgEncodeOptions), msg.signature.signature, publicKeyBase64);
    }
    catch (e) {
        return false;
    }
};
const _verifyPublicationSignatureAndAuthor = async ({ publicationJson }) => {
    const signatureValidity = await _verifyJsonSignature(publicationJson);
    if (!signatureValidity)
        return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };
    return { valid: true };
};
export async function verifyVote({ vote, resolveAuthorNames, clientsManager }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(vote))
        return { valid: false, reason: messages.ERR_VOTE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: vote });
    if (!res.valid)
        return res;
    return { valid: true };
}
export async function verifyCommunityEdit({ communityEdit, resolveAuthorNames, clientsManager }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(communityEdit))
        return { valid: false, reason: messages.ERR_COMMUNITY_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: communityEdit });
    if (!res.valid)
        return res;
    return { valid: true };
}
export async function verifyCommentEdit({ edit, resolveAuthorNames, clientsManager }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(edit))
        return { valid: false, reason: messages.ERR_COMMENT_EDIT_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: edit });
    if (!res.valid)
        return res;
    return { valid: true };
}
export async function verifyCommentModeration({ moderation, resolveAuthorNames, clientsManager }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(moderation))
        return { valid: false, reason: messages.ERR_COMMENT_MODERATION_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const res = await _verifyPublicationSignatureAndAuthor({ publicationJson: moderation });
    if (!res.valid)
        return res;
    return { valid: true };
}
export async function verifyCommentPubsubMessage({ comment, resolveAuthorNames, clientsManager, abortSignal }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(comment))
        return { valid: false, reason: messages.ERR_COMMENT_PUBSUB_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const validation = await _verifyPublicationSignatureAndAuthor({
        publicationJson: comment
    });
    if (!validation.valid)
        return validation;
    return validation;
}
export async function verifyCommentIpfs(opts) {
    const cacheKey = sha256(opts.comment.signature.signature +
        opts.comment.signature.publicKey +
        opts.calculatedCommentCid +
        (opts.communityAddressFromInstance || ""));
    if (opts.clientsManager._pkc._memCaches.commentVerificationCache.get(cacheKey))
        return { valid: true };
    // Handle both old format (subplebbitAddress) and new format (communityPublicKey/communityName)
    const commentCommunityAddress = getCommunityAddressFromRecord(opts.comment);
    if (opts.communityAddressFromInstance &&
        commentCommunityAddress &&
        !areEquivalentCommunityAddresses(commentCommunityAddress, opts.communityAddressFromInstance))
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH };
    // Reject CommentIpfs records that contain reserved (runtime-only) fields
    if (_isThereReservedFieldInRecord(opts.comment, CommentIpfsReservedFields))
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_RESERVED_FIELD };
    // Reject CommentIpfs records where author contains reserved fields (e.g. nameResolved)
    if (opts.comment.author && remeda.intersection(Object.keys(opts.comment.author), AuthorCommentIpfsReservedFields).length > 0)
        return { valid: false, reason: messages.ERR_COMMENT_IPFS_AUTHOR_INCLUDES_RESERVED_FIELD };
    const keysCasted = opts.comment.signature.signedPropertyNames;
    const validRes = await verifyCommentPubsubMessage({
        comment: remeda.pick(opts.comment, ["signature", ...keysCasted]),
        resolveAuthorNames: opts.resolveAuthorNames,
        clientsManager: opts.clientsManager,
        abortSignal: opts.abortSignal
    });
    if (!validRes.valid)
        return validRes;
    opts.clientsManager._pkc._memCaches.commentVerificationCache.set(cacheKey, true);
    return validRes;
}
function _allFieldsOfRecordInSignedPropertyNames(record) {
    const fieldsOfRecord = remeda.keys.strict(remeda.omit(record, ["signature"]));
    for (const field of fieldsOfRecord)
        if (!record.signature.signedPropertyNames.includes(field))
            return false;
    return true;
}
export async function verifyCommunity({ community, communityIpnsName, resolveAuthorNames, clientsManager, validatePages, cacheIfValid, abortSignal }) {
    const log = Logger("pkc-js:signatures:verifyCommunity");
    if (!_allFieldsOfRecordInSignedPropertyNames(community))
        return { valid: false, reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    if (_isThereReservedFieldInRecord(community, CommunityIpfsReservedFields))
        return { valid: false, reason: messages.ERR_COMMUNITY_RECORD_INCLUDES_RESERVED_FIELD };
    const signatureValidity = await _verifyJsonSignature(community);
    if (!signatureValidity)
        return { valid: false, reason: messages.ERR_COMMUNITY_SIGNATURE_IS_INVALID };
    const cacheIfValidWithDefault = typeof cacheIfValid === "boolean" ? cacheIfValid : true;
    const cacheKey = sha256(community.signature.signature + validatePages + communityIpnsName);
    if (cacheIfValidWithDefault && clientsManager._pkc._memCaches.communityVerificationCache.get(cacheKey))
        return { valid: true };
    // Derive address for page verification: name || publicKey || ipnsName
    const communityAddress = community.name || getPKCAddressFromPublicKeySync(community.signature.publicKey);
    const communityForPages = { address: communityAddress, signature: community.signature };
    if (community.posts?.pages && validatePages)
        for (const preloadedPageSortName of remeda.keys.strict(community.posts.pages)) {
            const pageCid = community.posts.pageCids?.[preloadedPageSortName];
            const preloadedPage = community.posts.pages[preloadedPageSortName];
            if (!remeda.isPlainObject(preloadedPage))
                throw Error("failed to find page ipfs of community to verify");
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
                log.error(`Community (${communityAddress}) page (${preloadedPageSortName} - ${community.posts.pageCids?.[preloadedPageSortName]}) has an invalid signature due to reason (${pageValidity.reason})`);
                return { valid: false, reason: messages.ERR_COMMUNITY_POSTS_INVALID };
            }
        }
    const communityPeerId = PeerId.createFromB58String(communityIpnsName);
    const signaturePeerId = await getPeerIdFromPublicKey(community.signature.publicKey);
    if (!communityPeerId.equals(signaturePeerId))
        return { valid: false, reason: messages.ERR_COMMUNITY_IPNS_NAME_DOES_NOT_MATCH_SIGNATURE_PUBLIC_KEY };
    clientsManager._pkc._memCaches.communityVerificationCache.set(cacheKey, true);
    return { valid: true };
}
async function _validateSignatureOfPKCRecord(publication) {
    if (typeof publication.signature.publicKey !== "string")
        return { valid: false, reason: messages.ERR_SIGNATURE_HAS_NO_PUBLIC_KEY };
    const signatureValidity = await _verifyJsonSignature(publication);
    if (!signatureValidity)
        return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };
    return { valid: true };
}
async function _validateSignatureOfPubsubMsg(publication) {
    const signatureValidity = await _verifyPubsubSignature(publication);
    if (!signatureValidity)
        return { valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID };
    return { valid: true };
}
function _isThereReservedFieldInRecord(record, reservedFields) {
    return remeda.intersection(Object.keys(record), reservedFields).length > 0;
}
export async function verifyCommentUpdate({ update, resolveAuthorNames, clientsManager, community, comment, validatePages, validateUpdateSignature, abortSignal }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(update))
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    if (_isThereReservedFieldInRecord(update, CommentUpdateReservedFields))
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_RESERVED_FIELD };
    const log = Logger("pkc-js:signatures:verifyCommentUpdate");
    if (validateUpdateSignature) {
        const jsonValidation = await _validateSignatureOfPKCRecord(update);
        if (!jsonValidation.valid)
            return jsonValidation;
    }
    const cacheKey = sha256(update.signature.signature + community.address + JSON.stringify(comment) + validatePages + validateUpdateSignature);
    if (clientsManager._pkc._memCaches.commentUpdateVerificationCache.get(cacheKey))
        return { valid: true };
    if ("edit" in update && update.edit) {
        if (update.edit.signature.publicKey !== comment.signature.publicKey)
            return { valid: false, reason: messages.ERR_AUTHOR_EDIT_IS_NOT_SIGNED_BY_AUTHOR };
        const editSignatureValidation = await _validateSignatureOfPKCRecord(update.edit);
        if (!editSignatureValidation.valid)
            return { valid: false, reason: messages.ERR_COMMENT_UPDATE_EDIT_SIGNATURE_IS_INVALID };
    }
    if (update.cid !== comment.cid)
        return { valid: false, reason: messages.ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT };
    if ("replies" in update && update.replies && validatePages) {
        // Validate update.replies
        const replyPageKeys = remeda.keys.strict(update.replies.pages);
        for (const replySortName of replyPageKeys) {
            const pageCid = update.replies.pageCids?.[replySortName];
            const page = update.replies.pages[replySortName];
            if (!page)
                throw Error("Failed to find page to verify within comment update");
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
            if (!validity.valid)
                return validity;
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
async function _validateChallengeRequestId(msg) {
    const signaturePublicKeyPeerId = await getPeerIdFromPublicKeyBuffer(msg.signature.publicKey);
    if (!signaturePublicKeyPeerId.equals(msg.challengeRequestId))
        return { valid: false, reason: messages.ERR_CHALLENGE_REQUEST_ID_NOT_DERIVED_FROM_SIGNATURE };
    else
        return { valid: true };
}
export async function verifyChallengeRequest({ request, validateTimestampRange }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(request))
        return { valid: false, reason: messages.ERR_CHALLENGE_REQUEST_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const idValid = await _validateChallengeRequestId(request);
    if (!idValid.valid)
        return idValid;
    if ((validateTimestampRange && _minimumTimestamp() > request.timestamp) || _maximumTimestamp() < request.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };
    return _validateSignatureOfPubsubMsg(request);
}
export async function verifyChallengeMessage({ challenge, pubsubTopic, validateTimestampRange }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(challenge))
        return { valid: false, reason: messages.ERR_CHALLENGE_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const msgSignerAddress = await getPKCAddressFromPublicKeyBuffer(challenge.signature.publicKey);
    if (msgSignerAddress !== pubsubTopic)
        return { valid: false, reason: messages.ERR_CHALLENGE_MSG_SIGNER_IS_NOT_COMMUNITY };
    if ((validateTimestampRange && _minimumTimestamp() > challenge.timestamp) || _maximumTimestamp() < challenge.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };
    return _validateSignatureOfPubsubMsg(challenge);
}
export async function verifyChallengeAnswer({ answer, validateTimestampRange }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(answer))
        return { valid: false, reason: messages.ERR_CHALLENGE_ANSWER_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const idValid = await _validateChallengeRequestId(answer);
    if (!idValid.valid)
        return idValid;
    if ((validateTimestampRange && _minimumTimestamp() > answer.timestamp) || _maximumTimestamp() < answer.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };
    return _validateSignatureOfPubsubMsg(answer);
}
export async function verifyChallengeVerification({ verification, pubsubTopic, validateTimestampRange }) {
    if (!_allFieldsOfRecordInSignedPropertyNames(verification))
        return { valid: false, reason: messages.ERR_CHALLENGE_VERIFICATION_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES };
    const msgSignerAddress = await getPKCAddressFromPublicKeyBuffer(verification.signature.publicKey);
    if (msgSignerAddress !== pubsubTopic)
        return { valid: false, reason: messages.ERR_CHALLENGE_VERIFICATION_MSG_SIGNER_IS_NOT_COMMUNITY };
    if ((validateTimestampRange && _minimumTimestamp() > verification.timestamp) || _maximumTimestamp() < verification.timestamp)
        return { valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED };
    return _validateSignatureOfPubsubMsg(verification);
}
export async function verifyPageComment({ pageComment, community, parentComment, resolveAuthorNames, clientsManager, validatePages, validateUpdateSignature, abortSignal }) {
    // we need to account for multiple cases:
    // when we're verifying a page from a community.posts, that means there's no parent comment cid or any of its props
    // another sceneario is with a flat page, where we don't have the parent comment cid or prop, but we do have its postCid
    // another sceneario is when we're veriifying a nested page and we have the parent comment cid and all its props
    // another sceneario is when we're verifying a mod queue page that has comments with different depths with different parentCids and not necessarily a shared postCid
    // Handle both old format (subplebbitAddress) and new format (communityPublicKey/communityName)
    const pageCommunityAddress = getCommunityAddressFromRecord(pageComment.comment);
    if (pageCommunityAddress && !areEquivalentCommunityAddresses(pageCommunityAddress, community.address))
        return { valid: false, reason: messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY };
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
        calculatedCommentCid,
        abortSignal
    });
    if (!commentSignatureValidity.valid)
        return commentSignatureValidity;
    const postCid = (parentComment && parentComment.postCid) || (pageComment.comment.depth === 0 ? calculatedCommentCid : pageComment.comment.postCid);
    if (!postCid)
        return { valid: false, reason: messages.ERR_PAGE_COMMENT_NO_WAY_TO_DERIVE_POST_CID };
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
    if (!commentUpdateSignatureValidity.valid)
        return commentUpdateSignatureValidity;
    return commentSignatureValidity;
}
export async function verifyPage({ pageCid, pageSortName, page, resolveAuthorNames, clientsManager, community, parentComment, validatePages, validateUpdateSignature, abortSignal }) {
    const cacheKey = pageCid &&
        sha256(pageCid +
            community.address +
            community.signature?.publicKey +
            JSON.stringify(parentComment) +
            validatePages +
            validateUpdateSignature);
    if (cacheKey)
        if (clientsManager._pkc._memCaches.pageVerificationCache.get(cacheKey))
            return { valid: true };
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
        if (!verifyRes.valid)
            return verifyRes;
    }
    if (cacheKey)
        clientsManager._pkc._memCaches.pageVerificationCache.set(cacheKey, true);
    return { valid: true };
}
export async function verifyModQueuePage({ pageCid, page, resolveAuthorNames, clientsManager, community, validatePages, validateUpdateSignature, abortSignal }) {
    const cacheKey = pageCid && sha256(pageCid + community.address + community.signature?.publicKey + validatePages + validateUpdateSignature);
    if (cacheKey)
        if (clientsManager._pkc._memCaches.pageVerificationCache.get(cacheKey))
            return { valid: true };
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
        if (!verifyRes.valid)
            return verifyRes;
    }
    if (cacheKey)
        clientsManager._pkc._memCaches.pageVerificationCache.set(cacheKey, true);
    return { valid: true };
}
//# sourceMappingURL=signatures.js.map