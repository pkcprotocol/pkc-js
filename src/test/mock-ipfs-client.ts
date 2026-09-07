import io, { Socket } from "socket.io-client";
import type { PubsubClient, PubsubSubscriptionHandler } from "../types.js";
import { v4 as uuidV4 } from "uuid";
import { Buffer } from "buffer";
import { hideClassPrivateProps } from "../util.js";

const DEFAULT_PORT = 25963;
const defaultServerUrl = `ws://localhost:${DEFAULT_PORT}`;
const sharedConnectionStates: Map<string, ConnectionState> = new Map();

type PendingConnectionHandlers = {
    onConnect: () => void;
    onError: (error: Error) => void;
};

type ConnectionState = {
    ioClient?: Socket;
    pendingConnectionWait?: Promise<void>;
    pendingConnectionHandlers?: PendingConnectionHandlers;
    users: number;
    shouldCleanupWindowIo: boolean;
};

const cleanupPendingConnectionWait = (state: ConnectionState) => {
    if (state.pendingConnectionHandlers && state.ioClient) {
        state.ioClient.off("connect", state.pendingConnectionHandlers.onConnect);
        state.ioClient.off("connect_error", state.pendingConnectionHandlers.onError);
    }
    state.pendingConnectionHandlers = undefined;
    state.pendingConnectionWait = undefined;
};

const waitForSocketConnection = async (state: ConnectionState) => {
    if (!state.ioClient) throw new Error("MockPubsubHttpClient has been destroyed");
    if (state.ioClient.connected) return;

    if (!state.pendingConnectionWait) {
        state.pendingConnectionWait = new Promise<void>((resolve, reject) => {
            const onConnect = () => {
                cleanupPendingConnectionWait(state);
                resolve();
            };
            const onError = (error: Error) => {
                cleanupPendingConnectionWait(state);
                reject(error ?? new Error("Failed to connect to mock pubsub server"));
            };

            state.pendingConnectionHandlers = { onConnect, onError };
            state.ioClient!.once("connect", onConnect);
            state.ioClient!.once("connect_error", onError);
        });
    }

    await state.pendingConnectionWait;
};

const ensurePubsubActive = async (state: ConnectionState) => {
    if (!state.ioClient) throw new Error("MockPubsubHttpClient has been destroyed");
    if (!state.ioClient.active) throw new Error("IOClient in MockPubsubHttpClient is not active");
    if (!state.ioClient.connected) await waitForSocketConnection(state);
};

class MockPubsubHttpClient {
    public pubsub: PubsubClient["_client"]["pubsub"];
    private _subscriptions: {
        subscriptionId: string;
        topic: string;
        rawCallback: PubsubSubscriptionHandler;
    }[];
    private _topicListeners: Map<
        string,
        {
            callback: (msg: Buffer) => void;
        }
    >;
    private _recentlyPublishedMessages: Set<string>;
    private readonly _connectionState: ConnectionState;
    private readonly dropRate?: number;

    constructor(connectionState: ConnectionState, dropRate?: number) {
        // dropRate should be between 0 and 1
        this._connectionState = connectionState;
        this.dropRate = dropRate;
        this._subscriptions = [];
        this._recentlyPublishedMessages = new Set();
        this._topicListeners = new Map();

        this.pubsub = {
            publish: async (topic: string, message: Uint8Array) => {
                await ensurePubsubActive(this._connectionState);
                const ioClient = this.getIoClient();
                const messageKey = Buffer.from(message).toString("base64");
                this._recentlyPublishedMessages.add(messageKey);
                setTimeout(() => this._recentlyPublishedMessages.delete(messageKey), 30 * 1000);
                if (typeof this.dropRate === "number") {
                    if (Math.random() > this.dropRate) ioClient.emit(topic, message);
                } else ioClient.emit(topic, message);
            },
            subscribe: async (topic: string, rawCallback: PubsubSubscriptionHandler) => {
                await ensurePubsubActive(this._connectionState);
                // kubo-rpc-client's SubscriptionTracker rejects a second subscribe with the same handler
                // on a topic, and the client manager treats that rejection as "already subscribed". Do
                // the same instead of registering the handler twice, which made every message reach it
                // twice when a publication retried its request on the same provider (#349).
                if (this._subscriptions.some((sub) => sub.topic === topic && sub.rawCallback === rawCallback))
                    throw new Error(`Already subscribed to ${topic} with this handler`);
                this._ensureTopicListener(topic);
                const uniqueSubId = uuidV4();
                this._subscriptions.push({ topic, rawCallback, subscriptionId: uniqueSubId });
            },
            unsubscribe: async (topic: string, rawCallback?: PubsubSubscriptionHandler) => {
                await ensurePubsubActive(this._connectionState);
                if (!rawCallback) {
                    const subscriptionsWithTopic = this._subscriptions.filter((sub) => sub.topic === topic);

                    if (subscriptionsWithTopic.length === 0) return;

                    this._subscriptions = this._subscriptions.filter(
                        (sub) => !subscriptionsWithTopic.map((sub) => sub.subscriptionId).includes(sub.subscriptionId)
                    );
                } else {
                    const toUnsubscribe = this._subscriptions.find((sub) => sub.topic === topic && sub.rawCallback === rawCallback);
                    if (!toUnsubscribe) return;
                    this._subscriptions = this._subscriptions.filter((sub) => sub.subscriptionId !== toUnsubscribe.subscriptionId);
                }
                this._cleanupTopicListenerIfUnused(topic);
            },
            ls: async () => {
                await ensurePubsubActive(this._connectionState);
                return this._subscriptions.map((sub) => sub.topic);
            },
            peers: async () => {
                await ensurePubsubActive(this._connectionState);
                return [];
            }
        };
        hideClassPrivateProps(this);
    }

