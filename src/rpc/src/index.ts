import { Server as RpcWebsocketsServer } from "rpc-websockets";
import { mkdirSync } from "fs";
import path from "path";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import PlebbitJs, { setPlebbitJs } from "./lib/plebbit-js/index.js";
import {
    clone,
    encodeChallengeAnswerMessage,
    encodeChallengeMessage,
    encodeChallengeRequest,
    encodeChallengeVerificationMessage,
    generateSubscriptionId
} from "./utils.js";
import Logger from "@pkc/pkc-logger";
import type {
    PlebbitWsServerClassOptions,
    JsonRpcSendNotificationOptions,
    CreatePlebbitWsServerOptions,
    PlebbitWsServerSettingsSerialized,
    PlebbitRpcServerEvents,
    RpcSubplebbitState
} from "./types.js";
import { Plebbit } from "../../plebbit/plebbit.js";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor,
    DecryptedChallengeVerificationMessageType
} from "../../pubsub-messages/types.js";
import WebSocket from "ws";
import Publication from "../../publications/publication.js";
import { PlebbitError } from "../../plebbit-error.js";
import { LocalSubplebbit } from "../../runtime/node/subplebbit/local-subplebbit.js";
import { RemoteSubplebbit } from "../../subplebbit/remote-subplebbit.js";
import { hideClassPrivateProps, replaceXWithY } from "../../util.js";
import * as remeda from "remeda";
import type { IncomingMessage } from "http";
import type { CommentChallengeRequestToEncryptType, CommentIpfsType, CommentRpcErrorToTransmit } from "../../publications/comment/types.js";
import type {
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType,
    RpcRemoteSubplebbitType,
    SubplebbitEvents,
    SubplebbitRpcErrorToTransmit
} from "../../subplebbit/types.js";
import {
    parseCommentChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails,
    parseCommentEditChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails,
    parseCommentModerationChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails,
    parseCreateNewLocalSubplebbitUserOptionsSchemaWithPlebbitErrorIfItFails,
    parseCreatePlebbitWsServerOptionsSchemaWithPlebbitErrorIfItFails,
    parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails,
    parseSetNewSettingsPlebbitWsServerSchemaWithPlebbitErrorIfItFails,
    parseSubplebbitEditChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails,
    parseSubplebbitEditOptionsSchemaWithPlebbitErrorIfItFails,
    parseVoteChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails
} from "../../schema/schema-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import type { VoteChallengeRequestToEncryptType } from "../../publications/vote/types.js";
import type { CommentEditChallengeRequestToEncryptType } from "../../publications/comment-edit/types.js";
import type { CommentModerationChallengeRequestToEncrypt } from "../../publications/comment-moderation/types.js";
import type { InputPlebbitOptions } from "../../types.js";
import type { SubplebbitEditChallengeRequestToEncryptType } from "../../publications/subplebbit-edit/types.js";
import { PublicationRpcErrorToTransmit, RpcPublishResult } from "../../publications/types.js";
import { TypedEmitter } from "tiny-typed-emitter";
import { sanitizeRpcNotificationResult } from "./json-rpc-util.js";
import type { ModQueuePageIpfs, PageIpfs } from "../../pages/types.js";
import { buildPageRuntimeFields, buildPagesRuntimeFields } from "../../pages/util.js";
import {
    parseRpcSubplebbitAddressParam,
    parseRpcSubplebbitLookupParam,
    parseRpcAuthorNameParam,
    parseRpcCidParam,
    parseRpcCommentRepliesPageParam,
    parseRpcSubplebbitPageParam,
    parseRpcEditSubplebbitParam,
    parseRpcPublishChallengeAnswersParam,
    parseRpcUnsubscribeParam
} from "../../clients/rpc-client/rpc-schema-util.js";
import { SubplebbitAddressRpcParam, SubplebbitLookupRpcParam } from "../../clients/rpc-client/types.js";
import { findStartedSubplebbit } from "../../plebbit/tracked-instance-registry-util.js";

// store started subplebbits  to be able to stop them
// store as a singleton because not possible to start the same sub twice at the same time

const log = Logger("plebbit-js-rpc:plebbit-ws-server");

// TODO need to think how to update Plebbit instance of publication after setSettings?

