import Logger from "../../logger.js";
import { Client as WebSocketClient } from "rpc-websockets";
import assert from "assert";
import { PlebbitError } from "../../plebbit-error.js";
import EventEmitter from "events";
import pTimeout from "p-timeout";
import { hideClassPrivateProps, replaceXWithY, resolveWhenPredicateIsTrue } from "../../util.js";
import type {
    CreateNewLocalSubplebbitUserOptions,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType,
    SubplebbitEditOptions,
    RpcLocalSubplebbitUpdateResultType
} from "../../subplebbit/types.js";
import type { ModQueuePageIpfs, PageIpfs } from "../../pages/types.js";
import type { PageRuntimeFields } from "../../pages/util.js";
import { SubscriptionIdSchema } from "./schema.js";
import type { DecryptedChallengeAnswer, DecryptedChallengeRequest } from "../../pubsub-messages/types.js";
import type { PlebbitWsServerSettingsSerialized } from "../../rpc/src/types.js";
import { parseSetNewSettingsPlebbitWsServerSchemaWithPlebbitErrorIfItFails } from "../../schema/schema-util.js";
import { ZodError } from "zod";
import type { CommentIpfsType } from "../../publications/comment/types.js";
import { SetNewSettingsPlebbitWsServerSchema } from "../../rpc/src/schema.js";
import * as z from "zod";
import { TypedEmitter } from "tiny-typed-emitter";
import type { PlebbitRpcClientEvents } from "../../types.js";
import type { RpcPublishResult } from "../../publications/types.js";
import { messages } from "../../errors.js";
import type {
    SubplebbitAddressRpcParam,
    SubplebbitLookupRpcParam,
    CidRpcParam,
    CommentPageRpcParam,
    SubplebbitPageRpcParam
} from "./types.js";
import {
    parseRpcSubplebbitAddressParam,
    parseRpcSubplebbitLookupParam,
    parseRpcAuthorNameParam,
    parseRpcCidParam,
    parseRpcCommentRepliesPageParam,
    parseRpcSubplebbitPageParam
} from "./rpc-schema-util.js";

const log = Logger("pkc-js:PlebbitRpcClient");

export default class PlebbitRpcClient extends TypedEmitter<PlebbitRpcClientEvents> {
    state: "stopped" | "connecting" | "failed" | "connected";
    subplebbits: string[];
    settings?: PlebbitWsServerSettingsSerialized;

