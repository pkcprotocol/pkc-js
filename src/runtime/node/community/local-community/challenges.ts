import Logger from "../../../../logger.js";
import * as remeda from "remeda";
import * as cborg from "cborg";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { derivePublicationFromChallengeRequest, getErrorCodeFromMessage, timestamp } from "../../../../util.js";
import env from "../../../../version.js";
import { PKCError } from "../../../../pkc-error.js";
import { messages } from "../../../../errors.js";
import {
    cleanUpBeforePublishing,
    signChallengeMessage,
    signChallengeVerification,
    signCommentUpdateForChallengeVerification,
    verifyChallengeAnswer,
    verifyChallengeRequest
} from "../../../../signer/signatures.js";
import { decryptEd25519AesGcmPublicKeyBuffer } from "../../../../signer/index.js";
import { encryptEd25519AesGcmPublicKeyBuffer } from "../../../../signer/encryption.js";
import { getPKCAddressFromPublicKey } from "../../../../signer/util.js";
import { buildRuntimeAuthor, getAuthorNameFromWire } from "../../../../publications/publication-author.js";
import { CommentIpfsSchema } from "../../../../publications/comment/schema.js";
import {
    ChallengeAnswerMessageSchema,
    ChallengeMessageSchema,
    ChallengeRequestMessageSchema,
    ChallengeVerificationMessageSchema,
    DecryptedChallengeRequestPublicationSchema,
    DecryptedChallengeRequestSchema
} from "../../../../pubsub-messages/schema.js";
import { parseDecryptedChallengeAnswerWithPKCErrorIfItFails, parseJsonWithPKCErrorIfFails } from "../../../../schema/schema-util.js";
import { GetChallengeAnswers, getChallengeVerification, type ChallengeResultAggregate } from "../challenges/index.js";
import type { Challenge } from "../../../../community/types.js";
import type {
    ChallengeAnswerMessageType,
    ChallengeMessageType,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageType,
    DecryptedChallenge,
    DecryptedChallengeAnswer,
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeRequest,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    DecryptedChallengeVerification,
    DecryptedChallengeVerificationMessageType,
    PublicationFromDecryptedChallengeRequest,
    PublicationWithCommunityAuthorFromDecryptedChallengeRequest
} from "../../../../pubsub-messages/types.js";
import type { IpfsHttpClientPubsubMessage } from "../../../../types.js";
import type { LocalCommunity } from "../local-community.js";
import { DUPLICATE_PUBLICATION_ERRORS } from "./defaults.js";
import { pubsubTopicWithfallback } from "./comment-updates.js";
import { storePublication } from "./publication-store.js";
import { checkPublicationValidity, respondWithErrorIfSignatureOfPublicationIsInvalid } from "./publication-validation.js";

export function cleanUpChallengeAnswerPromise(community: LocalCommunity, challengeRequestIdString: string) {
    community._challengeAnswerPromises.delete(challengeRequestIdString);
    community._challengeAnswerResolveReject.delete(challengeRequestIdString);
    delete community._challengeExchangesFromLocalPublishers[challengeRequestIdString];
}

export async function decryptOrRespondWithFailure(
    community: LocalCommunity,
    request: ChallengeRequestMessageType | ChallengeAnswerMessageType
): Promise<string> {
    const log = Logger("pkc-js:local-community:_decryptOrRespondWithFailure");
    try {
        return await decryptEd25519AesGcmPublicKeyBuffer(request.encrypted, community.signer.privateKey, request.signature.publicKey);
    } catch (e) {
        log.error(`Failed to decrypt request (${request.challengeRequestId.toString()}) due to error`, e);
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_COMMUNITY_FAILED_TO_DECRYPT_PUBSUB_MSG },
            request.challengeRequestId
        );

        throw e;
    }
}

