import Logger from "../../logger.js";
import { Client as WebSocketClient } from "rpc-websockets";
import assert from "assert";
import { PKCError } from "../../pkc-error.js";
import EventEmitter from "events";
import pTimeout from "p-timeout";
import { hideClassPrivateProps, replaceXWithY, resolveWhenPredicateIsTrue } from "../../util.js";
import type {
    CreateNewLocalCommunityUserOptions,
    RpcInternalCommunityRecordBeforeFirstUpdateType,
    CommunityEditOptions,
    RpcLocalCommunityUpdateResultType
} from "../../community/types.js";
import type { ModQueuePageIpfs, PageIpfs } from "../../pages/types.js";
import type { PageRuntimeFields } from "../../pages/util.js";
import { SubscriptionIdSchema } from "./schema.js";
import type { DecryptedChallengeAnswer, DecryptedChallengeRequest } from "../../pubsub-messages/types.js";
import type { PKCWsServerSettingsSerialized } from "../../rpc/src/types.js";
import { parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails } from "../../schema/schema-util.js";
import { ZodError } from "zod";
import type { CommentIpfsType } from "../../publications/comment/types.js";
import { SetNewSettingsPKCWsServerSchema } from "../../rpc/src/schema.js";
import * as z from "zod";
import { TypedEmitter } from "tiny-typed-emitter";
import type { PKCRpcClientEvents } from "../../types.js";
import type { RpcPublishResult } from "../../publications/types.js";
import { messages } from "../../errors.js";
import type {
    CommunityAddressRpcParam,
    CommunityLookupRpcParam,
    CidRpcParam,
    CommentPageRpcParam,
    CommunityPageRpcParam
} from "./types.js";
import {
    parseRpcCommunityAddressParam,
    parseRpcCommunityLookupParam,
    parseRpcAuthorNameParam,
    parseRpcCidParam,
    parseRpcCommentRepliesPageParam,
    parseRpcCommunityPageParam
} from "./rpc-schema-util.js";

const log = Logger("pkc-js:PKCRpcClient");

export default class PKCRpcClient extends TypedEmitter<PKCRpcClientEvents> {
    state: "stopped" | "connecting" | "failed" | "connected";
    communities: string[];
    settings?: PKCWsServerSettingsSerialized;

