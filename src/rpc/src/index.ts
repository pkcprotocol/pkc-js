import { Server as RpcWebsocketsServer } from "rpc-websockets";
import { mkdirSync } from "fs";
import path from "path";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import PKCJs, { setPKCJs } from "./lib/pkc-js/index.js";
import {
    clone,
    encodeChallengeAnswerMessage,
    encodeChallengeMessage,
    encodeChallengeRequest,
    encodeChallengeVerificationMessage,
    generateSubscriptionId
} from "./utils.js";
import Logger from "../../logger.js";
import type {
    PKCWsServerClassOptions,
    JsonRpcSendNotificationOptions,
    CreatePKCWsServerOptions,
    PKCWsServerSettingsSerialized,
    PKCRpcServerEvents,
    RpcCommunityState
} from "./types.js";
import { PKC } from "../../pkc/pkc.js";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    DecryptedChallengeVerificationMessageType
} from "../../pubsub-messages/types.js";
import WebSocket from "ws";
import Publication from "../../publications/publication.js";
import { PKCError } from "../../pkc-error.js";
import { LocalCommunity } from "../../runtime/node/community/local-community.js";
import { RemoteCommunity } from "../../community/remote-community.js";
import { hideClassPrivateProps, replaceXWithY } from "../../util.js";
import * as remeda from "remeda";
import type { IncomingMessage } from "http";
import type {
    CommentChallengeRequestToEncryptType,
    CommentIpfsType,
    CommentRpcErrorToTransmit,
    RpcCommentUpdateResultType
} from "../../publications/comment/types.js";
import type {
    RpcInternalCommunityRecordAfterFirstUpdateType,
    RpcInternalCommunityRecordBeforeFirstUpdateType,
    RpcRemoteCommunityType,
    CommunityEvents,
    CommunityRpcErrorToTransmit
} from "../../community/types.js";
import {
    parseCommentChallengeRequestToEncryptSchemaWithPKCErrorIfItFails,
    parseCommentEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails,
    parseCommentModerationChallengeRequestToEncryptSchemaWithPKCErrorIfItFails,
    parseCreateNewLocalCommunityUserOptionsSchemaWithPKCErrorIfItFails,
    parseCreatePKCWsServerOptionsSchemaWithPKCErrorIfItFails,
    parseDecryptedChallengeAnswerWithPKCErrorIfItFails,
    parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails,
    parseCommunityEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails,
    parseCommunityEditOptionsSchemaWithPKCErrorIfItFails,
    parseVoteChallengeRequestToEncryptSchemaWithPKCErrorIfItFails
} from "../../schema/schema-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import type { VoteChallengeRequestToEncryptType } from "../../publications/vote/types.js";
import type { CommentEditChallengeRequestToEncryptType } from "../../publications/comment-edit/types.js";
import type { CommentModerationChallengeRequestToEncrypt } from "../../publications/comment-moderation/types.js";
import type { InputPKCOptions } from "../../types.js";
import type { CommunityEditChallengeRequestToEncryptType } from "../../publications/community-edit/types.js";
import { PublicationRpcErrorToTransmit, RpcPublishResult } from "../../publications/types.js";
import { TypedEmitter } from "tiny-typed-emitter";
import { sanitizeRpcNotificationResult } from "./json-rpc-util.js";
import type { ModQueuePageIpfs, PageIpfs } from "../../pages/types.js";
import { buildPageRuntimeFields, buildPagesRuntimeFields } from "../../pages/util.js";
import {
    parseRpcCommunityAddressParam,
    parseRpcCommunityLookupParam,
    parseRpcAuthorNameParam,
    parseRpcCidParam,
    parseRpcCommentRepliesPageParam,
    parseRpcCommunityPageParam,
    parseRpcEditCommunityParam,
    parseRpcPublishChallengeAnswersParam,
    parseRpcUnsubscribeParam
} from "../../clients/rpc-client/rpc-schema-util.js";
import { CommunityAddressRpcParam, CommunityLookupRpcParam } from "../../clients/rpc-client/types.js";
import { findStartedCommunity } from "../../pkc/tracked-instance-registry-util.js";

// store started subplebbits  to be able to stop them
// store as a singleton because not possible to start the same sub twice at the same time

const log = Logger("pkc-js-rpc:pkc-ws-server");

// TODO need to think how to update PKC instance of publication after setSettings?

class PKCWsServer extends TypedEmitter<PKCRpcServerEvents> {
    plebbit!: PKC;
    rpcWebsockets: RpcWebsocketsServer;
    ws: RpcWebsocketsServer["wss"];
    connections: { [connectionId: string]: WebSocket } = {};
    subscriptionCleanups: { [connectionId: string]: { [subscriptionId: number]: () => Promise<void> } } = {};
    // store publishing publications so they can be used by publishChallengeAnswers
    publishing: {
        [subscriptionId: number]: { publication: Publication; plebbit: PKC; connectionId: string; timeout?: NodeJS.Timeout };
    } = {};
    private _setSettingsQueue: Promise<void> = Promise.resolve();
    authKey: string | undefined;
    private _trackedCommunityListeners = new WeakMap<LocalCommunity, Map<keyof CommunityEvents, Set<(...args: any[]) => void>>>();
    private _getIpFromConnectionRequest = (req: IncomingMessage) => <string>req.socket.remoteAddress; // we set it up here so we can mock it in tests

    private _onSettingsChange: {
        [connectionId: string]: { [subscriptionId: number]: (args: { newPKC: PKC }) => Promise<void> };
    } = {}; // TODO rename this to _afterSettingsChange

    private _startedCommunitys: { [address: string]: "pending" | LocalCommunity } = {}; // TODO replace this with plebbit._startedCommunitys
    private _autoStartOnBoot: boolean = false;
    private _rpcStateDb: BetterSqlite3Database | undefined;

