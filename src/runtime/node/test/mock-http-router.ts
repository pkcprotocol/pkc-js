import http from "node:http";
import { URL } from "node:url";
import { CID } from "multiformats/cid";

// From https://specs.ipfs.tech/routing/http-routing-v1

type NormalizedProvider = {
    Schema: string;
    ID: string;
    Addrs: string[];
    Protocols?: string[];
    AgentVersion?: string;
};

type ProviderRecord = {
    provider: NormalizedProvider;
    receivedAt: number;
};

const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PROVIDERS_IN_RESPONSE = 100;
const CACHE_TTL_WITH_RESULTS_SECONDS = 5 * 60;
const CACHE_TTL_NO_RESULTS_SECONDS = 15;
const MAX_CACHE_WINDOW_SECONDS = 24 * 60 * 60;

export type RecordedRequest = {
    method: string;
    url: string;
    timestamp: number;
    headers: http.IncomingHttpHeaders;
    body: string;
};

export type MockHttpRouterOptions = {
    hostname?: string;
    port?: number;
    // When set, the provider GET handler waits this many ms before responding. Simulates a "slow"
    // router that accepts the connection then stalls (issue #171 reproduction). The delay aborts
    // early if the request is aborted by the client.
    providerGetDelayMs?: number;
};

const PROVIDERS_PUBLISH_PATH = "/routing/v1/providers";
const PROVIDERS_GET_PREFIX = "/routing/v1/providers/";

export class MockHttpRouter {
    private _server: http.Server;
    private _hostname: string;
    private _port: number;
    private _baseUrl?: string;
    private _providerRecords: Map<string, ProviderRecord[]>;
    private _requests: RecordedRequest[];
    private _providerGetDelayMs: number;

    constructor(options: MockHttpRouterOptions = {}) {
        this._hostname = options.hostname ?? "127.0.0.1";
        this._port = options.port ?? 0;
        this._providerRecords = new Map();
        this._requests = [];
        this._providerGetDelayMs = options.providerGetDelayMs ?? 0;
        this._server = http.createServer((req, res) => {
            this._handleRequest(req, res).catch((error) => {
                if (!res.headersSent) {
                    res.writeHead(500, this._buildCorsHeaders());
                    res.end("Internal Server Error");
                }
                console.error("MockHttpRouter request handling failed", error);
            });
        });
    }

    get url(): string {
        if (!this._baseUrl) throw Error("MockHttpRouter has not been started yet");
        return this._baseUrl;
    }

    get hostname(): string {
        return this._hostname;
    }

    get port(): number {
        return this._port;
    }

    get requests(): RecordedRequest[] {
        return [...this._requests];
    }

    async start(): Promise<void> {
        if (this._baseUrl) return;
        await new Promise<void>((resolve) => {
            this._server.listen(this._port, this._hostname, resolve);
        });
        const addressInfo = this._server.address();
        if (!addressInfo || typeof addressInfo === "string") throw Error("Unexpected server address info");
        this._port = addressInfo.port;
        this._baseUrl = `http://${this._hostname}:${this._port}`;
    }