class PlebbitWsServer extends TypedEmitter<PlebbitRpcServerEvents> {
    plebbit!: Plebbit;
    rpcWebsockets: RpcWebsocketsServer;
    ws: RpcWebsocketsServer["wss"];
    connections: { [connectionId: string]: WebSocket } = {};
    subscriptionCleanups: { [connectionId: string]: { [subscriptionId: number]: () => Promise<void> } } = {};
    // store publishing publications so they can be used by publishChallengeAnswers
    publishing: {
        [subscriptionId: number]: { publication: Publication; plebbit: Plebbit; connectionId: string; timeout?: NodeJS.Timeout };
    } = {};
    private _setSettingsQueue: Promise<void> = Promise.resolve();
    authKey: string | undefined;
    private _trackedSubplebbitListeners = new WeakMap<LocalSubplebbit, Map<keyof SubplebbitEvents, Set<(...args: any[]) => void>>>();
    private _getIpFromConnectionRequest = (req: IncomingMessage) => <string>req.socket.remoteAddress; // we set it up here so we can mock it in tests

    private _onSettingsChange: {
        [connectionId: string]: { [subscriptionId: number]: (args: { newPlebbit: Plebbit }) => Promise<void> };
    } = {}; // TODO rename this to _afterSettingsChange

    private _startedSubplebbits: { [address: string]: "pending" | LocalSubplebbit } = {}; // TODO replace this with plebbit._startedSubplebbits
    private _autoStartOnBoot: boolean = false;
    private _rpcStateDb: BetterSqlite3Database | undefined;

    constructor({ port, server, plebbit, authKey, startStartedSubplebbitsOnStartup }: PlebbitWsServerClassOptions) {
        super();
        const log = Logger("plebbit-js:PlebbitWsServer");
        this.authKey = authKey;
        this._autoStartOnBoot = startStartedSubplebbitsOnStartup ?? true;
        // don't instantiate plebbit in constructor because it's an async function
        this._initPlebbit(plebbit);
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

        // forward errors to PlebbitWsServer
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
        this.rpcWebsocketsRegister("getSubplebbitPage", this.getSubplebbitPage.bind(this));
        this.rpcWebsocketsRegister("getCommentPage", this.getCommentPage.bind(this));
        this.rpcWebsocketsRegister("createSubplebbit", this.createSubplebbit.bind(this));
        this.rpcWebsocketsRegister("startSubplebbit", this.startSubplebbit.bind(this));
        this.rpcWebsocketsRegister("stopSubplebbit", this.stopSubplebbit.bind(this));
        this.rpcWebsocketsRegister("editSubplebbit", this.editSubplebbit.bind(this));
        this.rpcWebsocketsRegister("deleteSubplebbit", this.deleteSubplebbit.bind(this));
        this.rpcWebsocketsRegister("subplebbitsSubscribe", this.subplebbitsSubscribe.bind(this));
        this.rpcWebsocketsRegister("settingsSubscribe", this.settingsSubscribe.bind(this));

        this.rpcWebsocketsRegister("fetchCid", this.fetchCid.bind(this));
        this.rpcWebsocketsRegister("resolveAuthorName", this.resolveAuthorName.bind(this));
        this.rpcWebsocketsRegister("setSettings", this.setSettings.bind(this));
        // JSON RPC pubsub methods
        this.rpcWebsocketsRegister("commentUpdateSubscribe", this.commentUpdateSubscribe.bind(this));
        this.rpcWebsocketsRegister("subplebbitUpdateSubscribe", this.subplebbitUpdateSubscribe.bind(this));
        this.rpcWebsocketsRegister("publishComment", this.publishComment.bind(this));
        this.rpcWebsocketsRegister("publishSubplebbitEdit", this.publishSubplebbitEdit.bind(this));
        this.rpcWebsocketsRegister("publishVote", this.publishVote.bind(this));
        this.rpcWebsocketsRegister("publishCommentEdit", this.publishCommentEdit.bind(this));
        this.rpcWebsocketsRegister("publishCommentModeration", this.publishCommentModeration.bind(this));
        this.rpcWebsocketsRegister("publishChallengeAnswers", this.publishChallengeAnswers.bind(this));
        this.rpcWebsocketsRegister("unsubscribe", this.unsubscribe.bind(this));

        hideClassPrivateProps(this);
    }

    async getStartedSubplebbit(address: string): Promise<LocalSubplebbit> {
        if (!(address in this._startedSubplebbits)) throw Error("Can't call getStartedSubplebbit when the sub hasn't been started");
        // if pending, wait until no longer pendng
        while (this._startedSubplebbits[address] === "pending") {
            await new Promise((r) => setTimeout(r, 20));
        }
        return <LocalSubplebbit>this._startedSubplebbits[address];
    }