    private _webSocketClient: WebSocketClient;
    private _websocketServerUrl: string;
    private _subscriptionEvents: Record<string, EventEmitter>; // subscription ID -> event emitter
    private _pendingSubscriptionMsgs: Record<string, any[]> = {};
    private _timeoutSeconds: number;
    private _openConnectionPromise?: Promise<any>;
    private _destroyRequested: boolean;
    constructor(rpcServerUrl: string) {
        super();
        assert(rpcServerUrl, "plebbit.plebbitRpcClientsOptions needs to be defined to create a new rpc client");

        this._websocketServerUrl = rpcServerUrl; // default to first for now. Will change later
        this._timeoutSeconds = 20;
        this.subplebbits = [];
        this._subscriptionEvents = {};

        this.on("subplebbitschange", (newSubs) => {
            this.subplebbits = newSubs;
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

    setState(newState: PlebbitRpcClient["state"]) {
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

                    // We need to parse error props into PlebbitErrors
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
            // forward errors to Plebbit
            this._webSocketClient.on("error", (error) => {
                lastWebsocketError = error;
                if (this._destroyRequested) {
                    log("Ignoring websocket error emitted after destroy request", error);
                    return;
                }
                // Detect HTTP 403 from server auth rejection
                const errorMessage = typeof error?.message === "string" ? error.message : "";
                if (errorMessage.includes("Unexpected server response: 403")) {
                    lastWebsocketError = new PlebbitError("ERR_RPC_AUTH_REQUIRED", {
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

            // Process error JSON from server into a PlebbitError instance
            const originalWebsocketCall = this._webSocketClient.call.bind(this._webSocketClient);

            this._webSocketClient.call = async (...args) => {
                try {
                    await this._init();
                    return await originalWebsocketCall(...args);
                } catch (e) {
                    const typedError = <PlebbitError | { code: number; message: string } | Error | ZodError>e;
                    //e is an error json representation of PlebbitError
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
                        if (lastWebsocketError instanceof PlebbitError) throw lastWebsocketError;
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
                e instanceof PlebbitError
                    ? e
                    : new PlebbitError("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC", {
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

    private _deserializeRpcError(errorPayload: any): PlebbitError | Error {
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
            const plebbitError = new PlebbitError(code as keyof typeof messages, details);
            this._setErrorName(plebbitError, name);
            this._assignAdditionalProps(plebbitError, rest);
            return plebbitError;
        }

        if (typeof code === "string" && typeof name === "string" && name === "PlebbitError") {
            const plebbitError = new PlebbitError("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC", details);
            (<any>plebbitError).code = code;
            (<any>plebbitError).message = serverMessage;
            this._setErrorName(plebbitError, name);
            this._assignAdditionalProps(plebbitError, rest);
            return plebbitError;
        }

        const genericError = new Error(serverMessage);
        genericError.name = typeof name === "string" && name.length > 0 ? (name as string) : genericError.name;
        (<any>genericError).code = code;
        (<any>genericError).details = details;
        this._assignAdditionalProps(genericError, rest);
        return genericError;
    }

    private _setErrorName(target: PlebbitError | Error, name?: unknown) {
        if (typeof name !== "string" || name.length === 0 || target.name === name) return;
        const descriptor = Object.getOwnPropertyDescriptor(target, "name");
        try {
            if (descriptor) Object.defineProperty(target, "name", { ...descriptor, value: name });
            else target.name = name;
        } catch {
            // Ignore failures to redefine the property
        }
    }

    private _assignAdditionalProps(target: PlebbitError | Error, rest: Record<string, unknown>) {
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

    async getSubplebbitPage(
        page: SubplebbitPageRpcParam
    ): Promise<{ page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields }> {
        const parsedGetSubplebbitPostsPage = parseRpcSubplebbitPageParam(page);
        const result = await this._webSocketClient.call("getSubplebbitPage", [parsedGetSubplebbitPostsPage]);
        return result as { page: PageIpfs | ModQueuePageIpfs; runtimeFields?: PageRuntimeFields };
    }

    async createSubplebbit(
        createSubplebbitOptions: CreateNewLocalSubplebbitUserOptions
    ): Promise<RpcInternalSubplebbitRecordBeforeFirstUpdateType> {
        // This is gonna create a new local sub. Not an instance of an existing sub
        const subProps = <RpcInternalSubplebbitRecordBeforeFirstUpdateType>(
            await this._webSocketClient.call("createSubplebbit", [createSubplebbitOptions])
        );
        return subProps;
    }

    private _initSubscriptionEvent(subscriptionId: number) {
        if (!this._subscriptionEvents[subscriptionId]) this._subscriptionEvents[subscriptionId] = new EventEmitter();
        if (!this._pendingSubscriptionMsgs[subscriptionId]) this._pendingSubscriptionMsgs[subscriptionId] = [];
    }

    async startSubplebbit(subplebbitAddress: SubplebbitAddressRpcParam) {
        const parsedStartSubplebbitArgs = parseRpcSubplebbitAddressParam(subplebbitAddress);
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("startSubplebbit", [parsedStartSubplebbitArgs]));
        this._initSubscriptionEvent(subscriptionId);
        return subscriptionId;
    }

    async stopSubplebbit(subplebbitAddress: SubplebbitAddressRpcParam): Promise<void> {
        const parsedStopSubplebbitArgs = parseRpcSubplebbitAddressParam(subplebbitAddress);

        const res = await this._webSocketClient.call("stopSubplebbit", [parsedStopSubplebbitArgs]);
        if (res !== true) throw Error("Calling RPC function should throw or return true");
    }

    async editSubplebbit(
        subplebbitAddress: string,
        subplebbitEditOptions: SubplebbitEditOptions
    ): Promise<RpcLocalSubplebbitUpdateResultType> {
        const propsAfterReplacing = replaceXWithY(subplebbitEditOptions, undefined, null);
        const rawRes = <RpcLocalSubplebbitUpdateResultType>(
            await this._webSocketClient.call("editSubplebbit", [{ address: subplebbitAddress, editOptions: propsAfterReplacing }])
        );
        return rawRes;
    }

    async deleteSubplebbit(subplebbitAddress: SubplebbitAddressRpcParam) {
        const parsedDeleteSubplebbitArgs = parseRpcSubplebbitAddressParam(subplebbitAddress);
        const res = await this._webSocketClient.call("deleteSubplebbit", [parsedDeleteSubplebbitArgs]);
        if (res !== true) throw Error("Calling RPC function deleteSubplebbit should either return true or throw");
    }

    async subplebbitUpdateSubscribe(subplebbitAddress: SubplebbitLookupRpcParam): Promise<number> {
        const parsedSubplebbitUpdateArgs = parseRpcSubplebbitLookupParam(subplebbitAddress);
        const subscriptionId = SubscriptionIdSchema.parse(
            await this._webSocketClient.call("subplebbitUpdateSubscribe", [parsedSubplebbitUpdateArgs])
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

    async publishSubplebbitEdit(subplebbitEdit: DecryptedChallengeRequest): Promise<RpcPublishResult> {
        const publishRes = <RpcPublishResult>await this._webSocketClient.call("publishSubplebbitEdit", [subplebbitEdit]);
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

    async resolveAuthorName(parsedAuthorAddress: SubplebbitAddressRpcParam) {
        const resolveAuthorAddressArgs = parseRpcAuthorNameParam(parsedAuthorAddress);
        const res = <{ resolvedAddress: string | null }>await this._webSocketClient.call("resolveAuthorName", [resolveAuthorAddressArgs]);
        if (typeof res?.resolvedAddress !== "string" && res?.resolvedAddress !== null)
            throw Error("RPC function resolveAuthorName should respond with { resolvedAddress: string | null }");
        return res.resolvedAddress;
    }

    async initalizeSubplebbitschangeEvent() {
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("subplebbitsSubscribe", []));
        this._initSubscriptionEvent(subscriptionId);
        this.getSubscription(subscriptionId).on("subplebbitschange", (res) => {
            this.emit("subplebbitschange", <string[]>res.params.result.subplebbits);
        });
        this.emitAllPendingMessages(subscriptionId);
    }

    async initalizeSettingschangeEvent() {
        const subscriptionId = SubscriptionIdSchema.parse(await this._webSocketClient.call("settingsSubscribe", []));
        this._initSubscriptionEvent(subscriptionId);
        this.getSubscription(subscriptionId).on("settingschange", (res) => {
            this.emit("settingschange", <PlebbitWsServerSettingsSerialized>res.params.result);
        });
        this.emitAllPendingMessages(subscriptionId);
    }

    async fetchCid(args: CidRpcParam): Promise<string> {
        const parsedFetchCidArgs = parseRpcCidParam(args);
        const res = <{ content: string }>await this._webSocketClient.call("fetchCid", [parsedFetchCidArgs]);
        if (typeof res?.content !== "string") throw Error("RPC function fetchCid did not respond with { content: string }");
        return res.content;
    }

    async setSettings(settings: z.input<typeof SetNewSettingsPlebbitWsServerSchema>) {
        const parsedSettings = parseSetNewSettingsPlebbitWsServerSchemaWithPlebbitErrorIfItFails(settings);
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