export async function publishChallenges(
    community: LocalCommunity,
    challenges: Omit<Challenge, "verify">[],
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor
) {
    const log = Logger("pkc-js:local-community:_publishChallenges");
    const toEncryptChallenge = <DecryptedChallenge>{ challenges };
    const toSignChallenge: Omit<ChallengeMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGE",
        protocolVersion: env.PROTOCOL_VERSION,
        userAgent: community._pkc.userAgent,
        challengeRequestId: request.challengeRequestId,
        encrypted: await encryptEd25519AesGcmPublicKeyBuffer(
            deterministicStringify(toEncryptChallenge),
            community.signer.privateKey,
            request.signature.publicKey
        ),
        timestamp: timestamp()
    });

    const challengeMessage = <ChallengeMessageType>{
        ...toSignChallenge,
        signature: await signChallengeMessage({ challengeMessage: toSignChallenge, signer: community.signer })
    };
    const pubsubClient = community._clientsManager.getDefaultKuboPubsubClient();

    community._clientsManager.updateKuboRpcPubsubState("publishing-challenge", pubsubClient.url);

    // we only publish over pubsub if the challenge exchange is not ongoing for local publishers
    if (!community._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()])
        await community._clientsManager.pubsubPublish(pubsubTopicWithfallback(community), challengeMessage);
    log(
        `Community ${community.address} with pubsub topic ${pubsubTopicWithfallback(community)} published ${challengeMessage.type} over pubsub: `,
        remeda.pick(toSignChallenge, ["timestamp"]),
        toEncryptChallenge.challenges.map((challenge) => challenge.type)
    );
    community._clientsManager.updateKuboRpcPubsubState("waiting-challenge-answers", pubsubClient.url);
    community.emit("challenge", {
        ...challengeMessage,
        challenges
    });
}

export async function publishFailedChallengeVerification(
    community: LocalCommunity,
    result: Pick<ChallengeVerificationMessageType, "challengeErrors" | "reason">,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
) {
    // challengeSucess=false
    const log = Logger("pkc-js:local-community:_publishFailedChallengeVerification");

    const toSignVerification: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEVERIFICATION",
        challengeRequestId: challengeRequestId,
        challengeSuccess: false,
        challengeErrors: result.challengeErrors,
        reason: result.reason,
        userAgent: community._pkc.userAgent,
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: timestamp()
    });

    const challengeVerification = <ChallengeVerificationMessageType>{
        ...toSignVerification,
        signature: await signChallengeVerification({ challengeVerification: toSignVerification, signer: community.signer })
    };

    const pubsubClient = community._clientsManager.getDefaultKuboPubsubClient();
    community._clientsManager.updateKuboRpcPubsubState("publishing-challenge-verification", pubsubClient.url);
    log(
        `Will publish ${challengeVerification.type} over pubsub topic ${pubsubTopicWithfallback(community)} on community ${community.address}:`,
        remeda.omit(toSignVerification, ["challengeRequestId"])
    );

    if (!community._challengeExchangesFromLocalPublishers[challengeRequestId.toString()])
        await community._clientsManager.pubsubPublish(pubsubTopicWithfallback(community), challengeVerification);
    community._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

    community.emit("challengeverification", challengeVerification);
    community._ongoingChallengeExchanges.delete(challengeRequestId.toString());
    delete community._challengeExchangesFromLocalPublishers[challengeRequestId.toString()];
    cleanUpChallengeAnswerPromise(community, challengeRequestId.toString());
}