    private _emitError(error: PlebbitError | Error) {
        if (this.listeners("error").length === 0)
            log.error("Unhandled error. This may crash your process, you need to listen for error event on PlebbitRpcWsServer", error);
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

    private _updateSubplebbitState(address: string, update: Partial<RpcSubplebbitState>): void {
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

    private _removeSubplebbitState(address: string): void {
        const db = this._getRpcStateDb();
        if (!db) return;
        db.prepare("DELETE FROM subplebbit_states WHERE address = ?").run(address);
    }

    async _autoStartPreviousSubplebbits(): Promise<void> {
        if (!this._autoStartOnBoot) return;

        const autoStartLog = Logger("plebbit-js-rpc:plebbit-ws-server:auto-start");
        autoStartLog("Checking for previously started subplebbits to auto-start");

        const db = this._getRpcStateDb();
        if (!db) return;

        const rows = db.prepare("SELECT address FROM subplebbit_states WHERE wasStarted = 1 AND wasExplicitlyStopped = 0").all() as {
            address: string;
        }[];

        const plebbit = await this._getPlebbitInstance();
        const localSubs = plebbit.subplebbits;

        for (const row of rows) {
            if (!localSubs.includes(row.address)) {
                autoStartLog(`Skipping auto-start for ${row.address} - subplebbit no longer exists`);
                this._removeSubplebbitState(row.address);
                continue;
            }

            if (row.address in this._startedSubplebbits) {
                autoStartLog(`Skipping auto-start for ${row.address} - already started`);
                continue;
            }

            autoStartLog(`Auto-starting subplebbit: ${row.address}`);
            try {
                await this._internalStartSubplebbit(row.address);
                autoStartLog(`Successfully auto-started: ${row.address}`);
            } catch (e) {
                autoStartLog.error(`Failed to auto-start subplebbit ${row.address}`, e);
                this._emitError(e instanceof Error ? e : new Error(`Failed to auto-start ${row.address}: ${String(e)}`));
            }
        }
    }

    private async _internalStartSubplebbit(address: string): Promise<LocalSubplebbit> {
        const plebbit = await this._getPlebbitInstance();

        this._startedSubplebbits[address] = "pending";
        try {
            const subplebbit = <LocalSubplebbit>await plebbit.createSubplebbit({ address });
            subplebbit.started = true;
            await subplebbit.start();
            this._startedSubplebbits[address] = subplebbit;
            this._updateSubplebbitState(address, { wasStarted: true, wasExplicitlyStopped: false });
            return subplebbit;
        } catch (e) {
            delete this._startedSubplebbits[address];
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
                const typedError = <PlebbitError | Error>e;
                log.error(`${callback.name} error`, { params, error: typedError });
                // We need to stringify the error here because rpc-websocket will remove props from PlebbitError
                if (typedError instanceof PlebbitError) {
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

    private _registerPublishing(subscriptionId: number, publication: Publication, plebbit: Plebbit, connectionId: string) {
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
        await this._retirePlebbitIfNeeded(record.plebbit);
    }

    private async _retirePlebbitIfNeeded(plebbit: Plebbit) {
        const activePublishes = Object.values(this.publishing).filter(({ plebbit: p }) => p === plebbit).length;
        if (activePublishes === 0 && !plebbit.destroyed) {
            // nothing relies on this instance anymore
            await plebbit.destroy().catch((error) => log.error("Failed destroying old plebbit immediately after setSettings", { error }));
            return;
        }
    }

    async _getPlebbitInstance() {
        await this._setSettingsQueue;
        return this.plebbit;
    }

    async getComment(params: any): Promise<CommentIpfsType> {
        const getCommentArgs = parseRpcCidParam(params[0]);
        const comment = await (await this._getPlebbitInstance()).getComment(getCommentArgs);
        // TODO may need to be changed later
        return comment.raw.comment!;
    }

    async getSubplebbitPage(params: any) {
        const { cid: pageCid, subplebbitAddress, type, pageMaxSize } = parseRpcSubplebbitPageParam(params[0]);
        const plebbit = await this._getPlebbitInstance();

        // Use started subplebbit to fetch the page if possible, to expediete the process
        const sub =
            subplebbitAddress in this._startedSubplebbits
                ? await this.getStartedSubplebbit(subplebbitAddress)
                : <RemoteSubplebbit | LocalSubplebbit>await plebbit.createSubplebbit({ address: subplebbitAddress });
        const { page } =
            type === "posts"
                ? await sub.posts._fetchAndVerifyPage({ pageCid, pageMaxSize })
                : await sub.modQueue._fetchAndVerifyPage({ pageCid, pageMaxSize });
        const runtimeFields = buildPageRuntimeFields(page, plebbit._memCaches.nameResolvedCache);
        return { page, runtimeFields };
    }

    async getCommentPage(params: any) {
        const { cid: pageCid, commentCid, subplebbitAddress, pageMaxSize } = parseRpcCommentRepliesPageParam(params[0]);
        const plebbit = await this._getPlebbitInstance();
        const comment = await plebbit.createComment({ cid: commentCid, subplebbitAddress });
        const { page } = await comment.replies._fetchAndVerifyPage({ pageCid, pageMaxSize });
        const runtimeFields = buildPageRuntimeFields(page, plebbit._memCaches.nameResolvedCache);
        return { page, runtimeFields };
    }

    async createSubplebbit(params: any) {
        const createSubplebbitOptions = parseCreateNewLocalSubplebbitUserOptionsSchemaWithPlebbitErrorIfItFails(params[0]);
        const plebbit = await this._getPlebbitInstance();
        const subplebbit = <LocalSubplebbit>await plebbit.createSubplebbit(createSubplebbitOptions);
        if (!(subplebbit instanceof LocalSubplebbit)) throw Error("Failed to create a local subplebbit. This is a critical error");
        return subplebbit.toJSONInternalRpcBeforeFirstUpdate();
    }

    private _trackSubplebbitListener(subplebbit: LocalSubplebbit, event: keyof SubplebbitEvents, listener: (...args: any[]) => void) {
        let listenersByEvent = this._trackedSubplebbitListeners.get(subplebbit);
        if (!listenersByEvent) {
            listenersByEvent = new Map();
            this._trackedSubplebbitListeners.set(subplebbit, listenersByEvent);
        }

        let listeners = listenersByEvent.get(event);
        if (!listeners) {
            listeners = new Set();
            listenersByEvent.set(event, listeners);
        }

        listeners.add(listener);
    }

    private _untrackSubplebbitListener(subplebbit: LocalSubplebbit, event: keyof SubplebbitEvents, listener: (...args: any[]) => void) {
        const listenersByEvent = this._trackedSubplebbitListeners.get(subplebbit);
        if (!listenersByEvent) return;

        const listeners = listenersByEvent.get(event);
        if (!listeners) return;

        listeners.delete(listener);
        if (listeners.size === 0) listenersByEvent.delete(event);
        if (listenersByEvent.size === 0) this._trackedSubplebbitListeners.delete(subplebbit);
    }

    _setupStartedEvents(subplebbit: LocalSubplebbit, connectionId: string, subscriptionId: number) {
        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({ method: "startSubplebbit", subscription: subscriptionId, event, result, connectionId });

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
        this._trackSubplebbitListener(subplebbit, "update", updateListener);

        const startedStateListener = () => sendEvent("startedstatechange", { state: subplebbit.startedState });
        subplebbit.on("startedstatechange", startedStateListener);
        this._trackSubplebbitListener(subplebbit, "startedstatechange", startedStateListener);

        const requestListener = (request: DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        subplebbit.on("challengerequest", requestListener);
        this._trackSubplebbitListener(subplebbit, "challengerequest", requestListener);

        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        subplebbit.on("challenge", challengeListener);
        this._trackSubplebbitListener(subplebbit, "challenge", challengeListener);

        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        subplebbit.on("challengeanswer", challengeAnswerListener);
        this._trackSubplebbitListener(subplebbit, "challengeanswer", challengeAnswerListener);

        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        subplebbit.on("challengeverification", challengeVerificationListener);
        this._trackSubplebbitListener(subplebbit, "challengeverification", challengeVerificationListener);

        const errorListener = (error: PlebbitError | Error) => {
            const rpcError = error as SubplebbitRpcErrorToTransmit;
            if (subplebbit.state === "started") rpcError.details = { ...rpcError.details, newStartedState: subplebbit.startedState };
            else if (subplebbit.state === "updating")
                rpcError.details = { ...rpcError.details, newUpdatingState: subplebbit.updatingState };
            log("subplebbit rpc error", rpcError);
            sendEvent("error", rpcError);
        };
        subplebbit.on("error", errorListener);
        this._trackSubplebbitListener(subplebbit, "error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            subplebbit.removeListener("update", updateListener);
            this._untrackSubplebbitListener(subplebbit, "update", updateListener);
            subplebbit.removeListener("startedstatechange", startedStateListener);
            this._untrackSubplebbitListener(subplebbit, "startedstatechange", startedStateListener);
            subplebbit.removeListener("challengerequest", requestListener);
            this._untrackSubplebbitListener(subplebbit, "challengerequest", requestListener);
            subplebbit.removeListener("challenge", challengeListener);
            this._untrackSubplebbitListener(subplebbit, "challenge", challengeListener);
            subplebbit.removeListener("challengeanswer", challengeAnswerListener);
            this._untrackSubplebbitListener(subplebbit, "challengeanswer", challengeAnswerListener);
            subplebbit.removeListener("challengeverification", challengeVerificationListener);
            this._untrackSubplebbitListener(subplebbit, "challengeverification", challengeVerificationListener);
            subplebbit.removeListener("error", errorListener);
            this._untrackSubplebbitListener(subplebbit, "error", errorListener);
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };
    }

    async startSubplebbit(params: any, connectionId: string) {
        const { address } = parseRpcSubplebbitAddressParam(params[0]);
        const plebbit = await this._getPlebbitInstance();

        const localSubs = plebbit.subplebbits;
        if (!localSubs.includes(address))
            throw new PlebbitError("ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_SUB", { subplebbitAddress: address });

        const subscriptionId = generateSubscriptionId();

        const startSub = async () => {
            const plebbit = await this._getPlebbitInstance();
            const isSubStarted = address in this._startedSubplebbits;
            if (isSubStarted) {
                const subplebbit = await this.getStartedSubplebbit(address);
                this._setupStartedEvents(subplebbit, connectionId, subscriptionId);
            } else {
                try {
                    this._startedSubplebbits[address] = "pending";
                    const subplebbit = <LocalSubplebbit>await plebbit.createSubplebbit({ address });
                    this._setupStartedEvents(subplebbit, connectionId, subscriptionId);
                    subplebbit.started = true; // a small hack to make sure first update has started=true
                    subplebbit.emit("update", subplebbit); // Need to emit an update so rpc user can receive sub props prior to running
                    await subplebbit.start();
                    this._startedSubplebbits[address] = subplebbit;
                    this._updateSubplebbitState(address, { wasStarted: true, wasExplicitlyStopped: false });
                } catch (e) {
                    const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
                    if (cleanup) await cleanup();
                    delete this._startedSubplebbits[address];
                    throw e;
                }
            }
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPlebbit }: { newPlebbit: Plebbit }) => {
            const current = this._startedSubplebbits[address];
            if (!current || current === "pending") return;
            const subplebbit = await this.getStartedSubplebbit(address);
            // mark as pending so other consumers wait while we restart with the new plebbit instance
            this._startedSubplebbits[address] = "pending";
            try {
                await subplebbit.stop();
                subplebbit._plebbit = newPlebbit;
                await subplebbit.start();
                this._startedSubplebbits[address] = subplebbit;
            } catch (error) {
                delete this._startedSubplebbits[address];
                throw error;
            }
        };

        await startSub();

        return subscriptionId;
    }

    async stopSubplebbit(params: any) {
        const { address } = parseRpcSubplebbitAddressParam(params[0]);
        const plebbit = await this._getPlebbitInstance();

        const localSubs = plebbit.subplebbits;
        if (!localSubs.includes(address))
            throw new PlebbitError("ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_SUB", { subplebbitAddress: address });
        const isSubStarted = address in this._startedSubplebbits;
        if (!isSubStarted) throw new PlebbitError("ERR_RPC_CLIENT_TRYING_TO_STOP_SUB_THAT_IS_NOT_RUNNING", { subplebbitAddress: address });
        const startedSubplebbit = await this.getStartedSubplebbit(address);
        await startedSubplebbit.stop();
        // emit last updates so subscribed instances can set their state to stopped
        await this._postStoppingOrDeleting(startedSubplebbit);
        delete this._startedSubplebbits[address];
        this._updateSubplebbitState(address, { wasExplicitlyStopped: true });

        return true;
    }

    private async _postStoppingOrDeleting(subplebbit: LocalSubplebbit) {
        // emit the last updates
        // remove all listeners
        subplebbit.emit("update", subplebbit);
        subplebbit.emit("startedstatechange", subplebbit.startedState);

        const trackedListeners = this._trackedSubplebbitListeners.get(subplebbit);
        if (trackedListeners) {
            for (const [event, listeners] of trackedListeners) {
                for (const listener of listeners) {
                    subplebbit.removeListener(event, listener);
                }
            }
            this._trackedSubplebbitListeners.delete(subplebbit);
        }
    }

    async editSubplebbit(params: any) {
        const rawParam = params[0];
        rawParam.editOptions = replaceXWithY(rawParam.editOptions, null, undefined);
        const { address, editOptions } = parseRpcEditSubplebbitParam(rawParam);
        const editSubplebbitOptions = parseSubplebbitEditOptionsSchemaWithPlebbitErrorIfItFails(editOptions);
        const plebbit = await this._getPlebbitInstance();

        const localSubs = plebbit.subplebbits;
        if (!localSubs.includes(address))
            throw new PlebbitError("ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_SUB", { subplebbitAddress: address });
        let subplebbit: LocalSubplebbit;
        if (this._startedSubplebbits[address] instanceof LocalSubplebbit) subplebbit = <LocalSubplebbit>this._startedSubplebbits[address];
        else {
            subplebbit = <LocalSubplebbit>await plebbit.createSubplebbit({ address });
            subplebbit.once("error", (error: PlebbitError | Error) => {
                log.error("RPC server Received an error on subplebbit", subplebbit.address, "edit", error);
            });
        }

        await subplebbit.edit(editSubplebbitOptions);
        if (editSubplebbitOptions.address && this._startedSubplebbits[address]) {
            // if (editSubplebbitOptions.address && this._startedSubplebbits[address] && editSubplebbitOptions.address !== address) {
            this._startedSubplebbits[editSubplebbitOptions.address] = this._startedSubplebbits[address];
            delete this._startedSubplebbits[address];

            // Update RPC state with new address
            const db = this._getRpcStateDb();
            if (db) {
                db.prepare("UPDATE subplebbit_states SET address = @newAddress WHERE address = @oldAddress").run({
                    newAddress: editSubplebbitOptions.address,
                    oldAddress: address
                });
            }
        }
        if (typeof subplebbit.updatedAt === "number") return subplebbit.toJSONInternalRpcAfterFirstUpdate();
        else return subplebbit.toJSONInternalRpcBeforeFirstUpdate();
    }

    async deleteSubplebbit(params: any) {
        const { address } = parseRpcSubplebbitAddressParam(params[0]);
        const plebbit = await this._getPlebbitInstance();

        const addresses = plebbit.subplebbits;
        if (!addresses.includes(address))
            throw new PlebbitError("ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_SUB", { subplebbitAddress: address });

        const isSubStarted = address in this._startedSubplebbits;
        const subplebbit = isSubStarted
            ? await this.getStartedSubplebbit(address)
            : <LocalSubplebbit>await plebbit.createSubplebbit({ address });
        await subplebbit.delete();
        await this._postStoppingOrDeleting(subplebbit);
        delete this._startedSubplebbits[address];
        this._removeSubplebbitState(address);

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

        const plebbit = await this._getPlebbitInstance();
        plebbit.on("subplebbitschange", plebbitSubscribeEvent);

        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            plebbit.removeListener("subplebbitschange", plebbitSubscribeEvent);
        };

        sendEvent("subplebbitschange", { subplebbits: plebbit.subplebbits });

        return subscriptionId;
    }

    async fetchCid(params: any) {
        const parsedArgs = parseRpcCidParam(params[0]);
        const plebbit = await this._getPlebbitInstance();
        const res = await plebbit.fetchCid(parsedArgs);
        if (typeof res !== "string") throw Error("Result of fetchCid should be a string");
        return { content: res };
    }

    private _serializeSettingsFromPlebbit(plebbit: Plebbit): PlebbitWsServerSettingsSerialized {
        const plebbitOptions = plebbit.parsedPlebbitOptions;
        const builtInChallenges = PlebbitJs.Plebbit.challenges || {};
        const allChallengeFactories = {
            ...builtInChallenges, // built-ins first
            ...(plebbit.settings?.challenges || {}) // user-defined override
        };
        const challenges = remeda.mapValues(allChallengeFactories, (challengeFactory) =>
            remeda.omit(challengeFactory({ challengeSettings: {} }), ["getChallenge"])
        );

        return <PlebbitWsServerSettingsSerialized>{ plebbitOptions, challenges };
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

        const sendRpcSettings = async ({ newPlebbit }: { newPlebbit: Plebbit }) => {
            sendEvent("settingschange", this._serializeSettingsFromPlebbit(newPlebbit));
        };

        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };

        this._onSettingsChange[connectionId][subscriptionId] = sendRpcSettings;
        await sendRpcSettings({ newPlebbit: this.plebbit });

        return subscriptionId;
    }

    private _initPlebbit(plebbit: Plebbit) {
        this.plebbit = plebbit;
        plebbit.on("error", (error: any) => log.error("RPC server", "Received an error on plebbit instance", error));
    }

    private async _createPlebbitInstanceFromSetSettings(newOptions: InputPlebbitOptions) {
        return PlebbitJs.Plebbit(newOptions);
    }

    async setSettings(params: any) {
        const runSetSettings = async () => {
            const settings = parseSetNewSettingsPlebbitWsServerSchemaWithPlebbitErrorIfItFails(params[0]);
            const currentSettings = this._serializeSettingsFromPlebbit(this.plebbit);
            if (deterministicStringify(settings.plebbitOptions) === deterministicStringify(currentSettings.plebbitOptions)) {
                log("RPC client called setSettings with the same settings as the current one, aborting");
                return;
            }

            log(`RPC client called setSettings, the clients need to call all subscription methods again`);
            const oldPlebbit = this.plebbit;
            // Strip nameResolvers from client settings — RPC server ignores them for now
            const { nameResolvers: _stripNr, ...plebbitOptionsWithoutNameResolvers } = settings.plebbitOptions;
            const newPlebbit = await this._createPlebbitInstanceFromSetSettings({
                ...plebbitOptionsWithoutNameResolvers,
                nameResolvers: this.plebbit.parsedPlebbitOptions.nameResolvers
            } as InputPlebbitOptions);
            this._initPlebbit(newPlebbit); // swap to new instance first so new RPC calls don't hit a destroyed plebbit

            // send a settingsNotification to all subscribers
            for (const connectionId of remeda.keys.strict(this._onSettingsChange)) {
                const connectionHandlers = this._onSettingsChange[connectionId];
                if (!connectionHandlers) continue;
                for (const subscriptionId of remeda.keys.strict(connectionHandlers)) {
                    const handler = connectionHandlers[subscriptionId];
                    if (handler) await handler({ newPlebbit });
                }
            }

            // ensure any existing publications get a timeout if they were created before the first setSettings
            for (const [subscriptionId, pub] of Object.entries(this.publishing).filter((pub) => pub[1].plebbit === oldPlebbit)) {
                pub.timeout = setTimeout(async () => {
                    await this._forceCleanupPublication(Number(subscriptionId), "timeout");
                }, 60000);
            }

            setTimeout(async () => {
                await this._retirePlebbitIfNeeded(oldPlebbit);
            }, 60000); // set this in a timeout because createSubplebbit may be using it
        };

        const setSettingsRun = this._setSettingsQueue.then(() => runSetSettings());
        // keep queue usable even if a run fails; error still propagates to the caller via setSettingsRun
        this._setSettingsQueue = setSettingsRun.catch(() => {});
        await setSettingsRun;
        return true;
    }

    async commentUpdateSubscribe(params: any, connectionId: string) {
        const logUpdate = Logger("plebbit-js-rpc:plebbit-ws-server:commentUpdateSubscribe");
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
        const plebbit = await this._getPlebbitInstance();
        const comment = await plebbit.createComment(parsedCommentUpdateArgs);
        const sendUpdate = () => {
            if (!sentCommentIpfsUpdateEvent && comment.raw.comment) {
                sendEvent("comment", {
                    comment: comment.raw.comment,
                    runtimeFields: { author: { nameResolved: comment.author.nameResolved } }
                });
                sentCommentIpfsUpdateEvent = true;
            }
            if (comment.raw.commentUpdate) {
                const updateEvent: Record<string, any> = { commentUpdate: comment.raw.commentUpdate };
                if (comment.raw.commentUpdate.replies?.pages) {
                    updateEvent.runtimeFields = {
                        replies: {
                            pages: buildPagesRuntimeFields(comment.raw.commentUpdate.replies.pages, plebbit._memCaches.nameResolvedCache)
                        }
                    };
                }
                sendEvent("update", updateEvent);
            }
        };
        const updateListener = () => sendUpdate();
        comment.on("update", updateListener);

        const updatingStateListener = () => sendEvent("updatingstatechange", { state: comment.updatingState });
        comment.on("updatingstatechange", updatingStateListener);

        const stateListener = () => sendEvent("statechange", { state: comment.state });
        comment.on("statechange", stateListener);

        const errorListener = (error: PlebbitError | Error) => {
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

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPlebbit }: { newPlebbit: Plebbit }) => {
            // TODO need to clean up and remove old comment here, and create a new comment
            comment._plebbit = newPlebbit;
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
        const parsedSubplebbitUpdateArgs = parseRpcSubplebbitLookupParam(params[0]);
        const subscriptionId = generateSubscriptionId();

        await this._bindSubplebbitUpdateSubscription(parsedSubplebbitUpdateArgs, connectionId, subscriptionId);

        return subscriptionId;
    }

    private async _bindSubplebbitUpdateSubscription(parsedArgs: SubplebbitLookupRpcParam, connectionId: string, subscriptionId: number) {
        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "subplebbitUpdateNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const plebbit = await this._getPlebbitInstance();
        const startedSubplebbit = findStartedSubplebbit(plebbit, parsedArgs);
        const isStartedSubplebbit = Boolean(startedSubplebbit);
        const subplebbit = startedSubplebbit || <LocalSubplebbit | RemoteSubplebbit>await plebbit.createSubplebbit(parsedArgs);

        const sendSubJson = () => {
            let jsonToSend:
                | RpcRemoteSubplebbitType
                | RpcInternalSubplebbitRecordAfterFirstUpdateType
                | RpcInternalSubplebbitRecordBeforeFirstUpdateType;
            if (subplebbit instanceof LocalSubplebbit)
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
        if (isStartedSubplebbit) {
            subplebbit.on("startedstatechange", startedStateListener);
        }

        const errorListener = (error: PlebbitError | Error) => {
            const rpcError = error as SubplebbitRpcErrorToTransmit;
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
            if (!isStartedSubplebbit && subplebbit.state !== "stopped") await subplebbit.stop();
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPlebbit }: { newPlebbit: Plebbit }) => {
            // TODO this may need changing
            if (!isStartedSubplebbit) {
                subplebbit._plebbit = newPlebbit;
                await subplebbit.stop();
                await subplebbit.update();
            }
        };

        // if fail, cleanup
        try {
            // need to send an update with first subplebbitUpdate if it's a local sub
            if ("signer" in subplebbit || subplebbit.raw.subplebbitIpfs) sendSubJson();

            // No need to call .update() if it's already running locally because we're listening to update event
            if (!isStartedSubplebbit) await subplebbit.update();
        } catch (e) {
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
            throw e;
        }
    }

    private async _createCommentInstanceFromPublishCommentParams(params: CommentChallengeRequestToEncryptType) {
        const plebbit = await this._getPlebbitInstance();
        const comment = await plebbit.createComment(params.comment);
        comment.challengeRequest = remeda.omit(params, ["comment"]);
        return comment;
    }

    async publishComment(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommentChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(params[0]);

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

        const errorListener = (error: PlebbitError | Error) => {
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
        const plebbit = await this._getPlebbitInstance();
        const vote = await plebbit.createVote(params.vote);
        vote.challengeRequest = remeda.omit(params, ["vote"]);
        return vote;
    }
    async publishVote(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseVoteChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(params[0]);

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

        const errorListener = (error: PlebbitError | Error) => {
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

    private async _createSubplebbitEditInstanceFromPublishSubplebbitEditParams(params: SubplebbitEditChallengeRequestToEncryptType) {
        const plebbit = await this._getPlebbitInstance();
        const subplebbitEdit = await plebbit.createSubplebbitEdit(params.subplebbitEdit);
        subplebbitEdit.challengeRequest = remeda.omit(params, ["subplebbitEdit"]);
        return subplebbitEdit;
    }

    async publishSubplebbitEdit(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseSubplebbitEditChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(params[0]);

        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "publishSubplebbitEditNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const subplebbitEdit = await this._createSubplebbitEditInstanceFromPublishSubplebbitEditParams(publishOptions);
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

        const errorListener = (error: PlebbitError | Error) => {
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
        const plebbit = await this._getPlebbitInstance();
        const commentEdit = await plebbit.createCommentEdit(params.commentEdit);
        commentEdit.challengeRequest = remeda.omit(params, ["commentEdit"]);
        return commentEdit;
    }

    async publishCommentEdit(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommentEditChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(params[0]);
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

        const errorListener = (error: PlebbitError | Error) => {
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
        const plebbit = await this._getPlebbitInstance();
        const commentModeration = await plebbit.createCommentModeration(params.commentModeration);
        commentModeration.challengeRequest = remeda.omit(params, ["commentModeration"]);
        return commentModeration;
    }

    async publishCommentModeration(params: any, connectionId: string): Promise<RpcPublishResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseCommentModerationChallengeRequestToEncryptSchemaWithPlebbitErrorIfItFails(params[0]);
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

        const errorListener = (error: PlebbitError | Error) => {
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
        const decryptedChallengeAnswers = parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails({
            challengeAnswers: parsed.challengeAnswers
        });

        const record = this.publishing[subscriptionId];
        if (!record?.publication) {
            throw Error(`no subscription with id '${subscriptionId}'`);
        }
        const publication = record.publication;

        await this._getPlebbitInstance(); // to await for settings change

        await publication.publishChallengeAnswers(decryptedChallengeAnswers.challengeAnswers);

        return true;
    }

    async resolveAuthorName(params: any) {
        const parsedArgs = parseRpcAuthorNameParam(params[0]);
        const plebbit = await this._getPlebbitInstance();
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
        const plebbit = await this._getPlebbitInstance();
        await plebbit.destroy(); // this will stop all started subplebbits
        for (const subplebbitAddress of remeda.keys.strict(this._startedSubplebbits)) {
            delete this._startedSubplebbits[subplebbitAddress];
        }
        this._rpcStateDb?.close();
        this._rpcStateDb = undefined;
        this._onSettingsChange = {};
    }
}

const createPlebbitWsServer = async (options: CreatePlebbitWsServerOptions) => {
    const parsedOptions = parseCreatePlebbitWsServerOptionsSchemaWithPlebbitErrorIfItFails(options);
    const plebbit = await PlebbitJs.Plebbit(parsedOptions.plebbitOptions);

    const plebbitWss = new PlebbitWsServer({
        plebbit,
        port: parsedOptions.port,
        server: parsedOptions.server,
        authKey: parsedOptions.authKey,
        startStartedSubplebbitsOnStartup: parsedOptions.startStartedSubplebbitsOnStartup
    });

    // Auto-start previously started subplebbits (fire-and-forget, non-blocking)
    plebbitWss._autoStartPreviousSubplebbits().catch((e) => {
        log.error("Failed to auto-start previous subplebbits", e);
    });

    return plebbitWss;
};

const PlebbitRpc = {
    PlebbitWsServer: createPlebbitWsServer,
    // for mocking plebbit-js during tests
    setPlebbitJs
};

export default PlebbitRpc;
