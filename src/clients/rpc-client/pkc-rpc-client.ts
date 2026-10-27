import Logger from "../../logger.js";
import { Client as WebSocketClient } from "rpc-websockets";
import assert from "assert";
import { PKCError } from "../../pkc-error.js";
import EventEmitter from "events";
import pTimeout from "p-timeout";
import { hideClassPrivateProps, replaceXWithY, resolveWhenPredicateIsTrue } from "../../util.js";
import type { CreateNewLocalCommunityUserOptions } from "../../community/types.js";
import type { CommentChallengeRequestToEncryptType } from "../../publications/comment/types.js";
import type { VoteChallengeRequestToEncryptType } from "../../publications/vote/types.js";
import type { CommentEditChallengeRequestToEncryptType } from "../../publications/comment-edit/types.js";
import type { CommentModerationChallengeRequestToEncrypt } from "../../publications/comment-moderation/types.js";
import type { CommunityEditChallengeRequestToEncryptType } from "../../publications/community-edit/types.js";
import type { PKCWsServerSettingsSerialized } from "../../rpc/src/types.js";
import { parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails } from "../../schema/schema-util.js";
import { ZodError } from "zod";
import type { CommentIpfsType } from "../../publications/comment/types.js";
import { SetNewSettingsPKCWsServerSchema } from "../../rpc/src/schema.js";
import * as z from "zod";
import { TypedEmitter } from "tiny-typed-emitter";
import type { PKCRpcClientEvents } from "../../types.js";
import { messages } from "../../errors.js";
import type {
    AuthorNameRpcParam,
    CommunityIdentifierRpcParam,
    CidRpcParam,
    FetchCidRpcParam,
    FetchCommunityListRpcParam,
    PublishCommunityListRpcParam,
    CommentPageRpcParam,
    CommunityPageRpcParam,
    EditCommunityRpcParam,
    PublishChallengeAnswersRpcParam,
    RpcInternalCommunityRecordBeforeFirstUpdateType,
    RpcLocalCommunityUpdateResultType,
    RpcCommentPageResult,
    RpcCommunityPageResult,
    RpcResolveAuthorNameResult,
    RpcSubscriptionIdResult,
    RpcSuccessResult,
    RpcFetchCidResult,
    ExportCommunityRpcParam,
    CancelExportRpcParam,
    RpcExportCommunityResult,
    ExportCommunityModLogsRpcParam,
    RpcExportCommunityModLogsResult,
    PublishAnchorRecordRpcParam,
    AnchorPublishPreparation,
    PublishedAnchorRecord,
    RpcPublishCommunityListResult,
    RpcFetchCommunityListResult
} from "./types.js";
import {
    parseRpcCommunityIdentifierParam,
    parseRpcAuthorNameParam,
    parseRpcCidParam,
    parseRpcFetchCidParam,
    parseRpcEditCommunityParam,
    parseRpcCommentRepliesPageParam,
    parseRpcCommunityPageParam,
    parseRpcResolveAuthorNameResult,
    parseRpcFetchCidResult,
    parseRpcSuccessResult,
    parseRpcSubscriptionIdResult,
    parseRpcExportCommunityParam,
    parseRpcCancelExportParam,
    parseRpcExportCommunityResult,
    parseRpcExportCommunityModLogsParam,
    parseRpcExportCommunityModLogsResult,
    parseRpcPublishAnchorRecordParam,
    parseRpcAnchorPublishPreparationResult,
    parseRpcPublishedAnchorRecordResult,
    parseRpcPublishCommunityListParam,
    parseRpcPublishCommunityListResult,
    parseRpcFetchCommunityListParam,
    parseRpcFetchCommunityListResult
} from "./rpc-schema-util.js";

const log = Logger("pkc-js:PKCRpcClient");

// The subset of ws (Node) and the native WebSocket (browser) that destroy() needs to wait for a close
interface RawWebSocket {
    readonly readyState: number;
    addEventListener(type: "close", listener: () => void, options?: { once: boolean }): void;
}
const WEBSOCKET_READY_STATE_CLOSED = 3;
const DESTROY_SOCKET_CLOSE_TIMEOUT_MS = 5_000;

// Captured at module load so the deferred attach-and-replay (attachSubscriptionHandlersDeferred)
// keeps working when a downstream app enables fake timers: vitest/jest replace the GLOBAL
// setTimeout after modules are imported, so this bound reference stays the real timer and
// subscriptions never become silently inert under un-advanced fake timers. The deferral still
// runs on a macrotask, so environments that throttle timers (e.g. hidden browser tabs) may delay
// the attach and the buffered replay accordingly.
const scheduleMacrotask: typeof setTimeout = setTimeout.bind(globalThis);

