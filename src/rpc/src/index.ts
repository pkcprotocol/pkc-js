import pLimit from "p-limit";
import pRetry from "p-retry";
import { Server as RpcWebsocketsServer } from "rpc-websockets";
import { createReadStream, existsSync, mkdirSync, promises as fsPromises, statSync } from "fs";
import http, { type Server as HTTPServer, type ServerResponse } from "http";
import type { Server as HTTPSServer } from "https";
import { fileURLToPath } from "node:url";
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
import { keys, mapValues, omit } from "remeda";
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
import { PublicationRpcErrorToTransmit } from "../../publications/types.js";
import { TypedEmitter } from "tiny-typed-emitter";
import { sanitizeRpcNotificationResult } from "./json-rpc-util.js";
import type { ModQueuePageIpfs, PageIpfs } from "../../pages/types.js";
import { buildPageRuntimeFields, buildPagesRuntimeFields } from "../../pages/util.js";
import {
    parseRpcCommunityIdentifierParam,
    parseRpcAuthorNameParam,
    parseRpcCidParam,
    parseRpcCommentRepliesPageParam,
    parseRpcCommunityPageParam,
    parseRpcEditCommunityParam,
    parseRpcPublishChallengeAnswersParam,
    parseRpcUnsubscribeParam,
    parseRpcExportCommunityParam,
    parseRpcCancelExportParam,
    parseRpcExportCommunityModLogsParam,
    parseRpcPublishAnchorRecordParam
} from "../../clients/rpc-client/rpc-schema-util.js";
import { fromString as uint8ArrayFromString } from "uint8arrays/from-string";
import type {
    CommunityIdentifierRpcParam,
    AnchorPublishPreparation,
    PublishedAnchorRecord,
    RpcSubscriptionIdResult,
    RpcSuccessResult,
    RpcFetchCidResult,
    RpcResolveAuthorNameResult,
    RpcCommentPageResult,
    RpcCommunityPageResult,
    RpcLocalCommunityUpdateResultType,
    RpcExportCommunityResult,
    RpcExportCommunityModLogsResult
} from "../../clients/rpc-client/types.js";
import type { CommunityExportRecord } from "../../community/types.js";
import { findStartedCommunity } from "../../pkc/tracked-instance-registry-util.js";

// store started communities to be able to stop them
// store as a singleton because not possible to start the same community twice at the same time

const log = Logger("pkc-js-rpc:pkc-ws-server");

// Max retries when an auto-start hits a transient Kubo network blip (e.g. a boot-time restart).
// With factor=2, minTimeout=2s, maxTimeout=15s this spans ~89s of backoff, comfortably covering a
// ~30-60s embedded-Kubo restart window observed in production (issue #158).
const AUTO_START_TRANSIENT_RETRIES = 8;

// Transient errors thrown when a request hits a Kubo node that is restarting or briefly unreachable.
// These are safe to retry; anything else (e.g. a bad signature, a missing community) is not.
const _isTransientKuboError = (error: unknown): boolean => {
    const markers = ["fetch failed", "other side closed", "socket hang up", "econnrefused", "econnreset", "und_err"];
    const seen = new Set<unknown>();
    let current: unknown = error;
    // Walk the error chain (cause / details.actualError) since the network error is often wrapped.
    while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current);
        const err = current as { message?: unknown; code?: unknown; cause?: unknown; details?: { actualError?: unknown } };
        const haystack =
            `${typeof err.message === "string" ? err.message : ""} ${typeof err.code === "string" ? err.code : ""}`.toLowerCase();
        if (markers.some((marker) => haystack.includes(marker))) return true;
        current = err.cause ?? err.details?.actualError;
    }
    return false;
};

// TODO need to think how to update PKC instance of publication after setSettings?

class PKCWsServer extends TypedEmitter<PKCRpcServerEvents> {
    pkc!: PKC;
    rpcWebsockets: RpcWebsocketsServer;
    ws: RpcWebsocketsServer["wss"];
    connections: { [connectionId: string]: WebSocket } = {};
    subscriptionCleanups: { [connectionId: string]: { [subscriptionId: number]: () => Promise<void> } } = {};
    // store publishing publications so they can be used by publishChallengeAnswers
    publishing: {
        [subscriptionId: number]: { publication: Publication; pkc: PKC; connectionId: string; timeout?: NodeJS.Timeout };
    } = {};
    private _setSettingsQueue: Promise<void> = Promise.resolve();
    authKey: string | undefined;
    private _trackedCommunityListeners = new WeakMap<LocalCommunity, Map<keyof CommunityEvents, Set<(...args: any[]) => void>>>();
    private _getIpFromConnectionRequest = (req: IncomingMessage) => <string>req.socket.remoteAddress; // we set it up here so we can mock it in tests

    private _onSettingsChange: {
        [connectionId: string]: { [subscriptionId: number]: (args: { newPKC: PKC }) => Promise<void> };
    } = {}; // TODO rename this to _afterSettingsChange

    private _startedCommunities: { [address: string]: "pending" | LocalCommunity } = {};
    private _autoStartOnBoot: boolean = false;
    private _autoStartConcurrency: number;
    private _rpcStateDb: BetterSqlite3Database | undefined;
    private _allowPrivateKeyExport: boolean;
    // Max age (ms) for orphaned export sqlite files before the startup sweep deletes them.
    private _exportFileMaxAgeMs: number;
    // Per-address cache of LocalCommunity instances loaded for export purposes when the
    // community isn't currently in _startedCommunities. Keeps `_exports` and the
    // `exportschange` event consistent across exportCommunity / exportsSubscribe / cancelExport
    // calls for the same address.
    private _exportCommunityInstances: Map<string, LocalCommunity> = new Map();
    // http.Server backing the WS — populated when caller passes neither `server` nor relies on
    // rpc-websockets to bind its own. We attach the GET /exports/<exportId> route to whichever
    // http server underlies the WS.
    private _httpServer: HTTPServer | HTTPSServer | undefined;
    private _ownsHttpServer: boolean = false;

    constructor({
        port,
        server,
        pkc,
        authKey,
        startStartedCommunitiesOnStartup,
        autoStartConcurrency,
        allowPrivateKeyExport,
        exportFileMaxAgeMs
    }: PKCWsServerClassOptions) {
        super();
        const log = Logger("pkc-js:PKCWsServer");
        this.authKey = authKey;
        this._autoStartOnBoot = startStartedCommunitiesOnStartup ?? true;
        // Clamp to at least 1 since pLimit(0) throws. 0 or 1 means sequential (no parallelism)
        this._autoStartConcurrency = Math.max(1, autoStartConcurrency ?? 5);
        // Default true — matches private-RPC scope. Public-RPC operators set false.
        this._allowPrivateKeyExport = allowPrivateKeyExport ?? true;
        // Default 24h — orphaned export sqlite files older than this are swept on startup.
        // 0 disables the sweep entirely (export files are kept forever). `??` preserves an explicit 0.
        this._exportFileMaxAgeMs = exportFileMaxAgeMs ?? 24 * 60 * 60 * 1000;
        // don't instantiate pkc in constructor because it's an async function
        this._initPKC(pkc);

        // Always operate on an explicit http.Server so we can attach the /exports/<exportId>
        // route alongside the WS upgrade handler. When the caller passed neither `server` nor
        // delegated port-binding to rpc-websockets, we create and own one.
        if (server) {
            this._httpServer = server;
        } else {
            this._httpServer = http.createServer();
            this._ownsHttpServer = true;
            if (typeof port === "number") this._httpServer.listen(port);
        }
        this._httpServer.on("request", (req, res) => {
            // rpc-websockets does not register request listeners — any HTTP request reaching
            // this http.Server is ours to handle. Currently the only route is GET /exports/<id>.
            this._handleExportsHttpRequest(req, res).catch((e) => {
                log.error("Unhandled error in /exports HTTP handler", e);
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.end();
                }
            });
        });