    constructor({ port, server, plebbit, authKey, startStartedCommunitysOnStartup }: PKCWsServerClassOptions) {
        super();
        const log = Logger("pkc-js:PKCWsServer");
        this.authKey = authKey;
        this._autoStartOnBoot = startStartedCommunitysOnStartup ?? true;
        // don't instantiate plebbit in constructor because it's an async function
        this._initPKC(plebbit);
        this.rpcWebsockets = new RpcWebsocketsServer({
            port,
            server,
            verifyClient: ({ req }, callback) => {
                // block non-localhost requests without auth key for security

                const requestOriginatorIp = this._getIpFromConnectionRequest(req);
                log.trace("Received new connection request from", requestOriginatorIp, "with url", req.url);
                const xForwardedFor = Boolean(req.rawHeaders.find((item, i) => item.toLowerCase() === "x-forwarded-for" && i % 2 === 0));

                // client is on localhost and server is not forwarded by a proxy
                // req.socket.localAddress is the local address of the rpc server
                const isLocalhost = req.socket.localAddress && req.socket.localAddress === requestOriginatorIp && !xForwardedFor;

                // the request path is the auth key, e.g. localhost:9138/some-random-auth-key (not secure on http)
                const hasAuth = this.authKey && `/${this.authKey}` === req.url;

                // if isn't localhost and doesn't have auth, block access
                if (!isLocalhost && !hasAuth) {
                    log(
                        `Rejecting RPC connection request from`,
                        requestOriginatorIp,
                        `rejected because there is no auth key, url:`,
                        req.url
                    );
                    callback(false, 403, "You need to set the auth key to connect remotely");
                } else callback(true);
            }
        });
        // rpc-sockets uses this library https://www.npmjs.com/package/ws
        this.ws = this.rpcWebsockets.wss;

        // forward errors to PKCWsServer
        this.rpcWebsockets.on("error", (error) => {
            log.error("RPC server", "Received an error on rpc-websockets", error);
            this._emitError(error);
        });

        // save connections to send messages to them later
        this.ws.on("connection", (ws) => {
            //@ts-ignore-error
            this.connections[ws._id] = ws;
            //@ts-ignore-error
            this.subscriptionCleanups[ws._id] = {};
            //@ts-expect-error
            this._onSettingsChange[ws._id] = {};
            //@ts-expect-error
            log("Established connection with new RPC client", ws._id);
        });

        // cleanup on disconnect
        this.rpcWebsockets.on("disconnection", async (ws) => {
            log("RPC client disconnected", ws._id, "number of rpc clients connected", this.rpcWebsockets.wss.clients.size);
            const subscriptionCleanups = this.subscriptionCleanups[ws._id];
            if (!subscriptionCleanups) {
                delete this.subscriptionCleanups[ws._id];
                delete this.connections[ws._id];
                delete this._onSettingsChange[ws._id];
                log("Disconnected from RPC client (no subscriptions to clean)", ws._id);
                return;
            }
            for (const subscriptionId in subscriptionCleanups) {
                await subscriptionCleanups[subscriptionId]();
                delete subscriptionCleanups[subscriptionId];
            }
            delete this.subscriptionCleanups[ws._id];
            delete this.connections[ws._id];
            delete this._onSettingsChange[ws._id];
            log("Disconnected from RPC client", ws._id);
        });

        // register all JSON RPC methods
        this.rpcWebsocketsRegister("getComment", this.getComment.bind(this));
        this.rpcWebsocketsRegister("getCommunityPage", this.getCommunityPage.bind(this));
        this.rpcWebsocketsRegister("getCommentPage", this.getCommentPage.bind(this));
        this.rpcWebsocketsRegister("createCommunity", this.createCommunity.bind(this));
        this.rpcWebsocketsRegister("startCommunity", this.startCommunity.bind(this));
        this.rpcWebsocketsRegister("stopCommunity", this.stopCommunity.bind(this));
        this.rpcWebsocketsRegister("editCommunity", this.editCommunity.bind(this));
        this.rpcWebsocketsRegister("deleteCommunity", this.deleteCommunity.bind(this));
        this.rpcWebsocketsRegister("subplebbitsSubscribe", this.subplebbitsSubscribe.bind(this));
        this.rpcWebsocketsRegister("settingsSubscribe", this.settingsSubscribe.bind(this));

        this.rpcWebsocketsRegister("fetchCid", this.fetchCid.bind(this));
        this.rpcWebsocketsRegister("resolveAuthorName", this.resolveAuthorName.bind(this));
        this.rpcWebsocketsRegister("setSettings", this.setSettings.bind(this));
        // JSON RPC pubsub methods
        this.rpcWebsocketsRegister("commentUpdateSubscribe", this.commentUpdateSubscribe.bind(this));
        this.rpcWebsocketsRegister("subplebbitUpdateSubscribe", this.subplebbitUpdateSubscribe.bind(this));
        this.rpcWebsocketsRegister("publishComment", this.publishComment.bind(this));
        this.rpcWebsocketsRegister("publishCommunityEdit", this.publishCommunityEdit.bind(this));
        this.rpcWebsocketsRegister("publishVote", this.publishVote.bind(this));
        this.rpcWebsocketsRegister("publishCommentEdit", this.publishCommentEdit.bind(this));
        this.rpcWebsocketsRegister("publishCommentModeration", this.publishCommentModeration.bind(this));
        this.rpcWebsocketsRegister("publishChallengeAnswers", this.publishChallengeAnswers.bind(this));
        this.rpcWebsocketsRegister("unsubscribe", this.unsubscribe.bind(this));

        hideClassPrivateProps(this);
    }

    async getStartedCommunity(address: string): Promise<LocalCommunity> {
        if (!(address in this._startedCommunitys)) throw Error("Can't call getStartedCommunity when the sub hasn't been started");
        // if pending, wait until no longer pendng
        while (this._startedCommunitys[address] === "pending") {
            await new Promise((r) => setTimeout(r, 20));
        }
        return <LocalCommunity>this._startedCommunitys[address];
    }

    private _emitError(error: PKCError | Error) {
        if (this.listeners("error").length === 0)
            log.error("Unhandled error. This may crash your process, you need to listen for error event on PKCRpcWsServer", error);
        this.emit("error", error);
    }

    // SQLite-based state management for auto-start functionality
    private _getRpcStateDb(): BetterSqlite3Database | undefined {
        if (this._rpcStateDb) return this._rpcStateDb;
        const dataPath = this.plebbit.dataPath;
        if (!dataPath) return undefined;

        const rpcServerDir = path.join(dataPath, "rpc-server");
        mkdirSync(rpcServerDir, { recursive: true });
        const dbPath = path.join(rpcServerDir, "rpc-state.db");
        this._rpcStateDb = new Database(dbPath);
        this._rpcStateDb.pragma("journal_mode = WAL");
        this._rpcStateDb.exec(`
            CREATE TABLE IF NOT EXISTS subplebbit_states (
                address TEXT PRIMARY KEY,
                wasStarted INTEGER NOT NULL DEFAULT 0,
                wasExplicitlyStopped INTEGER NOT NULL DEFAULT 0
            )
        `);
        return this._rpcStateDb;
    }

    private _updateCommunityState(address: string, update: Partial<RpcCommunityState>): void {
        const db = this._getRpcStateDb();
        if (!db) return;
        // Ensure row exists with defaults (INSERT OR IGNORE won't fail if row already exists)
        db.prepare("INSERT OR IGNORE INTO subplebbit_states (address) VALUES (?)").run(address);
        // Update only the specified fields
        if (update.wasStarted !== undefined) {
            db.prepare("UPDATE subplebbit_states SET wasStarted = ? WHERE address = ?").run(update.wasStarted ? 1 : 0, address);
        }
        if (update.wasExplicitlyStopped !== undefined) {
            db.prepare("UPDATE subplebbit_states SET wasExplicitlyStopped = ? WHERE address = ?").run(
                update.wasExplicitlyStopped ? 1 : 0,
                address
            );
        }
    }

    private _removeCommunityState(address: string): void {
        const db = this._getRpcStateDb();
        if (!db) return;
        db.prepare("DELETE FROM subplebbit_states WHERE address = ?").run(address);
    }

    async _autoStartPreviousCommunitys(): Promise<void> {
        if (!this._autoStartOnBoot) return;

        const autoStartLog = Logger("pkc-js-rpc:pkc-ws-server:auto-start");
        autoStartLog("Checking for previously started subplebbits to auto-start");

        const db = this._getRpcStateDb();
        if (!db) return;

        const rows = db.prepare("SELECT address FROM subplebbit_states WHERE wasStarted = 1 AND wasExplicitlyStopped = 0").all() as {
            address: string;
        }[];

        const plebbit = await this._getPKCInstance();
        const localSubs = plebbit.subplebbits;

        for (const row of rows) {
            if (!localSubs.includes(row.address)) {
                autoStartLog(`Skipping auto-start for ${row.address} - subplebbit no longer exists`);
                this._removeCommunityState(row.address);
                continue;
            }

            if (row.address in this._startedCommunitys) {
                autoStartLog(`Skipping auto-start for ${row.address} - already started`);
                continue;
            }

            autoStartLog(`Auto-starting subplebbit: ${row.address}`);
            try {
                await this._internalStartCommunity(row.address);
                autoStartLog(`Successfully auto-started: ${row.address}`);
            } catch (e) {
                autoStartLog.error(`Failed to auto-start subplebbit ${row.address}`, e);
                this._emitError(e instanceof Error ? e : new Error(`Failed to auto-start ${row.address}: ${String(e)}`));
            }
        }
    }