export async function publishIdempotentDuplicateVerification(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"],
    duplicateReason: string
) {
    const log = Logger("pkc-js:local-community:_publishIdempotentDuplicateVerification");

    let encrypted: ChallengeVerificationMessageType["encrypted"] | undefined;
    let toEncryptDecrypted: DecryptedChallengeVerification | undefined;

    // For comments, include the existing comment data in the encrypted response
    if (duplicateReason === messages.ERR_DUPLICATE_COMMENT && request.comment) {
        const existingComment = community._dbHandler.queryCommentBySignatureEncoded(request.comment.signature.signature);
        if (!existingComment) {
            return publishFailedChallengeVerification(community, { reason: duplicateReason }, challengeRequestId);
        }
        log("Returning idempotent success for duplicate comment", existingComment.cid);

        const authorSignerAddress = await getPKCAddressFromPublicKey(existingComment.signature.publicKey);
        const authorDomain = getAuthorNameFromWire(existingComment.author);
        const authorCommunity = community._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
        if (!authorCommunity) {
            return publishFailedChallengeVerification(community, { reason: duplicateReason }, challengeRequestId);
        }
        const commentNumberPostNumber = community._dbHandler._assignNumbersForComment(existingComment.cid);

        const commentUpdateNoSig = <Omit<DecryptedChallengeVerification["commentUpdate"], "signature">>cleanUpBeforePublishing({
            author: { community: authorCommunity },
            cid: existingComment.cid,
            protocolVersion: env.PROTOCOL_VERSION,
            ...commentNumberPostNumber
        });
        const commentUpdate = <DecryptedChallengeVerification["commentUpdate"]>{
            ...commentUpdateNoSig,
            signature: await signCommentUpdateForChallengeVerification({
                update: commentUpdateNoSig,
                signer: community.signer
            })
        };
        const commentIpfs = CommentIpfsSchema.strip().parse(existingComment);
        toEncryptDecrypted = { comment: commentIpfs, commentUpdate };

        encrypted = await encryptEd25519AesGcmPublicKeyBuffer(
            deterministicStringify(toEncryptDecrypted),
            community.signer.privateKey,
            request.signature.publicKey
        );
    } else {
        // For edits/moderations: success has no encrypted data (same as normal success)
        log("Returning idempotent success for duplicate", duplicateReason);
    }

    const toSignMsg: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEVERIFICATION",
        challengeRequestId,
        encrypted,
        challengeSuccess: true,
        reason: undefined,
        userAgent: community._pkc.userAgent,
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: timestamp()
    });
    const challengeVerification = <ChallengeVerificationMessageType>{
        ...toSignMsg,
        signature: await signChallengeVerification({ challengeVerification: toSignMsg, signer: community.signer })
    };

    const pubsubClient = community._clientsManager.getDefaultKuboPubsubClient();
    community._clientsManager.updateKuboRpcPubsubState("publishing-challenge-verification", pubsubClient.url);
    if (!community._challengeExchangesFromLocalPublishers[challengeRequestId.toString()])
        await community._clientsManager.pubsubPublish(pubsubTopicWithfallback(community), challengeVerification);
    community._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

    const objectToEmit = <DecryptedChallengeVerificationMessageType>{ ...challengeVerification, ...toEncryptDecrypted };
    community.emit("challengeverification", objectToEmit);
    community._ongoingChallengeExchanges.delete(challengeRequestId.toString());
    delete community._challengeExchangesFromLocalPublishers[challengeRequestId.toString()];
    cleanUpChallengeAnswerPromise(community, challengeRequestId.toString());
}

export async function storePublicationAndEncryptForChallengeVerification(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType,
    pendingApproval?: boolean,
    challengeAggregate?: ChallengeResultAggregate
): Promise<(DecryptedChallengeVerification & Required<Pick<DecryptedChallengeVerificationMessageType, "encrypted">>) | undefined> {
    const commentAfterAddingToIpfs = await storePublication(community, request, pendingApproval, challengeAggregate);
    if (!commentAfterAddingToIpfs) return undefined;
    const authorSignerAddress = await getPKCAddressFromPublicKey(commentAfterAddingToIpfs.comment.signature.publicKey);
    const authorDomain = getAuthorNameFromWire(commentAfterAddingToIpfs.comment.author);

    const authorCommunity = community._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
    if (!authorCommunity) throw Error("author.community can never be undefined after adding a comment");
    const commentNumberPostNumber = community._dbHandler._assignNumbersForComment(commentAfterAddingToIpfs.cid);

    // Spread challenge-supplied commentUpdate fields onto the first commentUpdate. The
    // signedPropertyNames computed at sign time is derived from the actual object keys, so any new
    // keys (e.g. `reason`, `countryCode`) land in the signature.
    const commentUpdateOfVerificationNoSignature = <Omit<DecryptedChallengeVerification["commentUpdate"], "signature">>(
        cleanUpBeforePublishing({
            ...(challengeAggregate?.aggregatedCommentUpdate ?? {}),
            author: { community: authorCommunity },
            cid: commentAfterAddingToIpfs.cid,
            protocolVersion: env.PROTOCOL_VERSION,
            pendingApproval,
            ...commentNumberPostNumber
        })
    );
    const commentUpdate = <DecryptedChallengeVerification["commentUpdate"]>{
        ...commentUpdateOfVerificationNoSignature,
        signature: await signCommentUpdateForChallengeVerification({
            update: commentUpdateOfVerificationNoSignature,
            signer: community.signer
        })
    };

    const toEncrypt = <DecryptedChallengeVerification>{ comment: commentAfterAddingToIpfs.comment, commentUpdate };

    const encrypted = await encryptEd25519AesGcmPublicKeyBuffer(
        deterministicStringify(toEncrypt),
        community.signer.privateKey,
        request.signature.publicKey
    );

    return { ...toEncrypt, encrypted };
}