        this.rpcWebsockets = new RpcWebsocketsServer({
            server: this._httpServer,
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
        this.rpcWebsocketsRegister("prepareAnchorPublish", this.prepareAnchorPublish.bind(this));
        this.rpcWebsocketsRegister("publishAnchorRecord", this.publishAnchorRecord.bind(this));
        this.rpcWebsocketsRegister("communitiesSubscribe", this.communitiesSubscribe.bind(this));
        this.rpcWebsocketsRegister("settingsSubscribe", this.settingsSubscribe.bind(this));

        this.rpcWebsocketsRegister("fetchCid", this.fetchCid.bind(this));
        this.rpcWebsocketsRegister("resolveAuthorName", this.resolveAuthorName.bind(this));
        this.rpcWebsocketsRegister("setSettings", this.setSettings.bind(this));
        // JSON RPC pubsub methods
        this.rpcWebsocketsRegister("commentUpdateSubscribe", this.commentUpdateSubscribe.bind(this));
        this.rpcWebsocketsRegister("communityUpdateSubscribe", this.communityUpdateSubscribe.bind(this));
        this.rpcWebsocketsRegister("publishComment", this.publishComment.bind(this));
        this.rpcWebsocketsRegister("publishCommunityEdit", this.publishCommunityEdit.bind(this));
        this.rpcWebsocketsRegister("publishVote", this.publishVote.bind(this));
        this.rpcWebsocketsRegister("publishCommentEdit", this.publishCommentEdit.bind(this));
        this.rpcWebsocketsRegister("publishCommentModeration", this.publishCommentModeration.bind(this));
        this.rpcWebsocketsRegister("publishChallengeAnswers", this.publishChallengeAnswers.bind(this));
        this.rpcWebsocketsRegister("unsubscribe", this.unsubscribe.bind(this));

        // community.export() — see EXPORT_COMMUNITY_SPEC.md
        this.rpcWebsocketsRegister("exportCommunity", this.exportCommunity.bind(this));
        this.rpcWebsocketsRegister("exportsSubscribe", this.exportsSubscribe.bind(this));
        this.rpcWebsocketsRegister("cancelExport", this.cancelExport.bind(this));
        this.rpcWebsocketsRegister("exportCommunityModLogs", this.exportCommunityModLogs.bind(this));

        hideClassPrivateProps(this);
    }

    async getStartedCommunity(address: string): Promise<LocalCommunity> {
        if (!(address in this._startedCommunities)) throw Error("Can't call getStartedCommunity when the community hasn't been started");
        // if pending, wait until no longer pendng
        while (this._startedCommunities[address] === "pending") {
            await new Promise((r) => setTimeout(r, 20));
        }
        return <LocalCommunity>this._startedCommunities[address];
    }

    private _findCommunityAddress(identifier: { name?: string; publicKey?: string }): string | undefined {
        const { name, publicKey } = identifier;
        if (!name && !publicKey) throw new Error("At least one of name or publicKey must be provided");
        if (name && name in this._startedCommunities) return name;
        if (name && this.pkc.communities.includes(name)) return name;
        if (publicKey && publicKey in this._startedCommunities) return publicKey;
        if (publicKey && this.pkc.communities.includes(publicKey)) return publicKey;
        return undefined;
    }

    private _emitError(error: PKCError | Error) {
        if (this.listeners("error").length === 0)
            log.error("Unhandled error. This may crash your process, you need to listen for error event on PKCRpcWsServer", error);
        this.emit("error", error);
    }

    // SQLite-based state management for auto-start functionality
    private _getRpcStateDb(): BetterSqlite3Database | undefined {
        if (this._rpcStateDb) return this._rpcStateDb;
        const dataPath = this.pkc.dataPath;
        if (!dataPath) return undefined;

        const rpcServerDir = path.join(dataPath, "rpc-server");
        mkdirSync(rpcServerDir, { recursive: true });
        const dbPath = path.join(rpcServerDir, "rpc-state.db");
        this._rpcStateDb = new Database(dbPath);
        this._rpcStateDb.pragma("journal_mode = WAL");
        // Auto-migrate old table name
        try {
            this._rpcStateDb.exec("ALTER TABLE community_states RENAME TO community_states");
        } catch (_) {}
        this._rpcStateDb.exec(`
            CREATE TABLE IF NOT EXISTS community_states (
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
        db.prepare("INSERT OR IGNORE INTO community_states (address) VALUES (?)").run(address);
        // Update only the specified fields
        if (update.wasStarted !== undefined) {
            db.prepare("UPDATE community_states SET wasStarted = ? WHERE address = ?").run(update.wasStarted ? 1 : 0, address);
        }
        if (update.wasExplicitlyStopped !== undefined) {
            db.prepare("UPDATE community_states SET wasExplicitlyStopped = ? WHERE address = ?").run(
                update.wasExplicitlyStopped ? 1 : 0,
                address
            );
        }
    }

    private _removeCommunityState(address: string): void {
        const db = this._getRpcStateDb();
        if (!db) return;
        db.prepare("DELETE FROM community_states WHERE address = ?").run(address);
    }

    async _autoStartPreviousCommunities(): Promise<void> {
        if (!this._autoStartOnBoot) return;

        const autoStartLog = Logger("pkc-js-rpc:pkc-ws-server:auto-start");
        autoStartLog("Checking for previously started communities to auto-start");

        const db = this._getRpcStateDb();
        if (!db) return;

        const rows = db.prepare("SELECT address FROM community_states WHERE wasStarted = 1 AND wasExplicitlyStopped = 0").all() as {
            address: string;
        }[];

        const pkc = await this._getPKCInstance();

        // Bug 1 (issue #158): the background HTTP-router reconcile may POST
        // /shutdown to the embedded Kubo to force a restart. If auto-start dispatches community
        // starts while that restart is in flight, those starts hit the dying Kubo socket and throw
        // `fetch failed`. Wait for the reconcile to settle before touching the node.
        await pkc._waitForHttpRoutersSetupToSettle();

        const localCommunities = pkc.communities;

        // Filter phase: determine which communities need starting
        const communitiesToStart: string[] = [];
        for (const row of rows) {
            if (!localCommunities.includes(row.address)) {
                autoStartLog(`Skipping auto-start for ${row.address} - community no longer exists`);
                this._removeCommunityState(row.address);
                continue;
            }

            if (row.address in this._startedCommunities) {
                autoStartLog(`Skipping auto-start for ${row.address} - already started`);
                continue;
            }

            communitiesToStart.push(row.address);
        }

        if (communitiesToStart.length === 0) {
            autoStartLog("No communities to auto-start");
            return;
        }

        // Startup phase: start communities in parallel with bounded concurrency
        autoStartLog(`Auto-starting ${communitiesToStart.length} communities with concurrency limit of ${this._autoStartConcurrency}`);

        const limit = pLimit(this._autoStartConcurrency);
        await Promise.allSettled(
            communitiesToStart.map((address) =>
                limit(async () => {
                    autoStartLog(`Auto-starting community: ${address}`);
                    try {
                        // Bug 2 (issue #158): a community whose start hits a transient Kubo blip
                        // (e.g. a boot-time restart window) must not be left permanently stopped.
                        // Retry transient network errors with backoff; non-transient errors abort
                        // immediately so we don't mask real failures.
                        await pRetry(() => this._internalStartCommunity(address), {
                            retries: AUTO_START_TRANSIENT_RETRIES,
                            factor: 2,
                            minTimeout: 2000,
                            maxTimeout: 15000,
                            shouldRetry: ({ error }) => _isTransientKuboError(error),
                            onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
                                if (_isTransientKuboError(error))
                                    autoStartLog(
                                        `Transient failure auto-starting ${address} (attempt ${attemptNumber}, ${retriesLeft} retries left), retrying`,
                                        error.message
                                    );
                            }
                        });
                        autoStartLog(`Successfully auto-started: ${address}`);
                    } catch (e) {
                        autoStartLog.error(`Failed to auto-start community ${address}`, e);
                        this._emitError(e instanceof Error ? e : new Error(`Failed to auto-start ${address}: ${String(e)}`));
                    }
                })
            )
        );
    }

    private async _internalStartCommunity(address: string): Promise<LocalCommunity> {
        const pkc = await this._getPKCInstance();

        this._startedCommunities[address] = "pending";
        try {
            const community = <LocalCommunity>await pkc.createCommunity({ address });
            community.started = true;
            await community.start();
            this._startedCommunities[address] = community;
            this._updateCommunityState(address, { wasStarted: true, wasExplicitlyStopped: false });
            return community;
        } catch (e) {
            delete this._startedCommunities[address];
            throw e;
        }
    }

    // util function to log errors of registered methods
    rpcWebsocketsRegister(method: string, callback: Function) {
        let invocationCounter = 0; // correlates the two trace lines of one call under concurrent same-method calls
        const callbackWithErrorHandled = async (params: any, connectionId: string) => {
            const invocationId = `${method}#${++invocationCounter}`;
            try {
                // Trace receipt and response dispatch so a client hanging on a lost response (issue #195)
                // can be attributed to either side: dispatched-but-never-matched vs never-dispatched
                log.trace(`Received RPC call (${invocationId}) from connection (${connectionId})`);
                const res = await callback(params, connectionId);
                log.trace(`Dispatching RPC response for call (${invocationId}) to connection (${connectionId})`);
                return res;
            } catch (e: any) {
                const typedError = <PKCError | Error>e;
                log.error(`${callback.name} error (${invocationId})`, { params, error: typedError });
                // We need to stringify the error here because rpc-websocket will remove props from PKCError
                if (typedError instanceof PKCError) {
                    const seen = new WeakSet();
                    const errorJson = JSON.parse(
                        JSON.stringify(typedError, (_key, value) => {
                            if (typeof value === "object" && value !== null) {
                                if (seen.has(value)) return undefined;
                                seen.add(value);
                            }
                            return value;
                        })
                    );
                    delete errorJson["stack"];
                    throw errorJson;
                } else {
                    // Plain Error properties (message, name) are non-enumerable and lost by JSON.stringify.
                    // Extract them into a plain object so rpc-websockets can serialize them.
                    const errorJson: Record<string, unknown> = {
                        message: typedError.message,
                        name: typedError.name
                    };
                    if ("details" in typedError) errorJson.details = (typedError as any).details;
                    if ("code" in typedError) errorJson.code = (typedError as any).code;
                    throw errorJson;
                }
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

    private _registerPublishing(subscriptionId: number, publication: Publication, pkc: PKC, connectionId: string) {
        this.publishing[subscriptionId] = { publication, pkc, connectionId };
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
        await this._retirePKCIfNeeded(record.pkc);
    }

    private async _retirePKCIfNeeded(pkc: PKC) {
        const activePublishes = Object.values(this.publishing).filter(({ pkc: p }) => p === pkc).length;
        if (activePublishes === 0 && !pkc.destroyed) {
            // nothing relies on this instance anymore
            await pkc.destroy().catch((error) => log.error("Failed destroying old pkc immediately after setSettings", { error }));
            return;
        }
    }

    async _getPKCInstance() {
        await this._setSettingsQueue;
        return this.pkc;
    }

    async getComment(params: any): Promise<CommentIpfsType> {
        const getCommentArgs = parseRpcCidParam(params[0]);
        const comment = await (await this._getPKCInstance()).getComment(getCommentArgs);
        // TODO may need to be changed later
        return comment.raw.comment!;
    }

    async getCommunityPage(params: any): Promise<RpcCommunityPageResult> {
        const { cid: pageCid, communityPublicKey, communityName, type, pageMaxSize } = parseRpcCommunityPageParam(params[0]);
        if (!communityPublicKey && !communityName) throw Error("At least one of communityPublicKey or communityName must be provided");
        const communityAddress = (communityName || communityPublicKey)!;
        const pkc = await this._getPKCInstance();

        // Use started community to fetch the page if possible, to expedite the process
        const community =
            communityAddress in this._startedCommunities
                ? await this.getStartedCommunity(communityAddress)
                : <RemoteCommunity | LocalCommunity>await pkc.createCommunity({ name: communityName, publicKey: communityPublicKey });
        const { page } =
            type === "posts"
                ? await community.posts._fetchAndVerifyPage({ pageCid, pageMaxSize })
                : await community.modQueue._fetchAndVerifyPage({ pageCid, pageMaxSize });
        const runtimeFields = buildPageRuntimeFields(page, pkc._memCaches.nameResolvedCache);
        return { page, runtimeFields };
    }

    async getCommentPage(params: any): Promise<RpcCommentPageResult> {
        const { cid: pageCid, commentCid, communityPublicKey, communityName, pageMaxSize } = parseRpcCommentRepliesPageParam(params[0]);
        const pkc = await this._getPKCInstance();
        const comment = await pkc.createComment({ cid: commentCid, communityPublicKey, communityName });
        const { page } = await comment.replies._fetchAndVerifyPage({ pageCid, pageMaxSize });
        const runtimeFields = buildPageRuntimeFields(page, pkc._memCaches.nameResolvedCache);
        return { page, runtimeFields };
    }

    async createCommunity(params: any): Promise<RpcInternalCommunityRecordBeforeFirstUpdateType> {
        const createCommunityOptions = parseCreateNewLocalCommunityUserOptionsSchemaWithPKCErrorIfItFails(params[0]);
        const pkc = await this._getPKCInstance();
        const community = <LocalCommunity>await pkc.createCommunity(createCommunityOptions);
        if (!(community instanceof LocalCommunity)) throw Error("Failed to create a local community. This is a critical error");
        return community.toJSONInternalRpcBeforeFirstUpdate();
    }

    private _trackCommunityListener(community: LocalCommunity, event: keyof CommunityEvents, listener: (...args: any[]) => void) {
        let listenersByEvent = this._trackedCommunityListeners.get(community);
        if (!listenersByEvent) {
            listenersByEvent = new Map();
            this._trackedCommunityListeners.set(community, listenersByEvent);
        }

        let listeners = listenersByEvent.get(event);
        if (!listeners) {
            listeners = new Set();
            listenersByEvent.set(event, listeners);
        }

        listeners.add(listener);
    }

    private _untrackCommunityListener(community: LocalCommunity, event: keyof CommunityEvents, listener: (...args: any[]) => void) {
        const listenersByEvent = this._trackedCommunityListeners.get(community);
        if (!listenersByEvent) return;

        const listeners = listenersByEvent.get(event);
        if (!listeners) return;

        listeners.delete(listener);
        if (listeners.size === 0) listenersByEvent.delete(event);
        if (listenersByEvent.size === 0) this._trackedCommunityListeners.delete(community);
    }

    _setupStartedEvents(community: LocalCommunity, connectionId: string, subscriptionId: number) {
        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({ method: "startCommunity", subscription: subscriptionId, event, result, connectionId });

        const getUpdateJson = () =>
            typeof community.updatedAt === "number"
                ? community.toJSONInternalRpcAfterFirstUpdate()
                : community.toJSONInternalRpcBeforeFirstUpdate();
        const updateListener = () => {
            const json = getUpdateJson();
            // Merge preloaded page runtimeFields into existing runtimeFields
            const communityIpfsRecord = community.raw.communityIpfs;
            if (communityIpfsRecord?.posts?.pages && "runtimeFields" in json && json.runtimeFields) {
                Object.assign(json.runtimeFields, {
                    posts: { pages: buildPagesRuntimeFields(communityIpfsRecord.posts.pages, community._pkc._memCaches.nameResolvedCache) }
                });
            }
            sendEvent("update", json);
        };
        community.on("update", updateListener);
        this._trackCommunityListener(community, "update", updateListener);

        const startedStateListener = () => sendEvent("startedstatechange", { state: community.startedState });
        community.on("startedstatechange", startedStateListener);
        this._trackCommunityListener(community, "startedstatechange", startedStateListener);

        const requestListener = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        community.on("challengerequest", requestListener);
        this._trackCommunityListener(community, "challengerequest", requestListener);

        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        community.on("challenge", challengeListener);
        this._trackCommunityListener(community, "challenge", challengeListener);

        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        community.on("challengeanswer", challengeAnswerListener);
        this._trackCommunityListener(community, "challengeanswer", challengeAnswerListener);

        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        community.on("challengeverification", challengeVerificationListener);
        this._trackCommunityListener(community, "challengeverification", challengeVerificationListener);

        const errorListener = (error: PKCError | Error) => {
            const rpcError = error as CommunityRpcErrorToTransmit;
            if (community.state === "started") rpcError.details = { ...rpcError.details, newStartedState: community.startedState };
            else if (community.state === "updating") rpcError.details = { ...rpcError.details, newUpdatingState: community.updatingState };
            log("community rpc error", rpcError);
            sendEvent("error", rpcError);
        };
        community.on("error", errorListener);
        this._trackCommunityListener(community, "error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            community.removeListener("update", updateListener);
            this._untrackCommunityListener(community, "update", updateListener);
            community.removeListener("startedstatechange", startedStateListener);
            this._untrackCommunityListener(community, "startedstatechange", startedStateListener);
            community.removeListener("challengerequest", requestListener);
            this._untrackCommunityListener(community, "challengerequest", requestListener);
            community.removeListener("challenge", challengeListener);
            this._untrackCommunityListener(community, "challenge", challengeListener);
            community.removeListener("challengeanswer", challengeAnswerListener);
            this._untrackCommunityListener(community, "challengeanswer", challengeAnswerListener);
            community.removeListener("challengeverification", challengeVerificationListener);
            this._untrackCommunityListener(community, "challengeverification", challengeVerificationListener);
            community.removeListener("error", errorListener);
            this._untrackCommunityListener(community, "error", errorListener);
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];
        };
    }

    async startCommunity(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
        const { name, publicKey } = parseRpcCommunityIdentifierParam(params[0]);
        const pkc = await this._getPKCInstance();

        const address = this._findCommunityAddress({ name, publicKey });
        if (!address) throw new PKCError("ERR_RPC_CLIENT_ATTEMPTING_TO_START_A_REMOTE_COMMUNITY", { communityAddress: name || publicKey });

        const subscriptionId = generateSubscriptionId();

        const startCommunityImpl = async () => {
            const pkc = await this._getPKCInstance();
            const isCommunityStarted = address in this._startedCommunities;
            if (isCommunityStarted) {
                const community = await this.getStartedCommunity(address);
                this._setupStartedEvents(community, connectionId, subscriptionId);
            } else {
                try {
                    this._startedCommunities[address] = "pending";
                    const community = <LocalCommunity>await pkc.createCommunity({ address });
                    this._setupStartedEvents(community, connectionId, subscriptionId);
                    community.started = true; // a small hack to make sure first update has started=true
                    community.emit("update", community); // Need to emit an update so rpc user can receive community props prior to running
                    await community.start();
                    this._startedCommunities[address] = community;
                    this._updateCommunityState(address, { wasStarted: true, wasExplicitlyStopped: false });
                } catch (e) {
                    const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
                    if (cleanup) await cleanup();
                    delete this._startedCommunities[address];
                    throw e;
                }
            }
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPKC }: { newPKC: PKC }) => {
            const current = this._startedCommunities[address];
            if (!current || current === "pending") return;
            const community = await this.getStartedCommunity(address);
            // mark as pending so other consumers wait while we restart with the new pkc instance
            this._startedCommunities[address] = "pending";
            try {
                await community.stop();
                community._pkc = newPKC;
                await community.start();
                this._startedCommunities[address] = community;
            } catch (error) {
                delete this._startedCommunities[address];
                throw error;
            }
        };

        await startCommunityImpl();

        return { subscriptionId };
    }

    async stopCommunity(params: any): Promise<RpcSuccessResult> {
        const { name, publicKey } = parseRpcCommunityIdentifierParam(params[0]);
        const pkc = await this._getPKCInstance();

        const address = this._findCommunityAddress({ name, publicKey });
        if (!address) throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_STOP_REMOTE_COMMUNITY", { communityAddress: name || publicKey });
        const isCommunityStarted = address in this._startedCommunities;
        if (!isCommunityStarted)
            throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_STOP_COMMUNITY_THAT_IS_NOT_RUNNING", { communityAddress: address });
        const startedCommunity = await this.getStartedCommunity(address);
        await startedCommunity.stop();
        // emit last updates so subscribed instances can set their state to stopped
        await this._postStoppingOrDeleting(startedCommunity);
        delete this._startedCommunities[address];
        this._updateCommunityState(address, { wasExplicitlyStopped: true });

        return { success: true };
    }

    private async _postStoppingOrDeleting(community: LocalCommunity) {
        // emit the last updates
        // remove all listeners
        community.emit("update", community);
        community.emit("startedstatechange", community.startedState);

        const trackedListeners = this._trackedCommunityListeners.get(community);
        if (trackedListeners) {
            for (const [event, listeners] of trackedListeners) {
                for (const listener of listeners) {
                    community.removeListener(event, listener);
                }
            }
            this._trackedCommunityListeners.delete(community);
        }
    }

    async editCommunity(params: any): Promise<RpcLocalCommunityUpdateResultType> {
        const rawParam = params[0];
        rawParam.editOptions = replaceXWithY(rawParam.editOptions, null, undefined);
        const { name, publicKey, editOptions } = parseRpcEditCommunityParam(rawParam);
        const editCommunityOptions = parseCommunityEditOptionsSchemaWithPKCErrorIfItFails(editOptions);
        const pkc = await this._getPKCInstance();

        const address = this._findCommunityAddress({ name, publicKey });
        if (!address) throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_EDIT_REMOTE_COMMUNITY", { communityAddress: name || publicKey });
        let community: LocalCommunity;
        if (this._startedCommunities[address] instanceof LocalCommunity) community = <LocalCommunity>this._startedCommunities[address];
        else {
            community = <LocalCommunity>await pkc.createCommunity({ address });
            community.once("error", (error: PKCError | Error) => {
                log.error("RPC server Received an error on community", community.address, "edit", error);
            });
        }

        await community.edit(editCommunityOptions);
        if (editCommunityOptions.address && this._startedCommunities[address]) {
            // if (editCommunityOptions.address && this._startedCommunities[address] && editCommunityOptions.address !== address) {
            this._startedCommunities[editCommunityOptions.address] = this._startedCommunities[address];
            delete this._startedCommunities[address];

            // Update RPC state with new address
            const db = this._getRpcStateDb();
            if (db) {
                db.prepare("UPDATE community_states SET address = @newAddress WHERE address = @oldAddress").run({
                    newAddress: editCommunityOptions.address,
                    oldAddress: address
                });
            }
        }
        if (typeof community.updatedAt === "number") return community.toJSONInternalRpcAfterFirstUpdate();
        else return community.toJSONInternalRpcBeforeFirstUpdate();
    }

    // Delegation setup (#234). Both operate on a delegated community whether or not it is started: the
    // anchor record can only be signed after the community exists, and the community refuses to start
    // until that record is published. See docs/protocol/delegated-ipns.md.
    private async _getLocalCommunityForAnchorMethod(identifier: { name?: string; publicKey?: string }): Promise<LocalCommunity> {
        const address = this._findCommunityAddress(identifier);
        if (!address)
            throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_USE_ANCHOR_METHOD_ON_NON_LOCAL_COMMUNITY", {
                communityAddress: identifier.name || identifier.publicKey
            });
        if (this._startedCommunities[address] instanceof LocalCommunity) return <LocalCommunity>this._startedCommunities[address];
        const pkc = await this._getPKCInstance();
        return <LocalCommunity>await pkc.createCommunity({ address });
    }