    private async _internalStartCommunity(address: string): Promise<LocalCommunity> {
        const plebbit = await this._getPKCInstance();

        this._startedCommunitys[address] = "pending";
        try {
            const subplebbit = <LocalCommunity>await plebbit.createCommunity({ address });
            subplebbit.started = true;
            await subplebbit.start();
            this._startedCommunitys[address] = subplebbit;
            this._updateCommunityState(address, { wasStarted: true, wasExplicitlyStopped: false });
            return subplebbit;
        } catch (e) {
            delete this._startedCommunitys[address];
            throw e;
        }
    }

    // util function to log errors of registered methods
    rpcWebsocketsRegister(method: string, callback: Function) {
        const callbackWithErrorHandled = async (params: any, connectionId: string) => {
            try {
                const res = await callback(params, connectionId);
                return res;
            } catch (e: any) {
                const typedError = <PKCError | Error>e;
                log.error(`${callback.name} error`, { params, error: typedError });
                // We need to stringify the error here because rpc-websocket will remove props from PKCError
                if (typedError instanceof PKCError) {
                    const errorJson = JSON.parse(JSON.stringify(typedError));
                    delete errorJson["stack"];
                    throw errorJson;
                } else throw typedError;
            }
        };
        this.rpcWebsockets.register(method, callbackWithErrorHandled);

        // register localhost:9138/<auth-key> to bypass block on non-localhost requests, using /<auth-key> as namespace
        if (this.authKey) {
            this.rpcWebsockets.register(method, callbackWithErrorHandled, `/${this.authKey}`);
        }
    }

    // send json rpc notification message (no id field, but must have subscription id)
    jsonRpcSendNotification({ method, result, subscription, event, connectionId }: JsonRpcSendNotificationOptions) {
        const message = {
            jsonrpc: "2.0",
            method,
            params: {
                result: sanitizeRpcNotificationResult(event, result),
                subscription,
                event
            }
        };
        this.connections[connectionId]?.send?.(JSON.stringify(message));
    }

    private _registerPublishing(subscriptionId: number, publication: Publication, plebbit: PKC, connectionId: string) {
        this.publishing[subscriptionId] = { publication, plebbit, connectionId };
    }

    private _clearPublishing(subscriptionId: number) {
        const record = this.publishing[subscriptionId];
        if (record?.timeout) clearTimeout(record.timeout);
        delete this.publishing[subscriptionId];
    }

    private async _forceCleanupPublication(subscriptionId: number, reason: string) {
        const record = this.publishing[subscriptionId];
        if (!record) return;
        const cleanup = await this.subscriptionCleanups?.[record.connectionId]?.[subscriptionId];
        log(`Force-cleaning publication ${subscriptionId} after ${reason}`);
        if (cleanup) {
            await cleanup();
            if (this.subscriptionCleanups?.[record.connectionId]) delete this.subscriptionCleanups[record.connectionId][subscriptionId];
        }
        this._clearPublishing(subscriptionId);
        await this._retirePKCIfNeeded(record.plebbit);
    }

    private async _retirePKCIfNeeded(plebbit: PKC) {
        const activePublishes = Object.values(this.publishing).filter(({ plebbit: p }) => p === plebbit).length;
        if (activePublishes === 0 && !plebbit.destroyed) {
            // nothing relies on this instance anymore
            await plebbit.destroy().catch((error) => log.error("Failed destroying old plebbit immediately after setSettings", { error }));
            return;
        }
    }

    async _getPKCInstance() {
        await this._setSettingsQueue;
        return this.plebbit;
    }

    async getComment(params: any): Promise<CommentIpfsType> {
        const getCommentArgs = parseRpcCidParam(params[0]);
        const comment = await (await this._getPKCInstance()).getComment(getCommentArgs);
        // TODO may need to be changed later
        return comment.raw.comment!;
    }

    async getCommunityPage(params: any) {
        const { cid: pageCid, subplebbitAddress, type, pageMaxSize } = parseRpcCommunityPageParam(params[0]);
        const plebbit = await this._getPKCInstance();

        // Use started subplebbit to fetch the page if possible, to expediete the process
        const sub =
            subplebbitAddress in this._startedCommunitys
                ? await this.getStartedCommunity(subplebbitAddress)
                : <RemoteCommunity | LocalCommunity>await plebbit.createCommunity({ address: subplebbitAddress });
        const { page } =
            type === "posts"
                ? await sub.posts._fetchAndVerifyPage({ pageCid, pageMaxSize })
                : await sub.modQueue._fetchAndVerifyPage({ pageCid, pageMaxSize });
        const runtimeFields = buildPageRuntimeFields(page, plebbit._memCaches.nameResolvedCache);
        return { page, runtimeFields };
    }

    async getCommentPage(params: any) {
        const { cid: pageCid, commentCid, subplebbitAddress, pageMaxSize } = parseRpcCommentRepliesPageParam(params[0]);
        const plebbit = await this._getPKCInstance();
        const comment = await plebbit.createComment({ cid: commentCid, subplebbitAddress });
        const { page } = await comment.replies._fetchAndVerifyPage({ pageCid, pageMaxSize });
        const runtimeFields = buildPageRuntimeFields(page, plebbit._memCaches.nameResolvedCache);
        return { page, runtimeFields };
    }

    async createCommunity(params: any) {
        const createCommunityOptions = parseCreateNewLocalCommunityUserOptionsSchemaWithPKCErrorIfItFails(params[0]);
        const plebbit = await this._getPKCInstance();
        const subplebbit = <LocalCommunity>await plebbit.createCommunity(createCommunityOptions);
        if (!(subplebbit instanceof LocalCommunity)) throw Error("Failed to create a local subplebbit. This is a critical error");
        return subplebbit.toJSONInternalRpcBeforeFirstUpdate();
    }

    private _trackCommunityListener(subplebbit: LocalCommunity, event: keyof CommunityEvents, listener: (...args: any[]) => void) {
        let listenersByEvent = this._trackedCommunityListeners.get(subplebbit);
        if (!listenersByEvent) {
            listenersByEvent = new Map();
            this._trackedCommunityListeners.set(subplebbit, listenersByEvent);
        }

        let listeners = listenersByEvent.get(event);
        if (!listeners) {
            listeners = new Set();
            listenersByEvent.set(event, listeners);
        }

        listeners.add(listener);
    }

    private _untrackCommunityListener(subplebbit: LocalCommunity, event: keyof CommunityEvents, listener: (...args: any[]) => void) {
        const listenersByEvent = this._trackedCommunityListeners.get(subplebbit);
        if (!listenersByEvent) return;

        const listeners = listenersByEvent.get(event);
        if (!listeners) return;

        listeners.delete(listener);
        if (listeners.size === 0) listenersByEvent.delete(event);
        if (listenersByEvent.size === 0) this._trackedCommunityListeners.delete(subplebbit);
    }