export async function publishChallengeVerification(
    community: LocalCommunity,
    challengeResult: Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess" | "reason">,
    request: DecryptedChallengeRequestMessageType,
    pendingApproval?: boolean,
    challengeAggregate?: ChallengeResultAggregate
) {
    const log = Logger("pkc-js:local-community:_publishChallengeVerification");
    if (!challengeResult.challengeSuccess)
        return publishFailedChallengeVerification(community, challengeResult, request.challengeRequestId);
    else {
        // Challenge has passed, we store the publication (except if there's an issue with the publication)
        // call below could fail if the comment is duplicated
        let failureReason: string | undefined;
        let toEncrypt:
            | (DecryptedChallengeVerification & Required<Pick<DecryptedChallengeVerificationMessageType, "encrypted">>)
            | undefined;

        try {
            toEncrypt = await storePublicationAndEncryptForChallengeVerification(community, request, pendingApproval, challengeAggregate);
        } catch (e) {
            failureReason = (e as PKCError).message;
            log.error("Failed to store store Publication And Encrypt For ChallengeVerification", e);
        }

        const toSignMsg: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGEVERIFICATION",
            challengeRequestId: request.challengeRequestId,
            encrypted: toEncrypt?.encrypted, // could be undefined
            challengeErrors: challengeResult.challengeErrors,
            userAgent: community._pkc.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp(),
            ...(failureReason ? { reason: failureReason, challengeSuccess: false } : { challengeSuccess: true, reason: undefined })
        });
        const challengeVerification = <ChallengeVerificationMessageType>{
            ...toSignMsg,
            signature: await signChallengeVerification({ challengeVerification: toSignMsg, signer: community.signer })
        };

        const pubsubClient = community._clientsManager.getDefaultKuboPubsubClient();

        community._clientsManager.updateKuboRpcPubsubState("publishing-challenge-verification", pubsubClient.url);

        if (!community._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()])
            await community._clientsManager.pubsubPublish(pubsubTopicWithfallback(community), challengeVerification);

        community._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

        const objectToEmit = <DecryptedChallengeVerificationMessageType>{ ...challengeVerification, ...toEncrypt };
        community.emit("challengeverification", objectToEmit);
        community._ongoingChallengeExchanges.delete(request.challengeRequestId.toString());
        delete community._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()];
        cleanUpChallengeAnswerPromise(community, request.challengeRequestId.toString());
        log.trace(
            `Published ${challengeVerification.type} over pubsub topic ${pubsubTopicWithfallback(community)}:`,
            remeda.omit(objectToEmit, ["signature", "encrypted", "challengeRequestId"])
        );
    }
}

export async function parseChallengeRequestPublicationOrRespondWithFailure(
    community: LocalCommunity,
    request: ChallengeRequestMessageType,
    decryptedRawString: string
): Promise<DecryptedChallengeRequest> {
    let decryptedJson: DecryptedChallengeRequest;
    try {
        decryptedJson = parseJsonWithPKCErrorIfFails(decryptedRawString);
    } catch (e) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_REQUEST_ENCRYPTED_IS_INVALID_JSON_AFTER_DECRYPTION },
            request.challengeRequestId
        );
        throw e;
    }

    const parseRes = DecryptedChallengeRequestSchema.loose().safeParse(decryptedJson);
    if (!parseRes.success) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING },
            request.challengeRequestId
        );

        throw new PKCError("ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING", {
            decryptedJson,
            schemaError: parseRes.error
        });
    }

    return decryptedJson;
}