    async prepareAnchorPublish(params: any): Promise<AnchorPublishPreparation> {
        const { name, publicKey } = parseRpcCommunityIdentifierParam(params[0]);
        const community = await this._getLocalCommunityForAnchorMethod({ name, publicKey });
        return community.prepareAnchorPublish();
    }

    async publishAnchorRecord(params: any): Promise<PublishedAnchorRecord> {
        const { name, publicKey, recordBase64 } = parseRpcPublishAnchorRecordParam(params[0]);
        const community = await this._getLocalCommunityForAnchorMethod({ name, publicKey });
        // base64 in, bytes out: the record is signed, so it must reach routing.put byte-identical.
        return community.publishAnchorRecord(uint8ArrayFromString(recordBase64, "base64"));
    }

    async deleteCommunity(params: any): Promise<RpcSuccessResult> {
        const { name, publicKey } = parseRpcCommunityIdentifierParam(params[0]);
        const pkc = await this._getPKCInstance();

        const address = this._findCommunityAddress({ name, publicKey });
        if (!address) throw new PKCError("ERR_RPC_CLIENT_TRYING_TO_DELETE_REMOTE_COMMUNITY", { communityAddress: name || publicKey });

        const isCommunityStarted = address in this._startedCommunities;
        const community = isCommunityStarted
            ? await this.getStartedCommunity(address)
            : <LocalCommunity>await pkc.createCommunity({ address });
        await community.delete();
        await this._postStoppingOrDeleting(community);
        delete this._startedCommunities[address];
        this._removeCommunityState(address);

        return { success: true };
    }

