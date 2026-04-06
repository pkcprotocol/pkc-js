import assert from "assert";
import { Signer, decryptEd25519AesGcm, encryptEd25519AesGcm } from "../signer/index.js";
import type {
    ChallengeAnswerMessageType,
    ChallengeMessageType,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageType,
    DecryptedChallenge,
    DecryptedChallengeAnswer,
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequest,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeVerification,
    DecryptedChallengeVerificationMessageType,
    EncodedDecryptedChallengeAnswerMessageType,
    EncodedDecryptedChallengeMessageType,
    EncodedDecryptedChallengeRequestMessageType,
    EncodedDecryptedChallengeVerificationMessageType,
    PublicationFromDecryptedChallengeRequest
} from "../pubsub-messages/types.js";
import type { AuthorPubsubJsonType, CreatePublicationOptions, IpfsHttpClientPubsubMessage, PublicationTypeName } from "../types.js";
import Logger from "../logger.js";
import env from "../version.js";
import { Plebbit } from "../plebbit/plebbit.js";
import {
    cleanUpBeforePublishing,
    signChallengeAnswer,
    signChallengeRequest,
    verifyChallengeMessage,
    verifyChallengeVerification
} from "../signer/signatures.js";
import { deepMergeRuntimeFields, hideClassPrivateProps, isStringDomain, shortifyAddress, timestamp } from "../util.js";
import { TypedEmitter } from "tiny-typed-emitter";
import { Comment } from "./comment/comment.js";
import { PlebbitError } from "../plebbit-error.js";
import { getBufferedPlebbitAddressFromPublicKey } from "../signer/util.js";
import * as cborg from "cborg";
import * as remeda from "remeda";
import type { SubplebbitIpfsType } from "../subplebbit/types.js";
import { findStartedSubplebbit, findUpdatingSubplebbit } from "../plebbit/tracked-instance-registry-util.js";
import type { CommentIpfsType } from "./comment/types.js";
import {
    parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails,
    parseDecryptedChallengeVerification,
    parseDecryptedChallengeWithPlebbitErrorIfItFails,
    parseJsonWithPlebbitErrorIfFails
} from "../schema/schema-util.js";
import {
    ChallengeRequestMessageSchema,
    ChallengeAnswerMessageSchema,
    ChallengeMessageSchema,
    ChallengeVerificationMessageSchema
} from "../pubsub-messages/schema.js";

import {
    decodeRpcChallengeAnswerPubsubMsg,
    decodeRpcChallengePubsubMsg,
    decodeRpcChallengeRequestPubsubMsg,
    decodeRpcChallengeVerificationPubsubMsg
} from "../clients/rpc-client/decode-rpc-response-util.js";
import type {
    PublicationEventArgs,
    PublicationEvents,
    PublicationPublishingState,
    PublicationRpcErrorToTransmit,
    PublicationState
} from "./types.js";
import type { SignerType } from "../signer/types.js";
import PlebbitRpcClient from "../clients/rpc-client/plebbit-rpc-client.js";
import { PublicationClientsManager } from "./publication-client-manager.js";
import { LocalSubplebbit } from "../runtime/node/subplebbit/local-subplebbit.js";
import { buildRuntimeAuthor } from "./publication-author.js";
import { buildRuntimeCommunityFields, normalizeCommunityInputFromSubplebbit } from "./publication-community.js";

class Publication extends TypedEmitter<PublicationEvents> {
    // Only publication props
    clients!: PublicationClientsManager["clients"];

    communityAddress!: string;
    shortCommunityAddress!: string;
    communityPublicKey?: string; // IPNS key of the community
    communityName?: string; // domain name of the community
    timestamp!: PublicationFromDecryptedChallengeRequest["timestamp"];
    signature!: PublicationFromDecryptedChallengeRequest["signature"] | CommentIpfsType["signature"];
    signer?: SignerType;
    author!: AuthorPubsubJsonType;
    protocolVersion!: DecryptedChallengeRequestMessageType["protocolVersion"];

    challengeRequest?: CreatePublicationOptions["challengeRequest"];

    state!: PublicationState | Comment["state"];
    publishingState!: PublicationPublishingState;

    raw: {
        pubsubMessageToPublish?: PublicationFromDecryptedChallengeRequest;
        unsignedPublicationOptions?: CreatePublicationOptions;
    } = {};

    // private
    _community?: {
        address: string;
        publicKey: string;
        name?: string;
        encryption: SubplebbitIpfsType["encryption"];
        pubsubTopic?: SubplebbitIpfsType["pubsubTopic"];
    } = undefined; // will be used for publishing
    _publishingToLocalSubplebbit?: LocalSubplebbit;

    _challengeExchanges: Record<
        string, // challengeRequestId stringified
        {
            challengeAnswer?: DecryptedChallengeAnswerMessageType;
            challengeRequest: DecryptedChallengeRequestMessageType;
            challenge?: DecryptedChallengeMessageType;
            challengeVerification?: DecryptedChallengeVerificationMessageType;
            challengeRequestPublishTimestamp?: number; // in seconds
            challengeAnswerPublishTimestamp?: number; // in seconds
            signer?: Signer; // could be undefined if we're publishing over an RPC
            challengeRequestPublishError?: Error;
            challengeAnswerPublishError?: Error;
            providerUrl: string; // either kubo rpc url or libp2pjsclient key, or RPC url
        }
    > = {};
    private _publishToDifferentProviderThresholdSeconds: number;
    private _setProviderFailureThresholdSeconds: number;
    private _rpcPublishSubscriptionId?: number = undefined;
    _clientsManager!: PublicationClientsManager;
    _plebbit: Plebbit;

    constructor(plebbit: Plebbit) {
        super();
        this._plebbit = plebbit;
        this._updatePublishingStateWithEmission("stopped");
        this._setStateWithEmission("stopped");
        this._initClients();
        this._handleChallengeExchange = this._handleChallengeExchange.bind(this);
        this.publish = this.publish.bind(this);
        this.on("error", (...args) => this.listenerCount("error") === 1 && this._plebbit.emit("error", ...args)); // only bubble up to plebbit if no other listeners are attached

        this._publishToDifferentProviderThresholdSeconds = 10;
        this._setProviderFailureThresholdSeconds = 60 * 2; // Two minutes

        // public method should be bound
        this.publishChallengeAnswers = this.publishChallengeAnswers.bind(this);

        hideClassPrivateProps(this);
    }

    protected _initClients() {
        this._clientsManager = new PublicationClientsManager(this);
        this.clients = this._clientsManager.clients;
    }

    setCommunityAddress(communityAddress: string) {
        this.communityAddress = communityAddress;
        this.shortCommunityAddress = shortifyAddress(communityAddress);
    }