export function buildRuntimeChallengeRequestPublication({
    publication,
    authorCommunity
}: {
    publication: PublicationFromDecryptedChallengeRequest;
    authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"];
}): PublicationWithCommunityAuthorFromDecryptedChallengeRequest {
    return {
        ...publication,
        author: buildRuntimeAuthor({
            author: publication.author,
            signaturePublicKey: publication.signature.publicKey,
            community: authorCommunity
        })
    };
}

export function buildRuntimeChallengeRequest({
    request,
    authorCommunity
}: {
    request: DecryptedChallengeRequestMessageType;
    authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"];
}): DecryptedChallengeRequestMessageTypeWithCommunityAuthor {
    // This function needs to be updated everytime we add a new publication type
    const runtimeRequest = remeda.clone(request) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

    if (request.comment)
        runtimeRequest.comment = buildRuntimeChallengeRequestPublication({
            publication: request.comment,
            authorCommunity
        }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["comment"];
    if (request.vote)
        runtimeRequest.vote = buildRuntimeChallengeRequestPublication({
            publication: request.vote,
            authorCommunity
        }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["vote"];
    if (request.commentEdit)
        runtimeRequest.commentEdit = buildRuntimeChallengeRequestPublication({
            publication: request.commentEdit,
            authorCommunity
        }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["commentEdit"];
    if (request.commentModeration)
        runtimeRequest.commentModeration = buildRuntimeChallengeRequestPublication({
            publication: request.commentModeration,
            authorCommunity
        }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["commentModeration"];
    if (request.communityEdit)
        runtimeRequest.communityEdit = buildRuntimeChallengeRequestPublication({
            publication: request.communityEdit,
            authorCommunity
        }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["communityEdit"];

    return runtimeRequest;
}

// Result type for the parse/validate phase of handleChallengeRequest.
type ParsedChallengeRequest = {
    decryptedRequestMsg: DecryptedChallengeRequestMessageType;
    decryptedRequestWithCommunityAuthor: DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
    publication: PublicationFromDecryptedChallengeRequest;
    communityAuthor: ReturnType<LocalCommunity["_dbHandler"]["queryCommunityAuthor"]>;
};

// Decrypt, parse, derive the publication, and validate signatures/duplicate fields.
// Returns the parsed structures, or `undefined` if a failure verification was published and processing should stop.
async function parseAndValidateChallengeRequest(
    community: LocalCommunity,
    request: ChallengeRequestMessageType,
    log: Logger
): Promise<ParsedChallengeRequest | undefined> {
    const decryptedRawString = await decryptOrRespondWithFailure(community, request);

    const decryptedRequest = await parseChallengeRequestPublicationOrRespondWithFailure(community, request, decryptedRawString);

    const publicationFieldNames = remeda.keys.strict(DecryptedChallengeRequestPublicationSchema.shape);
    let publication: PublicationFromDecryptedChallengeRequest;
    try {
        publication = derivePublicationFromChallengeRequest(decryptedRequest);
    } catch {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_CHALLENGE_REQUEST_ENCRYPTED_HAS_NO_PUBLICATION_AFTER_DECRYPTING },
            request.challengeRequestId
        );
        return undefined;
    }
    let publicationCount = 0;
    publicationFieldNames.forEach((pubField) => {
        if (pubField in decryptedRequest) publicationCount++;
    });
    if (publicationCount > 1) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_CHALLENGE_REQUEST_ENCRYPTED_HAS_MULTIPLE_PUBLICATIONS_AFTER_DECRYPTING },
            request.challengeRequestId
        );
        return undefined;
    }

    // Reject deprecated wire format fields early, before signature verification
    // (these fields are never in signedPropertyNames and would otherwise fail with a generic error)
    if ("subplebbitAddress" in publication) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS },
            request.challengeRequestId
        );
        return undefined;
    }
    if ("communityAddress" in publication) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS },
            request.challengeRequestId
        );
        return undefined;
    }

    const authorSignerAddress = await getPKCAddressFromPublicKey(publication.signature.publicKey);
    const authorDomain = getAuthorNameFromWire(publication.author);

    // Check publication props validity
    const communityAuthor = community._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
    const decryptedRequestMsg = <DecryptedChallengeRequestMessageType>{ ...request, ...decryptedRequest };
    const decryptedRequestWithCommunityAuthor = buildRuntimeChallengeRequest({
        request: decryptedRequestMsg,
        authorCommunity: communityAuthor
    });

    try {
        await respondWithErrorIfSignatureOfPublicationIsInvalid(community, decryptedRequestMsg); // This function will throw an error if signature is invalid
    } catch (e) {
        log.error("Signature of challengerequest.publication is invalid, emitting an error event and aborting the challenge exchange", e);
        community.emit("challengerequest", decryptedRequestWithCommunityAuthor);
        return undefined;
    }

    log.trace("Received a valid challenge request", decryptedRequestWithCommunityAuthor);

    community.emit("challengerequest", decryptedRequestWithCommunityAuthor);

    const publicationInvalidityReason = await checkPublicationValidity(community, decryptedRequestMsg, publication, communityAuthor);
    if (publicationInvalidityReason) {
        if (DUPLICATE_PUBLICATION_ERRORS.has(publicationInvalidityReason)) {
            const sig = publication.signature.signature;
            const attempts = (community._duplicatePublicationAttempts.get(sig) || 0) + 1;
            community._duplicatePublicationAttempts.set(sig, attempts);
            if (attempts <= 1) {
                await publishIdempotentDuplicateVerification(
                    community,
                    decryptedRequestMsg,
                    request.challengeRequestId,
                    publicationInvalidityReason
                );
                return undefined;
            }
        }
        await publishFailedChallengeVerification(community, { reason: publicationInvalidityReason }, request.challengeRequestId);
        return undefined;
    }

    return { decryptedRequestMsg, decryptedRequestWithCommunityAuthor, publication, communityAuthor };
}