    async destroy(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this._server.close((error) => (error ? reject(error) : resolve()));
        });
        this._baseUrl = undefined;
    }

    clearRequests(): void {
        this._requests = [];
    }

    hasProvidersFor(cid: string): boolean {
        return this._getActiveProviders(cid).length > 0;
    }

    getProvidersFor(cid: string): any[] {
        return this._getActiveProviders(cid).map((record) => this._cloneProvider(record.provider));
    }

    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const body = await this._readBody(req);
        this._recordRequest(req, body);

        const corsHeaders = this._buildCorsHeaders();
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                ...corsHeaders,
                "Content-Length": "0"
            });
            res.end();
            return;
        }

        const requestUrl = this._buildUrl(req);
        if (req.method === "PUT" && this._isProvidersPublishPath(requestUrl.pathname)) {
            this._handleProviderPublish(body, res, corsHeaders);
            return;
        }
        if (req.method === "GET" && this._isProvidersGetPath(requestUrl.pathname)) {
            await this._handleProviderGet(requestUrl, res, corsHeaders);
            return;
        }
        res.writeHead(501, corsHeaders);
        res.end("Not Implemented");
    }

    private _buildCorsHeaders(): Record<string, string> {
        return {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type,Accept"
        };
    }

    private _buildUrl(req: http.IncomingMessage): URL {
        const host = req.headers.host ?? `${this._hostname}:${this._port}`;
        return new URL(req.url ?? "/", `http://${host}`);
    }

    private _recordRequest(req: http.IncomingMessage, body: Buffer) {
        this._requests.push({
            method: req.method ?? "GET",
            url: req.url ?? "/",
            timestamp: Date.now(),
            headers: { ...req.headers },
            body: body.toString("utf8")
        });
        const MAX_LOGGED_REQUESTS = 200;
        if (this._requests.length > MAX_LOGGED_REQUESTS) this._requests.shift();
    }

    private async _readBody(req: http.IncomingMessage): Promise<Buffer> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        return Buffer.concat(chunks);
    }

    private _isProvidersPublishPath(pathname: string) {
        return pathname === PROVIDERS_PUBLISH_PATH || pathname === `${PROVIDERS_PUBLISH_PATH}/`;
    }

    private _isProvidersGetPath(pathname: string) {
        return pathname.startsWith(PROVIDERS_GET_PREFIX) && pathname.length > PROVIDERS_GET_PREFIX.length;
    }

    private _handleProviderPublish(bodyBuffer: Buffer, res: http.ServerResponse, corsHeaders: Record<string, string>) {
        let parsedBody: any;
        try {
            parsedBody = JSON.parse(bodyBuffer.toString("utf8") || "{}");
        } catch {
            res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON payload" }));
            return;
        }

        if (!parsedBody || !Array.isArray(parsedBody.Providers)) {
            res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Providers array is required" }));
            return;
        }

        let storedCount = 0;
        const now = Date.now();
        for (const provider of parsedBody.Providers) {
            const keys: unknown = provider?.Payload?.Keys;
            if (!Array.isArray(keys)) continue;
            for (const key of keys) {
                if (typeof key !== "string" || !key) continue;
                if (this._addProviderRecord(key, provider, now)) {
                    storedCount++;
                }
            }
        }

        res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, stored: storedCount }));
    }

    // Seed a provider record for a CID directly, without going through the HTTP publish path.
    // Used by tests that need a "good" router which immediately serves a known provider.
    addProviderForTesting(cid: string, provider: { ID: string; Addrs: string[]; Protocols?: string[] }): void {
        this._addProviderRecord(cid, { ID: provider.ID, Addrs: provider.Addrs, Protocols: provider.Protocols }, Date.now());
    }

    private async _handleProviderGet(url: URL, res: http.ServerResponse, corsHeaders: Record<string, string>) {
        if (this._providerGetDelayMs > 0) {
            // Stall before responding to emulate a slow/hanging router. Resolve early if the client
            // disconnects (response closes before we wrote it) so we don't keep a dangling timer or
            // try to write to a dead socket. We key off the response lifecycle, NOT the request body
            // stream, whose "close" fires as soon as the GET body is drained.
            const clientGone = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => resolve(false), this._providerGetDelayMs);
                res.once("close", () => {
                    if (!res.writableEnded) {
                        clearTimeout(timer);
                        resolve(true);
                    }
                });
            });
            if (clientGone) return;
        }
        const cid = decodeURIComponent(url.pathname.slice(PROVIDERS_GET_PREFIX.length)).replace(/\/+$/, "");
        if (!cid) {
            res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "CID path parameter is required" }));
            return;
        }

        const activeProviders = this._getActiveProviders(cid);
        if (!activeProviders.length) {
            this._writeProvidersResponse(res, corsHeaders, [], 404);
            return;
        }

        const filteredProviders = this._filterProviders(activeProviders, url.searchParams);
        if (!filteredProviders.length) {
            this._writeProvidersResponse(res, corsHeaders, [], 404);
            return;
        }

        this._writeProvidersResponse(res, corsHeaders, filteredProviders, 200);
    }

    private _filterProviders(records: ProviderRecord[], searchParams: URLSearchParams): ProviderRecord[] {
        const filterAddrsParam = searchParams.get("filter-addrs");
        const filterProtocolsParam = searchParams.get("filter-protocols");

        const results: ProviderRecord[] = [];
        for (const record of records) {
            const providerCopy = this._cloneProvider(record.provider);
            if (filterAddrsParam && !this._filterAddrs(providerCopy, filterAddrsParam)) continue;
            if (filterProtocolsParam && !this._filterProtocols(providerCopy, filterProtocolsParam)) continue;
            results.push({ provider: providerCopy, receivedAt: record.receivedAt });
            if (results.length >= MAX_PROVIDERS_IN_RESPONSE) break;
        }
        return results;
    }

    private _filterAddrs(provider: any, filterParam: string): boolean {
        const addrsInfo = this._getAddrsReference(provider);
        const addrs = addrsInfo?.addrs ?? [];
        const { positive, negative, includeUnknown } = this._parseFilterParam(filterParam);

        if (!addrs.length) {
            return includeUnknown;
        }

        const filteredAddrs = addrs.filter((address: string) => this._addrMatches(address, positive, negative));
        if (!filteredAddrs.length) {
            if (includeUnknown) {
                addrsInfo?.assign([]);
                return true;
            }
            return false;
        }
        addrsInfo?.assign(filteredAddrs);
        return true;
    }

    private _filterProtocols(provider: any, filterParam: string): boolean {
        const rawFilters = filterParam
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((value) => value.toLowerCase());
        if (!rawFilters.length) return true;

        const includeUnknown = rawFilters.includes("unknown");
        const normalizedFilters = rawFilters.filter((value) => value !== "unknown");

        const providerProtocols = this._getProviderProtocols(provider);
        if (!providerProtocols.length) {
            return includeUnknown;
        }
        if (!normalizedFilters.length) {
            return true;
        }
        return providerProtocols.some((protocol) => normalizedFilters.includes(protocol));
    }

    private _writeProvidersResponse(
        res: http.ServerResponse,
        corsHeaders: Record<string, string>,
        providers: ProviderRecord[],
        statusCode: 200 | 404
    ) {
        const hasResults = providers.length > 0;
        const lastModified = hasResults ? this._getLatestTimestamp(providers) : Date.now();
        const ttlSeconds = hasResults ? CACHE_TTL_WITH_RESULTS_SECONDS : CACHE_TTL_NO_RESULTS_SECONDS;

        res.writeHead(statusCode, {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${ttlSeconds}, stale-while-revalidate=${MAX_CACHE_WINDOW_SECONDS}, stale-if-error=${MAX_CACHE_WINDOW_SECONDS}`,
            "Last-Modified": new Date(lastModified).toUTCString(),
            Vary: "Accept"
        });
        const payloadProviders = providers.map((record) => record.provider);
        res.end(
            JSON.stringify({
                Providers: payloadProviders.length ? payloadProviders : null
            })
        );
    }

    private _getLatestTimestamp(providers: ProviderRecord[]): number {
        let latest = 0;
        for (const record of providers) {
            latest = Math.max(latest, record.receivedAt);
        }
        return latest || Date.now();
    }

    private _getAddrsReference(provider: any): { addrs: string[]; assign: (value: string[]) => void } | null {
        if (Array.isArray(provider?.Payload?.Addrs)) {
            return {
                addrs: provider.Payload.Addrs,
                assign: (value: string[]) => {
                    provider.Payload.Addrs = value;
                }
            };
        }
        if (Array.isArray(provider?.Addrs)) {
            return {
                addrs: provider.Addrs,
                assign: (value: string[]) => {
                    provider.Addrs = value;
                }
            };
        }
        return null;
    }

    private _addrMatches(address: string, positive: string[], negative: string[]): boolean {
        const normalized = address.toLowerCase();
        if (negative.some((protocol) => normalized.includes(protocol))) {
            return false;
        }
        if (!positive.length) return true;
        return positive.some((protocol) => normalized.includes(protocol));
    }

    private _parseFilterParam(filterParam: string) {
        const rawFilters = filterParam
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
        const positive: string[] = [];
        const negative: string[] = [];
        let includeUnknown = false;
        for (const item of rawFilters) {
            if (item.startsWith("!")) {
                negative.push(item.slice(1).toLowerCase());
            } else if (item.toLowerCase() === "unknown") {
                includeUnknown = true;
            } else {
                positive.push(item.toLowerCase());
            }
        }
        return { positive, negative, includeUnknown };
    }

    private _getProviderProtocols(provider: any): string[] {
        const fromArray = provider?.Protocols ?? provider?.Payload?.Protocols;
        if (Array.isArray(fromArray)) {
            return fromArray.map((protocol: string) => protocol?.toLowerCase()).filter(Boolean);
        }
        const protocol = provider?.Protocol ?? provider?.Payload?.Protocol;
        if (typeof protocol === "string") {
            return [protocol.toLowerCase()];
        }
        return [];
    }

    private _addProviderRecord(cid: string, provider: any, receivedAt: number): boolean {
        const normalizedProvider = this._normalizeProvider(provider);
        if (!normalizedProvider) return false;
        const record: ProviderRecord = { provider: normalizedProvider, receivedAt };
        const existing = this._providerRecords.get(cid) ?? [];
        const active = existing.filter(
            (entry) => receivedAt - entry.receivedAt <= PROVIDER_TTL_MS && entry.provider.ID !== normalizedProvider.ID
        );
        active.unshift(record);
        this._providerRecords.set(cid, active.slice(0, MAX_PROVIDERS_IN_RESPONSE));
        return true;
    }

    private _getActiveProviders(cid: string): ProviderRecord[] {
        const now = Date.now();
        const variants = this._getCidVariants(cid);
        const results: ProviderRecord[] = [];
        for (const variant of variants) {
            const records = this._providerRecords.get(variant);
            if (!records?.length) continue;
            const active = records.filter((record) => now - record.receivedAt <= PROVIDER_TTL_MS);
            if (active.length !== records.length) {
                this._providerRecords.set(variant, active);
            }
            results.push(...active);
        }
        return results;
    }

    private _getCidVariants(cid: string): string[] {
        const variants = new Set<string>([cid]);
        try {
            const parsed = CID.parse(cid);
            variants.add(parsed.toV1().toString());
            try {
                variants.add(parsed.toV0().toString());
            } catch {
                // CID cannot be converted to v0 (non-dagpb), ignore
            }
            if (parsed.code !== 0x55) {
                variants.add(CID.createV1(0x55, parsed.multihash).toString());
            }
        } catch {
            // not a valid CID, fall back to original string only
        }
        return [...variants];
    }

    private _normalizeProvider(provider: any): NormalizedProvider | null {
        const payload = provider?.Payload ?? {};
        const idCandidate = typeof payload.ID === "string" && payload.ID ? payload.ID : provider?.ID;
        const id = typeof idCandidate === "string" && idCandidate ? idCandidate : undefined;
        if (!id) return null;

        const addrs = this._extractAddrs(provider);
        if (!addrs.length) return null;

        const protocols = this._getProviderProtocols(provider);
        const normalizedProtocols = protocols.length ? Array.from(new Set(protocols)) : undefined;

        const normalized: NormalizedProvider = {
            Schema: "peer",
            ID: id,
            Addrs: addrs
        };
        if (normalizedProtocols?.length) normalized.Protocols = normalizedProtocols;

        const agentVersion = payload.AgentVersion ?? provider?.AgentVersion;
        if (typeof agentVersion === "string" && agentVersion) {
            normalized.AgentVersion = agentVersion;
        }

        return normalized;
    }

    private _extractAddrs(provider: any): string[] {
        const payloadAddrs = Array.isArray(provider?.Payload?.Addrs) ? provider.Payload.Addrs : [];
        const rootAddrs = Array.isArray(provider?.Addrs) ? provider.Addrs : [];
        const all = [...payloadAddrs, ...rootAddrs];
        const normalized = all.map((addr) => (typeof addr === "string" ? addr : null)).filter((addr): addr is string => Boolean(addr));
        return normalized.filter((addr, index) => normalized.indexOf(addr) === index);
    }

    private _cloneProvider(provider: any): any {
        return JSON.parse(JSON.stringify(provider ?? {}));
    }
}