    _setupStartedEvents(subplebbit: LocalCommunity, connectionId: string, subscriptionId: number) {
        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({ method: "startCommunity", subscription: subscriptionId, event, result, connectionId });

        const getUpdateJson = () =>
            typeof subplebbit.updatedAt === "number"
                ? subplebbit.toJSONInternalRpcAfterFirstUpdate()
                : subplebbit.toJSONInternalRpcBeforeFirstUpdate();
        const updateListener = () => {
            const json = getUpdateJson();
            // Merge preloaded page runtimeFields into existing runtimeFields
            const subIpfs = subplebbit.raw.subplebbitIpfs;
            if (subIpfs?.posts?.pages && "runtimeFields" in json && json.runtimeFields) {
                Object.assign(json.runtimeFields, {
                    posts: { pages: buildPagesRuntimeFields(subIpfs.posts.pages, subplebbit._plebbit._memCaches.nameResolvedCache) }
                });
            }
            sendEvent("update", json);
        };
        subplebbit.on("update", updateListener);
        this._trackCommunityListener(subplebbit, "update", updateListener);

        const startedStateListener = () => sendEvent("startedstatechange", { state: subplebbit.startedState });
        subplebbit.on("startedstatechange", startedStateListener);
        this._trackCommunityListener(subplebbit, "startedstatechange", startedStateListener);

        const requestListener = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        subplebbit.on("challengerequest", requestListener);
        this._trackCommunityListener(subplebbit, "challengerequest", requestListener);

        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        subplebbit.on("challenge", challengeListener);
        this._trackCommunityListener(subplebbit, "challenge", challengeListener);

        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        subplebbit.on("challengeanswer", challengeAnswerListener);
        this._trackCommunityListener(subplebbit, "challengeanswer", challengeAnswerListener);

        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        subplebbit.on("challengeverification", challengeVerificationListener);
        this._trackCommunityListener(subplebbit, "challengeverification", challengeVerificationListener);

        const errorListener = (error: PKCError | Error) => {
            const rpcError = error as CommunityRpcErrorToTransmit;
            if (subplebbit.state === "started") rpcError.details = { ...rpcError.details, newStartedState: subplebbit.startedState };
            else if (subplebbit.state === "updating")
                rpcError.details = { ...rpcError.details, newUpdatingState: subplebbit.updatingState };
            log("subplebbit rpc error", rpcError);
            sendEvent("error", rpcError);
        };
        subplebbit.on("error", errorListener);
        this._trackCommunityListener(subplebbit, "error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            subplebbit.removeListener("update", updateListener);
            this._untrackCommunityListener(subplebbit, "update", updateListener);
            subplebbit.removeListener("startedstatechange", startedStateListener);
            this._untrackCommunityListener(subplebbit, "startedstatechange", startedStateListener);
            subplebbit.removeListener("challengerequest", requestListener);
            this._untrackCommunityListener(subplebbit, "challengerequest", requestListener);
            subplebbit.removeListener("challenge", challengeListener);
            this._untrackCommunityListener(subplebbit, "challenge", challengeListener);
            subplebbit.removeListener("challengeanswer", challengeAnswerListener);
            this._untrackCommunityListener(subplebbit, "challengeanswer", challengeAnswerListener);
            subplebbit.removeListener("challengeverification", challengeVerificationListener);
            this._untrackCommunityListener(subplebbit, "challengeverification", challengeVerificationListener);
            subplebbit.removeListener("error", errorListener);
            this._untrackCommunityListener(subplebbit, "error", errorListener);
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };
    }

    async startCommunity(params: any, connectionId: string) {
        const { address } = parseRpcCommunityAddressParam(params[0]);
        const plebbit = await this._getPKCInstance();

        const localSubs = plebbit.subplebbits;
        if (!localSubs.includes(address))
            throw new PKCError("ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_COMMUNITY", { subplebbitAddress: address });

        const subscriptionId = generateSubscriptionId();

        const startSub = async () => {
            const plebbit = await this._getPKCInstance();
            const isSubStarted = address in this._startedCommunitys;
            if (isSubStarted) {
                const subplebbit = await this.getStartedCommunity(address);
                this._setupStartedEvents(subplebbit, connectionId, subscriptionId);
            } else {
                try {
                    this._startedCommunitys[address] = "pending";
                    const subplebbit = <LocalCommunity>await plebbit.createCommunity({ address });
                    this._setupStartedEvents(subplebbit, connectionId, subscriptionId);
                    subplebbit.started = true; // a small hack to make sure first update has started=true
                    subplebbit.emit("update", subplebbit); // Need to emit an update so rpc user can receive sub props prior to running
                    await subplebbit.start();
                    this._startedCommunitys[address] = subplebbit;
                    this._updateCommunityState(address, { wasStarted: true, wasExplicitlyStopped: false });
                } catch (e) {
                    const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
                    if (cleanup) await cleanup();
                    delete this._startedCommunitys[address];
                    throw e;
                }
            }
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPKC }: { newPKC: PKC }) => {
            const current = this._startedCommunitys[address];
            if (!current || current === "pending") return;
            const subplebbit = await this.getStartedCommunity(address);
            // mark as pending so other consumers wait while we restart with the new plebbit instance
            this._startedCommunitys[address] = "pending";
            try {
                await subplebbit.stop();
                subplebbit._plebbit = newPKC;
                await subplebbit.start();
                this._startedCommunitys[address] = subplebbit;
            } catch (error) {
                delete this._startedCommunitys[address];
                throw error;
            }
        };

        await startSub();

