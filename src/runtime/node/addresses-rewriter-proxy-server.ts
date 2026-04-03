import http from "node:http";
import https from "node:https";
import path from "node:path";
import Logger from "../../logger.js";
import * as remeda from "remeda";
import retry from "retry";
import { Plebbit } from "../../plebbit/plebbit.js";
import { hideClassPrivateProps } from "../../util.js";
import { RoutingQueryEvent } from "kubo-rpc-client";
import { AddressRewriterDatabase, RequestLogEntry } from "./address-rewriter-db.js";
const debug = Logger("plebbit-js:addresses-rewriter");
const MAX_BODY_PREVIEW_BYTES = 4096;

type AddressesRewriterOptions = {
    kuboClients: Plebbit["clients"]["kuboRpcClients"][string]["_client"][];
    port: number;
    hostname: string | undefined;
    proxyTargetUrl: string;
    plebbit: Pick<Plebbit, "_storage" | "dataPath">;
};

export class AddressesRewriterProxyServer {
    addresses: Record<string, string[]>; // Peer id => addresses
    kuboClients: AddressesRewriterOptions["kuboClients"];
    port: number;
    hostname: string;
    proxyTarget: URL;
    server: ReturnType<(typeof http)["createServer"]>;
    _storageKeyName: string;
    _plebbit: Pick<Plebbit, "_storage" | "dataPath">;

    // SQLite logging
    private _db: AddressRewriterDatabase | null;
    private _logWriteInterval?: ReturnType<typeof setInterval>;
    private _requestLogBuffer: RequestLogEntry[] = [];
    private _isWritingLogs = false;
    private _loggingEnabled: boolean;

    // Failed keys retry logic
    private _failedKeys: Set<string> = new Set();
    private _retryInterval?: ReturnType<typeof setInterval>;

    private _updateAddressesInterval?: ReturnType<typeof setInterval>;