// Runs the challenge exchange (challenges -> answers) for the request, returning the verification result.
async function runChallengeExchangeIfNeeded(
    community: LocalCommunity,
    parsed: ParsedChallengeRequest,
    log: Logger
): Promise<(Awaited<ReturnType<typeof getChallengeVerification>> & { reason?: string }) | undefined> {
    const { decryptedRequestWithCommunityAuthor } = parsed;

    const answerPromiseKey = decryptedRequestWithCommunityAuthor.challengeRequestId.toString();
    const getChallengeAnswers: GetChallengeAnswers = async (challenges) => {
        // ...get challenge answers from user. e.g.:
        // step 1. community publishes challenge pubsub message with `challenges` provided in argument of `getChallengeAnswers`
        // step 2. community waits for challenge answer pubsub message with `challengeAnswers` and then returns `challengeAnswers`
        await publishChallenges(community, challenges, decryptedRequestWithCommunityAuthor);
        const challengeAnswerPromise = new Promise<DecryptedChallengeAnswer["challengeAnswers"]>((resolve, reject) =>
            community._challengeAnswerResolveReject.set(answerPromiseKey, { resolve, reject })
        );
        community._challengeAnswerPromises.set(answerPromiseKey, challengeAnswerPromise);
        const challengeAnswers = await community._challengeAnswerPromises.get(answerPromiseKey);
        if (!challengeAnswers) throw Error("Failed to retrieve challenge answers from promise. This is a critical error");
        cleanUpChallengeAnswerPromise(community, answerPromiseKey);
        return challengeAnswers;
    };
    // NOTE: we try to get challenge verification immediately after receiving challenge request
    // because some challenges are automatic and skip the challenge message
    let challengeVerification: Awaited<ReturnType<typeof getChallengeVerification>> & { reason?: string };
    try {
        challengeVerification = await getChallengeVerification({
            challengeRequestMessage: decryptedRequestWithCommunityAuthor,
            community,
            getChallengeAnswers
        });
    } catch (e) {
        // getChallengeVerification will throw if one of the getChallenge function throws, which indicates a bug with the challenge script
        // notify the community owner that that one of his challenge is misconfigured via an error event
        log.error("getChallenge failed, the community owner needs to check the challenge code. The error is: ", e);
        community.emit("error", <PKCError>e);

        // notify the author that his publication wasn't published because the community is misconfigured
        challengeVerification = {
            challengeSuccess: false,
            reason: `One of the community challenges is misconfigured: ${(<Error>e).message}`
        };
    }

    return challengeVerification;
}

