import { randomInt } from "crypto";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    DecryptedChallengeVerificationMessageType,
    EncodedDecryptedChallengeAnswerMessageType,
    EncodedDecryptedChallengeMessageType,
    EncodedDecryptedChallengeRequestMessageType,
    EncodedDecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    EncodedDecryptedChallengeVerificationMessageType
} from "../../pubsub-messages/types.js";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";

// don't pass stateful objects to JSON RPC
export const clone = (obj: any) => JSON.parse(JSON.stringify(obj));

const maxRandomInt = 281474976710655;
export const generateSubscriptionId = () => randomInt(1, maxRandomInt);

function _encodeChallengeRequestId(
    id: DecryptedChallengeRequestMessageType["challengeRequestId"]
): EncodedDecryptedChallengeRequestMessageType["challengeRequestId"] {
    return uint8ArrayToString(id, "base58btc");
}

function _encodeEncrypted(
    encrypted: DecryptedChallengeRequestMessageType["encrypted"]
): EncodedDecryptedChallengeRequestMessageType["encrypted"] {
    return {
        tag: uint8ArrayToString(encrypted.tag, "base64"),
        iv: uint8ArrayToString(encrypted.iv, "base64"),
        ciphertext: uint8ArrayToString(encrypted.ciphertext, "base64"),
        type: encrypted.type
    };
}

function _encodeSignature(
    signature: DecryptedChallengeRequestMessageType["signature"]
): EncodedDecryptedChallengeRequestMessageType["signature"] {
    return {
        ...signature,
        publicKey: uint8ArrayToString(signature.publicKey, "base64"),
        signature: uint8ArrayToString(signature.signature, "base64")
    };
}

export function encodeChallengeRequest(
    msg: DecryptedChallengeRequestMessageType | DecryptedChallengeRequestMessageTypeWithCommunityAuthor
): EncodedDecryptedChallengeRequestMessageType | EncodedDecryptedChallengeRequestMessageTypeWithCommunityAuthor {
    return {
        ...msg,
        challengeRequestId: _encodeChallengeRequestId(msg.challengeRequestId),
        encrypted: _encodeEncrypted(msg.encrypted),
        signature: _encodeSignature(msg.signature)
    };
}

export function encodeChallengeMessage(msg: DecryptedChallengeMessageType): EncodedDecryptedChallengeMessageType {
    return {
        ...msg,
        challengeRequestId: _encodeChallengeRequestId(msg.challengeRequestId),
        encrypted: _encodeEncrypted(msg.encrypted),
        signature: _encodeSignature(msg.signature)
    };
}

export function encodeChallengeAnswerMessage(msg: DecryptedChallengeAnswerMessageType): EncodedDecryptedChallengeAnswerMessageType {
    return {
        ...msg,
        challengeRequestId: _encodeChallengeRequestId(msg.challengeRequestId),
        encrypted: _encodeEncrypted(msg.encrypted),
        signature: _encodeSignature(msg.signature)
    };
}

export function encodeChallengeVerificationMessage(
    msg: DecryptedChallengeVerificationMessageType
): EncodedDecryptedChallengeVerificationMessageType {
    const encrypted = msg.encrypted ? _encodeEncrypted(msg.encrypted) : undefined;

    return {
        ...msg,
        challengeRequestId: _encodeChallengeRequestId(msg.challengeRequestId),
        encrypted,
        signature: _encodeSignature(msg.signature)
    };
}
