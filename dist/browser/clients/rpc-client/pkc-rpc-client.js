import Logger from "../../logger.js";
import { Client as WebSocketClient } from "rpc-websockets";
import assert from "assert";
import { PKCError } from "../../pkc-error.js";
import EventEmitter from "events";
import pTimeout from "p-timeout";
import { hideClassPrivateProps, replaceXWithY, resolveWhenPredicateIsTrue } from "../../util.js";
import { SubscriptionIdSchema } from "./schema.js";
import { parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails } from "../../schema/schema-util.js";
import { TypedEmitter } from "tiny-typed-emitter";
import { messages } from "../../errors.js";
import { parseRpcCommunityAddressParam, parseRpcCommunityLookupParam, parseRpcAuthorNameParam, parseRpcCidParam, parseRpcCommentRepliesPageParam, parseRpcCommunityPageParam } from "./rpc-schema-util.js";
const log = Logger("pkc-js:PKCRpcClient");
export default class PKCRpcClient extends TypedEmitter {
    constructor(rpcServerUrl) {
        super();
        this._pendingSubscriptionMsgs = {};
        assert(rpcServerUrl, "pkc.pkcRpcClientsOptions needs to be defined to create a new rpc client");
        this._websocketServerUrl = rpcServerUrl; // default to first for now. Will change later
        this._timeoutSeconds = 20;
        this.communities = [];
        this._subscriptionEvents = {};
        this.on("communitieschange", (newSubs) => {
            this.communities = newSubs;
        });
        this.on("settingschange", (newSettings) => {
            this.settings = newSettings;
        });
        // temporary place holder because we don't want to initialize the web socket client until we call
        //@ts-expect-error
        this._webSocketClient = {
            call: async (...args) => {
                await this._init();
                return this._webSocketClient.call(...args);
            }
        };
        hideClassPrivateProps(this);
        this.state = "stopped";
        this._destroyRequested = false;
    }
    setState(newState) {
        if (newState === this.state)
            return;
        this.state = newState;
        this.emit("statechange", this.state);
    }
    async _init() {
        const log = Logger("pkc-js:pkc-rpc-client:_init");
        if (this._destroyRequested)
            return;
        // wait for websocket connection to open
        let lastWebsocketError;
        if (!(this._webSocketClient instanceof WebSocketClient)) {
            this.setState("connecting");
            // Set up events here
            // save all subscription messages (ie json rpc messages without 'id', also called json rpc 'notifications')
            // NOTE: it is possible to receive a subscription message before receiving the subscription id
            this._webSocketClient = new WebSocketClient(this._websocketServerUrl);
            log("Created a new WebSocket instance with url " + this._websocketServerUrl);
            //@ts-expect-error
            this._webSocketClient.socket.on("message", (jsonMessage) => {
                const message = JSON.parse(jsonMessage);
                const subscriptionId = message?.params?.subscription;
                if (subscriptionId) {
                    this._initSubscriptionEvent(subscriptionId);
                    // We need to parse error props into PKCErrors
                    if (message?.params?.event === "error") {
                        message.params.result = this._deserializeRpcError(message.params.result);
                        delete message.params.result.stack; // Need to delete locally generated stack traces
                    }
                    if (this._subscriptionEvents[subscriptionId].listenerCount(message?.params?.event) === 0)
                        this._pendingSubscriptionMsgs[subscriptionId].push(message);
                    else
                        this._subscriptionEvents[subscriptionId].emit(message?.params?.event, message);
                }
            });
            this._webSocketClient.on("open", () => {
                log("Connected to RPC server", this._websocketServerUrl);
                this.setState("connected");
            });
            // forward errors to PKC
            this._webSocketClient.on("error", (error) => {
                lastWebsocketError = error;
                if (this._destroyRequested) {
                    log("Ignoring websocket error emitted after destroy request", error);
                    return;
                }
                // Detect HTTP 403 from server auth rejection
                const errorMessage = typeof error?.message === "string" ? error.message : "";
                if (errorMessage.includes("Unexpected server response: 403")) {
                    lastWebsocketError = new PKCError("ERR_RPC_AUTH_REQUIRED", {
                        rpcServerUrl: this._websocketServerUrl
                    });
                    this._webSocketClient.setAutoReconnect(false);
                    this.emit("error", lastWebsocketError);
                    this.setState("failed");
                    return;
                }
                this.emit("error", error);
            });
            this._webSocketClient.on("close", () => {
                log.error("connection with web socket has been closed", this._websocketServerUrl);
                this._openConnectionPromise = undefined;
                this.setState("stopped");
            });
            // Process error JSON from server into a PKCError instance
            const originalWebsocketCall = this._webSocketClient.call.bind(this._webSocketClient);
            this._webSocketClient.call = async (...args) => {
                try {
                    await this._init();
                    return await originalWebsocketCall(...args);
                }
                catch (e) {
                    const typedError = e;
                    //e is an error json representation of PKCError
                    //@ts-expect-error
                    typedError.details = { ...typedError.details, rpcArgs: args, rpcServerUrl: this._websocketServerUrl };
                    throw typedError;
                }
            };
        }
        // @ts-expect-error
        if (this._webSocketClient.ready)
            return;
        if (!this._openConnectionPromise)
            this._openConnectionPromise = pTimeout(resolveWhenPredicateIsTrue({
                toUpdate: this,
                predicate: () => {
                    if (this.state === "connected")
                        return true;
                    if (lastWebsocketError instanceof PKCError)
                        throw lastWebsocketError;
                    return false;
                },
                eventName: "statechange"
            }), {
                milliseconds: this._timeoutSeconds * 1000
            });
        try {
            await this._openConnectionPromise;
        }
        catch (e) {
            if (this._destroyRequested) {
                log("Aborted RPC connection before it finished opening because destroy was requested", this._websocketServerUrl);
                return;
            }
            const err = e instanceof PKCError
                ? e
                : new PKCError("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC", {
                    timeoutSeconds: this._timeoutSeconds,
                    error: lastWebsocketError,
                    rpcServerUrl: this._websocketServerUrl
                });
            this.setState("failed");
            this.emit("error", err);
            throw err;
        }
    }
    async destroy() {
        if (this._destroyRequested)
            return;
        this._destroyRequested = true;
        const cleanupSubscriptionLocally = (subscriptionId) => {
            delete this._subscriptionEvents[subscriptionId];
            delete this._pendingSubscriptionMsgs[subscriptionId];
        };
        for (const subscriptionId of Object.keys(this._subscriptionEvents))
            try {
                if (this.state === "connected") {
                    await this.unsubscribe(Number(subscriptionId));
                }
                else
                    cleanupSubscriptionLocally(subscriptionId);
            }
            catch (e) {
                log.error("Failed to unsubscribe to subscription ID", subscriptionId, e);
                cleanupSubscriptionLocally(subscriptionId);
            }
        try {
            if (this._webSocketClient instanceof WebSocketClient) {
                this._webSocketClient.setAutoReconnect(false);
                this._webSocketClient.close();
            }
        }
        catch (e) {
            log.error("Failed to close websocket", e);
        }
        this._openConnectionPromise = undefined;
        this.setState("stopped");
    }
    toJSON() {
        return undefined;
    }
    getSubscription(subscriptionId) {
        if (!this._subscriptionEvents[subscriptionId])
            throw Error(`No subscription to RPC with id (${subscriptionId})`);
        else
            return this._subscriptionEvents[subscriptionId];
    }
    async unsubscribe(subscriptionId) {
        await this._webSocketClient.call("unsubscribe", [{ subscriptionId }]);
        if (this._subscriptionEvents[subscriptionId])
            this._subscriptionEvents[subscriptionId].removeAllListeners();
        delete this._subscriptionEvents[subscriptionId];
        delete this._pendingSubscriptionMsgs[subscriptionId];
    }
    _deserializeRpcError(errorPayload) {
        if (!errorPayload || typeof errorPayload !== "object") {
            const genericError = new Error("Received malformed RPC error payload");
            genericError.details = { rawError: errorPayload };
            return genericError;
        }
        const { code, details, message, name, ...rest } = errorPayload;
        const hasValidCode = typeof code === "string" && Object.prototype.hasOwnProperty.call(messages, code);
        const serverMessage = typeof message === "string" && message.length > 0 ? message : "RPC server returned an unknown error";
        if (hasValidCode) {
            const pkcError = new PKCError(code, details);
            this._setErrorName(pkcError, name);
            this._assignAdditionalProps(pkcError, rest);
            return pkcError;
        }
        if (typeof code === "string" && typeof name === "string" && name === "PKCError") {
            const pkcError = new PKCError("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC", details);
            pkcError.code = code;
            pkcError.message = serverMessage;
            this._setErrorName(pkcError, name);
            this._assignAdditionalProps(pkcError, rest);
            return pkcError;
        }
        const genericError = new Error(serverMessage);
        genericError.name = typeof name === "string" && name.length > 0 ? name : genericError.name;
        genericError.code = code;
        genericError.details = details;
        this._assignAdditionalProps(genericError, rest);
        return genericError;
    }
    _setErrorName(target, name) {
        if (typeof name !== "string" || name.length === 0 || target.name === name)
            return;
        const descriptor = Object.getOwnPropertyDescriptor(target, "name");
        try {
            if (descriptor)
                Object.defineProperty(target, "name", { ...descriptor, value: name });
            else
                target.name = name;
        }
        catch {
            // Ignore failures to redefine the property
        }
    }
    _assignAdditionalProps(target, rest) {
        if (rest && Object.keys(rest).length > 0)
            Object.assign(target, rest);
    }
    emitAllPendingMessages(subscriptionId) {
        this._pendingSubscriptionMsgs[subscriptionId].forEach((message) => this._subscriptionEvents[subscriptionId].emit(message?.params?.event, message));
        delete this._pendingSubscriptionMsgs[subscriptionId];
    }
    async getComment(args) {
        const parsedGetCommentArgs = parseRpcCidParam(args);
        const commentProps = await this._webSocketClient.call("getComment", [parsedGetCommentArgs]);
        return commentProps;
    }
    async getCommentPage(page) {
        const parsedGetCommentRepliesPageArgs = parseRpcCommentRepliesPageParam(page);
        const result = await this._webSocketClient.call("getCommentPage", [parsedGetCommentRepliesPageArgs]);
        return result;
    }
    async getCommunityPage(page) {
        const parsedGetCommunityPostsPage = parseRpcCommunityPageParam(page);
        const result = await this._webSocketClient.call("getCommunityPage", [parsedGetCommunityPostsPage]);
        return result;
    }
    async createCommunity(createCommunityOptions) {
        // This is gonna create a new local community. Not an instance of an existing community
        const communityProps = (await this._webSocketClient.call("createCommunity", [createCommunityOptions]));
        return communityProps;
    }
    _initSubscriptionEvent(subscriptionId) {
        if (!this._subscriptionEvents[subscriptionId])
            this._subscriptionEvents[subscriptionId] = new EventEmitter();
        if (!this._pendingSubscriptionMsgs[subscriptionId])
            this._pendingSubscriptionMsgs[subscriptionId] = [];
    }
    async startCommunity(communityAddress) {
        const parsedStartCommunityArgs = parseRpcCommunityAddressParam(communityAddress);
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("startCommunity", [parsedStartCommunityArgs]));
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }
    async stopCommunity(communityAddress) {
        const parsedStopCommunityArgs = parseRpcCommunityAddressParam(communityAddress);
        const res = await this._webSocketClient.call("stopCommunity", [parsedStopCommunityArgs]);
        if (res !== true)
            throw Error("Calling RPC function should throw or return true");
    }
    async editCommunity(communityAddress, communityEditOptions) {
        const propsAfterReplacing = replaceXWithY(communityEditOptions, undefined, null);
        const rawRes = (await this._webSocketClient.call("editCommunity", [{ address: communityAddress, editOptions: propsAfterReplacing }]));
        return rawRes;
    }
    async deleteCommunity(communityAddress) {
        const parsedDeleteCommunityArgs = parseRpcCommunityAddressParam(communityAddress);
        const res = await this._webSocketClient.call("deleteCommunity", [parsedDeleteCommunityArgs]);
        if (res !== true)
            throw Error("Calling RPC function deleteCommunity should either return true or throw");
    }
    async communityUpdateSubscribe(communityAddress) {
        const parsedCommunityUpdateArgs = parseRpcCommunityLookupParam(communityAddress);
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("communityUpdateSubscribe", [parsedCommunityUpdateArgs]));
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }
    async publishComment(commentProps) {
        const publishRes = await this._webSocketClient.call("publishComment", [commentProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }
    async publishCommentEdit(commentEditProps) {
        const publishRes = await this._webSocketClient.call("publishCommentEdit", [commentEditProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }
    async publishCommentModeration(commentModProps) {
        const publishRes = await this._webSocketClient.call("publishCommentModeration", [commentModProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }
    async publishVote(voteProps) {
        const publishRes = await this._webSocketClient.call("publishVote", [voteProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }
    async publishCommunityEdit(communityEdit) {
        const publishRes = await this._webSocketClient.call("publishCommunityEdit", [communityEdit]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }
    async commentUpdateSubscribe(args) {
        const parsedCommentUpdateArgs = parseRpcCidParam(args);
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("commentUpdateSubscribe", [parsedCommentUpdateArgs]));
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }
    async publishChallengeAnswers(subscriptionId, challengeAnswers) {
        const parsedId = SubscriptionIdSchema.parse(subscriptionId);
        const res = await this._webSocketClient.call("publishChallengeAnswers", [{ subscriptionId: parsedId, challengeAnswers }]);
        if (res !== true)
            throw Error("RPC function publishChallengeAnswers should either return true or throw");
        return res;
    }
    async resolveAuthorName(parsedAuthorAddress) {
        const resolveAuthorAddressArgs = parseRpcAuthorNameParam(parsedAuthorAddress);
        const res = await this._webSocketClient.call("resolveAuthorName", [resolveAuthorAddressArgs]);
        if (typeof res?.resolvedAddress !== "string" && res?.resolvedAddress !== null)
            throw Error("RPC function resolveAuthorName should respond with { resolvedAddress: string | null }");
        return res.resolvedAddress;
    }
    async initalizeCommunitieschangeEvent() {
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("communitiesSubscribe", []));
        this._initSubscriptionEvent(subscriptionId);
        this.getSubscription(subscriptionId).on("communitieschange", (res) => {
            this.emit("communitieschange", res.params.result.communities);
        });
        this.emitAllPendingMessages(subscriptionId);
    }
    async initalizeSettingschangeEvent() {
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("settingsSubscribe", []));
        this._initSubscriptionEvent(subscriptionId);
        this.getSubscription(subscriptionId).on("settingschange", (res) => {
            this.emit("settingschange", res.params.result);
        });
        this.emitAllPendingMessages(subscriptionId);
    }
    async fetchCid(args) {
        const parsedFetchCidArgs = parseRpcCidParam(args);
        const res = await this._webSocketClient.call("fetchCid", [parsedFetchCidArgs]);
        if (typeof res?.content !== "string")
            throw Error("RPC function fetchCid did not respond with { content: string }");
        return res.content;
    }
    async setSettings(settings) {
        const parsedSettings = parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(settings);
        const res = await this._webSocketClient.call("setSettings", [parsedSettings]);
        if (res !== true)
            throw Error("Failed setSettings");
        return res;
    }
    async rpcCall(method, params) {
        // This function can be used to call any function on the rpc server
        const res = await this._webSocketClient.call(method, params);
        return res;
    }
    async getDefaults() {
        throw Error("Not implemented");
    }
    async getPeers() {
        throw Error("Not implemented");
    }
    async getStats() {
        throw Error("Not implemented");
    }
}
//# sourceMappingURL=pkc-rpc-client.js.map