    private _webSocketClient: WebSocketClient;
    private _websocketServerUrl: string;
    private _subscriptionEvents: Record<string, EventEmitter>; // subscription ID -> event emitter
    private _pendingSubscriptionMsgs: Record<string, any[]> = {};
    private _timeoutSeconds: number;
    private _openConnectionPromise?: Promise<any>;
    private _destroyRequested: boolean;
    constructor(rpcServerUrl: string) {
        super();
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

    setState(newState: PKCRpcClient["state"]) {
        if (newState === this.state) return;
        this.state = newState;
        this.emit("statechange", this.state);
    }

    async _init() {
        const log = Logger("pkc-js:pkc-rpc-client:_init");
        if (this._destroyRequested) return;
        // wait for websocket connection to open
        let lastWebsocketError: Error | undefined;
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
                        delete (<any>message.params.result).stack; // Need to delete locally generated stack traces
                    }
                    if (this._subscriptionEvents[subscriptionId].listenerCount(message?.params?.event) === 0)
                        this._pendingSubscriptionMsgs[subscriptionId].push(message);
                    else this._subscriptionEvents[subscriptionId].emit(message?.params?.event, message);
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
                } catch (e) {
                    const typedError = <PKCError | { code: number; message: string } | Error | ZodError>e;
                    //e is an error json representation of PKCError
                    //@ts-expect-error
                    typedError.details = { ...typedError.details, rpcArgs: args, rpcServerUrl: this._websocketServerUrl };

                    throw typedError;
                }
            };
        }
        // @ts-expect-error
        if (this._webSocketClient.ready) return;
        if (!this._openConnectionPromise)
            this._openConnectionPromise = pTimeout(
                resolveWhenPredicateIsTrue({
                    toUpdate: this,
                    predicate: () => {
                        if (this.state === "connected") return true;
                        if (lastWebsocketError instanceof PKCError) throw lastWebsocketError;
                        return false;
                    },
                    eventName: "statechange"
                }),
                {
                    milliseconds: this._timeoutSeconds * 1000
                }
            );

        try {
            await this._openConnectionPromise;
        } catch (e) {
            if (this._destroyRequested) {
                log("Aborted RPC connection before it finished opening because destroy was requested", this._websocketServerUrl);
                return;
            }
            const err =
                e instanceof PKCError
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
        if (this._destroyRequested) return;
        this._destroyRequested = true;
        const cleanupSubscriptionLocally = (subscriptionId: string) => {
            delete this._subscriptionEvents[subscriptionId];
            delete this._pendingSubscriptionMsgs[subscriptionId];
        };
        for (const subscriptionId of Object.keys(this._subscriptionEvents))
            try {
                if (this.state === "connected") {
                    await this.unsubscribe(Number(subscriptionId));
                } else cleanupSubscriptionLocally(subscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe to subscription ID", subscriptionId, e);
                cleanupSubscriptionLocally(subscriptionId);
            }

        try {
            if (this._webSocketClient instanceof WebSocketClient) {
                this._webSocketClient.setAutoReconnect(false);
                this._webSocketClient.close();
            }
        } catch (e) {
            log.error("Failed to close websocket", e);
        }

        this._openConnectionPromise = undefined;
        this.setState("stopped");
    }

    toJSON() {
        return undefined;
    }

    getSubscription(subscriptionId: number) {
        if (!this._subscriptionEvents[subscriptionId]) throw Error(`No subscription to RPC with id (${subscriptionId})`);
        else return this._subscriptionEvents[subscriptionId];
    }

    async unsubscribe(subscriptionId: number) {
        await this._webSocketClient.call("unsubscribe", [{ subscriptionId }]);
        if (this._subscriptionEvents[subscriptionId]) this._subscriptionEvents[subscriptionId].removeAllListeners();
        delete this._subscriptionEvents[subscriptionId];
        delete this._pendingSubscriptionMsgs[subscriptionId];
    }

    private _deserializeRpcError(errorPayload: any): PKCError | Error {
        if (!errorPayload || typeof errorPayload !== "object") {
            const genericError = new Error("Received malformed RPC error payload");
            (<any>genericError).details = { rawError: errorPayload };
            return genericError;
        }

        const { code, details, message, name, ...rest } = errorPayload as {
            code?: unknown;
            details?: unknown;
            message?: unknown;
            name?: unknown;
        };
        const hasValidCode = typeof code === "string" && Object.prototype.hasOwnProperty.call(messages, code);
        const serverMessage =
            typeof message === "string" && message.length > 0 ? (message as string) : "RPC server returned an unknown error";

        if (hasValidCode) {
            const pkcError = new PKCError(code as keyof typeof messages, details);
            this._setErrorName(pkcError, name);
            this._assignAdditionalProps(pkcError, rest);
            return pkcError;
        }

        if (typeof code === "string" && typeof name === "string" && name === "PKCError") {
            const pkcError = new PKCError("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC", details);
            (<any>pkcError).code = code;
            (<any>pkcError).message = serverMessage;
            this._setErrorName(pkcError, name);
            this._assignAdditionalProps(pkcError, rest);
            return pkcError;
        }

        const genericError = new Error(serverMessage);
        genericError.name = typeof name === "string" && name.length > 0 ? (name as string) : genericError.name;
        (<any>genericError).code = code;
        (<any>genericError).details = details;
        this._assignAdditionalProps(genericError, rest);
        return genericError;
    }

    private _setErrorName(target: PKCError | Error, name?: unknown) {
        if (typeof name !== "string" || name.length === 0 || target.name === name) return;
        const descriptor = Object.getOwnPropertyDescriptor(target, "name");
        try {
            if (descriptor) Object.defineProperty(target, "name", { ...descriptor, value: name });
            else target.name = name;
        } catch {
            // Ignore failures to redefine the property
        }
    }

    private _assignAdditionalProps(target: PKCError | Error, rest: Record<string, unknown>) {
        if (rest && Object.keys(rest).length > 0) Object.assign(target, rest);
    }

    emitAllPendingMessages(subscriptionId: number) {
        this._pendingSubscriptionMsgs[subscriptionId].forEach((message) =>
            this._subscriptionEvents[subscriptionId].emit(message?.params?.event, message)
        );
        delete this._pendingSubscriptionMsgs[subscriptionId];
    }

    async getComment(args: CidRpcParam): Promise<CommentIpfsType> {
        const parsedGetCommentArgs = parseRpcCidParam(args);
        const commentProps = <CommentIpfsType>await this._webSocketClient.call("getComment", [parsedGetCommentArgs]);
        return commentProps;
    }

    async getCommentPage(page: CommentPageRpcParam): Promise<{ page: PageIpfs; runtimeFields?: PageRuntimeFields }> {
        const parsedGetCommentRepliesPageArgs = parseRpcCommentRepliesPageParam(page);
        const result = await this._webSocketClient.call("getCommentPage", [parsedGetCommentRepliesPageArgs]);
        return result as { page: PageIpfs; runtimeFields?: PageRuntimeFields };
    }

    async getCommunityPage(page: CommunityPageRpcParam): Promise<{ page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const parsedGetCommunityPostsPage = parseRpcCommunityPageParam(page);
        const result = await this._webSocketClient.call("getCommunityPage", [parsedGetCommunityPostsPage]);
        return result as { page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields };
    }

    async createCommunity(
        createCommunityOptions: CreateNewLocalCommunityUserOptions
    ): Promise<RpcInternalCommunityRecordBeforeFirstUpdateType> {
        // This is gonna create a new local sub. Not an instance of an existing sub
        const subProps = <RpcInternalCommunityRecordBeforeFirstUpdateType>(
            await this._webSocketClient.call("createCommunity", [createCommunityOptions])
        );
        return subProps;
    }

    private _initSubscriptionEvent(subscriptionId: number) {
        if (!this._subscriptionEvents[subscriptionId]) this._subscriptionEvents[subscriptionId] = new EventEmitter();
        if (!this._pendingSubscriptionMsgs[subscriptionId]) this._pendingSubscriptionMsgs[subscriptionId] = [];
    }

    async startCommunity(communityAddress: CommunityAddressRpcParam) {
        const parsedStartCommunityArgs = parseRpcCommunityAddressParam(communityAddress);
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("startCommunity", [parsedStartCommunityArgs]));
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }

    async stopCommunity(communityAddress: CommunityAddressRpcParam): Promise<void> {
        const parsedStopCommunityArgs = parseRpcCommunityAddressParam(communityAddress);

        const res = await this._webSocketClient.call("stopCommunity", [parsedStopCommunityArgs]);
        if (res !== true) throw Error("Calling RPC function should throw or return true");
    }

    async editCommunity(communityAddress: string, communityEditOptions: CommunityEditOptions): Promise<RpcLocalCommunityUpdateResultType> {
        const propsAfterReplacing = replaceXWithY(communityEditOptions, undefined, null);
        const rawRes = <RpcLocalCommunityUpdateResultType>(
            await this._webSocketClient.call("editCommunity", [{ address: communityAddress, editOptions: propsAfterReplacing }])
        );
        return rawRes;
    }

    async deleteCommunity(communityAddress: CommunityAddressRpcParam) {
        const parsedDeleteCommunityArgs = parseRpcCommunityAddressParam(communityAddress);
        const res = await this._webSocketClient.call("deleteCommunity", [parsedDeleteCommunityArgs]);
        if (res !== true) throw Error("Calling RPC function deleteCommunity should either return true or throw");
    }

    async communityUpdateSubscribe(communityAddress: CommunityLookupRpcParam): Promise<number> {
        const parsedCommunityUpdateArgs = parseRpcCommunityLookupParam(communityAddress);
        const subscriptionId = SubscriptionIdSchema.parse(
            await this._webSocketClient.call("communityUpdateSubscribe", [parsedCommunityUpdateArgs])
        );
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }

    async publishComment(commentProps: DecryptedChallengeRequest): Promise<RpcPublishResult> {
        const publishRes = <RpcPublishResult>await this._webSocketClient.call("publishComment", [commentProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }

    async publishCommentEdit(commentEditProps: DecryptedChallengeRequest): Promise<RpcPublishResult> {
        const publishRes = <RpcPublishResult>await this._webSocketClient.call("publishCommentEdit", [commentEditProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }

    async publishCommentModeration(commentModProps: DecryptedChallengeRequest): Promise<RpcPublishResult> {
        const publishRes = <RpcPublishResult>await this._webSocketClient.call("publishCommentModeration", [commentModProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }

    async publishVote(voteProps: DecryptedChallengeRequest): Promise<RpcPublishResult> {
        const publishRes = <RpcPublishResult>await this._webSocketClient.call("publishVote", [voteProps]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }

    async publishCommunityEdit(communityEdit: DecryptedChallengeRequest): Promise<RpcPublishResult> {
        const publishRes = <RpcPublishResult>await this._webSocketClient.call("publishCommunityEdit", [communityEdit]);
        this._initSubscriptionEvent(publishRes);
        return publishRes;
    }

    async commentUpdateSubscribe(args: CidRpcParam) {
        const parsedCommentUpdateArgs = parseRpcCidParam(args);
        const subscriptionId = SubscriptionIdSchema.parse(
            await this._webSocketClient.call("commentUpdateSubscribe", [parsedCommentUpdateArgs])
        );
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }

    async publishChallengeAnswers(subscriptionId: number, challengeAnswers: DecryptedChallengeAnswer["challengeAnswers"]) {
        const parsedId = SubscriptionIdSchema.parse(subscriptionId);
        const res = <boolean>await this._webSocketClient.call("publishChallengeAnswers", [{ subscriptionId: parsedId, challengeAnswers }]);
        if (res !== true) throw Error("RPC function publishChallengeAnswers should either return true or throw");
        return res;
    }

    async resolveAuthorName(parsedAuthorAddress: CommunityAddressRpcParam) {
        const resolveAuthorAddressArgs = parseRpcAuthorNameParam(parsedAuthorAddress);
        const res = <{ resolvedAddress: string | null }>await this._webSocketClient.call("resolveAuthorName", [resolveAuthorAddressArgs]);
        if (typeof res?.resolvedAddress !== "string" && res?.resolvedAddress !== null)
            throw Error("RPC function resolveAuthorName should respond with { resolvedAddress: string | null }");
        return res.resolvedAddress;
    }

    async initalizeCommunitieschangeEvent() {
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("communitiesSubscribe", []));
        this._initSubscriptionEvent(subscriptionId);
        this.getSubscription(subscriptionId).on("communitieschange", (res) => {
            this.emit("communitieschange", <string[]>res.params.result.communities);
        });
        this.emitAllPendingMessages(subscriptionId);
    }

    async initalizeSettingschangeEvent() {
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("settingsSubscribe", []));
        this._initSubscriptionEvent(subscriptionId);
        this.getSubscription(subscriptionId).on("settingschange", (res) => {
            this.emit("settingschange", <PKCWsServerSettingsSerialized>res.params.result);
        });
        this.emitAllPendingMessages(subscriptionId);
    }

    async fetchCid(args: CidRpcParam): Promise<string> {
        const parsedFetchCidArgs = parseRpcCidParam(args);
        const res = <{ content: string }>await this._webSocketClient.call("fetchCid", [parsedFetchCidArgs]);
        if (typeof res?.content !== "string") throw Error("RPC function fetchCid did not respond with { content: string }");
        return res.content;
    }

    async setSettings(settings: z.input<typeof SetNewSettingsPKCWsServerSchema>) {
        const parsedSettings = parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(settings);
        const res = <boolean>await this._webSocketClient.call("setSettings", [parsedSettings]);
        if (res !== true) throw Error("Failed setSettings");
        return res;
    }

    async rpcCall(method: string, params: any[]): Promise<any> {
        // This function can be used to call any function on the rpc server
        const res = <any>await this._webSocketClient.call(method, params);
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