    private _ensureTopicListener(topic: string) {
        if (this._topicListeners.has(topic)) return;
        const callback = (msg: Buffer) => {
            const messageKey = msg.toString("base64");
            if (this._recentlyPublishedMessages.has(messageKey)) {
                this._recentlyPublishedMessages.delete(messageKey);
                return;
            }
            const subscriptionsWithTopic = this._subscriptions.filter((sub) => sub.topic === topic);
            if (subscriptionsWithTopic.length === 0) return;
            const data = new Uint8Array(msg);
            //@ts-expect-error
            subscriptionsWithTopic.forEach((sub) => sub.rawCallback({ from: undefined!, seqno: undefined, topicIDs: undefined, data }));
        };
        this._topicListeners.set(topic, { callback });
        this.getIoClient().on(topic, callback);
    }

    private _cleanupTopicListenerIfUnused(topic: string) {
        if (this._subscriptions.some((sub) => sub.topic === topic)) return;
        const listener = this._topicListeners.get(topic);
        if (!listener) return;
        this._connectionState.ioClient?.off(topic, listener.callback);
        this._topicListeners.delete(topic);
    }

    async destroy() {
        if (this._connectionState.users > 0) this._connectionState.users--;
        if (this._connectionState.users === 0) {
            if (this._connectionState.pendingConnectionHandlers) {
                this._connectionState.pendingConnectionHandlers.onError(
                    new Error("MockPubsubHttpClient destroyed before the socket connected")
                );
            } else {
                cleanupPendingConnectionWait(this._connectionState);
            }
            await this._connectionState.ioClient?.disconnect();
            this._connectionState.ioClient = undefined;
            const globalWindow = (globalThis as { window?: { io?: Socket } }).window;
            if (this._connectionState.shouldCleanupWindowIo && globalWindow?.io) {
                delete globalWindow.io;
            }
            this._connectionState.shouldCleanupWindowIo = false;
        }
    }

    private getIoClient(): Socket {
        const ioClient = this._connectionState.ioClient;
        if (!ioClient) throw new Error("MockPubsubHttpClient has been destroyed");
        return ioClient;
    }
}

type CreateMockPubsubClientOptions = {
    dropRate?: number;
    forceNewIoClient?: boolean;
    serverUrl?: string;
};

const createIoClient = (serverUrl: string) => io(serverUrl);

const createConnectionState = (serverUrl: string, shouldCleanupWindowIo = false): ConnectionState => ({
    ioClient: createIoClient(serverUrl),
    pendingConnectionWait: undefined,
    pendingConnectionHandlers: undefined,
    users: 0,
    shouldCleanupWindowIo
});

const getOrCreateSharedConnectionState = (serverUrl: string): ConnectionState => {
    const existingState = sharedConnectionStates.get(serverUrl);

    if (existingState?.ioClient) return existingState;

    let createdWindowIo = false;
    let ioClient;

    const globalWindow = (globalThis as { window?: { io?: Socket } }).window;

    if (globalWindow && serverUrl === defaultServerUrl) {
        if (!globalWindow.io) {
            globalWindow.io = createIoClient(serverUrl);
            createdWindowIo = true;
        }
        ioClient = globalWindow.io;
    } else {
        ioClient = createIoClient(serverUrl);
    }

    const newState: ConnectionState = existingState || {
        pendingConnectionWait: undefined,
        pendingConnectionHandlers: undefined,
        users: 0,
        shouldCleanupWindowIo: createdWindowIo
    };
    newState.ioClient = ioClient;
    newState.shouldCleanupWindowIo = createdWindowIo;
    sharedConnectionStates.set(serverUrl, newState);
    return newState;
};

export const createMockPubsubClient = ({
    dropRate,
    forceNewIoClient,
    serverUrl
}: CreateMockPubsubClientOptions = {}): MockPubsubHttpClient => {
    const resolvedServerUrl = serverUrl ?? defaultServerUrl;

    if (forceNewIoClient) {
        const dedicatedConnectionState = createConnectionState(resolvedServerUrl);
        dedicatedConnectionState.users++;
        return new MockPubsubHttpClient(dedicatedConnectionState, dropRate);
    }

    const sharedConnectionState = getOrCreateSharedConnectionState(resolvedServerUrl);
    sharedConnectionState.users++;

    return new MockPubsubHttpClient(sharedConnectionState, dropRate);
};

export const waitForMockPubsubConnection = async (serverUrl = defaultServerUrl) => {
    const connectionState = sharedConnectionStates.get(serverUrl);
    if (!connectionState?.ioClient) throw new Error("MockPubsubHttpClient has not been instantiated");
    await waitForSocketConnection(connectionState);
};