// Publishes the final challenge verification (success or failure) including storing the publication on success.
async function runVerificationAndStorePublication(
    community: LocalCommunity,
    parsed: ParsedChallengeRequest,
    challengeVerification: Awaited<ReturnType<typeof getChallengeVerification>> & { reason?: string }
): Promise<void> {
    const aggregate: ChallengeResultAggregate = {
        aggregatedComment: challengeVerification.aggregatedComment,
        aggregatedCommentUpdate: challengeVerification.aggregatedCommentUpdate,
        aggregatedReason: challengeVerification.aggregatedReason
    };
    // Surface the challenge-supplied aggregatedReason as the published verification.reason on failure.
    const challengeResultForPublish: Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess" | "reason"> = {
        challengeSuccess: challengeVerification.challengeSuccess,
        challengeErrors: challengeVerification.challengeErrors,
        reason: challengeVerification.reason ?? challengeVerification.aggregatedReason
    };
    await publishChallengeVerification(
        community,
        challengeResultForPublish,
        parsed.decryptedRequestMsg,
        challengeVerification.pendingApproval,
        aggregate
    );
}

export async function handleChallengeRequest(community: LocalCommunity, request: ChallengeRequestMessageType, isLocalPublisher: boolean) {
    const log = Logger("pkc-js:local-community:handleChallengeRequest");

    if (community._ongoingChallengeExchanges.has(request.challengeRequestId.toString())) {
        log("Received a duplicate challenge request", request.challengeRequestId.toString());
        return; // This is a duplicate challenge request
    }
    if (isLocalPublisher) {
        // we need to mark the challenge exchange as ongoing for local publishers and skip publishing it over pubsub
        log("Marking challenge exchange as ongoing for local publisher");
        community._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()] = true;
    }
    community._ongoingChallengeExchanges.set(request.challengeRequestId.toString(), true);
    const requestSignatureValidation = await verifyChallengeRequest({ request, validateTimestampRange: true });
    if (!requestSignatureValidation.valid)
        throw new PKCError(getErrorCodeFromMessage(requestSignatureValidation.reason), {
            challengeRequest: remeda.omit(request, ["encrypted"])
        });

    const parsed = await parseAndValidateChallengeRequest(community, request, log);
    if (!parsed) return;

    const challengeVerification = await runChallengeExchangeIfNeeded(community, parsed, log);
    if (!challengeVerification) return;

    await runVerificationAndStorePublication(community, parsed, challengeVerification);
}

export async function parseChallengeAnswerOrRespondWithFailure(
    community: LocalCommunity,
    challengeAnswer: ChallengeAnswerMessageType,
    decryptedRawString: string
) {
    let parsedJson: any;

    try {
        parsedJson = parseJsonWithPKCErrorIfFails(decryptedRawString);
    } catch (e) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_CHALLENGE_ANSWER_IS_INVALID_JSON },
            challengeAnswer.challengeRequestId
        );
        throw e;
    }

    try {
        return parseDecryptedChallengeAnswerWithPKCErrorIfItFails(parsedJson);
    } catch (e) {
        await publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_CHALLENGE_ANSWER_IS_INVALID_SCHEMA },
            challengeAnswer.challengeRequestId
        );
        throw e;
    }
}