        return subscriptionId;
    }

    async stopCommunity(params: any) {
        const { address } = parseRpcCommunityAddressParam(params[0]);
        const plebbit = await this._getPKCInstance();

        const localSubs = plebbit.subplebbits;
        if (!localSubs.includes(address))
            throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_COMMUNITY", { subplebbitAddress: address });
        const isSubStarted = address in this._startedCommunitys;
        if (!isSubStarted)
            throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_STOP_COMMUNITY_THAT_IS_NOT_RUNNING", { subplebbitAddress: address });
        const startedCommunity = await this.getStartedCommunity(address);
        await startedCommunity.stop();
        // emit last updates so subscribed instances can set their state to stopped
        await this._postStoppingOrDeleting(startedCommunity);
        delete this._startedCommunitys[address];
        this._updateCommunityState(address, { wasExplicitlyStopped: true });

        return true;
    }

    private async _postStoppingOrDeleting(subplebbit: LocalCommunity) {
        // emit the last updates
        // remove all listeners
        subplebbit.emit("update", subplebbit);
        subplebbit.emit("startedstatechange", subplebbit.startedState);

        const trackedListeners = this._trackedCommunityListeners.get(subplebbit);
        if (trackedListeners) {
            for (const [event, listeners] of trackedListeners) {
                for (const listener of listeners) {
                    subplebbit.removeListener(event, listener);
                }
            }
            this._trackedCommunityListeners.delete(subplebbit);
        }
    }

    async editCommunity(params: any) {
        const rawParam = params[0];
        rawParam.editOptions = replaceXWithY(rawParam.editOptions, null, undefined);
        const { address, editOptions } = parseRpcEditCommunityParam(rawParam);
        const editCommunityOptions = parseCommunityEditOptionsSchemaWithPKCErrorIfItFails(editOptions);
        const plebbit = await this._getPKCInstance();

        const localSubs = plebbit.subplebbits;
        if (!localSubs.includes(address))
            throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_COMMUNITY", { subplebbitAddress: address });
        let subplebbit: LocalCommunity;
        if (this._startedCommunitys[address] instanceof LocalCommunity) subplebbit = <LocalCommunity>this._startedCommunitys[address];
        else {
            subplebbit = <LocalCommunity>await plebbit.createCommunity({ address });
            subplebbit.once("error", (error: PKCError | Error) => {
                log.error("RPC server Received an error on subplebbit", subplebbit.address, "edit", error);
            });
        }

        await subplebbit.edit(editCommunityOptions);
        if (editCommunityOptions.address && this._startedCommunitys[address]) {
            // if (editCommunityOptions.address && this._startedCommunitys[address] && editCommunityOptions.address !== address) {
            this._startedCommunitys[editCommunityOptions.address] = this._startedCommunitys[address];
            delete this._startedCommunitys[address];

            // Update RPC state with new address
            const db = this._getRpcStateDb();
            if (db) {
                db.prepare("UPDATE subplebbit_states SET address = @newAddress WHERE address = @oldAddress").run({
                    newAddress: editCommunityOptions.address,
                    oldAddress: address
                });
            }
        }
        if (typeof subplebbit.updatedAt === "number") return subplebbit.toJSONInternalRpcAfterFirstUpdate();
        else return subplebbit.toJSONInternalRpcBeforeFirstUpdate();
    }

    async deleteCommunity(params: any) {
        const { address } = parseRpcCommunityAddressParam(params[0]);
        const plebbit = await this._getPKCInstance();

        const addresses = plebbit.subplebbits;
        if (!addresses.includes(address))
            throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_COMMUNITY", { subplebbitAddress: address });

        const isSubStarted = address in this._startedCommunitys;
        const subplebbit = isSubStarted
            ? await this.getStartedCommunity(address)
            : <LocalCommunity>await plebbit.createCommunity({ address });
        await subplebbit.delete();
        await this._postStoppingOrDeleting(subplebbit);
        delete this._startedCommunitys[address];
        this._removeCommunityState(address);

        return true;
    }

    async subplebbitsSubscribe(params: any, connectionId: string) {
        // TODO need to implement _onSettingsChange here
        const subscriptionId = generateSubscriptionId();
        const sendEvent = (event: string, result: any) => {
            this.jsonRpcSendNotification({
                method: "subplebbitsNotification",
                subscription: Number(subscriptionId),
                event,
                result,
                connectionId
            });
        };

        const plebbitSubscribeEvent = (newSubs: string[]) => sendEvent("subplebbitschange", { subplebbits: newSubs });

        const plebbit = await this._getPKCInstance();
        plebbit.on("subplebbitschange", plebbitSubscribeEvent);

        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            plebbit.removeListener("subplebbitschange", plebbitSubscribeEvent);
        };

        sendEvent("subplebbitschange", { subplebbits: plebbit.subplebbits });

        return subscriptionId;
    }

    async fetchCid(params: any) {
        const parsedArgs = parseRpcCidParam(params[0]);
        const plebbit = await this._getPKCInstance();
        const res = await plebbit.fetchCid(parsedArgs);
        if (typeof res !== "string") throw Error("Result of fetchCid should be a string");
        return { content: res };
    }

    private _serializeSettingsFromPKC(plebbit: PKC): PKCWsServerSettingsSerialized {
        const plebbitOptions = plebbit.parsedPKCOptions;
        const builtInChallenges = PKCJs.PKC.challenges || {};
        const allChallengeFactories = {
            ...builtInChallenges, // built-ins first
            ...(plebbit.settings?.challenges || {}) // user-defined override
        };
        const challenges = remeda.mapValues(allChallengeFactories, (challengeFactory) =>
            remeda.omit(challengeFactory({ challengeSettings: {} }), ["getChallenge"])
        );

        return <PKCWsServerSettingsSerialized>{ plebbitOptions, challenges };
    }

    async settingsSubscribe(params: any, connectionId: string): Promise<number> {
        const subscriptionId = generateSubscriptionId();
        const sendEvent = (event: string, result: any) => {
            this.jsonRpcSendNotification({
                method: "settingsNotification",
                subscription: Number(subscriptionId),
                event,
                result,
                connectionId
            });
        };

        const sendRpcSettings = async ({ newPKC }: { newPKC: PKC }) => {
            sendEvent("settingschange", this._serializeSettingsFromPKC(newPKC));
        };

        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };

        this._onSettingsChange[connectionId][subscriptionId] = sendRpcSettings;
        await sendRpcSettings({ newPKC: this.plebbit });

        return subscriptionId;
    }

    private _initPKC(plebbit: PKC) {
        this.plebbit = plebbit;
        plebbit.on("error", (error: any) => log.error("RPC server", "Received an error on plebbit instance", error));
    }

    private async _createPKCInstanceFromSetSettings(newOptions: InputPKCOptions) {
        return PKCJs.PKC(newOptions);
    }

    async setSettings(params: any) {
        const runSetSettings = async () => {
            const settings = parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(params[0]);
            const currentSettings = this._serializeSettingsFromPKC(this.plebbit);
            if (deterministicStringify(settings.plebbitOptions) === deterministicStringify(currentSettings.plebbitOptions)) {
                log("RPC client called setSettings with the same settings as the current one, aborting");
                return;
            }

            log(`RPC client called setSettings, the clients need to call all subscription methods again`);
            const oldPKC = this.plebbit;
            // Strip nameResolvers from client settings — RPC server ignores them for now
            const { nameResolvers: _stripNr, ...plebbitOptionsWithoutNameResolvers } = settings.plebbitOptions;
            const newPKC = await this._createPKCInstanceFromSetSettings({
                ...plebbitOptionsWithoutNameResolvers,
                nameResolvers: this.plebbit.parsedPKCOptions.nameResolvers
            } as InputPKCOptions);
            this._initPKC(newPKC); // swap to new instance first so new RPC calls don't hit a destroyed plebbit

            // send a settingsNotification to all subscribers
            for (const connectionId of remeda.keys.strict(this._onSettingsChange)) {
                const connectionHandlers = this._onSettingsChange[connectionId];
                if (!connectionHandlers) continue;
                for (const subscriptionId of remeda.keys.strict(connectionHandlers)) {
                    const handler = connectionHandlers[subscriptionId];
                    if (handler) await handler({ newPKC });
                }
            }

            // ensure any existing publications get a timeout if they were created before the first setSettings
            for (const [subscriptionId, pub] of Object.entries(this.publishing).filter((pub) => pub[1].plebbit === oldPKC)) {
                pub.timeout = setTimeout(async () => {
                    await this._forceCleanupPublication(Number(subscriptionId), "timeout");
                }, 60000);
            }

            setTimeout(async () => {
                await this._retirePKCIfNeeded(oldPKC);
            }, 60000); // set this in a timeout because createCommunity may be using it
        };

        const setSettingsRun = this._setSettingsQueue.then(() => runSetSettings());
        // keep queue usable even if a run fails; error still propagates to the caller via setSettingsRun
        this._setSettingsQueue = setSettingsRun.catch(() => {});
        await setSettingsRun;
        return true;
    }

    async commentUpdateSubscribe(params: any, connectionId: string) {
        const logUpdate = Logger("pkc-js-rpc:pkc-ws-server:commentUpdateSubscribe");
        const parsedCommentUpdateArgs = parseRpcCidParam(params[0]);
        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "commentUpdateNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        let sentCommentIpfsUpdateEvent = false;
        let lastSentNameResolved: boolean | undefined = undefined;
        const plebbit = await this._getPKCInstance();
        const comment = await plebbit.createComment(parsedCommentUpdateArgs);
        const sendUpdate = () => {
            if (!sentCommentIpfsUpdateEvent && comment.raw.comment) {
                sendEvent("comment", {
                    comment: comment.raw.comment,
                    runtimeFields: { author: { nameResolved: comment.author.nameResolved } }
                });
                sentCommentIpfsUpdateEvent = true;
                lastSentNameResolved = comment.author.nameResolved;
            }
            if (comment.raw.commentUpdate) {
                const updateEvent: RpcCommentUpdateResultType = { commentUpdate: comment.raw.commentUpdate };
                const runtimeFields: NonNullable<RpcCommentUpdateResultType["runtimeFields"]> = {};
                if (comment.raw.commentUpdate.replies?.pages) {
                    runtimeFields.replies = {
                        pages: buildPagesRuntimeFields(comment.raw.commentUpdate.replies.pages, plebbit._memCaches.nameResolvedCache)
                    };
                }
                if (typeof comment.author.nameResolved === "boolean") {
                    runtimeFields.author = { nameResolved: comment.author.nameResolved };
                }
                if (Object.keys(runtimeFields).length > 0) {
                    updateEvent.runtimeFields = runtimeFields;
                }
                sendEvent("update", updateEvent);
                lastSentNameResolved = comment.author.nameResolved;
            } else if (
                sentCommentIpfsUpdateEvent &&
                typeof comment.author.nameResolved === "boolean" &&
                comment.author.nameResolved !== lastSentNameResolved
            ) {
                // nameResolved changed but no commentUpdate to piggyback on — send dedicated runtimeupdate event
                sendEvent("runtimeupdate", { author: { nameResolved: comment.author.nameResolved } });
                lastSentNameResolved = comment.author.nameResolved;
            }
        };
        const updateListener = () => sendUpdate();
        comment.on("update", updateListener);

        const updatingStateListener = () => sendEvent("updatingstatechange", { state: comment.updatingState });
        comment.on("updatingstatechange", updatingStateListener);

        const stateListener = () => sendEvent("statechange", { state: comment.state });
        comment.on("statechange", stateListener);

        const errorListener = (error: PKCError | Error) => {
            const errorWithNewUpdatingState = error as CommentRpcErrorToTransmit;
            if (comment.state === "publishing")
                errorWithNewUpdatingState.details = { ...errorWithNewUpdatingState.details, newPublishingState: comment.publishingState };
            else if (comment.state === "updating")
                errorWithNewUpdatingState.details = { ...errorWithNewUpdatingState.details, newUpdatingState: comment.updatingState };
            sendEvent("error", errorWithNewUpdatingState);
        };
        comment.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            logUpdate("Cleaning up commentUpdate subscription", { subscriptionId, connectionId, cid: comment.cid });
            comment.removeListener("update", updateListener);
            comment.removeListener("updatingstatechange", updatingStateListener);
            comment.removeListener("statechange", stateListener);
            comment.removeListener("error", errorListener);
            await comment.stop();
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPKC }: { newPKC: PKC }) => {
            // TODO need to clean up and remove old comment here, and create a new comment
            comment._plebbit = newPKC;
            await comment.update();
        };

        // if fail, cleanup
        try {
            sendUpdate();
            await comment.update();
        } catch (e) {
            logUpdate.error("Cleaning up subscription to comment", comment.cid, "because comment.update threw an error", e);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
            throw e;
        }

        return subscriptionId;
    }

    async subplebbitUpdateSubscribe(params: any, connectionId: string) {
        const parsedCommunityUpdateArgs = parseRpcCommunityLookupParam(params[0]);
        const subscriptionId = generateSubscriptionId();

        await this._bindCommunityUpdateSubscription(parsedCommunityUpdateArgs, connectionId, subscriptionId);

        return subscriptionId;
    }

    private async _bindCommunityUpdateSubscription(parsedArgs: CommunityLookupRpcParam, connectionId: string, subscriptionId: number) {
        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "subplebbitUpdateNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const plebbit = await this._getPKCInstance();
        const startedCommunity = findStartedCommunity(plebbit, parsedArgs);
        const isStartedCommunity = Boolean(startedCommunity);
        const subplebbit = startedCommunity || <LocalCommunity | RemoteCommunity>await plebbit.createCommunity(parsedArgs);

        const sendSubJson = () => {
            let jsonToSend:
                | RpcRemoteCommunityType
                | RpcInternalCommunityRecordAfterFirstUpdateType
                | RpcInternalCommunityRecordBeforeFirstUpdateType;
            if (subplebbit instanceof LocalCommunity)
                jsonToSend =
                    typeof subplebbit.updatedAt === "number"
                        ? subplebbit.toJSONInternalRpcAfterFirstUpdate()
                        : subplebbit.toJSONInternalRpcBeforeFirstUpdate();
            else jsonToSend = subplebbit.toJSONRpcRemote();

            // Merge preloaded page runtimeFields into existing runtimeFields
            const subIpfs = subplebbit.raw.subplebbitIpfs;
            if (subIpfs?.posts?.pages && "runtimeFields" in jsonToSend && jsonToSend.runtimeFields) {
                Object.assign(jsonToSend.runtimeFields, {
                    posts: { pages: buildPagesRuntimeFields(subIpfs.posts.pages, plebbit._memCaches.nameResolvedCache) }
                });
            }

            sendEvent("update", jsonToSend);
        };

        const updateListener = () => sendSubJson();
        subplebbit.on("update", updateListener);

        const updatingStateListener = () => sendEvent("updatingstatechange", { state: subplebbit.updatingState });
        subplebbit.on("updatingstatechange", updatingStateListener);

        // listener for startestatechange
        const startedStateListener = () => sendEvent("updatingstatechange", { state: subplebbit.startedState });
        if (isStartedCommunity) {
            subplebbit.on("startedstatechange", startedStateListener);
        }

        const errorListener = (error: PKCError | Error) => {
            const rpcError = error as CommunityRpcErrorToTransmit;
            if (subplebbit.state === "started") rpcError.details = { ...rpcError.details, newStartedState: subplebbit.startedState };
            else if (subplebbit.state === "updating")
                rpcError.details = { ...rpcError.details, newUpdatingState: subplebbit.updatingState };
            log("subplebbit rpc error", rpcError);
            sendEvent("error", rpcError);
        };
        subplebbit.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            log("Cleaning up subplebbit", subplebbit.address, "client subscription");
            subplebbit.removeListener("update", updateListener);
            subplebbit.removeListener("updatingstatechange", updatingStateListener);
            subplebbit.removeListener("error", errorListener);
            subplebbit.removeListener("startedstatechange", startedStateListener);
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];

            // We don't wanna stop the local sub if it's running already, this function is just for fetching updates
            // if we comment this out remove test passes
            if (!isStartedCommunity && subplebbit.state !== "stopped") await subplebbit.stop();
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPKC }: { newPKC: PKC }) => {
            // TODO this may need changing
            if (!isStartedCommunity) {
                subplebbit._plebbit = newPKC;
                await subplebbit.stop();
                await subplebbit.update();
            }
        };

        // if fail, cleanup
        try {
            // need to send an update with first subplebbitUpdate if it's a local sub
            if ("signer" in subplebbit || subplebbit.raw.subplebbitIpfs) sendSubJson();

            // No need to call .update() if it's already running locally because we're listening to update event
            if (!isStartedCommunity) await subplebbit.update();
        } catch (e) {
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
            throw e;
        }
    }

    private async _createCommentInstanceFromPublishCommentParams(params: CommentChallengeRequestToEncryptType) {
        const plebbit = await this._getPKCInstance();
        const comment = await plebbit.createComment(params.comment);
        comment.challengeRequest = remeda.omit(params, ["comment"]);
        return comment;
    }

    async publishComment(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommentChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(params[0]);

        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "publishCommentNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const comment = await this._createCommentInstanceFromPublishCommentParams(publishOptions);
        this._registerPublishing(subscriptionId, comment, comment._plebbit, connectionId);
        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        comment.on("challenge", challengeListener);

        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        comment.on("challengeanswer", challengeAnswerListener);

        const challengeRequestListener = (request: DecryptedChallengeRequestMessageType) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        comment.on("challengerequest", challengeRequestListener);

        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification),
                runtimeFields: { author: { nameResolved: comment.author.nameResolved } }
            });
        comment.on("challengeverification", challengeVerificationListener);

        const publishingStateListener = () => {
            sendEvent("publishingstatechange", { state: comment.publishingState });
        };
        comment.on("publishingstatechange", publishingStateListener);

        const stateListener = () => sendEvent("statechange", { state: comment.state });
        comment.on("statechange", stateListener);

        const errorListener = (error: PKCError | Error) => {
            const commentRpcError = error as CommentRpcErrorToTransmit;
            commentRpcError.details = {
                ...commentRpcError.details,
                newPublishingState: comment.publishingState
            };
            sendEvent("error", commentRpcError);
        };
        comment.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            comment.removeListener("challenge", challengeListener);
            comment.removeListener("challengeanswer", challengeAnswerListener);
            comment.removeListener("challengerequest", challengeRequestListener);
            comment.removeListener("challengeverification", challengeVerificationListener);
            comment.removeListener("publishingstatechange", publishingStateListener);
            comment.removeListener("statechange", stateListener);
            comment.removeListener("error", errorListener);
            await comment.stop();
            this._clearPublishing(subscriptionId);
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };

        // if fail, cleanup

        try {
            await comment.publish();
        } catch (e) {
            const error = e as PublicationRpcErrorToTransmit;
            error.details = { ...error.details, publishThrowError: true };
            errorListener(error);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
            return subscriptionId;
        }

        return subscriptionId;
    }

    private async _createVoteInstanceFromPublishVoteParams(params: VoteChallengeRequestToEncryptType) {
        const plebbit = await this._getPKCInstance();
        const vote = await plebbit.createVote(params.vote);
        vote.challengeRequest = remeda.omit(params, ["vote"]);
        return vote;
    }
    async publishVote(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseVoteChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(params[0]);

        // TODO need to think, what happens if user never sends a unsubsribe call?
        // publication will never get removed from this.publishing
        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({ method: "publishVoteNotification", subscription: subscriptionId, event, result, connectionId });

        const vote = await this._createVoteInstanceFromPublishVoteParams(publishOptions);
        this._registerPublishing(subscriptionId, vote, vote._plebbit, connectionId);
        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        vote.on("challenge", challengeListener);
        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        vote.on("challengeanswer", challengeAnswerListener);
        const challengeRequestListener = (request: DecryptedChallengeRequestMessageType) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        vote.on("challengerequest", challengeRequestListener);
        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        vote.on("challengeverification", challengeVerificationListener);
        const publishingStateListener = () => sendEvent("publishingstatechange", { state: vote.publishingState });
        vote.on("publishingstatechange", publishingStateListener);

        const errorListener = (error: PKCError | Error) => {
            const voteRpcError = error as PublicationRpcErrorToTransmit;
            voteRpcError.details = { ...voteRpcError.details, newPublishingState: vote.publishingState };
            sendEvent("error", voteRpcError);
        };
        vote.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            this._clearPublishing(subscriptionId);
            await vote.stop();
            vote.removeListener("challenge", challengeListener);
            vote.removeListener("challengeanswer", challengeAnswerListener);
            vote.removeListener("challengerequest", challengeRequestListener);
            vote.removeListener("challengeverification", challengeVerificationListener);
            vote.removeListener("publishingstatechange", publishingStateListener);
            vote.removeListener("error", errorListener);
        };

        // if fail, cleanup
        try {
            await vote.publish();
        } catch (e) {
            const error = e as PublicationRpcErrorToTransmit;
            error.details = { ...error.details, publishThrowError: true };
            errorListener(error);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
        }

        return subscriptionId;
    }

    private async _createCommunityEditInstanceFromPublishCommunityEditParams(params: CommunityEditChallengeRequestToEncryptType) {
        const plebbit = await this._getPKCInstance();
        const subplebbitEdit = await plebbit.createCommunityEdit(params.subplebbitEdit);
        subplebbitEdit.challengeRequest = remeda.omit(params, ["subplebbitEdit"]);
        return subplebbitEdit;
    }

    async publishCommunityEdit(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommunityEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(params[0]);

        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "publishCommunityEditNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const subplebbitEdit = await this._createCommunityEditInstanceFromPublishCommunityEditParams(publishOptions);
        this._registerPublishing(subscriptionId, subplebbitEdit, subplebbitEdit._plebbit, connectionId);
        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        subplebbitEdit.on("challenge", challengeListener);
        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        subplebbitEdit.on("challengeanswer", challengeAnswerListener);
        const challengeRequestListener = (request: DecryptedChallengeRequestMessageType) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        subplebbitEdit.on("challengerequest", challengeRequestListener);
        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        subplebbitEdit.on("challengeverification", challengeVerificationListener);
        const publishingStateListener = () => sendEvent("publishingstatechange", { state: subplebbitEdit.publishingState });
        subplebbitEdit.on("publishingstatechange", publishingStateListener);

        const errorListener = (error: PKCError | Error) => {
            const editRpcError = error as PublicationRpcErrorToTransmit;
            editRpcError.details = { ...editRpcError.details, newPublishingState: subplebbitEdit.publishingState };
            sendEvent("error", editRpcError);
        };
        subplebbitEdit.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            this._clearPublishing(subscriptionId);
            await subplebbitEdit.stop();
            subplebbitEdit.removeListener("challenge", challengeListener);
            subplebbitEdit.removeListener("challengeanswer", challengeAnswerListener);
            subplebbitEdit.removeListener("challengerequest", challengeRequestListener);
            subplebbitEdit.removeListener("challengeverification", challengeVerificationListener);
            subplebbitEdit.removeListener("publishingstatechange", publishingStateListener);
            subplebbitEdit.removeListener("error", errorListener);
        };

        // if fail, cleanup
        try {
            await subplebbitEdit.publish();
        } catch (e) {
            const error = e as PublicationRpcErrorToTransmit;
            error.details = { ...error.details, publishThrowError: true };
            errorListener(error);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
        }

        return subscriptionId;
    }

    private async _createCommentEditInstanceFromPublishCommentEditParams(params: CommentEditChallengeRequestToEncryptType) {
        const plebbit = await this._getPKCInstance();
        const commentEdit = await plebbit.createCommentEdit(params.commentEdit);
        commentEdit.challengeRequest = remeda.omit(params, ["commentEdit"]);
        return commentEdit;
    }

    async publishCommentEdit(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommentEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(params[0]);
        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "publishCommentEditNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const commentEdit = await this._createCommentEditInstanceFromPublishCommentEditParams(publishOptions);
        this._registerPublishing(subscriptionId, commentEdit, commentEdit._plebbit, connectionId);
        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        commentEdit.on("challenge", challengeListener);
        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        commentEdit.on("challengeanswer", challengeAnswerListener);
        const challengeRequestListener = (request: DecryptedChallengeRequestMessageType) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        commentEdit.on("challengerequest", challengeRequestListener);
        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        commentEdit.on("challengeverification", challengeVerificationListener);
        const publishingStateListener = () => sendEvent("publishingstatechange", { state: commentEdit.publishingState });
        commentEdit.on("publishingstatechange", publishingStateListener);

        const errorListener = (error: PKCError | Error) => {
            const commentEditRpcError = error as PublicationRpcErrorToTransmit;
            commentEditRpcError.details = {
                ...commentEditRpcError.details,
                newPublishingState: commentEdit.publishingState
            };
            sendEvent("error", commentEditRpcError);
        };
        commentEdit.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            this._clearPublishing(subscriptionId);
            await commentEdit.stop();
            commentEdit.removeListener("challenge", challengeListener);
            commentEdit.removeListener("challengeanswer", challengeAnswerListener);
            commentEdit.removeListener("challengerequest", challengeRequestListener);
            commentEdit.removeListener("challengeverification", challengeVerificationListener);
            commentEdit.removeListener("publishingstatechange", publishingStateListener);
            commentEdit.removeListener("error", errorListener);
        };

        // if fail, cleanup
        try {
            await commentEdit.publish();
        } catch (e) {
            const error = e as PublicationRpcErrorToTransmit;
            error.details = { ...error.details, publishThrowError: true };
            errorListener(error);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
        }

        return subscriptionId;
    }

    private async _createCommentModerationInstanceFromPublishCommentModerationParams(params: CommentModerationChallengeRequestToEncrypt) {
        const plebbit = await this._getPKCInstance();
        const commentModeration = await plebbit.createCommentModeration(params.commentModeration);
        commentModeration.challengeRequest = remeda.omit(params, ["commentModeration"]);
        return commentModeration;
    }

    async publishCommentModeration(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommentModerationChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(params[0]);
        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "publishCommentModerationNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const commentMod = await this._createCommentModerationInstanceFromPublishCommentModerationParams(publishOptions);

        this._registerPublishing(subscriptionId, commentMod, commentMod._plebbit, connectionId);
        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        commentMod.on("challenge", challengeListener);
        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        commentMod.on("challengeanswer", challengeAnswerListener);
        const challengeRequestListener = (request: DecryptedChallengeRequestMessageType) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        commentMod.on("challengerequest", challengeRequestListener);
        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        commentMod.on("challengeverification", challengeVerificationListener);
        const publishingStateListener = () => sendEvent("publishingstatechange", { state: commentMod.publishingState });
        commentMod.on("publishingstatechange", publishingStateListener);

        const errorListener = (error: PKCError | Error) => {
            const commentModRpcError = error as PublicationRpcErrorToTransmit;
            commentModRpcError.details = {
                ...commentModRpcError.details,
                newPublishingState: commentMod.publishingState
            };
            sendEvent("error", commentModRpcError);
        };
        commentMod.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            commentMod.removeListener("challenge", challengeListener);
            commentMod.removeListener("challengeanswer", challengeAnswerListener);
            commentMod.removeListener("challengerequest", challengeRequestListener);
            commentMod.removeListener("challengeverification", challengeVerificationListener);
            commentMod.removeListener("publishingstatechange", publishingStateListener);
            commentMod.removeListener("error", errorListener);
            await commentMod.stop();
            this._clearPublishing(subscriptionId);
        };

        // if fail, cleanup
        try {
            await commentMod.publish();
        } catch (e) {
            const error = e as PublicationRpcErrorToTransmit;
            error.details = { ...error.details, publishThrowError: true };
            errorListener(error);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
        }

        return subscriptionId;
    }

    async publishChallengeAnswers(params: any) {
        const parsed = parseRpcPublishChallengeAnswersParam(params[0]);
        const subscriptionId = parsed.subscriptionId;
        const decryptedChallengeAnswers = parseDecryptedChallengeAnswerWithPKCErrorIfItFails({
            challengeAnswers: parsed.challengeAnswers
        });

        const record = this.publishing[subscriptionId];
        if (!record?.publication) {
            throw Error(`no subscription with id '${subscriptionId}'`);
        }
        const publication = record.publication;

        await this._getPKCInstance(); // to await for settings change

        await publication.publishChallengeAnswers(decryptedChallengeAnswers.challengeAnswers);

        return true;
    }

    async resolveAuthorName(params: any) {
        const parsedArgs = parseRpcAuthorNameParam(params[0]);
        const plebbit = await this._getPKCInstance();
        const resolvedAuthorAddress = await plebbit.resolveAuthorName(parsedArgs);
        return { resolvedAddress: resolvedAuthorAddress };
    }

    async unsubscribe(params: any, connectionId: string) {
        const { subscriptionId } = parseRpcUnsubscribeParam(params[0]);

        log("Received unsubscribe", { connectionId, subscriptionId });
        const connectionCleanups = this.subscriptionCleanups[connectionId];
        if (!connectionCleanups || !connectionCleanups[subscriptionId]) return true;

        await connectionCleanups[subscriptionId](); // commenting this out fixes the timeout with remove.test.js
        delete connectionCleanups[subscriptionId];
        return true;
    }

    async destroy() {
        for (const connectionId of remeda.keys.strict(this.subscriptionCleanups))
            for (const subscriptionId of remeda.keys.strict(this.subscriptionCleanups[connectionId]))
                await this.unsubscribe([{ subscriptionId: Number(subscriptionId) }], connectionId);

        this.ws.close();
        const plebbit = await this._getPKCInstance();
        await plebbit.destroy(); // this will stop all started subplebbits
        for (const subplebbitAddress of remeda.keys.strict(this._startedCommunitys)) {
            delete this._startedCommunitys[subplebbitAddress];
        }
        this._rpcStateDb?.close();
        this._rpcStateDb = undefined;
        this._onSettingsChange = {};
    }
}

const createPKCWsServer = async (options: CreatePKCWsServerOptions) => {
    const parsedOptions = parseCreatePKCWsServerOptionsSchemaWithPKCErrorIfItFails(options);
    const plebbit = await PKCJs.PKC(parsedOptions.plebbitOptions);

    const plebbitWss = new PKCWsServer({
        plebbit,
        port: parsedOptions.port,
        server: parsedOptions.server,
        authKey: parsedOptions.authKey,
        startStartedCommunitysOnStartup: parsedOptions.startStartedCommunitysOnStartup
    });

    // Auto-start previously started subplebbits (fire-and-forget, non-blocking)
    plebbitWss._autoStartPreviousCommunitys().catch((e) => {
        log.error("Failed to auto-start previous subplebbits", e);
    });

    return plebbitWss;
};

const PKCRpc = {
    PKCWsServer: createPKCWsServer,
    // for mocking plebbit-js during tests
    setPKCJs
};

export default PKCRpc;