    _initBaseRemoteProps(props: CommentIpfsType | PublicationFromDecryptedChallengeRequest) {
        const communityFields = buildRuntimeCommunityFields({ publication: props as Record<string, unknown> });
        this.setCommunityAddress(communityFields.communityAddress);
        this.communityPublicKey = communityFields.communityPublicKey;
        this.communityName = communityFields.communityName;
        this.timestamp = props.timestamp;
        this.signature = props.signature;
        const runtimeAuthor = buildRuntimeAuthor({
            author: props.author,
            signaturePublicKey: props.signature.publicKey
        });
        this.author = { ...runtimeAuthor, shortAddress: shortifyAddress(runtimeAuthor.address) };
        this.protocolVersion = props.protocolVersion;
    }

    _initUnsignedLocalProps<
        T extends {
            signer: SignerType;
            communityAddress: string;
            communityPublicKey?: string;
            communityName?: string;
            timestamp: number;
            protocolVersion: string;
            author?: Record<string, unknown>;
        }
    >(opts: { unsignedOptions: T; challengeRequest?: CreatePublicationOptions["challengeRequest"] }) {
        this.raw.unsignedPublicationOptions = opts.unsignedOptions as CreatePublicationOptions;
        this.challengeRequest = opts.challengeRequest;
        this.signer = opts.unsignedOptions.signer;
        this.communityAddress = opts.unsignedOptions.communityAddress;
        this.shortCommunityAddress = shortifyAddress(opts.unsignedOptions.communityAddress);
        // Derive communityName/communityPublicKey from communityAddress if not explicitly provided
        if (opts.unsignedOptions.communityPublicKey) this.communityPublicKey = opts.unsignedOptions.communityPublicKey;
        else if (!isStringDomain(opts.unsignedOptions.communityAddress)) this.communityPublicKey = opts.unsignedOptions.communityAddress;
        if (opts.unsignedOptions.communityName) this.communityName = opts.unsignedOptions.communityName;
        else if (isStringDomain(opts.unsignedOptions.communityAddress)) this.communityName = opts.unsignedOptions.communityAddress;
        this.timestamp = opts.unsignedOptions.timestamp;
        this.protocolVersion = opts.unsignedOptions.protocolVersion;
        const runtimeAuthor = buildRuntimeAuthor({
            author: opts.unsignedOptions.author,
            signaturePublicKey: opts.unsignedOptions.signer.publicKey!
        });
        this.author = { ...runtimeAuthor, shortAddress: shortifyAddress(runtimeAuthor.address) };
    }

    protected async _signPublicationOptionsToPublish(
        _cleanedPublication: unknown
    ): Promise<PublicationFromDecryptedChallengeRequest["signature"]> {
        throw new Error(`Should be implemented by children of Publication`);
    }

    private async _signPublication({ communityFields }: { communityFields: { communityPublicKey: string; communityName?: string } }) {
        if (!this.raw.unsignedPublicationOptions) throw Error("No unsigned publication options to sign");

        const optionsWithCommunity = {
            ...this.raw.unsignedPublicationOptions,
            ...communityFields
        };
        const cleaned = cleanUpBeforePublishing(optionsWithCommunity) as Record<string, unknown>;
        const signature = await this._signPublicationOptionsToPublish(cleaned);
        const signedPublicationFields = Object.fromEntries(
            signature.signedPropertyNames.map((propertyName) => [propertyName, cleaned[propertyName]])
        );

        const signedPublication = <PublicationFromDecryptedChallengeRequest>{
            ...signedPublicationFields,
            signature
        };
        this.raw.pubsubMessageToPublish = signedPublication;
        delete this.raw.unsignedPublicationOptions;
        this._initBaseRemoteProps(signedPublication);
    }

    async _signPublicationWithCommunityFields() {
        if (!this._community) throw Error("Community must be loaded before signing");
        const communityFields = normalizeCommunityInputFromSubplebbit({ communityInstance: this._community });

        await this._signPublication({ communityFields });
    }

    async _signPublicationWithKnownCommunityFieldsIfAvailable() {
        if (!this.communityPublicKey || this.raw.pubsubMessageToPublish || !this.raw.unsignedPublicationOptions) return;

        await this._signPublication({
            communityFields: {
                communityPublicKey: this.communityPublicKey,
                ...(this.communityName ? { communityName: this.communityName } : {})
            }
        });
    }

    protected async _validateSignatureHook(): Promise<void> {
        // Subclasses override to validate signature after signing
    }

    protected async _verifyDecryptedChallengeVerificationAndUpdateCommentProps(decryptedVerification: DecryptedChallengeVerification) {
        throw Error("should be handled in comment, not publication");
    }

    protected getType(): PublicationTypeName {
        throw new Error(`Should be implemented by children of Publication`);
    }

    toJSONPubsubRequestToEncrypt(): DecryptedChallengeRequest {
        if (!this.raw.pubsubMessageToPublish)
            throw Error("raw.pubsubMessageToPublish must be defined before calling toJSONPubsubRequestToEncrypt");
        return {
            [this.getType()]: this.raw.pubsubMessageToPublish,
            ...this.challengeRequest
        };
    }