    async communitiesSubscribe(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
        // TODO need to implement _onSettingsChange here
        const subscriptionId = generateSubscriptionId();
        const sendEvent = (event: string, result: any) => {
            this.jsonRpcSendNotification({
                method: "communitiesNotification",
                subscription: Number(subscriptionId),
                event,
                result,
                connectionId
            });
        };

        const pkcSubscribeEvent = (newCommunities: string[]) => sendEvent("communitieschange", { communities: newCommunities });

        const pkc = await this._getPKCInstance();
        pkc.on("communitieschange", pkcSubscribeEvent);

        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            pkc.removeListener("communitieschange", pkcSubscribeEvent);
        };

        sendEvent("communitieschange", { communities: pkc.communities });

        return { subscriptionId };
    }

    async fetchCid(params: any): Promise<RpcFetchCidResult> {
        const parsedArgs = parseRpcCidParam(params[0]);
        const pkc = await this._getPKCInstance();
        return pkc.fetchCid(parsedArgs);
    }

    private _serializeSettingsFromPKC(pkc: PKC): PKCWsServerSettingsSerialized {
        const pkcOptions = pkc.parsedPKCOptions;
        const builtInChallenges = PKCJs.PKC.challenges || {};
        const allChallengeFactories = {
            ...builtInChallenges, // built-ins first
            ...(pkc.settings?.challenges || {}) // user-defined override
        };
        const challenges = mapValues(allChallengeFactories, (challengeFactory) =>
            omit(challengeFactory({ challengeSettings: {} }), ["getChallenge"])
        );

        return <PKCWsServerSettingsSerialized>{ pkcOptions, challenges };
    }

    async settingsSubscribe(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
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
        await sendRpcSettings({ newPKC: this.pkc });

        return { subscriptionId };
    }

    private _initPKC(pkc: PKC) {
        this.pkc = pkc;
        pkc.on("error", (error: any) => log.error("RPC server", "Received an error on pkc instance", error));
    }

    private async _createPKCInstanceFromSetSettings(newOptions: InputPKCOptions) {
        return PKCJs.PKC(newOptions);
    }

    async setSettings(params: any): Promise<RpcSuccessResult> {
        const runSetSettings = async () => {
            const settings = parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(params[0]);
            const currentSettings = this._serializeSettingsFromPKC(this.pkc);
            if (deterministicStringify(settings.pkcOptions) === deterministicStringify(currentSettings.pkcOptions)) {
                log("RPC client called setSettings with the same settings as the current one, aborting");
                return;
            }

            log(`RPC client called setSettings, the clients need to call all subscription methods again`);
            const oldPKC = this.pkc;
            // Strip nameResolvers from client settings — RPC server ignores them for now
            const { nameResolvers: _stripNr, ...pkcOptionsWithoutNameResolvers } = settings.pkcOptions;
            const newPKC = await this._createPKCInstanceFromSetSettings({
                ...pkcOptionsWithoutNameResolvers,
                nameResolvers: this.pkc.parsedPKCOptions.nameResolvers
            } as InputPKCOptions);
            this._initPKC(newPKC); // swap to new instance first so new RPC calls don't hit a destroyed pkc

            // send a settingsNotification to all subscribers
            for (const connectionId of keys(this._onSettingsChange)) {
                const connectionHandlers = this._onSettingsChange[connectionId];
                if (!connectionHandlers) continue;
                for (const subscriptionId of keys(connectionHandlers)) {
                    const handler = connectionHandlers[subscriptionId];
                    if (!handler) continue;
                    try {
                        await handler({ newPKC });
                    } catch (error) {
                        // One failing handler must not abort the loop: the remaining subscriptions
                        // would never migrate to the new pkc and would die silently when the old
                        // pkc is destroyed (issue #129)
                        log.error(
                            `Failed to apply settings change to subscription ${subscriptionId} of connection ${connectionId}, continuing with remaining subscriptions`,
                            error
                        );
                    }
                }
            }

            // ensure any existing publications get a timeout if they were created before the first setSettings
            for (const [subscriptionId, pub] of Object.entries(this.publishing).filter((pub) => pub[1].pkc === oldPKC)) {
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
        return { success: true as const };
    }

    async commentUpdateSubscribe(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
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
        const pkc = await this._getPKCInstance();
        const comment = await pkc.createComment(parsedCommentUpdateArgs);
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
                        pages: buildPagesRuntimeFields(comment.raw.commentUpdate.replies.pages, pkc._memCaches.nameResolvedCache)
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
            comment._pkc = newPKC;
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

        return { subscriptionId };
    }

    async communityUpdateSubscribe(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
        const parsedCommunityUpdateArgs = parseRpcCommunityIdentifierParam(params[0]);
        const subscriptionId = generateSubscriptionId();

        await this._bindCommunityUpdateSubscription(parsedCommunityUpdateArgs, connectionId, subscriptionId);

        return { subscriptionId };
    }

    private async _bindCommunityUpdateSubscription(parsedArgs: CommunityIdentifierRpcParam, connectionId: string, subscriptionId: number) {
        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "communityUpdateNotification",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const pkc = await this._getPKCInstance();
        const startedCommunity = findStartedCommunity(pkc, parsedArgs);
        const isStartedCommunity = Boolean(startedCommunity);
        const community = startedCommunity || <LocalCommunity | RemoteCommunity>await pkc.createCommunity(parsedArgs);

        const sendCommunityJson = () => {
            let jsonToSend:
                | RpcRemoteCommunityType
                | RpcInternalCommunityRecordAfterFirstUpdateType
                | RpcInternalCommunityRecordBeforeFirstUpdateType;
            if (community instanceof LocalCommunity)
                jsonToSend =
                    typeof community.updatedAt === "number"
                        ? community.toJSONInternalRpcAfterFirstUpdate()
                        : community.toJSONInternalRpcBeforeFirstUpdate();
            else jsonToSend = community.toJSONRpcRemote();

            // Merge preloaded page runtimeFields into existing runtimeFields
            const communityIpfsRecord = community.raw.communityIpfs;
            if (communityIpfsRecord?.posts?.pages && "runtimeFields" in jsonToSend && jsonToSend.runtimeFields) {
                Object.assign(jsonToSend.runtimeFields, {
                    posts: { pages: buildPagesRuntimeFields(communityIpfsRecord.posts.pages, pkc._memCaches.nameResolvedCache) }
                });
            }

            sendEvent("update", jsonToSend);
        };

        const updateListener = () => sendCommunityJson();
        community.on("update", updateListener);

        const updatingStateListener = () => sendEvent("updatingstatechange", { state: community.updatingState });
        community.on("updatingstatechange", updatingStateListener);

        // listener for startestatechange
        const startedStateListener = () => sendEvent("updatingstatechange", { state: community.startedState });
        if (isStartedCommunity) {
            community.on("startedstatechange", startedStateListener);
        }

        const errorListener = (error: PKCError | Error) => {
            const rpcError = error as CommunityRpcErrorToTransmit;
            if (community.state === "started") rpcError.details = { ...rpcError.details, newStartedState: community.startedState };
            else if (community.state === "updating") rpcError.details = { ...rpcError.details, newUpdatingState: community.updatingState };
            log("community rpc error", rpcError);
            sendEvent("error", rpcError);
        };
        community.on("error", errorListener);

        // Guards recovery from firing during transitions we initiate on purpose (an unsubscribe
        // teardown, or the stop()+update() swap in the settings handler below)
        let intentionalStopInFlight = false;
        let recovering = false;
        // The subscription's mirror shares a server-side pkc._updatingCommunities entry with every
        // other subscription to the same community. That shared entry can be stopped while this
        // client is still subscribed (its refcount driven to 0 by another subscription's teardown
        // or setSettings, or a pkc being destroyed), which cascades this mirror to "stopped"
        // (src/community/remote-community.ts). Nothing else revives it, so the client's websocket
        // would stay connected but silent forever (issue #129 / #181). The client never asked to
        // stop, so re-establish updating on a fresh entry.
        const recoverIfStrandedListener = async (newState: string) => {
            if (newState !== "stopped" || isStartedCommunity || intentionalStopInFlight || recovering) return;
            // Client has unsubscribed if the cleanup is gone; don't resurrect a dead subscription
            if (!this.subscriptionCleanups?.[connectionId]?.[subscriptionId]) return;
            recovering = true;
            try {
                log("Recovering community subscription", community.address, "whose shared updating instance was stopped");
                await community.update();
            } catch (e) {
                log.error("Failed to recover community subscription after its updating instance stopped", community.address, e);
            } finally {
                recovering = false;
            }
        };
        community.on("statechange", recoverIfStrandedListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            log("Cleaning up community", community.address, "client subscription");
            // Remove the recovery listener FIRST so the stop() below (an intentional teardown) does
            // not trigger a resurrection
            community.removeListener("statechange", recoverIfStrandedListener);
            community.removeListener("update", updateListener);
            community.removeListener("updatingstatechange", updatingStateListener);
            community.removeListener("error", errorListener);
            community.removeListener("startedstatechange", startedStateListener);
            if (this._onSettingsChange[connectionId]) delete this._onSettingsChange[connectionId][subscriptionId];

            // We don't wanna stop the local community if it's running already, this function is just for fetching updates
            // if we comment this out remove test passes
            if (!isStartedCommunity && community.state !== "stopped") await community.stop();
        };

        this._onSettingsChange[connectionId][subscriptionId] = async ({ newPKC }: { newPKC: PKC }) => {
            // TODO this may need changing
            if (!isStartedCommunity) {
                intentionalStopInFlight = true;
                try {
                    community._pkc = newPKC;
                    await community.stop();
                    await community.update();
                } finally {
                    intentionalStopInFlight = false;
                }
            }
        };

        // if fail, cleanup
        try {
            // need to send an update with first communityUpdate if it's a local community
            if ("signer" in community || community.raw.communityIpfs) sendCommunityJson();

            // No need to call .update() if it's already running locally because we're listening to update event
            if (!isStartedCommunity) await community.update();
        } catch (e) {
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
            throw e;
        }
    }

    private async _createCommentInstanceFromPublishCommentParams(params: CommentChallengeRequestToEncryptType) {
        const pkc = await this._getPKCInstance();
        const comment = await pkc.createComment(params.comment);
        comment.challengeRequest = omit(params, ["comment"]);
        return comment;
    }

    async publishComment(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
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
        this._registerPublishing(subscriptionId, comment, comment._pkc, connectionId);
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
            return { subscriptionId };
        }

        return { subscriptionId };
    }

    private async _createVoteInstanceFromPublishVoteParams(params: VoteChallengeRequestToEncryptType) {
        const pkc = await this._getPKCInstance();
        const vote = await pkc.createVote(params.vote);
        vote.challengeRequest = omit(params, ["vote"]);
        return vote;
    }
    async publishVote(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
        // TODO need to implement _onSettingsChange here
        const publishOptions = parseVoteChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(params[0]);

        // TODO need to think, what happens if user never sends a unsubsribe call?
        // publication will never get removed from this.publishing
        const subscriptionId = generateSubscriptionId();

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({ method: "publishVoteNotification", subscription: subscriptionId, event, result, connectionId });

        const vote = await this._createVoteInstanceFromPublishVoteParams(publishOptions);
        this._registerPublishing(subscriptionId, vote, vote._pkc, connectionId);
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

        return { subscriptionId };
    }

    private async _createCommunityEditInstanceFromPublishCommunityEditParams(params: CommunityEditChallengeRequestToEncryptType) {
        const pkc = await this._getPKCInstance();
        const communityEdit = await pkc.createCommunityEdit(params.communityEdit);
        communityEdit.challengeRequest = omit(params, ["communityEdit"]);
        return communityEdit;
    }

    async publishCommunityEdit(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
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

        const communityEdit = await this._createCommunityEditInstanceFromPublishCommunityEditParams(publishOptions);
        this._registerPublishing(subscriptionId, communityEdit, communityEdit._pkc, connectionId);
        const challengeListener = (challenge: DecryptedChallengeMessageType) => sendEvent("challenge", encodeChallengeMessage(challenge));
        communityEdit.on("challenge", challengeListener);
        const challengeAnswerListener = (answer: DecryptedChallengeAnswerMessageType) =>
            sendEvent("challengeanswer", encodeChallengeAnswerMessage(answer));
        communityEdit.on("challengeanswer", challengeAnswerListener);
        const challengeRequestListener = (request: DecryptedChallengeRequestMessageType) =>
            sendEvent("challengerequest", encodeChallengeRequest(request));
        communityEdit.on("challengerequest", challengeRequestListener);
        const challengeVerificationListener = (challengeVerification: DecryptedChallengeVerificationMessageType) =>
            sendEvent("challengeverification", {
                challengeVerification: encodeChallengeVerificationMessage(challengeVerification)
            });
        communityEdit.on("challengeverification", challengeVerificationListener);
        const publishingStateListener = () => sendEvent("publishingstatechange", { state: communityEdit.publishingState });
        communityEdit.on("publishingstatechange", publishingStateListener);

        const errorListener = (error: PKCError | Error) => {
            const editRpcError = error as PublicationRpcErrorToTransmit;
            editRpcError.details = { ...editRpcError.details, newPublishingState: communityEdit.publishingState };
            sendEvent("error", editRpcError);
        };
        communityEdit.on("error", errorListener);

        // cleanup function
        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            this._clearPublishing(subscriptionId);
            await communityEdit.stop();
            communityEdit.removeListener("challenge", challengeListener);
            communityEdit.removeListener("challengeanswer", challengeAnswerListener);
            communityEdit.removeListener("challengerequest", challengeRequestListener);
            communityEdit.removeListener("challengeverification", challengeVerificationListener);
            communityEdit.removeListener("publishingstatechange", publishingStateListener);
            communityEdit.removeListener("error", errorListener);
        };

        // if fail, cleanup
        try {
            await communityEdit.publish();
        } catch (e) {
            const error = e as PublicationRpcErrorToTransmit;
            error.details = { ...error.details, publishThrowError: true };
            errorListener(error);
            const cleanup = this.subscriptionCleanups?.[connectionId]?.[subscriptionId];
            if (cleanup) await cleanup();
        }

        return { subscriptionId };
    }

    private async _createCommentEditInstanceFromPublishCommentEditParams(params: CommentEditChallengeRequestToEncryptType) {
        const pkc = await this._getPKCInstance();
        const commentEdit = await pkc.createCommentEdit(params.commentEdit);
        commentEdit.challengeRequest = omit(params, ["commentEdit"]);
        return commentEdit;
    }

    async publishCommentEdit(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
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
        this._registerPublishing(subscriptionId, commentEdit, commentEdit._pkc, connectionId);
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

        return { subscriptionId };
    }

    private async _createCommentModerationInstanceFromPublishCommentModerationParams(params: CommentModerationChallengeRequestToEncrypt) {
        const pkc = await this._getPKCInstance();
        const commentModeration = await pkc.createCommentModeration(params.commentModeration);
        commentModeration.challengeRequest = omit(params, ["commentModeration"]);
        return commentModeration;
    }

    async publishCommentModeration(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
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

        this._registerPublishing(subscriptionId, commentMod, commentMod._pkc, connectionId);
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

        return { subscriptionId };
    }

    async publishChallengeAnswers(params: any): Promise<RpcSuccessResult> {
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

        await publication.publishChallengeAnswers({ challengeAnswers: decryptedChallengeAnswers.challengeAnswers });

        return { success: true };
    }

    async resolveAuthorName(params: any): Promise<RpcResolveAuthorNameResult> {
        const parsedArgs = parseRpcAuthorNameParam(params[0]);
        const pkc = await this._getPKCInstance();
        return pkc.resolveAuthorName(parsedArgs);
    }

    // community.export() — see src/rpc/EXPORT_COMMUNITY_SPEC.md
    // Resolves to the canonical LocalCommunity instance for the given identifier so that
    // exportCommunity / exportsSubscribe / cancelExport all share the same `_exports` array
    // and `exportschange` event source. Cache-first ordering matters: once the first
    // export-related call lands on an instance, every subsequent one must reuse it. Otherwise
    // a subscription attached before community.start() would listen on a different
    // LocalCommunity than the started instance picked up by a later exportCommunity call
    // (pkc.createCommunity at src/pkc/pkc.ts:749 constructs a new LocalCommunity per call),
    // and the export's `exportschange` would never reach the listener.
    private async _resolveLocalCommunityForExport(parsedArgs: { name?: string; publicKey?: string }): Promise<LocalCommunity> {
        const address = this._findCommunityAddress(parsedArgs);
        if (!address) throw new PKCError("ERR_COMMUNITY_NOT_FOUND", { name: parsedArgs.name, publicKey: parsedArgs.publicKey });

        const cached = this._exportCommunityInstances.get(address);
        if (cached) return cached;

        // No cache yet — prefer the started instance if one exists, otherwise load fresh.
        const started = findStartedCommunity(this.pkc, parsedArgs);
        if (started instanceof LocalCommunity) {
            this._exportCommunityInstances.set(address, started);
            return started;
        }

        const community = <LocalCommunity | RemoteCommunity>await this.pkc.createCommunity({ address });
        if (!(community instanceof LocalCommunity)) throw new PKCError("ERR_COMMUNITY_NOT_LOCAL", { address });
        this._exportCommunityInstances.set(address, community);
        return community;
    }

    // Server-side records carry `file://` URLs (the embedded path). Over the wire we emit a
    // relative `/exports/<exportId>` URL; the RPC client absolutizes against rpcHttpOrigin.
    private _toWireExportRecord(rec: CommunityExportRecord): CommunityExportRecord {
        if (rec.progress === 1 && rec.url) return { ...rec, url: `/exports/${rec.exportId}` };
        return rec;
    }

    async exportCommunity(params: any, connectionId: string): Promise<RpcExportCommunityResult> {
        const parsedArgs = parseRpcExportCommunityParam(params[0]);
        if (parsedArgs.includePrivateKey === true && !this._allowPrivateKeyExport)
            throw new PKCError("ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED", {});
        const community = await this._resolveLocalCommunityForExport(parsedArgs);
        return community.export({ includePrivateKey: parsedArgs.includePrivateKey });
    }

    async exportCommunityModLogs(params: any): Promise<RpcExportCommunityModLogsResult> {
        // No private-key gate like exportCommunity: comment moderations are public, signed,
        // pubsub-published data. Resolve the owned community the same way editCommunity does.
        const { name, publicKey, startTimestamp, endTimestamp, commentCid, limit, order } = parseRpcExportCommunityModLogsParam(params[0]);
        const address = this._findCommunityAddress({ name, publicKey });
        if (!address) throw new PKCError("ERR_COMMUNITY_NOT_FOUND", { name, publicKey });
        let community: LocalCommunity;
        if (this._startedCommunities[address] instanceof LocalCommunity) community = <LocalCommunity>this._startedCommunities[address];
        else {
            const created = await (await this._getPKCInstance()).createCommunity({ address });
            if (!(created instanceof LocalCommunity)) throw new PKCError("ERR_COMMUNITY_NOT_LOCAL", { address });
            community = created;
        }
        return community.exportCommunityModLogs({ startTimestamp, endTimestamp, commentCid, limit, order });
    }

    async exportsSubscribe(params: any, connectionId: string): Promise<RpcSubscriptionIdResult> {
        const parsedArgs = parseRpcCommunityIdentifierParam(params[0]);
        const subscriptionId = generateSubscriptionId();
        const community = await this._resolveLocalCommunityForExport(parsedArgs);

        const sendEvent = (event: string, result: any) =>
            this.jsonRpcSendNotification({
                method: "exportschange",
                subscription: subscriptionId,
                event,
                result,
                connectionId
            });

        const exportschangeListener = (records: CommunityExportRecord[]) =>
            sendEvent("exportschange", { records: records.map((r) => this._toWireExportRecord(r)) });
        community.on("exportschange", exportschangeListener);

        this.subscriptionCleanups[connectionId][subscriptionId] = async () => {
            community.removeListener("exportschange", exportschangeListener);
        };

        // Initial notification carries the current exports array. Per spec, tearing down this
        // subscription does NOT cancel any in-flight exports — exports outlive client connections.
        sendEvent("exportschange", { records: community.exports.map((r) => this._toWireExportRecord(r)) });

        return { subscriptionId };
    }

    async cancelExport(params: any, connectionId: string): Promise<RpcSuccessResult> {
        const { exportId } = parseRpcCancelExportParam(params[0]);
        for (const community of this._exportLoadedCommunities())
            if (community._activeExports.has(exportId)) {
                await community._cancelExport(exportId);
                break;
            }
        // Idempotent: unknown exportId returns success without action (per spec).
        return { success: true };
    }

    private *_exportLoadedCommunities(): IterableIterator<LocalCommunity> {
        for (const value of Object.values(this._startedCommunities)) if (value instanceof LocalCommunity) yield value;
        for (const value of this._exportCommunityInstances.values()) yield value;
    }

    private _findCommunityOwningExport(exportId: string): { community: LocalCommunity; record: CommunityExportRecord } | undefined {
        for (const community of this._exportLoadedCommunities()) {
            const record = community._exports.find((r) => r.exportId === exportId);
            if (record) return { community, record };
        }
        return undefined;
    }

    // GET /exports/<exportId> — streams the sqlite backup over HTTP on the same port as the WS.
    // After a successful response, deletes the file and prunes the record (per spec).
    // Deletes export files older than `_exportFileMaxAgeMs` (default 24h, configurable via the
    // `exportFileMaxAgeMs` server option; 0 disables the sweep). Called once on server startup (per spec). Records
    // pointing to deleted files get pruned the next time the community loads via
    // loadAndPruneExportsFromKeyv. We do not eagerly load every community here to avoid the
    // boot cost; the embedded loader handles cleanup lazily.
    async _sweepOldExportFiles(): Promise<void> {
        const MAX_AGE_MS = this._exportFileMaxAgeMs;
        // 0 means "keep export files forever" — never auto-remove anything.
        if (MAX_AGE_MS === 0) return;
        if (!this.pkc.dataPath) return;
        const exportsDir = path.join(this.pkc.dataPath, "exports");
        if (!existsSync(exportsDir)) return;

        const now = Date.now();
        let entries: string[] = [];
        try {
            entries = await fsPromises.readdir(exportsDir);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.endsWith(".sqlite")) continue;
            const filePath = path.join(exportsDir, entry);
            try {
                const stat = await fsPromises.stat(filePath);
                if (now - stat.mtimeMs > MAX_AGE_MS) await fsPromises.unlink(filePath);
            } catch {
                // file may have been removed concurrently — ignore
            }
        }
    }

    private async _handleExportsHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const httpLog = Logger("pkc-js:PKCWsServer:exports-http");
        const requestUrl = new URL(req.url ?? "/", "http://localhost");
        const match = requestUrl.pathname.match(/^\/exports\/([0-9a-fA-F-]{36})$/);
        if (!match) {
            // On a caller-supplied server we may be sharing the http.Server with the caller's own
            // routes. Only the owner of the server is responsible for the catch-all 404 — otherwise
            // we'd hijack/clobber responses for unrelated routes the caller serves on the same port.
            if (this._ownsHttpServer) {
                res.statusCode = 404;
                res.end();
            }
            return;
        }
        if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET");
            res.end();
            return;
        }
        const exportId = match[1];
        const owner = this._findCommunityOwningExport(exportId);

        // Resolve the file to stream. Prefer the in-memory record of a loaded community; otherwise
        // fall back to the persisted file on disk. The disk fallback is what keeps a download URL
        // valid across a daemon restart, when the owning community has not been loaded back into
        // memory yet: the export file survives at <dataPath>/exports/<id>.sqlite and exportId is an
        // unguessable capability. (The `.partial` suffix used for in-flight backups can't match this
        // exact `<id>.sqlite` route, so a partial is never served.)
        const community = owner?.community;
        let candidatePath: string | undefined;
        if (owner) {
            const { record } = owner;
            if (record.progress === 1 && record.url)
                try {
                    const parsed = new URL(record.url);
                    if (parsed.protocol === "file:") candidatePath = fileURLToPath(parsed);
                } catch {
                    candidatePath = undefined;
                }
        } else if (this.pkc.dataPath) {
            candidatePath = path.join(this.pkc.dataPath, "exports", `${exportId}.sqlite`);
        }

        if (!candidatePath) {
            httpLog("GET /exports — unknown exportId", exportId);
            res.statusCode = 404;
            res.end();
            return;
        }
        const filePath = candidatePath;

        let size: number;
        try {
            size = statSync(filePath).size;
        } catch {
            res.statusCode = 404;
            res.end();
            return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.sqlite3");
        res.setHeader("Content-Length", String(size));

        const stream = createReadStream(filePath);
        let streamEnded = false;
        let streamErrored = false;
        stream.on("end", () => {
            streamEnded = true;
        });
        stream.on("error", (err) => {
            streamErrored = true;
            httpLog.error("Error streaming export file", filePath, err);
            if (!res.headersSent) res.statusCode = 500;
            res.end();
        });
        res.on("close", () => {
            // Cleanup only on fully streamed + flushed responses. Client aborts and stream
            // errors leave the record + file intact so the consumer can retry.
            if (streamErrored || !streamEnded || !res.writableEnded) return;
            if (community) {
                // Loaded community: prune the record and delete the file together.
                community._deleteExport(exportId).catch((e) => httpLog.error("Failed to cleanup downloaded export", exportId, e));
            } else {
                // Served from disk after a restart (no community loaded): just remove the file. The
                // stale KeyV record is pruned lazily the next time that community loads, via
                // loadAndPruneExportsFromKeyv (which drops records whose file is missing).
                fsPromises.unlink(filePath).catch((e) => httpLog.error("Failed to cleanup downloaded export file", exportId, e));
            }
        });
        stream.pipe(res);
    }

    async unsubscribe(params: any, connectionId: string): Promise<RpcSuccessResult> {
        const { subscriptionId } = parseRpcUnsubscribeParam(params[0]);

        log("Received unsubscribe", { connectionId, subscriptionId });
        const connectionCleanups = this.subscriptionCleanups[connectionId];
        if (!connectionCleanups || !connectionCleanups[subscriptionId]) return { success: true };

        await connectionCleanups[subscriptionId](); // commenting this out fixes the timeout with remove.test.js
        delete connectionCleanups[subscriptionId];
        return { success: true };
    }

    async destroy() {
        for (const connectionId of keys(this.subscriptionCleanups))
            for (const subscriptionId of keys(this.subscriptionCleanups[connectionId]))
                await this.unsubscribe([{ subscriptionId: Number(subscriptionId) }], connectionId);

        this.ws.close();
        if (this._ownsHttpServer && this._httpServer) await new Promise<void>((r) => this._httpServer!.close(() => r()));
        const pkc = await this._getPKCInstance();
        await pkc.destroy(); // this will stop all started communities
        for (const communityAddress of keys(this._startedCommunities)) {
            delete this._startedCommunities[communityAddress];
        }
        this._exportCommunityInstances.clear();
        this._rpcStateDb?.close();
        this._rpcStateDb = undefined;
        this._onSettingsChange = {};
    }
}

