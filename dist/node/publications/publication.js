import assert from "assert";
import { decryptEd25519AesGcm, encryptEd25519AesGcm } from "../signer/index.js";
import Logger from "../logger.js";
import env from "../version.js";
import { cleanUpBeforePublishing, signChallengeAnswer, signChallengeRequest, verifyChallengeMessage, verifyChallengeVerification } from "../signer/signatures.js";
import { deepMergeRuntimeFields, hideClassPrivateProps, isStringDomain, shortifyAddress, timestamp } from "../util.js";
import { TypedEmitter } from "tiny-typed-emitter";
import { Comment } from "./comment/comment.js";
import { PKCError } from "../pkc-error.js";
import { getBufferedPKCAddressFromPublicKey } from "../signer/util.js";
import * as cborg from "cborg";
import * as remeda from "remeda";
import { findStartedCommunity, findUpdatingCommunity } from "../pkc/tracked-instance-registry-util.js";
import { parseDecryptedChallengeAnswerWithPKCErrorIfItFails, parseDecryptedChallengeVerification, parseDecryptedChallengeWithPKCErrorIfItFails, parseJsonWithPKCErrorIfFails } from "../schema/schema-util.js";
import { ChallengeRequestMessageSchema, ChallengeAnswerMessageSchema, ChallengeMessageSchema, ChallengeVerificationMessageSchema } from "../pubsub-messages/schema.js";
import { decodeRpcChallengeAnswerPubsubMsg, decodeRpcChallengePubsubMsg, decodeRpcChallengeRequestPubsubMsg, decodeRpcChallengeVerificationPubsubMsg } from "../clients/rpc-client/decode-rpc-response-util.js";
import { PublicationClientsManager } from "./publication-client-manager.js";
import { buildRuntimeAuthor } from "./publication-author.js";
import { buildRuntimeCommunityFields, normalizeCommunityInputFromCommunity } from "./publication-community.js";
class Publication extends TypedEmitter {
    constructor(pkc) {
        super();
        this.raw = {};
        // private
        this._community = undefined; // will be used for publishing
        this._challengeExchanges = {};
        this._rpcPublishSubscriptionId = undefined;
        this._pkc = pkc;
        this._updatePublishingStateWithEmission("stopped");
        this._setStateWithEmission("stopped");
        this._initClients();
        this._handleChallengeExchange = this._handleChallengeExchange.bind(this);
        this.publish = this.publish.bind(this);
        this.on("error", (...args) => this.listenerCount("error") === 1 && this._pkc.emit("error", ...args)); // only bubble up to pkc if no other listeners are attached
        this._publishToDifferentProviderThresholdSeconds = 10;
        this._setProviderFailureThresholdSeconds = 60 * 2; // Two minutes
        // public method should be bound
        this.publishChallengeAnswers = this.publishChallengeAnswers.bind(this);
        hideClassPrivateProps(this);
    }
    _initClients() {
        this._clientsManager = new PublicationClientsManager(this);
        this.clients = this._clientsManager.clients;
    }
    setCommunityAddress(communityAddress) {
        this.communityAddress = communityAddress;
        this.shortCommunityAddress = shortifyAddress(communityAddress);
    }
    _initBaseRemoteProps(props) {
        const communityFields = buildRuntimeCommunityFields({ publication: props });
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
    _initUnsignedLocalProps(opts) {
        this.raw.unsignedPublicationOptions = opts.unsignedOptions;
        this.challengeRequest = opts.challengeRequest;
        this.signer = opts.unsignedOptions.signer;
        this.communityAddress = opts.unsignedOptions.communityAddress;
        this.shortCommunityAddress = shortifyAddress(opts.unsignedOptions.communityAddress);
        // Derive communityName/communityPublicKey from communityAddress if not explicitly provided
        if (opts.unsignedOptions.communityPublicKey)
            this.communityPublicKey = opts.unsignedOptions.communityPublicKey;
        else if (!isStringDomain(opts.unsignedOptions.communityAddress))
            this.communityPublicKey = opts.unsignedOptions.communityAddress;
        if (opts.unsignedOptions.communityName)
            this.communityName = opts.unsignedOptions.communityName;
        else if (isStringDomain(opts.unsignedOptions.communityAddress))
            this.communityName = opts.unsignedOptions.communityAddress;
        this.timestamp = opts.unsignedOptions.timestamp;
        this.protocolVersion = opts.unsignedOptions.protocolVersion;
        const runtimeAuthor = buildRuntimeAuthor({
            author: opts.unsignedOptions.author,
            signaturePublicKey: opts.unsignedOptions.signer.publicKey
        });
        this.author = { ...runtimeAuthor, shortAddress: shortifyAddress(runtimeAuthor.address) };
    }
    async _signPublicationOptionsToPublish(_cleanedPublication) {
        throw new Error(`Should be implemented by children of Publication`);
    }
    async _signPublication({ communityFields }) {
        if (!this.raw.unsignedPublicationOptions)
            throw Error("No unsigned publication options to sign");
        const optionsWithCommunity = {
            ...this.raw.unsignedPublicationOptions,
            ...communityFields
        };
        const cleaned = cleanUpBeforePublishing(optionsWithCommunity);
        const signature = await this._signPublicationOptionsToPublish(cleaned);
        const signedPublicationFields = Object.fromEntries(signature.signedPropertyNames.map((propertyName) => [propertyName, cleaned[propertyName]]));
        const signedPublication = {
            ...signedPublicationFields,
            signature
        };
        this.raw.pubsubMessageToPublish = signedPublication;
        delete this.raw.unsignedPublicationOptions;
        this._initBaseRemoteProps(signedPublication);
    }
    async _signPublicationWithCommunityFields() {
        if (!this._community)
            throw Error("Community must be loaded before signing");
        const communityFields = normalizeCommunityInputFromCommunity({ communityInstance: this._community });
        await this._signPublication({ communityFields });
    }
    async _signPublicationWithKnownCommunityFieldsIfAvailable() {
        if (!this.communityPublicKey || this.raw.pubsubMessageToPublish || !this.raw.unsignedPublicationOptions)
            return;
        await this._signPublication({
            communityFields: {
                communityPublicKey: this.communityPublicKey,
                ...(this.communityName ? { communityName: this.communityName } : {})
            }
        });
    }
    async _validateSignatureHook() {
        // Subclasses override to validate signature after signing
    }
    async _verifyDecryptedChallengeVerificationAndUpdateCommentProps(decryptedVerification) {
        throw Error("should be handled in comment, not publication");
    }
    getType() {
        throw new Error(`Should be implemented by children of Publication`);
    }
    toJSONPubsubRequestToEncrypt() {
        if (!this.raw.pubsubMessageToPublish)
            throw Error("raw.pubsubMessageToPublish must be defined before calling toJSONPubsubRequestToEncrypt");
        return {
            [this.getType()]: this.raw.pubsubMessageToPublish,
            ...this.challengeRequest
        };
    }
    async _handleRpcChallengeVerification(verification, runtimeFields) {
        const log = Logger("pkc-js:publication:_handleRpcChallengeVerification");
        if (verification.comment)
            await this._verifyDecryptedChallengeVerificationAndUpdateCommentProps(verification);
        if (this instanceof Comment && runtimeFields)
            deepMergeRuntimeFields(this, runtimeFields);
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
                await this._pkc._pkcRpcClient.unsubscribe(this._rpcPublishSubscriptionId);
            }
            catch (e) {
                log.error("Failed to unsubscribe from publication publish", e);
            }
            this._rpcPublishSubscriptionId = undefined;
        }
    }
    async _handleIncomingChallengePubsubMessage(msg) {
        const log = Logger("pkc-js:publication:_handleIncomingChallengePubsubMessage");
        if (Object.values(this._challengeExchanges).some((exchange) => exchange.challenge))
            return; // We only process one challenge
        const challengeMsgValidity = await verifyChallengeMessage({
            challenge: msg,
            pubsubTopic: this._communityPubsubTopicWithFallback(),
            validateTimestampRange: true
        });
        if (!challengeMsgValidity.valid) {
            const error = new PKCError("ERR_CHALLENGE_SIGNATURE_IS_INVALID", {
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
        log(`Received encrypted challenges.  Will decrypt and emit them on "challenge" event. User shoud publish solution by calling publishChallengeAnswers`);
        const pubsubSigner = this._challengeExchanges[msg.challengeRequestId.toString()].signer;
        if (!pubsubSigner)
            throw Error("Signer is undefined for this challenge exchange");
        let decryptedRawString;
        try {
            decryptedRawString = await decryptEd25519AesGcm(msg.encrypted, pubsubSigner.privateKey, this._community.encryption.publicKey);
        }
        catch (e) {
            const pkcError = new PKCError("ERR_PUBLICATION_FAILED_TO_DECRYPT_CHALLENGE", { decryptErr: e });
            log.error("could not decrypt challengemessage.encrypted", pkcError.toString());
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [pkcError] }
            });
            return;
        }
        let decryptedJson;
        try {
            decryptedJson = await parseJsonWithPKCErrorIfFails(decryptedRawString);
        }
        catch (e) {
            log.error("could not parse decrypted challengemessage.encrypted as a json", String(e));
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [e] }
            });
            return;
        }
        let decryptedChallenge;
        try {
            decryptedChallenge = parseDecryptedChallengeWithPKCErrorIfItFails(decryptedJson);
        }
        catch (e) {
            log.error("could not parse z challengemessage.encrypted as a json", String(e));
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [e] }
            });
            return;
        }
        const decryptedChallengeMsg = {
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
    async _handleIncomingChallengeVerificationPubsubMessage(msg) {
        const log = Logger("pkc-js:publication:_handleIncomingChallengeVerificationPubsubMessage");
        if (this._challengeExchanges[msg.challengeRequestId.toString()].challengeVerification)
            return;
        const signatureValidation = await verifyChallengeVerification({
            verification: msg,
            pubsubTopic: this._communityPubsubTopicWithFallback(),
            validateTimestampRange: true
        });
        if (!signatureValidation.valid) {
            const error = new PKCError("ERR_CHALLENGE_VERIFICATION_SIGNATURE_IS_INVALID", {
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
        let decryptedChallengeVerification;
        let newPublishingState;
        if (msg.challengeSuccess) {
            newPublishingState = "succeeded";
            log(`Received a challengeverification with challengeSuccess=true`, "for publication", this.getType());
            if (msg.encrypted) {
                let decryptedRawString;
                const pubsubSigner = this._challengeExchanges[msg.challengeRequestId.toString()].signer;
                if (!pubsubSigner)
                    throw Error("Signer is undefined for this challenge exchange");
                try {
                    decryptedRawString = await decryptEd25519AesGcm(msg.encrypted, pubsubSigner.privateKey, this._community.encryption.publicKey);
                }
                catch (e) {
                    const pkcError = new PKCError("ERR_INVALID_CHALLENGE_VERIFICATION_DECRYPTED_SCHEMA", {
                        decryptErr: e,
                        challenegVerificationMsg: msg
                    });
                    log.error("could not decrypt challengeverification.encrypted", pkcError);
                    this.emit("error", pkcError);
                    return;
                }
                let decryptedJson;
                try {
                    decryptedJson = await parseJsonWithPKCErrorIfFails(decryptedRawString);
                }
                catch (e) {
                    log.error("could not parse decrypted challengeverification.encrypted as a json", e);
                    this.emit("error", e);
                    return;
                }
                try {
                    decryptedChallengeVerification = parseDecryptedChallengeVerification(decryptedJson);
                }
                catch (e) {
                    log.error("could not parse challengeverification.encrypted due to invalid schema", e);
                    this.emit("error", e);
                    return;
                }
                if (decryptedChallengeVerification.comment) {
                    await this._verifyDecryptedChallengeVerificationAndUpdateCommentProps(decryptedChallengeVerification);
                    log("Updated the props of this instance with challengeverification.encrypted");
                }
            }
        }
        else {
            newPublishingState = "failed";
            log.error(`Challenge exchange with publication`, this.getType(), `has failed to pass`, "Challenge errors", msg.challengeErrors, `reason`, msg.reason);
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
    async _handleChallengeExchange(pubsubMsg) {
        const log = Logger("pkc-js:publication:handleChallengeExchange");
        let decodedJson;
        try {
            decodedJson = cborg.decode(pubsubMsg.data);
        }
        catch (e) {
            log.error("Failed to decode pubsub message", e);
            return;
        }
        const pubsubSchemas = [
            ChallengeVerificationMessageSchema.loose(),
            ChallengeMessageSchema.loose(),
            ChallengeRequestMessageSchema.loose(),
            ChallengeAnswerMessageSchema.loose()
        ];
        let pubsubMsgParsed;
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
        }
        else if (!Object.values(this._challengeExchanges).some((exchange) => remeda.isDeepEqual(pubsubMsgParsed.challengeRequestId, exchange.challengeRequest.challengeRequestId))) {
            log.trace(`Received pubsub message with different challenge request id, ignoring it`);
        }
        else if (pubsubMsgParsed.type === "CHALLENGE")
            return this._handleIncomingChallengePubsubMessage(pubsubMsgParsed);
        else if (pubsubMsgParsed.type === "CHALLENGEVERIFICATION")
            return this._handleIncomingChallengeVerificationPubsubMessage(pubsubMsgParsed);
    }
    _updatePubsubState(pubsubState, keyOrUrl) {
        if (this._publishingToLocalCommunity)
            return; // there's no pubsub for local community
        const kuboOrHelia = this._clientsManager.getDefaultPubsubKuboRpcClientOrHelia();
        if ("_helia" in kuboOrHelia)
            this._clientsManager.updateLibp2pJsClientState(pubsubState, keyOrUrl);
        else
            this._clientsManager.updateKuboRpcPubsubState(pubsubState, keyOrUrl);
    }
    async publishChallengeAnswers(challengeAnswers) {
        const log = Logger("pkc-js:publication:publishChallengeAnswers");
        const toEncryptAnswers = parseDecryptedChallengeAnswerWithPKCErrorIfItFails({
            challengeAnswers: challengeAnswers
        });
        if (this._pkc._pkcRpcClient && typeof this._rpcPublishSubscriptionId === "number") {
            return this._pkc._pkcRpcClient.publishChallengeAnswers(this._rpcPublishSubscriptionId, toEncryptAnswers.challengeAnswers);
        }
        const challengeExchangesWithChallenge = Object.values(this._challengeExchanges).filter((exchange) => exchange.challenge);
        if (challengeExchangesWithChallenge.length === 0)
            throw Error("No challenge exchanges with challenge");
        if (challengeExchangesWithChallenge.length > 1)
            throw Error("We should only have one challenge exchange with challenge");
        const challengeExchange = challengeExchangesWithChallenge[0];
        assert(this._community, "Local pkc-js needs publication._community to be defined to publish challenge answer");
        if (!challengeExchange.signer)
            throw Error("Signer is undefined for this challenge exchange");
        const encryptedChallengeAnswers = await encryptEd25519AesGcm(JSON.stringify(toEncryptAnswers), challengeExchange.signer.privateKey, this._community.encryption.publicKey);
        const toSignAnswer = cleanUpBeforePublishing({
            type: "CHALLENGEANSWER",
            challengeRequestId: challengeExchange.challengeRequest.challengeRequestId,
            encrypted: encryptedChallengeAnswers,
            userAgent: this._pkc.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp()
        });
        const answerMsgToPublish = {
            ...toSignAnswer,
            signature: await signChallengeAnswer({ challengeAnswer: toSignAnswer, signer: challengeExchange.signer })
        };
        // TODO should be handling multiple providers with publishing challenge answer?
        // For now, let's just publish to the provider that got us the challenge and its request
        this._updatePublishingStateWithEmission("publishing-challenge-answer");
        this._updatePubsubState("publishing-challenge-answer", challengeExchange.providerUrl);
        if (this._publishingToLocalCommunity) {
            try {
                await this._publishingToLocalCommunity.handleChallengeAnswer(answerMsgToPublish);
            }
            catch (e) {
                this._challengeExchanges[challengeExchange.challengeRequest.challengeRequestId.toString()].challengeAnswerPublishError =
                    e;
                this._updatePublishingStateWithEmission("failed");
                this._updatePubsubState("stopped", challengeExchange.providerUrl);
                throw e;
            }
        }
        else {
            try {
                await this._clientsManager.pubsubPublishOnProvider(this._communityPubsubTopicWithFallback(), answerMsgToPublish, challengeExchange.providerUrl);
            }
            catch (e) {
                this._challengeExchanges[challengeExchange.challengeRequest.challengeRequestId.toString()].challengeAnswerPublishError =
                    e;
                this._updatePublishingStateWithEmission("failed");
                this._updatePubsubState("stopped", challengeExchange.providerUrl);
                throw e;
            }
        }
        const decryptedChallengeAnswer = {
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
    _validatePublicationFields() {
        if (typeof this.timestamp !== "number" || this.timestamp < 0)
            throw new PKCError("ERR_PUBLICATION_MISSING_FIELD", { type: this.getType, timestamp: this.timestamp });
        if (typeof this.author?.address !== "string")
            throw new PKCError("ERR_PUBLICATION_MISSING_FIELD", { type: this.getType(), authorAddress: this.author?.address });
        if (typeof this.communityAddress !== "string")
            throw new PKCError("ERR_PUBLICATION_MISSING_FIELD", { type: this.getType(), communityAddress: this.communityAddress });
    }
    _validateCommunityFields() {
        if (typeof this._community?.encryption?.publicKey !== "string")
            throw new PKCError("ERR_COMMUNITY_MISSING_FIELD", { communityPublicKey: this._community?.encryption?.publicKey });
        if (typeof this._communityPubsubTopicWithFallback() !== "string")
            throw new PKCError("ERR_COMMUNITY_MISSING_FIELD", {
                pubsubTopic: this._community?.pubsubTopic,
                address: this._community?.address
            });
    }
    _updatePublishingStateNoEmission(newState) {
        this.publishingState = newState;
    }
    _updatePublishingStateWithEmission(newState) {
        if (this.publishingState === newState)
            return;
        this.publishingState = newState;
        this.emit("publishingstatechange", this.publishingState);
    }
    _updateRpcClientStateFromPublishingState(publishingState) {
        // We're deriving the the rpc state from publishing state
        const mapper = {
            failed: ["stopped"],
            "fetching-community-ipfs": ["fetching-community-ipfs"],
            "fetching-community-ipns": ["fetching-community-ipns"],
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
    _setStateNoEmission(newState) {
        if (newState === this.state)
            return;
        this.state = newState;
    }
    _setStateWithEmission(newState) {
        if (newState === this.state)
            return;
        this.state = newState;
        this.emit("statechange", newState);
    }
    _setRpcClientState(newState) {
        const currentRpcUrl = remeda.keys.strict(this.clients.pkcRpcClients)[0];
        if (newState === this.clients.pkcRpcClients[currentRpcUrl].state)
            return;
        this.clients.pkcRpcClients[currentRpcUrl].state = newState;
        this.clients.pkcRpcClients[currentRpcUrl].emit("statechange", newState);
    }
    _communityPubsubTopicWithFallback() {
        const pubsubTopic = this._community?.pubsubTopic || this._community?.address;
        if (typeof pubsubTopic !== "string")
            throw Error("Failed to load the pubsub topic of community");
        return pubsubTopic;
    }
    _getCommunityCache() {
        const cached = this._pkc._memCaches.communityForPublishing.get(this.communityAddress, { allowStale: true });
        if (cached)
            return cached;
        const subInstance = findUpdatingCommunity(this._pkc, { address: this.communityAddress }) ||
            findStartedCommunity(this._pkc, { address: this.communityAddress });
        const subIpfs = subInstance?.raw.communityIpfs;
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
    async _fetchCommunityForPublishing() {
        const log = Logger("pkc-js:publish:_fetchCommunityForPublishing");
        const cachedCommunity = this._getCommunityCache();
        if (cachedCommunity) {
            // We will use the cached community even though it's stale
            // And in the background we will fetch a new one and update the cache
            // cache.has will return false if the item is stale
            if (!this._pkc._memCaches.communityForPublishing.has(this.communityAddress)) {
                log("The cache of community is stale, we will use the cached and update in the background");
                this._pkc
                    .getCommunity({ address: this.communityAddress })
                    .catch((e) => log.error("Failed to update cache of community", this.communityAddress, e));
            }
            return cachedCommunity;
        }
        else
            return this._clientsManager.fetchCommunityForPublishingWithCacheGuard();
    }
    async stop() {
        await this._postSucessOrFailurePublishing();
        this._updatePublishingStateWithEmission("stopped");
    }
    _isAllAttemptsExhausted(maxNumOfChallengeExchanges) {
        // When all providers failed to publish
        // OR they're done with waiting
        if (Object.keys(this._challengeExchanges).length !== maxNumOfChallengeExchanges)
            return false;
        return Object.values(this._challengeExchanges).every((exchange) => {
            if (exchange.challengeRequestPublishError || exchange.challengeAnswerPublishError)
                return true;
            const doneWaitingForChallenge = typeof exchange.challengeRequestPublishTimestamp === "number" &&
                exchange.challengeRequestPublishTimestamp + this._setProviderFailureThresholdSeconds <= timestamp();
            return doneWaitingForChallenge;
        });
    }
    async _postSucessOrFailurePublishing() {
        const log = Logger("pkc-js:publication:_postSucessOrFailurePublishing");
        this._setStateWithEmission("stopped");
        if (this._rpcPublishSubscriptionId) {
            try {
                await this._pkc._pkcRpcClient.unsubscribe(this._rpcPublishSubscriptionId);
            }
            catch (e) {
                log.error("Failed to unsubscribe from publication publish", e);
            }
            this._rpcPublishSubscriptionId = undefined;
            this._setRpcClientState("stopped");
        }
        else if (this._community) {
            // the client is publishing to pubsub without using PKC RPC
            await this._clientsManager.pubsubUnsubscribe(this._communityPubsubTopicWithFallback(), this._handleChallengeExchange);
            Object.values(this._challengeExchanges).forEach((exchange) => this._updatePubsubState("stopped", exchange.providerUrl));
        }
    }
    _handleIncomingChallengeRequestFromRpc(args) {
        const encodedRequest = args.params.result;
        const request = decodeRpcChallengeRequestPubsubMsg(encodedRequest);
        this._challengeExchanges[request.challengeRequestId.toString()] = {
            ...this._challengeExchanges[request.challengeRequestId.toString()],
            challengeRequest: request,
            challengeRequestPublishTimestamp: timestamp(),
            providerUrl: Object.keys(this.clients.pkcRpcClients)[0]
        };
        this.emit("challengerequest", request);
    }
    _handleIncomingChallengeFromRpc(args) {
        const encodedChallenge = args.params.result;
        const challenge = decodeRpcChallengePubsubMsg(encodedChallenge);
        this._challengeExchanges[challenge.challengeRequestId.toString()] = {
            ...this._challengeExchanges[challenge.challengeRequestId.toString()],
            challenge,
            challengeRequestPublishTimestamp: timestamp()
        };
        this.emit("challenge", challenge);
    }
    _handleIncomingChallengeAnswerFromRpc(args) {
        const encodedChallengeAnswer = args.params.result;
        const challengeAnswerMsg = decodeRpcChallengeAnswerPubsubMsg(encodedChallengeAnswer);
        this._challengeExchanges[challengeAnswerMsg.challengeRequestId.toString()] = {
            ...this._challengeExchanges[challengeAnswerMsg.challengeRequestId.toString()],
            challengeAnswer: challengeAnswerMsg,
            challengeAnswerPublishTimestamp: timestamp()
        };
        this.emit("challengeanswer", challengeAnswerMsg);
    }
    async _handleIncomingChallengeVerificationFromRpc(args) {
        const { challengeVerification: encoded, runtimeFields } = args.params.result;
        const decoded = decodeRpcChallengeVerificationPubsubMsg(encoded);
        this._challengeExchanges[decoded.challengeRequestId.toString()] = {
            ...this._challengeExchanges[decoded.challengeRequestId.toString()],
            challengeVerification: decoded
        };
        await this._handleRpcChallengeVerification(decoded, runtimeFields);
    }
    _handleIncomingPublishingStateFromRpc(args) {
        const publishState = args.params.result.state; // we're optimistic that RPC server transmitted a correct string
        if (publishState === this.publishingState)
            this.emit("publishingstatechange", publishState);
        else
            this._updatePublishingStateWithEmission(publishState);
        this._updateRpcClientStateFromPublishingState(publishState);
    }
    _handleIncomingStateFromRpc(args) {
        const state = args.params.result.state; // optimistic here, we're not validating it via schema
    }
    async _handleIncomingErrorFromRpc(args) {
        const log = Logger("pkc-js:publication:publish:_publishWithRpc:_handleIncomingErrorFromRpc");
        const error = args.params.result;
        if (error.details?.newPublishingState)
            this._updatePublishingStateNoEmission(error.details.newPublishingState);
        if (error.details?.publishThrowError) {
            log.error("RPC server threw an error on publish(), will stop publication", error);
            await this._postSucessOrFailurePublishing();
        }
        this.emit("error", error);
    }
    async _publishWithRpc() {
        if (!this._pkc._pkcRpcClient)
            throw Error("Can't publish to RPC without publication.pkc.pkcRpcClient being defined");
        this._setStateWithEmission("publishing");
        const pubNameToPublishFunction = {
            comment: this._pkc._pkcRpcClient.publishComment,
            vote: this._pkc._pkcRpcClient.publishVote,
            commentEdit: this._pkc._pkcRpcClient.publishCommentEdit,
            commentModeration: this._pkc._pkcRpcClient.publishCommentModeration,
            communityEdit: this._pkc._pkcRpcClient.publishCommunityEdit
        };
        // PKCRpcClient will take care of zod parsing for us
        this._rpcPublishSubscriptionId = await pubNameToPublishFunction[this.getType()].bind(this._pkc._pkcRpcClient)(this.toJSONPubsubRequestToEncrypt());
        if (typeof this._rpcPublishSubscriptionId !== "number") {
            this._updatePublishingStateWithEmission("failed");
            await this._postSucessOrFailurePublishing();
            throw Error("Failed to find the type of publication");
        }
        this._pkc._pkcRpcClient
            .getSubscription(this._rpcPublishSubscriptionId)
            .on("challengerequest", this._handleIncomingChallengeRequestFromRpc.bind(this))
            .on("challenge", this._handleIncomingChallengeFromRpc.bind(this))
            .on("challengeanswer", this._handleIncomingChallengeAnswerFromRpc.bind(this))
            .on("challengeverification", this._handleIncomingChallengeVerificationFromRpc.bind(this))
            .on("publishingstatechange", this._handleIncomingPublishingStateFromRpc.bind(this))
            .on("statechange", this._handleIncomingStateFromRpc.bind(this))
            .on("error", this._handleIncomingErrorFromRpc.bind(this));
        this._pkc._pkcRpcClient.emitAllPendingMessages(this._rpcPublishSubscriptionId);
    }
    _changePublicationStateEmitEventEmitStateChangeEvent(opts) {
        // this code block is only called on a community whose update loop is already started
        // never called in a community that is mirroring a community with an update loop
        const shouldEmitStateChange = opts.newState && opts.newState !== this.state;
        const shouldEmitPublishingstatechange = opts.newPublishingState && opts.newPublishingState !== this.publishingState;
        if (opts.newState)
            this._setStateNoEmission(opts.newState);
        if (opts.newPublishingState)
            this._updatePublishingStateNoEmission(opts.newPublishingState);
        this.emit(opts.event.name, ...opts.event.args);
        if (shouldEmitStateChange)
            this.emit("statechange", this.state);
        if (shouldEmitPublishingstatechange)
            this.emit("publishingstatechange", this.publishingState);
    }
    async _signAndValidateChallengeRequestBeforePublishing(toSignMsg, pubsubSigner) {
        // No validation for now, we might add in the future
        return {
            ...toSignMsg,
            signature: await signChallengeRequest({ request: toSignMsg, signer: pubsubSigner })
        };
    }
    _didWeReceiveChallengeOrChallengeVerification() {
        return Object.values(this._challengeExchanges).some((exchange) => exchange.challenge || exchange.challengeVerification);
    }
    async _generateChallengeRequestToPublish(providerUrl, acceptedChallengeTypes) {
        const log = Logger("pkc-js:publication:publish:_generateChallengeRequestToPublish");
        const pubsubMessageSigner = await this._pkc.createSigner();
        const pubsubMsgToEncrypt = this.toJSONPubsubRequestToEncrypt();
        const encrypted = await encryptEd25519AesGcm(JSON.stringify(pubsubMsgToEncrypt), pubsubMessageSigner.privateKey, this._community.encryption.publicKey);
        const challengeRequestId = await getBufferedPKCAddressFromPublicKey(pubsubMessageSigner.publicKey);
        const toSignMsg = cleanUpBeforePublishing({
            type: "CHALLENGEREQUEST",
            encrypted,
            challengeRequestId,
            acceptedChallengeTypes,
            userAgent: this._pkc.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp()
        });
        const challengeRequest = await this._signAndValidateChallengeRequestBeforePublishing(toSignMsg, pubsubMessageSigner);
        log("Attempting to publish", this.getType(), "to pubsub topic", this._communityPubsubTopicWithFallback(), "with provider", providerUrl, "request.encrypted=", pubsubMsgToEncrypt);
        const decryptedChallengeRequest = { ...challengeRequest, ...pubsubMsgToEncrypt };
        this._challengeExchanges[challengeRequestId.toString()] = {
            challengeRequest: decryptedChallengeRequest,
            signer: pubsubMessageSigner,
            providerUrl
        };
        return challengeRequest;
    }
    async _initCommunity() {
        if (this._community)
            return;
        try {
            this._community = await this._fetchCommunityForPublishing();
            this._validateCommunityFields();
        }
        catch (e) {
            this._setStateWithEmission("stopped");
            this._updatePublishingStateWithEmission("failed");
            throw e;
        }
    }
    _challengeExchangesFormattedForErrors() {
        return Object.values(this._challengeExchanges).map((exchange) => ({
            ...exchange,
            timedoutWaitingForChallengeRequestResponse: !exchange.challengeVerification &&
                !exchange.challenge &&
                typeof exchange.challengeRequestPublishTimestamp === "number" &&
                exchange.challengeRequestPublishTimestamp + this._setProviderFailureThresholdSeconds <= timestamp()
        }));
    }
    async _handleNotReceivingResponseToChallengeRequest({ providers, currentPubsubProviderIndex, acceptedChallengeTypes }) {
        await new Promise((resolve) => setTimeout(resolve, this._publishToDifferentProviderThresholdSeconds * 1000));
        if (this._didWeReceiveChallengeOrChallengeVerification())
            return;
        // this provider did not get us a challenge or challenge verification
        const currentPubsubProvider = providers[currentPubsubProviderIndex];
        this._pkc._stats.recordGatewayFailure(currentPubsubProvider, "pubsub-publish");
        this._pkc._stats.recordGatewayFailure(currentPubsubProvider, "pubsub-subscribe");
        const log = Logger("pkc-js:publication:publish:_handleNotReceivingResponseToChallengeRequest");
        if (this._isAllAttemptsExhausted(providers.length)) {
            // pkc-js tried all providers and still no response is received
            log.error(`Failed to receive any response for publication`, this.getType());
            await this._postSucessOrFailurePublishing();
            const error = new PKCError("ERR_PUBSUB_DID_NOT_RECEIVE_RESPONSE_AFTER_PUBLISHING_CHALLENGE_REQUEST", {
                challengeExchanges: this._challengeExchangesFormattedForErrors(),
                publishToDifferentProviderThresholdSeconds: this._publishToDifferentProviderThresholdSeconds
            });
            this._changePublicationStateEmitEventEmitStateChangeEvent({
                newPublishingState: "failed",
                event: { name: "error", args: [error] }
            });
        }
        else if (this.state === "stopped") {
            log.error(`Publication is stopped, will not re-publish`);
            await this._postSucessOrFailurePublishing();
        }
        else {
            if (currentPubsubProviderIndex + 1 === providers.length) {
                log.error(`Failed to receive any response for publication`, this.getType(), "after publishing to all providers", providers);
                await this._postSucessOrFailurePublishing();
            }
            else {
                // let's publish to the next provider
                log(`Re-publishing publication after ${this._publishToDifferentProviderThresholdSeconds}s of not receiving challenge from provider (${currentPubsubProvider})`);
                currentPubsubProviderIndex += 1;
                while (!this._didWeReceiveChallengeOrChallengeVerification() && currentPubsubProviderIndex < providers.length) {
                    const providerUrl = providers[currentPubsubProviderIndex];
                    const challengeRequest = await this._generateChallengeRequestToPublish(providerUrl, acceptedChallengeTypes);
                    this._updatePublishingStateWithEmission("publishing-challenge-request");
                    this._updatePubsubState("subscribing-pubsub", providerUrl);
                    try {
                        await this._clientsManager.pubsubSubscribeOnProvider(this._communityPubsubTopicWithFallback(), this._handleChallengeExchange, providerUrl);
                        this._updatePubsubState("publishing-challenge-request", providerUrl);
                        await this._clientsManager.pubsubPublishOnProvider(this._communityPubsubTopicWithFallback(), challengeRequest, providerUrl);
                        this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishTimestamp =
                            timestamp();
                    }
                    catch (e) {
                        log.error("Failed to publish challenge request using provider ", providerUrl, e);
                        this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishError = e;
                        continue;
                    }
                    finally {
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
                    const allAttemptsFailedError = new PKCError("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS", {
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
    _getPubsubProviders() {
        const providers = this.clients.libp2pJsClients && remeda.keys.strict(this.clients.libp2pJsClients).length > 0
            ? remeda.keys.strict(this.clients.libp2pJsClients)
            : remeda.keys.strict(this.clients.pubsubKuboRpcClients);
        if (providers.length === 0)
            throw new PKCError("ERR_NO_PUBSUB_PROVIDERS_AVAILABLE_TO_PUBLISH_OVER_PUBSUB", { providers });
        if (providers.length === 1)
            providers.push(providers[0]); // Same provider should be retried twice if publishing fails
        return providers;
    }
    async _publishWithLocalCommunity(community, challengeRequest) {
        this._publishingToLocalCommunity = community;
        const log = Logger("pkc-js:publication:publish:_publishWithLocalCommunity");
        log("Community is local, will not publish over pubsub, and instead will publish directly to the community by accessing pkc._startedCommunities");
        const communityChallengeListener = async (challenge) => {
            if (challenge.challengeRequestId.toString() === challengeRequest.challengeRequestId.toString()) {
                // need to remove encrypted fields from challenge otherwise _handleIncomingChallengePubsubMessage will throw
                const encryptedFields = ["challenges"];
                log("Received a challenge from the local community", challenge);
                await this._handleIncomingChallengePubsubMessage(remeda.omit(challenge, encryptedFields));
            }
        };
        community.on("challenge", communityChallengeListener);
        const communityChallengeVerificationListener = async (decryptedChallengeVerification) => {
            if (decryptedChallengeVerification.challengeRequestId.toString() === challengeRequest.challengeRequestId.toString()) {
                log("Received a challenge verification from the local community", decryptedChallengeVerification);
                // need to remove publicatioon fields from challenge verification otherwise verifyChallengeVerification will throw
                const publicationFieldsToRemove = ["comment", "commentUpdate"];
                await this._handleIncomingChallengeVerificationPubsubMessage(remeda.omit(decryptedChallengeVerification, publicationFieldsToRemove));
            }
        };
        community.on("challengeverification", communityChallengeVerificationListener);
        this.emit("challengerequest", challengeRequest);
        community
            .handleChallengeRequest(challengeRequest, true)
            .then(() => {
            this._challengeExchanges[challengeRequest.challengeRequestId.toString()] = {
                ...this._challengeExchanges[challengeRequest.challengeRequestId.toString()],
                challengeRequestPublishTimestamp: timestamp()
            };
        })
            .catch((e) => {
            log.error("Failed to handle challenge request with local community", e);
            this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishError = e;
            throw e;
        })
            .finally(() => {
            community.removeListener("challenge", communityChallengeListener);
            community.removeListener("challengeverification", communityChallengeVerificationListener);
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
        if (this._pkc._pkcRpcClient)
            return this._publishWithRpc();
        const options = { acceptedChallengeTypes: [] };
        const providers = this._getPubsubProviders();
        const startedCommunity = findStartedCommunity(this._pkc, { address: this.communityAddress });
        if (startedCommunity) {
            return this._publishWithLocalCommunity(startedCommunity, await this._generateChallengeRequestToPublish("publishing directly to local community instance", options.acceptedChallengeTypes));
        }
        let currentPubsubProviderIndex = 0;
        while (!this._didWeReceiveChallengeOrChallengeVerification() && currentPubsubProviderIndex < providers.length) {
            const providerUrl = providers[currentPubsubProviderIndex];
            const challengeRequest = await this._generateChallengeRequestToPublish(providerUrl, options.acceptedChallengeTypes);
            this._updatePublishingStateWithEmission("publishing-challenge-request");
            this._updatePubsubState("subscribing-pubsub", providerUrl);
            try {
                // this will throw if we succeed in subscribing first attempt, but then fail to publish
                await this._clientsManager.pubsubSubscribeOnProvider(this._communityPubsubTopicWithFallback(), this._handleChallengeExchange, providerUrl);
                this._updatePubsubState("publishing-challenge-request", providerUrl);
                await this._clientsManager.pubsubPublishOnProvider(this._communityPubsubTopicWithFallback(), challengeRequest, providerUrl);
                this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishTimestamp = timestamp();
            }
            catch (e) {
                this._updatePubsubState("stopped", providerUrl);
                log.error("Failed to publish challenge request using provider ", providerUrl, e);
                currentPubsubProviderIndex += 1;
                this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequestPublishError = e;
                if (this._isAllAttemptsExhausted(providers.length)) {
                    await this._postSucessOrFailurePublishing();
                    const allAttemptsFailedError = new PKCError("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS", {
                        challengeExchanges: this._challengeExchangesFormattedForErrors(),
                        pubsubTopic: this._communityPubsubTopicWithFallback()
                    });
                    log.error("All attempts to publish", this.getType(), "has failed", allAttemptsFailedError);
                    this._changePublicationStateEmitEventEmitStateChangeEvent({
                        newPublishingState: "failed",
                        event: { name: "error", args: [allAttemptsFailedError] }
                    });
                    throw allAttemptsFailedError;
                }
                else
                    continue;
            }
            const decryptedRequest = this._challengeExchanges[challengeRequest.challengeRequestId.toString()].challengeRequest;
            this._updatePubsubState("waiting-challenge", providerUrl);
            this._updatePublishingStateWithEmission("waiting-challenge");
            log(`Published a challenge request of publication`, this.getType(), "with provider", providerUrl);
            this.emit("challengerequest", decryptedRequest);
            break;
        }
        // to handle cases where request is published but we didn't receive response within certain timeframe (20s for now)
        // Maybe the community didn't receive the request, or the provider did not relay the challenge from community for some reason
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
//# sourceMappingURL=publication.js.map