export async function handleChallengeAnswer(community: LocalCommunity, challengeAnswer: ChallengeAnswerMessageType) {
    const log = Logger("pkc-js:local-community:handleChallengeAnswer");

    if (!community._ongoingChallengeExchanges.has(challengeAnswer.challengeRequestId.toString()))
        // Respond with error to answers without challenge request
        return publishFailedChallengeVerification(
            community,
            { reason: messages.ERR_CHALLENGE_ANSWER_WITH_NO_CHALLENGE_REQUEST },
            challengeAnswer.challengeRequestId
        );
    const answerSignatureValidation = await verifyChallengeAnswer({ answer: challengeAnswer, validateTimestampRange: true });

    if (!answerSignatureValidation.valid) {
        cleanUpChallengeAnswerPromise(community, challengeAnswer.challengeRequestId.toString());
        community._ongoingChallengeExchanges.delete(challengeAnswer.challengeRequestId.toString());
        delete community._challengeExchangesFromLocalPublishers[challengeAnswer.challengeRequestId.toString()];
        throw new PKCError(getErrorCodeFromMessage(answerSignatureValidation.reason), { challengeAnswer });
    }

    const decryptedRawString = await decryptOrRespondWithFailure(community, challengeAnswer);

    const decryptedAnswers = await parseChallengeAnswerOrRespondWithFailure(community, challengeAnswer, decryptedRawString);

    const decryptedChallengeAnswerPubsubMessage = <DecryptedChallengeAnswerMessageType>{ ...challengeAnswer, ...decryptedAnswers };

    community.emit("challengeanswer", decryptedChallengeAnswerPubsubMessage);

    const challengeAnswerPromise = community._challengeAnswerResolveReject.get(challengeAnswer.challengeRequestId.toString());

    if (!challengeAnswerPromise)
        throw Error("The challenge answer promise is undefined, there is an issue with challenge. This is a critical error");

    challengeAnswerPromise.resolve(decryptedChallengeAnswerPubsubMessage.challengeAnswers);
}

export async function handleChallengeExchange(community: LocalCommunity, pubsubMsg: IpfsHttpClientPubsubMessage) {
    const log = Logger("pkc-js:local-community:handleChallengeExchange");

    const timeReceived = timestamp();

    const pubsubKilobyteSize = Buffer.byteLength(pubsubMsg.data) / 1000;
    if (pubsubKilobyteSize > 80) {
        log.error(`Received a pubsub message at (${timeReceived}) with size of ${pubsubKilobyteSize}. Silently dropping it`);
        return;
    }

    let decodedMsg: any;

    try {
        decodedMsg = cborg.decode(pubsubMsg.data);
    } catch (e) {
        log.error(`Failed to decode pubsub message received at (${timeReceived})`, (<Error>e).toString());
        return;
    }

    const pubsubSchemas = [
        ChallengeRequestMessageSchema.loose(),
        ChallengeMessageSchema.loose(),
        ChallengeAnswerMessageSchema.loose(),
        ChallengeVerificationMessageSchema.loose()
    ];

    let parsedPubsubMsg:
        | ChallengeRequestMessageType
        | ChallengeMessageType
        | ChallengeAnswerMessageType
        | ChallengeVerificationMessageType
        | undefined;
    for (const pubsubSchema of pubsubSchemas) {
        const parseRes = pubsubSchema.safeParse(decodedMsg);
        if (parseRes.success) {
            parsedPubsubMsg = parseRes.data;
            break;
        }
    }

    if (!parsedPubsubMsg) {
        log.error(`Failed to parse the schema of pubsub message received at (${timeReceived})`, decodedMsg);
        return;
    }

    if (parsedPubsubMsg.type === "CHALLENGE" || parsedPubsubMsg.type === "CHALLENGEVERIFICATION") {
        log.trace(`Received a pubsub message that is not meant to by processed by the community - ${parsedPubsubMsg.type}. Will ignore it`);
        return;
    } else if (parsedPubsubMsg.type === "CHALLENGEREQUEST") {
        try {
            await handleChallengeRequest(community, parsedPubsubMsg, false);
        } catch (e) {
            log.error(`Failed to process challenge request message received at (${timeReceived})`, e);
            community._dbHandler.rollbackTransaction();
        }
    } else if (parsedPubsubMsg.type === "CHALLENGEANSWER") {
        try {
            await handleChallengeAnswer(community, parsedPubsubMsg);
        } catch (e) {
            log.error(`Failed to process challenge answer message received at (${timeReceived})`, e);
            community._dbHandler.rollbackTransaction();
        }
    }
}