    // HTTP agents for connection reuse
    private _httpAgent: http.Agent;
    private _httpsAgent: https.Agent;
    constructor({ kuboClients: kuboClient, port, hostname, proxyTargetUrl, plebbit }: AddressesRewriterOptions) {
        this.addresses = {};

        this.kuboClients = kuboClient;
        this.port = port;
        this.hostname = hostname || "127.0.0.1";
        this.proxyTarget = new URL(proxyTargetUrl);
        this.server = http.createServer((req, res) => this._proxyRequestRewrite(req, res));
        this._storageKeyName = `httprouter_proxy_${proxyTargetUrl}`;
        this._plebbit = plebbit;

        // Environment-based logging toggle
        const envValue = process.env.ENABLE_LOGGING_OF_ADDRESS_REWRITER_PROXY;
        this._loggingEnabled = envValue === "1" || envValue?.toLowerCase() === "true";

        // Initialize database only when logging is enabled
        if (this._loggingEnabled) {
            const kuboConfig = this.kuboClients?.[0]?.getEndpointConfig();
            this._db = new AddressRewriterDatabase(this._plebbit.dataPath!, kuboConfig, this.proxyTarget);
        } else {
            this._db = null;
        }

        // Create HTTP agents with connection pooling and keep-alive
        this._httpAgent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 50,
            timeout: 10000
        });

        this._httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 50,
            timeout: 10000
        });

        hideClassPrivateProps(this);
    }

    async listen(callback?: () => void) {
        if (this._loggingEnabled && this._db) {
            await this._db.initialize();
            debug("Request logging enabled for addresses rewriter proxy");
        } else {
            debug("Request logging disabled for addresses rewriter proxy");
        }
        await this._startUpdateAddressesLoop();
        if (this._loggingEnabled) {
            this._startRequestLogging();
        }
        await this._startFailedKeysRetry();
        this.server.on("error", (err) =>
            debug.error("Error with address rewriter proxy", this.server.address(), "Proxy target", this.proxyTarget, err)
        );
        this.server.listen(this.port, this.hostname, callback);
        debug(
            "Addresses rewriter proxy at",
            this.hostname + ":" + this.port,
            "started listening to forward requests to",
            this.proxyTarget.host,
            `- request logging ${this._loggingEnabled ? "enabled" : "disabled"}`
        );
        await this._plebbit._storage.setItem(this._storageKeyName, `http://${this.hostname}:${this.port}`);
    }

    async destroy() {
        this.server.close();
        if (this._updateAddressesInterval) {
            clearInterval(this._updateAddressesInterval);
        }
        if (this._logWriteInterval) {
            clearInterval(this._logWriteInterval);
        }
        if (this._retryInterval) {
            clearInterval(this._retryInterval);
        }

        // Write any remaining logs before destroying
        await this._writeRequestLogs();

        // Close database connection
        this._db?.close();

        // Destroy HTTP agents to clean up connections
        this._httpAgent.destroy();
        this._httpsAgent.destroy();

        await this._plebbit._storage.removeItem(this._storageKeyName);
    }

    _proxyRequestRewrite(req: Parameters<http.RequestListener>[0], res: Parameters<http.RequestListener>[1]) {
        // get post body
        let reqBody = "";

        req.on("data", (chunk) => {
            reqBody += chunk.toString();
        });

        // wait for full post body
        req.on("end", () => {
            // Only track and rewrite PUT/POST requests (provider registration)
            const shouldRewrite = req.method === "PUT" || req.method === "POST";

            // Create request log entry for PUT/POST requests
            let requestLogEntry: RequestLogEntry | null = null;
            if (shouldRewrite) {
                const keys = this._extractKeysFromRequestBody(reqBody);
                const shouldLogRequest = this._loggingEnabled;
                if (keys.length > 0 || shouldLogRequest) {
                    requestLogEntry = {
                        keys,
                        receivedAt: Date.now(),
                        success: false,
                        method: req.method || "UNKNOWN",
                        url: req.url || "/",
                        retryCount: 0,
                        bodyPreview: shouldLogRequest ? this._createBodyPreview(reqBody) : undefined
                    };
                    if (shouldLogRequest) {
                        this._requestLogBuffer.push(requestLogEntry);
                    }
                }
            }

            // rewrite body with up to date addresses (only for PUT/POST)
            let rewrittenBody = reqBody;
            if (shouldRewrite && rewrittenBody) {
                try {
                    const json = JSON.parse(rewrittenBody);
                    if (json.Providers && Array.isArray(json.Providers)) {
                        for (const provider of json.Providers) {
                            const peerId = provider?.Payload?.ID;
                            if (peerId && this.addresses[peerId]) {
                                provider.Payload.Addrs = this.addresses[peerId];
                            }
                        }
                        rewrittenBody = JSON.stringify(json);
                    }
                } catch (e) {
                    const error = <Error>e;
                    debug("proxy body rewrite error:", error, "body", rewrittenBody, req.url, req.method);
                }
            }

            // proxy the request
            this._proxyRequest(req, res, rewrittenBody, requestLogEntry);
        });

        // Handle request errors
        req.on("error", (err) => {
            debug.trace("Request error:", req.url, req.method, req.headers, reqBody, err);
            if (!res.headersSent) {
                debug.trace("Request error:", req.url, req.method, req.headers, reqBody, err);
                res.writeHead(500);
                res.end("Internal Server Error");
            }
        });
    }

    private _proxyRequest(
        req: Parameters<http.RequestListener>[0],
        res: Parameters<http.RequestListener>[1],
        rewrittenBody: string,
        requestLogEntry: RequestLogEntry | null
    ) {
        if (requestLogEntry) {
            requestLogEntry.retryCount = 0;
            requestLogEntry.transmittedAt = Date.now();
        }

        const { request: httpRequest } = this.proxyTarget.protocol === "https:" ? https : http;
        const agent = this.proxyTarget.protocol === "https:" ? this._httpsAgent : this._httpAgent;

        const requestOptions: http.RequestOptions = {
            hostname: this.proxyTarget.hostname,
            protocol: this.proxyTarget.protocol,
            path: req.url,
            method: req.method,
            headers: {
                ...req.headers,
                "Content-Length": Buffer.byteLength(rewrittenBody),
                "content-length": Buffer.byteLength(rewrittenBody),
                host: this.proxyTarget.host
            },
            agent,
            timeout: 10000
        };
        if (this.proxyTarget.port) {
            requestOptions.port = this.proxyTarget.port;
        }

        const proxyReq = httpRequest(requestOptions);

        // Handle timeout
        proxyReq.setTimeout(10000, () => {
            debug.trace("Proxy request timed out", requestOptions);
            if (requestLogEntry) {
                requestLogEntry.success = false;
                requestLogEntry.statusCode = 504;
                requestLogEntry.error = "Request timeout";
                // Add failed keys to retry set
                if (requestLogEntry.keys) {
                    const sizeBefore = this._failedKeys.size;
                    requestLogEntry.keys.forEach((key) => this._failedKeys.add(key));
                    const sizeAfter = this._failedKeys.size;
                    if (sizeAfter > sizeBefore) {
                        // Save to database when new keys are added
                        this._saveFailedKeysToDatabase();
                    }
                }
            }
            proxyReq.destroy();

            if (!res.headersSent) {
                res.writeHead(504);
                res.end("Gateway Timeout");
            }
        });

        // Handle proxy request errors
        proxyReq.on("error", (e) => {
            proxyReq.destroy();

            if (requestLogEntry) {
                requestLogEntry.success = false;
                requestLogEntry.statusCode = 500;
                requestLogEntry.error = `Proxy error: ${e.message}`;
                debug.trace(`Updated log entry with error for keys: ${requestLogEntry.keys.join(", ")}`);
                // Add failed keys to retry set
                if (requestLogEntry.keys) {
                    const sizeBefore = this._failedKeys.size;
                    requestLogEntry.keys.forEach((key) => this._failedKeys.add(key));
                    const sizeAfter = this._failedKeys.size;
                    if (sizeAfter > sizeBefore) {
                        // Save to database when new keys are added
                        this._saveFailedKeysToDatabase();
                    }
                }
            }

            if (!res.headersSent) {
                debug.trace("address rewriter proxy error:", e, "Request options", requestOptions);
                res.writeHead(500);
                res.end("Internal Server Error");
            }
        });

        // Handle the proxy response
        proxyReq.on("response", (proxyRes) => {
            const statusCode = proxyRes.statusCode || 500;
            const isSuccess = statusCode >= 200 && statusCode < 300;

            if (requestLogEntry) {
                requestLogEntry.success = isSuccess;
                requestLogEntry.statusCode = statusCode;
                if (!isSuccess) {
                    requestLogEntry.error = `HTTP ${statusCode}`;
                    // Add failed keys to retry set
                    if (requestLogEntry.keys) {
                        const sizeBefore = this._failedKeys.size;
                        requestLogEntry.keys.forEach((key) => this._failedKeys.add(key));
                        const sizeAfter = this._failedKeys.size;
                        if (sizeAfter > sizeBefore) {
                            // Save to database when new keys are added
                            this._saveFailedKeysToDatabase();
                        }
                    }
                }
            }

            // Handle proxy response errors
            proxyRes.on("error", (err) => {
                debug.trace("Proxy response error:", err);
                if (!res.headersSent) {
                    res.writeHead(500);
                    res.end("Proxy Response Error");
                }
                if (requestLogEntry) {
                    requestLogEntry.success = false;
                    requestLogEntry.statusCode = 500;
                    requestLogEntry.error = `Proxy response error: ${err.message}`;
                }
                proxyRes.destroy(err);
            });

            // Forward successful response
            if (!res.headersSent) {
                res.writeHead(statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            }

            res.on("finish", () => {
                proxyRes.resume();
            });
        });

        proxyReq.write(rewrittenBody);
        proxyReq.end();
    }

    // get up to date listen addresses from kubo every x minutes
    async _startUpdateAddressesLoop() {
        if (!this.kuboClients?.length) throw Error("should have a defined kubo rpc client option to start the address rewriter");

        const isRetriableError = (error: any): boolean => {
            return error?.response?.status === 500 || error?.status === 500 || error?.statusCode === 500;
        };

        const tryUpdateAddressesForClient = async (kuboClient: Plebbit["clients"]["kuboRpcClients"][string]["_client"]): Promise<void> => {
            return new Promise((resolve) => {
                const operation = retry.operation({
                    retries: 3,
                    factor: 2,
                    minTimeout: 1000,
                    maxTimeout: 8000
                });

                operation.attempt(async (currentAttempt) => {
                    try {
                        const idRes = await kuboClient.id();
                        const swarmAddrsRes = await kuboClient.swarm.addrs();

                        const peerId: string = idRes.id.toString();
                        if (typeof peerId !== "string") throw Error("Failed to get Peer ID of kubo node");

                        const swarmListeningAddresses = swarmAddrsRes.filter((swarmAddr) => swarmAddr.id.toString() === peerId);

                        const addresses: string[] = remeda.unique([
                            ...idRes.addresses.map((addr) => addr.toString()),
                            ...remeda.flatten(swarmListeningAddresses.map((swarmAddr) => swarmAddr.addrs.map((addr) => addr.toString())))
                        ]);

                        if (addresses.length === 0) {
                            throw Error(`Failed to get any addresses for peer ${peerId}`);
                        }

                        this.addresses[peerId] = addresses;
                        resolve();
                    } catch (e) {
                        const error = <Error>e;

                        if (isRetriableError(error)) {
                            debug(`tryUpdateAddresses attempt ${currentAttempt}/4 failed with 500 error:`, error.message, {
                                kuboConfig: kuboClient.getEndpointConfig()
                            });
                            if (operation.retry(error)) return;
                        }

                        debug("tryUpdateAddresses error:", error.message, { kuboConfig: kuboClient.getEndpointConfig() });
                        resolve(); // Don't reject, just log and continue with other clients
                    }
                });
            });
        };

        const tryUpdateAddresses = async () => {
            const promises = this.kuboClients.map(tryUpdateAddressesForClient);
            await Promise.allSettled(promises);
        };
        await tryUpdateAddresses();
        this._updateAddressesInterval = setInterval(tryUpdateAddresses, 1000 * 60);
    }

    private _extractKeysFromRequestBody(body: string): string[] {
        try {
            const json = JSON.parse(body);
            const keys: string[] = [];
            if (json.Providers && Array.isArray(json.Providers)) {
                for (const provider of json.Providers) {
                    if (provider?.Payload?.Keys) {
                        keys.push(...provider.Payload.Keys);
                    }
                }
            }
            return keys;
        } catch {
            return [];
        }
    }

    private _createBodyPreview(body: string): string {
        const buffer = Buffer.from(body, "utf8");
        if (buffer.length <= MAX_BODY_PREVIEW_BYTES) return body;
        const truncated = buffer.subarray(0, MAX_BODY_PREVIEW_BYTES).toString("utf8");
        const truncatedBytes = buffer.length - MAX_BODY_PREVIEW_BYTES;
        return `${truncated}...[truncated ${truncatedBytes} bytes]`;
    }

    private async _writeRequestLogs(): Promise<void> {
        if (!this._loggingEnabled || !this._db) {
            return;
        }

        if (this._requestLogBuffer.length === 0 || this._isWritingLogs) {
            return;
        }

        this._isWritingLogs = true;
        const logsToWrite = [...this._requestLogBuffer];
        this._requestLogBuffer = []; // Clear buffer immediately to prevent duplicates

        try {
            this._db.insertRequestLogs(logsToWrite);
            debug.trace(`Wrote ${logsToWrite.length} new request log entries to SQLite database`);
        } catch (error) {
            debug.error(`Failed to write request logs to SQLite database:`, error);
            // Put logs back in buffer on failure
            this._requestLogBuffer.unshift(...logsToWrite);
        } finally {
            this._isWritingLogs = false;
        }
    }

    private _startRequestLogging() {
        if (!this._loggingEnabled || !this._db) {
            return;
        }
        const writeInterval = 5 * 1000; // 5 seconds
        this._logWriteInterval = setInterval(async () => {
            await this._writeRequestLogs();
        }, writeInterval);
    }

    private async _startFailedKeysRetry() {
        // Load failed keys from database on startup
        this._loadFailedKeysFromDatabase();

        // Start 2-minute interval for retrying failed keys
        const retryInterval = 2 * 60 * 1000; // 2 minutes
        this._retryInterval = setInterval(async () => {
            await this._retryFailedKeys();
        }, retryInterval);

        debug(`Started failed keys retry with ${this._failedKeys.size} keys from previous sessions`);
    }

    private _loadFailedKeysFromDatabase() {
        if (!this._loggingEnabled || !this._db) {
            return;
        }
        try {
            const keys = this._db.loadFailedKeys();
            keys.forEach((key) => this._failedKeys.add(key));
            debug(`Loaded ${keys.length} failed keys from database`);
        } catch (error) {
            debug.error("Failed to load failed keys from database:", error);
            throw error;
        }
    }

    private _saveFailedKeysToDatabase() {
        if (!this._loggingEnabled || !this._db) {
            return;
        }
        try {
            const keys = Array.from(this._failedKeys);
            this._db.saveFailedKeys(keys);

            if (keys.length === 0) {
                debug.trace(`All keys successfully provided - no failed keys to save`);
            } else {
                debug.trace(`Saved ${keys.length} failed keys to database`);
            }
        } catch (error) {
            debug.error("Failed to save failed keys to database:", error);
            throw error;
        }
    }

    private async _retryFailedKeys() {
        if (this._failedKeys.size === 0) {
            debug(`No failed keys to retry - all keys successfully provided`);
            return;
        }

        debug(`Retrying ${this._failedKeys.size} failed keys`);

        const keysToRetry = Array.from(this._failedKeys);
        const kuboClient = this.kuboClients?.[0];

        if (!kuboClient) {
            debug.error("No kubo client available for retry");
            return;
        }

        const successfulKeys: string[] = [];
        const stillFailedKeys: string[] = [];
        const keysToDiscard: string[] = [];

        // Process each key individually to get better granular control
        for (const key of keysToRetry) {
            try {
                debug.trace(`Providing key to HTTP routers: ${key}`);

                const events: RoutingQueryEvent[] = [];
                for await (const event of kuboClient.routing.provide(key, { recursive: true, verbose: true })) {
                    events.push(event);
                    debug(`Routing provide event for ${key}:`, event);
                }

                successfulKeys.push(key);
                debug.trace(`Successfully provided key: ${key}`);

                // Log successful reprovide attempt
                this._logReprovideAttempt(key, true, undefined, false);
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const isBlockNotLocal = errorMessage.includes("block") && errorMessage.includes("not found locally");

                // Log failed reprovide attempt
                this._logReprovideAttempt(key, false, errorMessage, isBlockNotLocal);

                // If block not found locally, discard this key - no point in retrying
                if (isBlockNotLocal) {
                    keysToDiscard.push(key);
                    debug.trace(`Discarding key ${key} - block not found locally, will not retry`);
                } else {
                    stillFailedKeys.push(key);
                    debug.trace(`Failed to provide key ${key}:`, error);
                }
            }
        }

        // Remove successful keys and keys to discard from failed set
        successfulKeys.forEach((key) => this._failedKeys.delete(key));
        keysToDiscard.forEach((key) => this._failedKeys.delete(key));

        // Save updated failed keys to database
        this._saveFailedKeysToDatabase();

        debug.trace(
            `Retry completed: ${successfulKeys.length} successful, ${stillFailedKeys.length} still failed, ${keysToDiscard.length} discarded`
        );
    }

    private _logReprovideAttempt(key: string, success: boolean, error?: string, blockNotLocal?: boolean): void {
        if (!this._loggingEnabled || !this._db) {
            return;
        }
        try {
            this._db.insertReprovideLog(key, success, error, blockNotLocal);
            debug.trace(`Logged reprovide attempt for key ${key}: success=${success}, blockNotLocal=${blockNotLocal}`);
        } catch (error) {
            debug.error(`Failed to log reprovide attempt for key ${key}:`, error);
            throw error;
        }
    }
}