    private async _handleRpcChallengeVerification(
        verification: DecryptedChallengeVerificationMessageType,
        runtimeFields?: Record<string, any>
    ) {
        const log = Logger("pkc-js:publication:_handleRpcChallengeVerification");
        if (verification.comment)
            await this._verifyDecryptedChallengeVerificationAndUpdateCommentProps(<DecryptedChallengeVerification>verification);
        if (this instanceof Comment && runtimeFields) deepMergeRuntimeFields(this, runtimeFields);
        this._setRpcClientState("stopped");
        const newPublishingState = verification.challengeSuccess ? "succeeded" : "failed";
        this._changePublicationStateEmitEventEmitStateChangeEvent({
            newPublishingState,
            newState: "stopped",
            event: {
                name: "challengeverification",
                args: [verification, this instanceof Comment && verification.comment ? this : undefined]
            }
        });
        if (this._rpcPublishSubscriptionId) {
            try {
                await this._plebbit._plebbitRpcClient!.unsubscribe(this._rpcPublishSubscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from publication publish", e);
            }
            this._rpcPublishSubscriptionId = undefined;
        }
    }

    private async _handleIncomingChallengePubsubMessage(msg: ChallengeMessageType) {
        const log = Logger("pkc-js:publication:_handleIncomingChallengePubsubMessage");
        if (Object.values(this._challengeExchanges).some((exchange) => exchange.challenge)) return; // We only process one challenge
        const challengeMsgValidity = await verifyChallengeMessage({
            challenge: msg,
            pubsubTopic: this._communityPubsubTopicWithFallback(),
            validateTimestampRange: true
        });
        if (!challengeMsgValidity.valid) {
            const error = new PlebbitError("ERR_CHALLENGE_SIGNATURE_IS_INVALID", {
                pubsubMsg: msg,
                reason: challengeMsgValidity.reason
            });
            log.error("received challenge message with invalid signature", error.toString());
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [error] }
            });
            return;
        }

        log(
            `Received encrypted challenges.  Will decrypt and emit them on "challenge" event. User shoud publish solution by calling publishChallengeAnswers`
        );

        const pubsubSigner = this._challengeExchanges[msg.challengeRequestId.toString()].signer;
        if (!pubsubSigner) throw Error("Signer is undefined for this challenge exchange");
        let decryptedRawString: string;

        try {
            decryptedRawString = await decryptEd25519AesGcm(msg.encrypted, pubsubSigner.privateKey, this._community!.encryption.publicKey);
        } catch (e) {
            const plebbitError = new PlebbitError("ERR_PUBLICATION_FAILED_TO_DECRYPT_CHALLENGE", { decryptErr: e });
            log.error("could not decrypt challengemessage.encrypted", plebbitError.toString());
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [plebbitError] }
            });
            return;
        }

        let decryptedJson: any;

        try {
            decryptedJson = await parseJsonWithPlebbitErrorIfFails(decryptedRawString);
        } catch (e) {
            log.error("could not parse decrypted challengemessage.encrypted as a json", String(e));
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [<PlebbitError>e] }
            });
            return;
        }

        let decryptedChallenge: DecryptedChallenge;

        try {
            decryptedChallenge = parseDecryptedChallengeWithPlebbitErrorIfItFails(decryptedJson);
        } catch (e) {
            log.error("could not parse z challengemessage.encrypted as a json", String(e));
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [<PlebbitError>e] }
            });
            return;
        }
        const decryptedChallengeMsg = <DecryptedChallengeMessageType>{
            ...msg,
            ...decryptedChallenge
        };
        this._challengeExchanges[msg.challengeRequestId.toString()].challenge = decryptedChallengeMsg;

        this._updatePublishingStateWithEmission("waiting-challenge-answers");
        const subscribedProviders = Object.entries(this._clientsManager.pubsubProviderSubscriptions)
            .filter(([, pubsubTopics]) => pubsubTopics.includes(this._communityPubsubTopicWithFallback()))
            .map(([provider]) => provider);

        subscribedProviders.forEach((provider) => this._updatePubsubState("waiting-challenge-answers", provider));
        this.emit("challenge", decryptedChallengeMsg);
    }

    private async _handleIncomingChallengeVerificationPubsubMessage(msg: ChallengeVerificationMessageType) {
        const log = Logger("pkc-js:publication:_handleIncomingChallengeVerificationPubsubMessage");
        if (this._challengeExchanges[msg.challengeRequestId.toString()].challengeVerification) return;
        const signatureValidation = await verifyChallengeVerification({
            verification: msg,
            pubsubTopic: this._communityPubsubTopicWithFallback(),
            validateTimestampRange: true
        });
        if (!signatureValidation.valid) {
            const error = new PlebbitError("ERR_CHALLENGE_VERIFICATION_SIGNATURE_IS_INVALID", {
                pubsubMsg: msg,
                reason: signatureValidation.reason
            });
            log.error("Publication received a challenge verification with invalid signature", error);
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [error] }
            });
            return;
        }
        let decryptedChallengeVerification: DecryptedChallengeVerification | undefined;
        let newPublishingState: Publication["publishingState"];
        if (msg.challengeSuccess) {
            newPublishingState = "succeeded";
            log(`Received a challengeverification with challengeSuccess=true`, "for publication", this.getType());
            if (msg.encrypted) {
                let decryptedRawString: string;

                const pubsubSigner = this._challengeExchanges[msg.challengeRequestId.toString()].signer;
                if (!pubsubSigner) throw Error("Signer is undefined for this challenge exchange");
                try {
                    decryptedRawString = await decryptEd25519AesGcm(
                        msg.encrypted,
                        pubsubSigner.privateKey,
                        this._community!.encryption.publicKey
                    );
                } catch (e) {
                    const plebbitError = new PlebbitError("ERR_INVALID_CHALLENGE_VERIFICATION_DECRYPTED_SCHEMA", {
                        decryptErr: e,
                        challenegVerificationMsg: msg
                    });
                    log.error("could not decrypt challengeverification.encrypted", plebbitError);
                    this.emit("error", plebbitError);
                    return;
                }

                let decryptedJson: any;

                try {
                    decryptedJson = await parseJsonWithPlebbitErrorIfFails(decryptedRawString);
                } catch (e) {
                    log.error("could not parse decrypted challengeverification.encrypted as a json", e);
                    this.emit("error", <PlebbitError>e);
                    return;
                }

                try {
                    decryptedChallengeVerification = parseDecryptedChallengeVerification(decryptedJson);
                } catch (e) {
                    log.error("could not parse challengeverification.encrypted due to invalid schema", e);
                    this.emit("error", <PlebbitError>e);
                    return;
                }

                if (decryptedChallengeVerification.comment) {
                    await this._verifyDecryptedChallengeVerificationAndUpdateCommentProps(decryptedChallengeVerification);
                    log("Updated the props of this instance with challengeverification.encrypted");
                }
            }
        } else {
            newPublishingState = "failed";
            log.error(
                `Challenge exchange with publication`,
                this.getType(),
                `has failed to pass`,
                "Challenge errors",
                msg.challengeErrors,
                `reason`,
                msg.reason
            );
        }

        const challengeVerificationMsg = { ...msg, ...decryptedChallengeVerification };

        this._challengeExchanges[msg.challengeRequestId.toString()].challengeVerification = challengeVerificationMsg;

        Object.values(this._challengeExchanges).forEach((exchange) => this._updatePubsubState("stopped", exchange.providerUrl));

        this._changePublicationStateEmitEventEmitStateChangeEvent({
            newPublishingState,
            newState: "stopped",
            event: {
                name: "challengeverification",
                args: [challengeVerificationMsg, this instanceof Comment && decryptedChallengeVerification ? this : undefined]
            }
        });
        await this._postSucessOrFailurePublishing();
    }

    private async _handleChallengeExchange(pubsubMsg: IpfsHttpClientPubsubMessage) {
        const log = Logger("pkc-js:publication:handleChallengeExchange");

        let decodedJson: string;
        try {
            decodedJson = cborg.decode(pubsubMsg.data);
        } catch (e) {
            log.error("Failed to decode pubsub message", e);
            return;
        }

        const pubsubSchemas = [
            ChallengeVerificationMessageSchema.loose(),
            ChallengeMessageSchema.loose(),
            ChallengeRequestMessageSchema.loose(),
            ChallengeAnswerMessageSchema.loose()
        ];

        let pubsubMsgParsed:
            | ChallengeRequestMessageType
            | ChallengeMessageType
            | ChallengeAnswerMessageType
            | ChallengeVerificationMessageType
            | undefined;
        for (const pubsubSchema of pubsubSchemas) {
            const parseRes = pubsubSchema.safeParse(decodedJson);
            if (parseRes.success) {
                pubsubMsgParsed = parseRes.data;
                break;
            }
        }

        if (!pubsubMsgParsed) {
            log.error(`Failed to parse the schema of decoded pubsub message`, decodedJson);
            return;
        }

        if (pubsubMsgParsed.type === "CHALLENGEREQUEST" || pubsubMsgParsed.type === "CHALLENGEANSWER") {
            log.trace("Received unrelated pubsub message of type", pubsubMsgParsed.type);
        } else if (
            !Object.values(this._challengeExchanges).some((exchange) =>
                remeda.isDeepEqual(pubsubMsgParsed.challengeRequestId, exchange.challengeRequest.challengeRequestId)
            )
        ) {
            log.trace(`Received pubsub message with different challenge request id, ignoring it`);
        } else if (pubsubMsgParsed.type === "CHALLENGE") return this._handleIncomingChallengePubsubMessage(pubsubMsgParsed);
        else if (pubsubMsgParsed.type === "CHALLENGEVERIFICATION")
            return this._handleIncomingChallengeVerificationPubsubMessage(pubsubMsgParsed);
    }

    private _updatePubsubState(pubsubState: Publication["clients"]["pubsubKuboRpcClients"][string]["state"], keyOrUrl: string) {
        if (this._publishingToLocalSubplebbit) return; // there's no pubsub for local subplebbit
        const kuboOrHelia = this._clientsManager.getDefaultPubsubKuboRpcClientOrHelia();
        if ("_helia" in kuboOrHelia) this._clientsManager.updateLibp2pJsClientState(pubsubState, keyOrUrl);
        else this._clientsManager.updateKuboRpcPubsubState(pubsubState, keyOrUrl);
    }

    async publishChallengeAnswers(challengeAnswers: DecryptedChallengeAnswerMessageType["challengeAnswers"]) {
        const log = Logger("pkc-js:publication:publishChallengeAnswers");

        const toEncryptAnswers = parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails(<DecryptedChallengeAnswer>{
            challengeAnswers: challengeAnswers
        });

        if (this._plebbit._plebbitRpcClient && typeof this._rpcPublishSubscriptionId === "number") {
            return this._plebbit._plebbitRpcClient.publishChallengeAnswers(
                this._rpcPublishSubscriptionId,
                toEncryptAnswers.challengeAnswers
            );
        }

        const challengeExchangesWithChallenge = Object.values(this._challengeExchanges).filter((exchange) => exchange.challenge);
        if (challengeExchangesWithChallenge.length === 0) throw Error("No challenge exchanges with challenge");
        if (challengeExchangesWithChallenge.length > 1) throw Error("We should only have one challenge exchange with challenge");

        const challengeExchange = challengeExchangesWithChallenge[0];

        assert(this._community, "Local plebbit-js needs publication.subplebbit to be defined to publish challenge answer");

        if (!challengeExchange.signer) throw Error("Signer is undefined for this challenge exchange");
        const encryptedChallengeAnswers = await encryptEd25519AesGcm(
            JSON.stringify(toEncryptAnswers),
            challengeExchange.signer.privateKey,
            this._community.encryption.publicKey
        );

        const toSignAnswer: Omit<ChallengeAnswerMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGEANSWER",
            challengeRequestId: challengeExchange.challengeRequest.challengeRequestId,
            encrypted: encryptedChallengeAnswers,
            userAgent: this._plebbit.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp()
        });

        const answerMsgToPublish = <ChallengeAnswerMessageType>{
            ...toSignAnswer,
            signature: await signChallengeAnswer({ challengeAnswer: toSignAnswer, signer: challengeExchange.signer })
        };

        // TODO should be handling multiple providers with publishing challenge answer?
        // For now, let's just publish to the provider that got us the challenge and its request
        this._updatePublishingStateWithEmission("publishing-challenge-answer");
        this._updatePubsubState("publishing-challenge-answer", challengeExchange.providerUrl);

        if (this._publishingToLocalSubplebbit) {
            try {
                await this._publishingToLocalSubplebbit.handleChallengeAnswer(answerMsgToPublish);
            } catch (e) {
                this._challengeExchanges[challengeExchange.challengeRequest.challengeRequestId.toString()].challengeAnswerPublishError =
                    e as Error | PlebbitError;
                this._updatePublishingStateWithEmission("failed");
                this._updatePubsubState("stopped", challengeExchange.providerUrl);
                throw e;
            }
        } else {
            try {
                await this._clientsManager.pubsubPublishOnProvider(
                    this._communityPubsubTopicWithFallback(),
                    answerMsgToPublish,
                    challengeExchange.providerUrl
                );
            } catch (e) {
                this._challengeExchanges[challengeExchange.challengeRequest.challengeRequestId.toString()].challengeAnswerPublishError =
                    e as Error | PlebbitError;
                this._updatePublishingStateWithEmission("failed");
                this._updatePubsubState("stopped", challengeExchange.providerUrl);
                throw e;
            }
        }

        const decryptedChallengeAnswer = <DecryptedChallengeAnswerMessageType>{
            ...toEncryptAnswers,
            ...answerMsgToPublish
        };

        this._challengeExchanges[challengeExchange.challengeRequest.challengeRequestId.toString()].challengeAnswer =
            decryptedChallengeAnswer;
        this._challengeExchanges[challengeExchange.challengeRequest.challengeRequestId.toString()].challengeAnswerPublishTimestamp =
            timestamp();

        this._updatePublishingStateWithEmission("waiting-challenge-verification");
        const providers = Object.entries(this._clientsManager.pubsubProviderSubscriptions)
            .filter(([, pubsubTopics]) => pubsubTopics.includes(this._communityPubsubTopicWithFallback()))
            .map(([provider]) => provider);
        providers.forEach((provider) => this._updatePubsubState("waiting-challenge-verification", provider));

        log(`Responded to challenge  with answers`, challengeAnswers);
        this.emit("challengeanswer", decryptedChallengeAnswer);
    }

    private _validatePublicationFields() {
        if (typeof this.timestamp !== "number" || this.timestamp < 0)
            throw new PlebbitError("ERR_PUBLICATION_MISSING_FIELD", { type: this.getType, timestamp: this.timestamp });

        if (typeof this.author?.address !== "string")
            throw new PlebbitError("ERR_PUBLICATION_MISSING_FIELD", { type: this.getType(), authorAddress: this.author?.address });
        if (typeof this.communityAddress !== "string")
            throw new PlebbitError("ERR_PUBLICATION_MISSING_FIELD", { type: this.getType(), communityAddress: this.communityAddress });
    }

    private _validateSubFields() {
        if (typeof this._community?.encryption?.publicKey !== "string")
            throw new PlebbitError("ERR_COMMUNITY_MISSING_FIELD", { subplebbitPublicKey: this._community?.encryption?.publicKey });
        if (typeof this._communityPubsubTopicWithFallback() !== "string")
            throw new PlebbitError("ERR_COMMUNITY_MISSING_FIELD", {
                pubsubTopic: this._community?.pubsubTopic,
                address: this._community?.address
            });
    }

    _updatePublishingStateNoEmission(newState: Publication["publishingState"]) {
        this.publishingState = newState;
    }

    _updatePublishingStateWithEmission(newState: Publication["publishingState"]) {
        if (this.publishingState === newState) return;
        this.publishingState = newState;
        this.emit("publishingstatechange", this.publishingState);
    }

    private _updateRpcClientStateFromPublishingState(publishingState: Publication["publishingState"]) {
        // We're deriving the the rpc state from publishing state

        const mapper: Record<Publication["publishingState"], Publication["clients"]["plebbitRpcClients"][0]["state"][]> = {
            failed: ["stopped"],
            "fetching-subplebbit-ipfs": ["fetching-subplebbit-ipfs"],
            "fetching-subplebbit-ipns": ["fetching-subplebbit-ipns"],
            "publishing-challenge-answer": ["publishing-challenge-answer"],
            "publishing-challenge-request": ["subscribing-pubsub", "publishing-challenge-request"],
            "resolving-community-name": ["resolving-community-name"],
            stopped: ["stopped"],
            succeeded: ["stopped"],
            "waiting-challenge": ["waiting-challenge"],
            "waiting-challenge-answers": ["waiting-challenge-answers"],
            "waiting-challenge-verification": ["waiting-challenge-verification"]
        };

        const newRpcClientState = mapper[publishingState] || [publishingState]; // In case RPC server transmitted a state we don't know about

        newRpcClientState.forEach(this._setRpcClientState.bind(this));
    }

    protected _setStateNoEmission(newState: Publication["state"]) {
        if (newState === this.state) return;
        this.state = newState;
    }

    protected _setStateWithEmission(newState: Publication["state"]) {
        if (newState === this.state) return;
        this.state = newState;
        this.emit("statechange", newState);
    }

    protected _setRpcClientState(newState: Publication["clients"]["plebbitRpcClients"][""]["state"]) {
        const currentRpcUrl = remeda.keys.strict(this.clients.plebbitRpcClients)[0];
        if (newState === this.clients.plebbitRpcClients[currentRpcUrl].state) return;
        this.clients.plebbitRpcClients[currentRpcUrl].state = newState;
        this.clients.plebbitRpcClients[currentRpcUrl].emit("statechange", newState);
    }

    private _communityPubsubTopicWithFallback(): string {
        const pubsubTopic = this._community?.pubsubTopic || this._community?.address;
        if (typeof pubsubTopic !== "string") throw Error("Failed to load the pubsub topic of subplebbit");
        return pubsubTopic;
    }

    _getCommunityCache(): NonNullable<Publication["_community"]> | undefined {
        const cached = this._plebbit._memCaches.subplebbitForPublishing.get(this.communityAddress, { allowStale: true });
        if (cached) return cached;
        const subInstance =
            findUpdatingSubplebbit(this._plebbit, { address: this.communityAddress }) ||
            findStartedSubplebbit(this._plebbit, { address: this.communityAddress });
        const subIpfs = subInstance?.raw.subplebbitIpfs;
        if (subIpfs && subInstance.publicKey)
            return {
                address: subInstance.address,
                publicKey: subInstance.publicKey,
                name: subInstance.name,
                encryption: subIpfs.encryption,
                pubsubTopic: subIpfs.pubsubTopic
            };
        return undefined;
    }

    async _fetchCommunityForPublishing(): Promise<NonNullable<Publication["_community"]>> {
        const log = Logger("pkc-js:publish:_fetchCommunityForPublishing");
        const cachedCommunity = this._getCommunityCache();

        if (cachedCommunity) {
            // We will use the cached community even though it's stale
            // And in the background we will fetch a new one and update the cache
            // cache.has will return false if the item is stale
            if (!this._plebbit._memCaches.subplebbitForPublishing.has(this.communityAddress)) {
                log("The cache of community is stale, we will use the cached and update in the background");
                this._plebbit
                    .getSubplebbit({ address: this.communityAddress })
                    .catch((e) => log.error("Failed to update cache of community", this.communityAddress, e));
            }
            return cachedCommunity;
        } else return this._clientsManager.fetchCommunityForPublishingWithCacheGuard();
    }

    async stop() {
        await this._postSucessOrFailurePublishing();
        this._updatePublishingStateWithEmission("stopped");
    }

    _isAllAttemptsExhausted(maxNumOfChallengeExchanges: number): boolean {
        // When all providers failed to publish
        // OR they're done with waiting

        if (Object.keys(this._challengeExchanges).length !== maxNumOfChallengeExchanges) return false;

        return Object.values(this._challengeExchanges).every((exchange) => {
            if (exchange.challengeRequestPublishError || exchange.challengeAnswerPublishError) return true;
            const doneWaitingForChallenge =
                typeof exchange.challengeRequestPublishTimestamp === "number" &&
                exchange.challengeRequestPublishTimestamp + this._setProviderFailureThresholdSeconds <= timestamp();
            return doneWaitingForChallenge;
        });
    }

    private async _postSucessOrFailurePublishing() {
        const log = Logger("pkc-js:publication:_postSucessOrFailurePublishing");
        this._setStateWithEmission("stopped");
        if (this._rpcPublishSubscriptionId) {
            try {
                await this._plebbit._plebbitRpcClient!.unsubscribe(this._rpcPublishSubscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from publication publish", e);
            }
            this._rpcPublishSubscriptionId = undefined;
            this._setRpcClientState("stopped");
        } else if (this._community) {
            // the client is publishing to pubsub without using plebbit RPC
            await this._clientsManager.pubsubUnsubscribe(this._communityPubsubTopicWithFallback(), this._handleChallengeExchange);
            Object.values(this._challengeExchanges).forEach((exchange) => this._updatePubsubState("stopped", exchange.providerUrl));
        }
    }

    private _handleIncomingChallengeRequestFromRpc(args: any) {
        const encodedRequest: EncodedDecryptedChallengeRequestMessageType = args.params.result;
        const request = decodeRpcChallengeRequestPubsubMsg(encodedRequest);
        this._challengeExchanges[request.challengeRequestId.toString()] = {
            ...this._challengeExchanges[request.challengeRequestId.toString()],
            challengeRequest: request,
            challengeRequestPublishTimestamp: timestamp(),
            providerUrl: Object.keys(this.clients.plebbitRpcClients)[0]
        };
        this.emit("challengerequest", request);
    }

    private _handleIncomingChallengeFromRpc(args: any) {
        const encodedChallenge: EncodedDecryptedChallengeMessageType = args.params.result;
        const challenge = decodeRpcChallengePubsubMsg(encodedChallenge);
        this._challengeExchanges[challenge.challengeRequestId.toString()] = {
            ...this._challengeExchanges[challenge.challengeRequestId.toString()],
            challenge,
            challengeRequestPublishTimestamp: timestamp()
        };

        this.emit("challenge", challenge);
    }

    private _handleIncomingChallengeAnswerFromRpc(args: any) {
        const encodedChallengeAnswer: EncodedDecryptedChallengeAnswerMessageType = args.params.result;

        const challengeAnswerMsg = decodeRpcChallengeAnswerPubsubMsg(encodedChallengeAnswer);
        this._challengeExchanges[challengeAnswerMsg.challengeRequestId.toString()] = {
            ...this._challengeExchanges[challengeAnswerMsg.challengeRequestId.toString()],
            challengeAnswer: challengeAnswerMsg,
            challengeAnswerPublishTimestamp: timestamp()
        };
        this.emit("challengeanswer", challengeAnswerMsg);
    }

    private async _handleIncomingChallengeVerificationFromRpc(args: any) {
        const { challengeVerification: encoded, runtimeFields } = args.params.result;
        const decoded = decodeRpcChallengeVerificationPubsubMsg(encoded);
        this._challengeExchanges[decoded.challengeRequestId.toString()] = {
            ...this._challengeExchanges[decoded.challengeRequestId.toString()],
            challengeVerification: decoded
        };
        await this._handleRpcChallengeVerification(decoded, runtimeFields);
    }

    private _handleIncomingPublishingStateFromRpc(args: any) {
        const publishState: Publication["publishingState"] = args.params.result.state; // we're optimistic that RPC server transmitted a correct string
        if (publishState === this.publishingState) this.emit("publishingstatechange", publishState);
        else this._updatePublishingStateWithEmission(publishState);
        this._updateRpcClientStateFromPublishingState(publishState);
    }

    private _handleIncomingStateFromRpc(args: any) {
        const state: Publication["state"] = args.params.result.state; // optimistic here, we're not validating it via schema
    }

    private async _handleIncomingErrorFromRpc(args: any) {
        const log = Logger("pkc-js:publication:publish:_publishWithRpc:_handleIncomingErrorFromRpc");
        const error: PublicationRpcErrorToTransmit = args.params.result;
        if (error.details?.newPublishingState) this._updatePublishingStateNoEmission(error.details.newPublishingState);
        if (error.details?.publishThrowError) {
            log.error("RPC server threw an error on publish(), will stop publication", error);
            await this._postSucessOrFailurePublishing();
        }
        this.emit("error", error);
    }

    async _publishWithRpc() {
        if (!this._plebbit._plebbitRpcClient)
            throw Error("Can't publish to RPC without publication.plebbit.plebbitRpcClient being defined");
        this._setStateWithEmission("publishing");

        const pubNameToPublishFunction: Record<PublicationTypeName, PlebbitRpcClient["publishComment"]> = {
            comment: this._plebbit._plebbitRpcClient.publishComment,
            vote: this._plebbit._plebbitRpcClient.publishVote,
            commentEdit: this._plebbit._plebbitRpcClient.publishCommentEdit,
            commentModeration: this._plebbit._plebbitRpcClient.publishCommentModeration,
            subplebbitEdit: this._plebbit._plebbitRpcClient.publishSubplebbitEdit
        };

        // PlebbitRpcClient will take care of zod parsing for us
        this._rpcPublishSubscriptionId = await pubNameToPublishFunction[this.getType()].bind(this._plebbit._plebbitRpcClient)(
            this.toJSONPubsubRequestToEncrypt()
        );
        if (typeof this._rpcPublishSubscriptionId !== "number") {
            this._updatePublishingStateWithEmission("failed");
            await this._postSucessOrFailurePublishing();
            throw Error("Failed to find the type of publication");
        }

        this._plebbit._plebbitRpcClient
            .getSubscription(this._rpcPublishSubscriptionId)
            .on("challengerequest", this._handleIncomingChallengeRequestFromRpc.bind(this))
            .on("challenge", this._handleIncomingChallengeFromRpc.bind(this))
            .on("challengeanswer", this._handleIncomingChallengeAnswerFromRpc.bind(this))
            .on("challengeverification", this._handleIncomingChallengeVerificationFromRpc.bind(this))
            .on("publishingstatechange", this._handleIncomingPublishingStateFromRpc.bind(this))
            .on("statechange", this._handleIncomingStateFromRpc.bind(this))
            .on("error", this._handleIncomingErrorFromRpc.bind(this));
        this._plebbit._plebbitRpcClient.emitAllPendingMessages(this._rpcPublishSubscriptionId);
    }

    private _changePublicationStateEmitEventEmitStateChangeEvent<
        T extends keyof Omit<PublicationEvents, "statechange" | "publishingstatechange">
    >(opts: {
        event: { name: T; args: PublicationEventArgs<T> };
        newPublishingState?: Publication["publishingState"];
        newState?: Publication["state"];
    }) {
        // this code block is only called on a sub whose update loop is already started
        // never called in a subplebbit that's mirroring a subplebbit with an update loop
        const shouldEmitStateChange = opts.newState && opts.newState !== this.state;
        const shouldEmitPublishingstatechange = opts.newPublishingState && opts.newPublishingState !== this.publishingState;
        if (opts.newState) this._setStateNoEmission(opts.newState);
        if (opts.newPublishingState) this._updatePublishingStateNoEmission(opts.newPublishingState);

        this.emit(opts.event.name, ...opts.event.args);

        if (shouldEmitStateChange) this.emit("statechange", this.state);
        if (shouldEmitPublishingstatechange) this.emit("publishingstatechange", this.publishingState);
    }

    private async _signAndValidateChallengeRequestBeforePublishing(
        toSignMsg: Omit<ChallengeRequestMessageType, "signature">,
        pubsubSigner: SignerType
    ): Promise<ChallengeRequestMessageType> {
        // No validation for now, we might add in the future
        return {
            ...toSignMsg,
            signature: await signChallengeRequest({ request: toSignMsg, signer: pubsubSigner })
        };
    }

    private _didWeReceiveChallengeOrChallengeVerification() {
        return Object.values(this._challengeExchanges).some((exchange) => exchange.challenge || exchange.challengeVerification);
    }

    private async _generateChallengeRequestToPublish(
        providerUrl: string,
        acceptedChallengeTypes: DecryptedChallengeRequestMessageType["acceptedChallengeTypes"]
    ) {
        const log = Logger("pkc-js:publication:publish:_generateChallengeRequestToPublish");
        const pubsubMessageSigner = await this._plebbit.createSigner();

        const pubsubMsgToEncrypt = this.toJSONPubsubRequestToEncrypt();
        const encrypted = await encryptEd25519AesGcm(
            JSON.stringify(pubsubMsgToEncrypt),
            pubsubMessageSigner.privateKey,
            this._community!.encryption.publicKey
        );

        const challengeRequestId = await getBufferedPlebbitAddressFromPublicKey(pubsubMessageSigner.publicKey);

        const toSignMsg: Omit<ChallengeRequestMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGEREQUEST",
            encrypted,
            challengeRequestId,
            acceptedChallengeTypes,
            userAgent: this._plebbit.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp()
        });

        const challengeRequest = await this._signAndValidateChallengeRequestBeforePublishing(toSignMsg, pubsubMessageSigner);
        log(
            "Attempting to publish",
            this.getType(),
            "to pubsub topic",
            this._communityPubsubTopicWithFallback(),
            "with provider",
            providerUrl,
            "request.encrypted=",
            pubsubMsgToEncrypt
        );

        const decryptedChallengeRequest = <DecryptedChallengeRequestMessageType>{ ...challengeRequest, ...pubsubMsgToEncrypt };

        this._challengeExchanges[challengeRequestId.toString()] = {
            challengeRequest: decryptedChallengeRequest,
            signer: pubsubMessageSigner,
            providerUrl
        };

        return challengeRequest;
    }

    async _initCommunity() {
        if (this._community) return;
        try {
            this._community = await this._fetchCommunityForPublishing();
            this._validateSubFields();
        } catch (e) {
            this._setStateWithEmission("stopped");
            this._updatePublishingStateWithEmission("failed");
            throw e;
        }
    }

    private _challengeExchangesFormattedForErrors() {
        return Object.values(this._challengeExchanges).map((exchange) => ({
            ...exchange,
            timedoutWaitingForChallengeRequestResponse:
                !exchange.challengeVerification &&
                !exchange.challenge &&
                typeof exchange.challengeRequestPublishTimestamp === "number" &&
                exchange.challengeRequestPublishTimestamp + this._setProviderFailureThresholdSeconds <= timestamp()
        }));
    }

    private async _handleNotReceivingResponseToChallengeRequest({
        providers,
        currentPubsubProviderIndex,
        acceptedChallengeTypes
    }: {
        providers: string[];
        currentPubsubProviderIndex: number;
        acceptedChallengeTypes: DecryptedChallengeRequestMessageType["acceptedChallengeTypes"];
    }) {
        await new Promise((resolve) => setTimeout(resolve, this._publishToDifferentProviderThresholdSeconds * 1000));

        if (this._didWeReceiveChallengeOrChallengeVerification()) return;

        // this provider did not get us a challenge or challenge verification
        const currentPubsubProvider = providers[currentPubsubProviderIndex];
        this._plebbit._stats.recordGatewayFailure(currentPubsubProvider, "pubsub-publish");
        this._plebbit._stats.recordGatewayFailure(currentPubsubProvider, "pubsub-subscribe");
        const log = Logger("pkc-js:publication:publish:_handleNotReceivingResponseToChallengeRequest");

        if (this._isAllAttemptsExhausted(providers.length)) {
            // plebbit-js tried all providers and still no response is received
            log.error(`Failed to receive any response for publication`, this.getType());
            await this._postSucessOrFailurePublishing();
            const error = new PlebbitError("ERR_PUBSUB_DID_NOT_RECEIVE_RESPONSE_AFTER_PUBLISHING_CHALLENGE_REQUEST", {
                challengeExchanges: this._challengeExchangesFormattedForErrors(),
                publishToDifferentProviderThresholdSeconds: this._publishToDifferentProviderThresholdSeconds
            });

            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [error] }
            });
        } else if (this.state === "stopped") {
            log.error(`Publication is stopped, will not re-publish`);
            await this._postSucessOrFailurePublishing();
        } else {
            if (currentPubsubProviderIndex + 1 === providers.length) {
                log.error(`Failed to receive any response for publication`, this.getType(), "after publishing to all providers", providers);
                await this._postSucessOrFailurePublishing();
            } else {
                // let's publish to the next provider

                log(
                    `Re-publishing publication after ${this._publishToDifferentProviderThresholdSeconds}s of not receiving challenge from provider (${currentPubsubProvider})`
                );

                currentPubsubProviderIndex += 1;
                while (!this._didWeReceiveChallengeOrChallengeVerification() && currentPubsubProviderIndex < providers.length) {
                    const providerUrl = providers[currentPubsubProviderIndex];
                    const challengeRequest = await this._generateChallengeRequestToPublish(providerUrl, acceptedChallengeTypes);

                    this._updatePublishingStateWithEmission("publishing-challenge-request");
                    this._updatePubsubState("subscribing-pubsub", providerUrl);
                    try {
                        await this._clientsManager.pubsubSubscribeOnProvider(
                            this._communityPubsubTopicWithFallback(),
                            this._handleChallengeExchange,
                            providerUrl
                        );
                        this._updatePubsubState("publishing-challenge-request", providerUrl);
                        await this._clientsManager.pubsubPublishOnProvider(
                            this._communityPubsubTopicWithFallback(),
                            challengeRequest,
                            providerUrl
                        );
                        this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishTimestamp =
                            timestamp();
                    } catch (e) {
                        log.error("Failed to publish challenge request using provider ", providerUrl, e);
                        this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishError = e as
                            | Error
                            | PlebbitError;
                        continue;
                    } finally {
                        currentPubsubProviderIndex += 1;
                    }
                    const decryptedRequest = this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequest;
                    this._updatePubsubState("waiting-challenge", providerUrl);

                    this._updatePublishingStateWithEmission("waiting-challenge");

                    log(`Published a challenge request of publication`, this.getType(), "with provider", providerUrl);
                    this.emit("challengerequest", decryptedRequest);
                    if (currentPubsubProviderIndex !== providers.length)
                        await new Promise((resolve) => setTimeout(resolve, this._publishToDifferentProviderThresholdSeconds * 1000));
                }
                await new Promise((resolve) => setTimeout(resolve, this._setProviderFailureThresholdSeconds * 1000));
                if (this._isAllAttemptsExhausted(providers.length)) {
                    await this._postSucessOrFailurePublishing();
                    const allAttemptsFailedError = new PlebbitError("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS", {
                        challengeExchanges: this._challengeExchangesFormattedForErrors(),
                        pubsubTopic: this._communityPubsubTopicWithFallback()
                    });
                    log.error("All attempts to publish", this.getType(), "has failed", allAttemptsFailedError);
                    this._changePublicationStateEmitEventEmitStateChangeEvent({
                        newPublishingState: "failed",
                        event: { name: "error", args: [allAttemptsFailedError] }
                    });
                    return;
                }
            }
        }
    }

    private _getPubsubProviders() {
        const providers =
            this.clients.libp2pJsClients && remeda.keys.strict(this.clients.libp2pJsClients).length > 0
                ? remeda.keys.strict(this.clients.libp2pJsClients)
                : remeda.keys.strict(this.clients.pubsubKuboRpcClients);
        if (providers.length === 0) throw new PlebbitError("ERR_NO_PUBSUB_PROVIDERS_AVAILABLE_TO_PUBLISH_OVER_PUBSUB", { providers });
        if (providers.length === 1) providers.push(providers[0]); // Same provider should be retried twice if publishing fails

        return providers;
    }

    private async _publishWithLocalSubplebbit(sub: LocalSubplebbit, challengeRequest: ChallengeRequestMessageType) {
        this._publishingToLocalSubplebbit = sub;
        const log = Logger("pkc-js:publication:publish:_publishWithLocalSubplebbit");
        log(
            "Sub is local, will not publish over pubsub, and instead will publish directly to the subplebbit by accessing plebbit._startedSubplebbits"
        );

        const subChallengeListener = async (challenge: DecryptedChallengeMessageType) => {
            if (challenge.challengeRequestId.toString() === challengeRequest.challengeRequestId.toString()) {
                // need to remove encrypted fields from challenge otherwise _handleIncomingChallengePubsubMessage will throw
                const encryptedFields = ["challenges"] as const;

                log("Received a challenge from the local subplebbit", challenge);
                await this._handleIncomingChallengePubsubMessage(remeda.omit(challenge, encryptedFields));
            }
        };

        sub.on("challenge", subChallengeListener);

        const subChallengeVerificationListener = async (decryptedChallengeVerification: DecryptedChallengeVerificationMessageType) => {
            if (decryptedChallengeVerification.challengeRequestId.toString() === challengeRequest.challengeRequestId.toString()) {
                log("Received a challenge verification from the local subplebbit", decryptedChallengeVerification);
                // need to remove publicatioon fields from challenge verification otherwise verifyChallengeVerification will throw
                const publicationFieldsToRemove = ["comment", "commentUpdate"] as const;
                await this._handleIncomingChallengeVerificationPubsubMessage(
                    remeda.omit(decryptedChallengeVerification, publicationFieldsToRemove)
                );
            }
        };

        sub.on("challengeverification", subChallengeVerificationListener);

        this.emit("challengerequest", challengeRequest);
        sub.handleChallengeRequest(challengeRequest, true)
            .then(() => {
                this._challengeExchanges[challengeRequest.challengeRequestId.toString()] = {
                    ...this._challengeExchanges[challengeRequest.challengeRequestId.toString()],
                    challengeRequestPublishTimestamp: timestamp()
                };
            })
            .catch((e) => {
                log.error("Failed to handle challenge request with local subplebbit", e);
                this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishError = e as
                    | Error
                    | PlebbitError;
                throw e;
            })
            .finally(() => {
                sub.removeListener("challenge", subChallengeListener);
                sub.removeListener("challengeverification", subChallengeVerificationListener);
            });
    }

    async publish() {
        const log = Logger("pkc-js:publication:publish");
        this._validatePublicationFields();
        this._setStateWithEmission("publishing");

        // Fetch community for BOTH RPC and non-RPC paths (needed for signing)
        await this._initCommunity();

        // Sign the publication with community fields if not yet signed
        if (this.raw.unsignedPublicationOptions && !this.raw.pubsubMessageToPublish) {
            await this._signPublicationWithCommunityFields();
        }

        await this._validateSignatureHook();

        if (this._plebbit._plebbitRpcClient) return this._publishWithRpc();

        const options = { acceptedChallengeTypes: [] };

        const providers = this._getPubsubProviders();
        const startedSubplebbit = findStartedSubplebbit(this._plebbit, { address: this.communityAddress }) as LocalSubplebbit | undefined;
        if (startedSubplebbit) {
            return this._publishWithLocalSubplebbit(
                startedSubplebbit,
                await this._generateChallengeRequestToPublish(
                    "publishing directly to local subplebbit instance",
                    options.acceptedChallengeTypes
                )
            );
        }

        let currentPubsubProviderIndex = 0;
        while (!this._didWeReceiveChallengeOrChallengeVerification() && currentPubsubProviderIndex < providers.length) {
            const providerUrl = providers[currentPubsubProviderIndex];
            const challengeRequest = await this._generateChallengeRequestToPublish(providerUrl, options.acceptedChallengeTypes);

            this._updatePublishingStateWithEmission("publishing-challenge-request");
            this._updatePubsubState("subscribing-pubsub", providerUrl);
            try {
                // this will throw if we succeed in subscribing first attempt, but then fail to publish

                await this._clientsManager.pubsubSubscribeOnProvider(
                    this._communityPubsubTopicWithFallback(),
                    this._handleChallengeExchange,
                    providerUrl
                );
                this._updatePubsubState("publishing-challenge-request", providerUrl);
                await this._clientsManager.pubsubPublishOnProvider(this._communityPubsubTopicWithFallback(), challengeRequest, providerUrl);
                this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishTimestamp = timestamp();
            } catch (e) {
                this._updatePubsubState("stopped", providerUrl);
                log.error("Failed to publish challenge request using provider ", providerUrl, e);
                currentPubsubProviderIndex += 1;
                this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishError = e as
                    | Error
                    | PlebbitError;
                if (this._isAllAttemptsExhausted(providers.length)) {
                    await this._postSucessOrFailurePublishing();
                    const allAttemptsFailedError = new PlebbitError("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS", {
                        challengeExchanges: this._challengeExchangesFormattedForErrors(),
                        pubsubTopic: this._communityPubsubTopicWithFallback()
                    });
                    log.error("All attempts to publish", this.getType(), "has failed", allAttemptsFailedError);
                    this._changePublicationStateEmitEventEmitStateChangeEvent({
                        newPublishingState: "failed",
                        event: { name: "error", args: [allAttemptsFailedError] }
                    });
                    throw allAttemptsFailedError;
                } else continue;
            }
            const decryptedRequest = this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequest;
            this._updatePubsubState("waiting-challenge", providerUrl);

            this._updatePublishingStateWithEmission("waiting-challenge");

            log(`Published a challenge request of publication`, this.getType(), "with provider", providerUrl);
            this.emit("challengerequest", decryptedRequest);
            break;
        }
        // to handle cases where request is published but we didn't receive response within certain timeframe (20s for now)
        // Maybe the sub didn't receive the request, or the provider did not relay the challenge from sub for some reason
        this._handleNotReceivingResponseToChallengeRequest({
            providers,
            currentPubsubProviderIndex,
            acceptedChallengeTypes: options.acceptedChallengeTypes
        }).catch((err) => {
            log.error("Failed to handle not receiving response to challenge request", err);
        });
    }
}

export default Publication;