const createPKCWsServer = async (options: CreatePKCWsServerOptions) => {
    const parsedOptions = parseCreatePKCWsServerOptionsSchemaWithPKCErrorIfItFails(options);
    const pkc = await PKCJs.PKC(parsedOptions.pkcOptions);

    const pkcWss = new PKCWsServer({
        pkc,
        port: parsedOptions.port,
        server: parsedOptions.server,
        authKey: parsedOptions.authKey,
        startStartedCommunitiesOnStartup: parsedOptions.startStartedCommunitiesOnStartup,
        autoStartConcurrency: parsedOptions.autoStartConcurrency,
        allowPrivateKeyExport: parsedOptions.allowPrivateKeyExport,
        exportFileMaxAgeMs: parsedOptions.exportFileMaxAgeMs
    });

    // Auto-start previously started communities (fire-and-forget, non-blocking)
    pkcWss._autoStartPreviousCommunities().catch((e) => {
        log.error("Failed to auto-start previous communities", e);
    });

    // Delete export files older than exportFileMaxAgeMs (default 24h, fire-and-forget) — see EXPORT_COMMUNITY_SPEC.md
    pkcWss._sweepOldExportFiles().catch((e) => {
        log.error("Failed to sweep old export files", e);
    });

    return pkcWss;
};

const PKCRpc = {
    PKCWsServer: createPKCWsServer,
    // for mocking pkc-js during tests
    setPKCJs
};

export default PKCRpc;