// A JSON-RPC notification: one event on one subscription. `result` is the event's payload, shaped per
// method and event, and narrowed by the handler the instance attached for it
interface RpcSubscriptionNotification {
    params: { subscription: number; event: string; result: unknown };
}

function isRpcSubscriptionNotification(message: unknown): message is RpcSubscriptionNotification {
    if (typeof message !== "object" || message === null || !("params" in message)) return false;
    const params = (message as { params: unknown }).params;
    if (typeof params !== "object" || params === null) return false;
    const { subscription, event } = params as { subscription?: unknown; event?: unknown };
    return typeof subscription === "number" && subscription > 0 && typeof event === "string";
}

export default class PKCRpcClient extends TypedEmitter<PKCRpcClientEvents> {
    state: "stopped" | "connecting" | "failed" | "connected";
    communities: string[];
    settings?: PKCWsServerSettingsSerialized;

    private _webSocketClient: WebSocketClient;
    private _websocketServerUrl: string;
    private _subscriptionEvents: Record<string, EventEmitter>; // subscription ID -> event emitter
    private _pendingSubscriptionMsgs: Record<string, RpcSubscriptionNotification[]> = {};
    private _timeoutSeconds: number;
    private _callTimeoutMs: number;

    // Surviving a dropped connection (#425). The server ties every subscription to the connection
    // and tears them all down when it closes, and it keeps no events for a dropped client. So after
    // rpc-websockets reconnects, the client re-issues each live subscription on the new connection;
    // the server's snapshot on subscribe brings the instance back to the latest state.
    // Instances keep the subscription id they got when they first subscribed (the local id); a
    // re-issued subscription gets a new id from the server, mapped back to the local id here
    private _serverIdByLocalId: Map<number, number> = new Map();
    private _localIdByServerId: Map<number, number> = new Map();
    // How to re-issue each live subscription, keyed by local id
    // (startCommunity is re-issued as startedCommunitySubscribe, which never overrides a stop)
    private _resubscribeCalls: Map<number, { method: string; params: unknown[] }> = new Map();
    // Publications in flight. The server stops them on disconnect, and re-publishing would start
    // a challenge exchange the user never saw, so they fail when the connection drops instead
    private _publishSubscriptionIds: Set<number> = new Set();
    private _hasConnectedBefore = false;
    // Sockets the notification handler is attached to; rpc-websockets creates a new one per connection
    private _socketsWithNotificationHandler: WeakSet<object> = new WeakSet();
    // Reconnect backoff: doubles from the base after every failed attempt, capped at the max, and
    // retries forever (rpc-websockets' default gives up after 5 attempts 1s apart, too soon for a
    // laptop waking from suspend). Reset on every successful open
    private _reconnectBaseIntervalMs = 1_000;
    private _reconnectMaxIntervalMs = 30_000;
    private _reconnectIntervalMs = this._reconnectBaseIntervalMs;
    private _openConnectionPromise?: Promise<any>;
    private _destroyRequested: boolean;
    constructor(rpcServerUrl: string) {
        super();
        assert(rpcServerUrl, "pkc.pkcRpcClientsOptions needs to be defined to create a new rpc client");

        this._websocketServerUrl = rpcServerUrl; // default to first for now. Will change later
        this._timeoutSeconds = 20;
        // Generous because some calls do unbounded server-side work (e.g. startCommunity repins a whole
        // community). Its purpose is turning a lost RPC response into a diagnosable error instead of an
        // infinite hang (issue #195), not bounding slow calls.
        const envCallTimeoutMs = typeof process !== "undefined" ? Number(process.env?.["PKC_RPC_CALL_TIMEOUT_MS"]) : Number.NaN;
        this._callTimeoutMs = envCallTimeoutMs > 0 ? envCallTimeoutMs : 300_000;
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

            this._webSocketClient = new WebSocketClient(this._websocketServerUrl, {
                reconnect_interval: this._reconnectIntervalMs,
                max_reconnects: 0 // retry forever, with the backoff below
            });
            log("Created a new WebSocket instance with url " + this._websocketServerUrl);
            this._attachNotificationHandler();

            this._webSocketClient.on("open", () => {
                log("Connected to RPC server", this._websocketServerUrl);
                // rpc-websockets replaced the socket if this is a reconnect
                this._attachNotificationHandler();
                this._reconnectIntervalMs = this._reconnectBaseIntervalMs;
                this._webSocketClient.setReconnectInterval(this._reconnectIntervalMs);
                const isReconnect = this._hasConnectedBefore;
                this._hasConnectedBefore = true;
                this.setState("connected");
                if (isReconnect) this._resubscribeAllAfterReconnect();
            });
            // forward errors to PKC
            this._webSocketClient.on("error", (error) => {
                // A failed connect attempt emits error before close, and rpc-websockets reads the
                // interval when the close schedules the next attempt
                this._backOffReconnectInterval();
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
                // This runs inside ws's error event, ahead of the close event that schedules the next
                // reconnect attempt. A throw here (an "error" emit with no listener on the PKC) would
                // skip that close and end the reconnect loop for good, or crash the process
                try {
                    this.emit("error", error);
                } catch (emitError) {
                    log.error("No listener received the RPC websocket error", this._websocketServerUrl, emitError);
                }
            });

            this._webSocketClient.on("close", () => {
                // destroy() already awaited this close and logged it; a log here would land after
                // destroy() resolved (#325)
                if (!this._destroyRequested) log.error("connection with web socket has been closed", this._websocketServerUrl);
                this._openConnectionPromise = undefined;
                this.setState("stopped");
                if (!this._destroyRequested) this._failPublicationsLostWithConnection();
            });

            // Process error JSON from server into a PKCError instance
            const originalWebsocketCall = this._webSocketClient.call.bind(this._webSocketClient);

            this._webSocketClient.call = async (...args) => {
                try {
                    await this._init();
                    // A dropped/unmatched JSON-RPC response would otherwise leave this promise pending
                    // forever (issue #195) — rpc-websockets applies no timeout of its own
                    return await pTimeout(originalWebsocketCall(...args), {
                        milliseconds: this._callTimeoutMs,
                        message: new PKCError("ERR_RPC_CALL_TIMED_OUT", {
                            rpcMethod: args[0],
                            timeoutMs: this._callTimeoutMs
                        })
                    });
                } catch (e) {
                    // A JSON-RPC rejection is the serialized server error as a plain object, never an
                    // Error instance: reconstruct a PKCError (or Error) from it, same as subscription
                    // "error" notifications. Locally-created errors (e.g. the pTimeout
                    // ERR_RPC_CALL_TIMED_OUT above, or transport errors) are already instances and
                    // pass through untouched.
                    const typedError = e instanceof Error ? <PKCError | Error | ZodError>e : this._deserializeRpcError(e);
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

        this._resubscribeCalls.clear();
        this._publishSubscriptionIds.clear();
        this._serverIdByLocalId.clear();
        this._localIdByServerId.clear();

        try {
            if (this._webSocketClient instanceof WebSocketClient) {
                this._webSocketClient.setAutoReconnect(false);
                // Between attempts there is no socket to close, only rpc-websockets' timer for the
                // next attempt, which would open a connection after destroy() resolved
                clearTimeout(
                    (this._webSocketClient as unknown as { reconnect_timer_id?: ReturnType<typeof setTimeout> }).reconnect_timer_id
                );
                // Wait for the socket to actually close so nothing (in particular no log line) runs on our
                // behalf after destroy() has resolved (#325)
                const socketClosed = this._waitForSocketClose();
                this._webSocketClient.close();
                await socketClosed;
                log("Closed websocket connection to", this._websocketServerUrl);
            }
        } catch (e) {
            log.error("Failed to close websocket", e);
        }

        this._openConnectionPromise = undefined;
        this.setState("stopped");
    }

    // Resolves once the raw socket under rpc-websockets has fully closed, right away if there is none.
    // Bounded so a peer that never completes the close handshake cannot hang destroy(); rpc-websockets
    // exposes the raw socket as `.socket` (ws in Node, the native WebSocket in browsers), both of which
    // support addEventListener.
    private async _waitForSocketClose(): Promise<void> {
        const socket = (this._webSocketClient as unknown as { socket?: RawWebSocket }).socket;
        if (!socket || socket.readyState === WEBSOCKET_READY_STATE_CLOSED) return;
        const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
        try {
            await pTimeout(closed, { milliseconds: DESTROY_SOCKET_CLOSE_TIMEOUT_MS });
        } catch {
            log.error("Websocket did not close within", DESTROY_SOCKET_CLOSE_TIMEOUT_MS, "ms of destroy()", this._websocketServerUrl);
        }
    }

    toJSON() {
        return undefined;
    }

    getSubscription(subscriptionId: number) {
        if (!this._subscriptionEvents[subscriptionId]) throw Error(`No subscription to RPC with id (${subscriptionId})`);
        else return this._subscriptionEvents[subscriptionId];
    }

    async unsubscribe(subscriptionId: number) {
        // The server dropped every subscription of a closed connection, and a publication that
        // failed with it is not on the new connection either, so there is nothing to call
        const liveOnServer =
            this.state === "connected" && (this._resubscribeCalls.has(subscriptionId) || this._publishSubscriptionIds.has(subscriptionId));
        const serverSubscriptionId = this._serverIdByLocalId.get(subscriptionId) ?? subscriptionId;
        this._resubscribeCalls.delete(subscriptionId);
        this._publishSubscriptionIds.delete(subscriptionId);
        if (liveOnServer) await this._webSocketClient.call("unsubscribe", [{ subscriptionId: serverSubscriptionId }]);
        this._serverIdByLocalId.delete(subscriptionId);
        this._localIdByServerId.delete(serverSubscriptionId);
        if (this._subscriptionEvents[subscriptionId]) this._subscriptionEvents[subscriptionId].removeAllListeners();
        delete this._subscriptionEvents[subscriptionId];
        delete this._pendingSubscriptionMsgs[subscriptionId];
    }

    private _attachNotificationHandler() {
        const socket = (
            this._webSocketClient as unknown as { socket?: { on: (event: "message", listener: (data: string) => void) => void } }
        ).socket;
        if (!socket || this._socketsWithNotificationHandler.has(socket)) return;
        this._socketsWithNotificationHandler.add(socket);
        socket.on("message", (jsonMessage) => {
            const message: unknown = JSON.parse(jsonMessage);
            if (!isRpcSubscriptionNotification(message)) return; // a response to a call, handled by rpc-websockets
            const serverSubscriptionId = message.params.subscription;
            const subscriptionId = this._localIdByServerId.get(serverSubscriptionId) ?? serverSubscriptionId;
            message.params.subscription = subscriptionId;
            this._dispatchNotification(subscriptionId, message);
        });
    }

    // save all subscription messages (ie json rpc messages without 'id', also called json rpc 'notifications')
    // NOTE: it is possible to receive a subscription message before receiving the subscription id
    private _dispatchNotification(subscriptionId: number, message: RpcSubscriptionNotification) {
        this._initSubscriptionEvent(subscriptionId);

        // We need to parse error props into PKCErrors
        if (message.params.event === "error" && !(message.params.result instanceof Error)) {
            const error = this._deserializeRpcError(message.params.result);
            delete (error as { stack?: string }).stack; // Need to delete locally generated stack traces
            message.params.result = error;
        }
        if (this._subscriptionEvents[subscriptionId].listenerCount(message.params.event) === 0)
            this._pendingSubscriptionMsgs[subscriptionId].push(message);
        else this._subscriptionEvents[subscriptionId].emit(message.params.event, message);
    }

    private _backOffReconnectInterval() {
        if (!(this._webSocketClient instanceof WebSocketClient)) return;
        this._reconnectIntervalMs = Math.min(this._reconnectIntervalMs * 2, this._reconnectMaxIntervalMs);
        this._webSocketClient.setReconnectInterval(this._reconnectIntervalMs);
    }

    // Subscribe and remember how to re-issue the subscription on a new connection
    private async _subscribe(
        method: string,
        params: unknown[],
        onReconnect: "resubscribe" | "fail",
        resubscribeMethod: string = method
    ): Promise<RpcSubscriptionIdResult> {
        const res = parseRpcSubscriptionIdResult(await this._webSocketClient.call(method, params));
        this._initSubscriptionEvent(res.subscriptionId);
        if (onReconnect === "resubscribe") this._resubscribeCalls.set(res.subscriptionId, { method: resubscribeMethod, params });
        else this._publishSubscriptionIds.add(res.subscriptionId);
        return res;
    }

    private _resubscribeAllAfterReconnect() {
        for (const subscriptionId of [...this._resubscribeCalls.keys()])
            this._resubscribe(subscriptionId).catch((error) => {
                if (this._destroyRequested) return;
                if ((error as { code?: unknown })?.code === "ERR_RPC_COMMUNITY_NOT_RUNNING") {
                    // Someone stopped the community on purpose, possibly while we were away; tell the
                    // instance the way a stop reaches a connected client, and do not try again
                    log("Not re-establishing start(), the community was stopped on purpose", subscriptionId);
                    this._resubscribeCalls.delete(subscriptionId);
                    this._dispatchNotification(subscriptionId, {
                        params: { event: "startedstatechange", subscription: subscriptionId, result: { state: "stopped" } }
                    });
                    return;
                }
                log.error("Failed to re-subscribe after reconnecting to the RPC server", subscriptionId, error);
                this._dispatchNotification(subscriptionId, {
                    params: { event: "error", subscription: subscriptionId, result: error }
                });
            });
    }

    private async _resubscribe(subscriptionId: number) {
        const call = this._resubscribeCalls.get(subscriptionId);
        if (!call || this._destroyRequested) return;
        const { subscriptionId: serverSubscriptionId } = parseRpcSubscriptionIdResult(
            await this._webSocketClient.call(call.method, call.params)
        );
        // The server sends its snapshot before the response, so it arrived under the new id,
        // which nothing mapped yet; take it over before it is replayed to the instance
        const earlyMessages = serverSubscriptionId === subscriptionId ? [] : this._pendingSubscriptionMsgs[serverSubscriptionId] ?? [];
        if (serverSubscriptionId !== subscriptionId) {
            delete this._pendingSubscriptionMsgs[serverSubscriptionId];
            delete this._subscriptionEvents[serverSubscriptionId];
        }
        if (this._resubscribeCalls.get(subscriptionId) !== call || this._destroyRequested) {
            // Unsubscribed while the call was in flight
            if (!this._destroyRequested)
                await this._webSocketClient.call("unsubscribe", [{ subscriptionId: serverSubscriptionId }]).catch((error) => {
                    log.error("Failed to unsubscribe a subscription re-issued after it was unsubscribed", error);
                });
            return;
        }
        const previousServerSubscriptionId = this._serverIdByLocalId.get(subscriptionId);
        if (previousServerSubscriptionId !== undefined) this._localIdByServerId.delete(previousServerSubscriptionId);
        this._serverIdByLocalId.set(subscriptionId, serverSubscriptionId);
        this._localIdByServerId.set(serverSubscriptionId, subscriptionId);
        log("Re-subscribed after reconnecting", call.method, { subscriptionId, serverSubscriptionId });
        for (const message of earlyMessages) {
            message.params.subscription = subscriptionId;
            this._dispatchNotification(subscriptionId, message);
        }
    }

    private _failPublicationsLostWithConnection() {
        for (const subscriptionId of [...this._publishSubscriptionIds]) {
            this._publishSubscriptionIds.delete(subscriptionId);
            const error = new PKCError("ERR_RPC_PUBLICATION_LOST_WITH_CONNECTION", {
                rpcServerUrl: this._websocketServerUrl,
                publishThrowError: true
            });
            this._dispatchNotification(subscriptionId, {
                params: { event: "publishingstatechange", subscription: subscriptionId, result: { state: "failed" } }
            });
            this._dispatchNotification(subscriptionId, { params: { event: "error", subscription: subscriptionId, result: error } });
        }
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

    subscriptionActive(subscriptionId: number): boolean {
        return Boolean(this._subscriptionEvents[subscriptionId]);
    }

    // Attach a subscription's notification handlers and replay its buffered notifications in a
    // macrotask, so events the server emitted at subscribe time (before the JSON-RPC subscribe
    // response) still reach a listener attached synchronously after the subscribing call resolves
    // (#299/#314). A microtask is not enough: it is enqueued before the promise-resolution jobs
    // that unwind the awaits, so it would still run before the caller's continuation. Attaching
    // the handlers inside the same deferred task keeps delivery ordered: notifications arriving in
    // the window find no listeners, so they are buffered and the replay drains everything in
    // arrival order. Opt-in per call site because some subscribers (e.g. the exports subscription
    // in rpc-local-community.ts) deliberately rely on the synchronous replay ordering.
    attachSubscriptionHandlersDeferred(opts: {
        subscriptionId: number;
        // Return true if the caller no longer owns this subscription (stopped, restarted)
        isStale: () => boolean;
        attach: (subscription: EventEmitter) => void;
        // Containment for a handler throw escaping the replay; pre-deferral the throw rejected
        // the subscribing call, post-deferral nothing awaits it, so the helper owns the shared
        // policy (log, surface via emitError, then stop) rather than each call site copying it.
        // Without this the throw would escape the timer as an uncaughtException.
        replayErrorContainment: {
            // The noun used in the log lines, e.g. "community", "comment", "publication"
            entityName: string;
            log: ReturnType<typeof Logger>;
            // Typically (error) => this.emit("error", error) on the subscribing instance
            emitError: (error: Error) => void;
            // The teardown matching the entity's blast radius (e.g. stopWithoutRpcCall for a
            // started community, where full stop() would halt it node-wide over RPC)
            stop: () => Promise<void>;
        };
    }) {
        scheduleMacrotask(() => {
            const ownsSubscription = () => !opts.isStale() && this.subscriptionActive(opts.subscriptionId);
            // The subscription may have been unsubscribed or the connection destroyed in the meantime
            if (!ownsSubscription()) return;
            try {
                opts.attach(this.getSubscription(opts.subscriptionId));
                this._emitPendingMessagesWhile(opts.subscriptionId, ownsSubscription);
            } catch (e) {
                this._containReplayError(e, opts.replayErrorContainment);
            }
        }, 0);
    }

    private _containReplayError(
        e: unknown,
        containment: { entityName: string; log: ReturnType<typeof Logger>; emitError: (error: Error) => void; stop: () => Promise<void> }
    ) {
        const { entityName, log: siteLog, emitError, stop } = containment;
        siteLog.error(`Error thrown while replaying buffered subscribe-time notifications, stopping the ${entityName}`, e);
        // Surface the contained throw before stopping: without the emit the only signal is a
        // debug-namespace log and a silent stop. The emit itself can throw (with no listeners
        // anywhere the pkc bubbling re-throws), so it stays contained too.
        try {
            emitError(e instanceof Error ? e : new Error(String(e)));
        } catch (emitFailure) {
            siteLog.error("No listener received the replay error", emitFailure);
        }
        stop().catch((stopError) => siteLog.error(`Failed to stop the ${entityName} after a replay error`, stopError));
    }

    // Replay the buffered notifications one message at a time, re-checking ownership between
    // messages: a replayed handler may call stop(), whose synchronous prefix clears the caller's
    // subscription id (directly, or through the mirror cleanup chain), and the remaining buffered
    // notifications must then be dropped instead of delivered into a stopping instance. The
    // messages delivered before the stop are consumed; the leftovers stay buffered for
    // unsubscribe() to discard.
    private _emitPendingMessagesWhile(subscriptionId: number, shouldDeliver: () => boolean) {
        const pendingMessages = this._pendingSubscriptionMsgs[subscriptionId];
        if (!pendingMessages) return;
        while (pendingMessages.length > 0) {
            if (!shouldDeliver()) return;
            const message = pendingMessages.shift()!;
            this._subscriptionEvents[subscriptionId].emit(message.params.event, message);
        }
        delete this._pendingSubscriptionMsgs[subscriptionId];
    }

    emitAllPendingMessages(subscriptionId: number) {
        // The replay may be deferred to a later task (#299), so the subscription can be
        // unsubscribed or the connection destroyed before it runs
        if (!this._pendingSubscriptionMsgs[subscriptionId]) return;
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

    async getCommentPage(page: CommentPageRpcParam): Promise<RpcCommentPageResult> {
        const parsedGetCommentRepliesPageArgs = parseRpcCommentRepliesPageParam(page);
        const result = await this._webSocketClient.call("getCommentPage", [parsedGetCommentRepliesPageArgs]);
        return result as RpcCommentPageResult;
    }

    async getCommunityPage(page: CommunityPageRpcParam): Promise<RpcCommunityPageResult> {
        const parsedGetCommunityPostsPage = parseRpcCommunityPageParam(page);
        const result = await this._webSocketClient.call("getCommunityPage", [parsedGetCommunityPostsPage]);
        return result as RpcCommunityPageResult;
    }

    async createCommunity(
        createCommunityOptions: CreateNewLocalCommunityUserOptions
    ): Promise<RpcInternalCommunityRecordBeforeFirstUpdateType> {
        // This is gonna create a new local community. Not an instance of an existing community
        const communityProps = <RpcInternalCommunityRecordBeforeFirstUpdateType>(
            await this._webSocketClient.call("createCommunity", [createCommunityOptions])
        );
        return communityProps;
    }

    private _initSubscriptionEvent(subscriptionId: number) {
        if (!this._subscriptionEvents[subscriptionId]) this._subscriptionEvents[subscriptionId] = new EventEmitter();
        if (!this._pendingSubscriptionMsgs[subscriptionId]) this._pendingSubscriptionMsgs[subscriptionId] = [];
    }

    async startCommunity(communityIdentifier: CommunityIdentifierRpcParam): Promise<RpcSubscriptionIdResult> {
        const parsedStartCommunityArgs = parseRpcCommunityIdentifierParam(communityIdentifier);
        const res = await this._subscribe("startCommunity", [parsedStartCommunityArgs], "resubscribe", "startedCommunitySubscribe");
        return res;
    }

    async stopCommunity(communityIdentifier: CommunityIdentifierRpcParam): Promise<RpcSuccessResult> {
        const parsedStopCommunityArgs = parseRpcCommunityIdentifierParam(communityIdentifier);
        return parseRpcSuccessResult(await this._webSocketClient.call("stopCommunity", [parsedStopCommunityArgs]));
    }

    // Delegation setup (#234). Neither call carries the anchor's private key: prepareAnchorPublish asks
    // the node (the only online party) which sequence to sign, and publishAnchorRecord hands back bytes
    // the client signed locally. See docs/protocol/delegated-ipns.md.
    async prepareAnchorPublish(communityIdentifier: CommunityIdentifierRpcParam): Promise<AnchorPublishPreparation> {
        const parsedArgs = parseRpcCommunityIdentifierParam(communityIdentifier);
        return parseRpcAnchorPublishPreparationResult(await this._webSocketClient.call("prepareAnchorPublish", [parsedArgs]));
    }

    async publishAnchorRecord(args: PublishAnchorRecordRpcParam): Promise<PublishedAnchorRecord> {
        const parsedArgs = parseRpcPublishAnchorRecordParam(args);
        return parseRpcPublishedAnchorRecordResult(await this._webSocketClient.call("publishAnchorRecord", [parsedArgs]));
    }

    async editCommunity(args: EditCommunityRpcParam): Promise<RpcLocalCommunityUpdateResultType> {
        // Validate with original values (schema accepts undefined but not null)
        parseRpcEditCommunityParam(args);
        // Convert undefined→null for JSON wire format, send without re-validating
        const wireArgs: EditCommunityRpcParam = {
            ...args,
            editOptions: replaceXWithY(args.editOptions, undefined, null) as EditCommunityRpcParam["editOptions"]
        };
        const rawRes = <RpcLocalCommunityUpdateResultType>await this._webSocketClient.call("editCommunity", [wireArgs]);
        return rawRes;
    }

    async deleteCommunity(communityIdentifier: CommunityIdentifierRpcParam): Promise<RpcSuccessResult> {
        const parsedDeleteCommunityArgs = parseRpcCommunityIdentifierParam(communityIdentifier);
        return parseRpcSuccessResult(await this._webSocketClient.call("deleteCommunity", [parsedDeleteCommunityArgs]));
    }

    async communityUpdateSubscribe(communityIdentifier: CommunityIdentifierRpcParam): Promise<RpcSubscriptionIdResult> {
        const parsedCommunityUpdateArgs = parseRpcCommunityIdentifierParam(communityIdentifier);
        const res = await this._subscribe("communityUpdateSubscribe", [parsedCommunityUpdateArgs], "resubscribe");
        return res;
    }

    async publishComment(commentProps: CommentChallengeRequestToEncryptType): Promise<RpcSubscriptionIdResult> {
        const res = await this._subscribe("publishComment", [commentProps], "fail");
        return res;
    }

    async publishCommentEdit(commentEditProps: CommentEditChallengeRequestToEncryptType): Promise<RpcSubscriptionIdResult> {
        const res = await this._subscribe("publishCommentEdit", [commentEditProps], "fail");
        return res;
    }

    async publishCommentModeration(commentModProps: CommentModerationChallengeRequestToEncrypt): Promise<RpcSubscriptionIdResult> {
        const res = await this._subscribe("publishCommentModeration", [commentModProps], "fail");
        return res;
    }

    async publishVote(voteProps: VoteChallengeRequestToEncryptType): Promise<RpcSubscriptionIdResult> {
        const res = await this._subscribe("publishVote", [voteProps], "fail");
        return res;
    }

    async publishCommunityEdit(communityEdit: CommunityEditChallengeRequestToEncryptType): Promise<RpcSubscriptionIdResult> {
        const res = await this._subscribe("publishCommunityEdit", [communityEdit], "fail");
        return res;
    }

    async commentUpdateSubscribe(args: CidRpcParam): Promise<RpcSubscriptionIdResult> {
        const parsedCommentUpdateArgs = parseRpcCidParam(args);
        const res = await this._subscribe("commentUpdateSubscribe", [parsedCommentUpdateArgs], "resubscribe");
        return res;
    }

    async publishChallengeAnswers(args: PublishChallengeAnswersRpcParam): Promise<RpcSuccessResult> {
        return parseRpcSuccessResult(await this._webSocketClient.call("publishChallengeAnswers", [args]));
    }

    async resolveAuthorName(parsedAuthorName: AuthorNameRpcParam): Promise<RpcResolveAuthorNameResult> {
        const resolveAuthorNameArgs = parseRpcAuthorNameParam(parsedAuthorName);
        const res = parseRpcResolveAuthorNameResult(await this._webSocketClient.call("resolveAuthorName", [resolveAuthorNameArgs]));
        return res;
    }

    async initalizeCommunitieschangeEvent() {
        const { subscriptionId } = await this._subscribe("communitiesSubscribe", [], "resubscribe");
        this.getSubscription(subscriptionId).on("communitieschange", (res) => {
            this.emit("communitieschange", <string[]>res.params.result.communities);
        });
        this.emitAllPendingMessages(subscriptionId);
    }

    async initalizeSettingschangeEvent() {
        const { subscriptionId } = await this._subscribe("settingsSubscribe", [], "resubscribe");
        this.getSubscription(subscriptionId).on("settingschange", (res) => {
            this.emit("settingschange", <PKCWsServerSettingsSerialized>res.params.result);
        });
        this.emitAllPendingMessages(subscriptionId);
    }

    async fetchCid(args: FetchCidRpcParam): Promise<RpcFetchCidResult> {
        const parsedFetchCidArgs = parseRpcFetchCidParam(args);
        return parseRpcFetchCidResult(await this._webSocketClient.call("fetchCid", [parsedFetchCidArgs]));
    }

    // CommunityList (docs/protocol/community-lists.md). The client signs locally; the server only
    // adds the signed JSON to IPFS and returns the cid. The fetch result is the raw record string so
    // the caller can check the bytes against the cid and verify the signature locally.
    async publishCommunityList(args: PublishCommunityListRpcParam): Promise<RpcPublishCommunityListResult> {
        const parsedArgs = parseRpcPublishCommunityListParam(args);
        return parseRpcPublishCommunityListResult(await this._webSocketClient.call("publishCommunityList", [parsedArgs]));
    }

    async fetchCommunityList(args: FetchCommunityListRpcParam): Promise<RpcFetchCommunityListResult> {
        const parsedArgs = parseRpcFetchCommunityListParam(args);
        return parseRpcFetchCommunityListResult(await this._webSocketClient.call("fetchCommunityList", [parsedArgs]));
    }

    async setSettings(settings: z.input<typeof SetNewSettingsPKCWsServerSchema>): Promise<RpcSuccessResult> {
        const parsedSettings = parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(settings);
        return parseRpcSuccessResult(await this._webSocketClient.call("setSettings", [parsedSettings]));
    }

    async rpcCall(method: string, params: any[]): Promise<any> {
        // This function can be used to call any function on the rpc server
        const res = <any>await this._webSocketClient.call(method, params);
        return res;
    }

    // community.export() — see src/rpc/EXPORT_COMMUNITY_SPEC.md

    // HTTP origin to absolutize relative `/exports/<exportId>` URLs returned by exportsSubscribe.
    // Derived from the WS URL with ws[s]:// swapped to http[s]:// and the auth-key path stripped.
    get rpcHttpOrigin(): string {
        const parsed = new URL(this._websocketServerUrl);
        const httpProto = parsed.protocol === "wss:" ? "https:" : "http:";
        return `${httpProto}//${parsed.host}`;
    }

    async exportCommunity(args: ExportCommunityRpcParam): Promise<RpcExportCommunityResult> {
        const parsedArgs = parseRpcExportCommunityParam(args);
        return parseRpcExportCommunityResult(await this._webSocketClient.call("exportCommunity", [parsedArgs]));
    }

    async exportCommunityModLogs(args: ExportCommunityModLogsRpcParam): Promise<RpcExportCommunityModLogsResult> {
        const parsedArgs = parseRpcExportCommunityModLogsParam(args);
        return parseRpcExportCommunityModLogsResult(await this._webSocketClient.call("exportCommunityModLogs", [parsedArgs]));
    }

    async exportsSubscribe(args: CommunityIdentifierRpcParam): Promise<RpcSubscriptionIdResult> {
        const parsedArgs = parseRpcCommunityIdentifierParam(args);
        const res = await this._subscribe("exportsSubscribe", [parsedArgs], "resubscribe");
        return res;
    }

    async cancelExport(args: CancelExportRpcParam): Promise<RpcSuccessResult> {
        const parsedArgs = parseRpcCancelExportParam(args);
        return parseRpcSuccessResult(await this._webSocketClient.call("cancelExport", [parsedArgs]));
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
