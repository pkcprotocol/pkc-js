// Regression test for https://github.com/pkcprotocol/pkc-js/issues/157
//
// The address-rewriter proxy creates a request-log entry with `success: false` and pushes it
// to its in-memory buffer BEFORE the upstream request is sent. The buffer is flushed to SQLite
// on a fixed 5s interval and then cleared. The real outcome is only written later, in-place, by
// the `response`/`error`/`timeout` callbacks. If a flush lands while a request is still in flight,
// the entry is persisted permanently as success=0 / status_code=NULL ("<empty>" failure) and is
// NEVER corrected, even after the client receives 200. This over-reports failures.
//
// This test reproduces the race deterministically (no reliance on the 5s timer): it holds the
// upstream response open, waits until the entry is buffered (request in flight), then manually
// invokes the flush, exactly as the periodic timer would. It asserts the *correct* behaviour
// (a request the client received 200 for must be logged success=1 / status 200), so it is RED
// against unmodified src and GREEN once the logging is fixed.

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { AddressesRewriterProxyServer } from "../../dist/node/runtime/node/addresses-rewriter-proxy-server.js";

const PEER_ID = "12D3KooWLNoZZe8n3UtsvRUcRPa4gmWLZsb5mF9Auns9NBhKXV9x";

type RequestLogRow = {
    success: number;
    status_code: number | null;
    error: string | null;
    method: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (cond: () => boolean, label: string, timeoutMs = 5000) => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
        await sleep(10);
    }
};

describe("address-rewriter request logging (issue #157)", () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        // Run cleanups in reverse registration order, then clear.
        for (const cleanup of cleanups.reverse()) await cleanup();
        cleanups.length = 0;
    });

    it("logs a successful (200) PUT as success=1 even when the flush fires while it is in flight", async () => {
        // Logging must be enabled before the constructor reads the env var.
        const prevEnv = process.env.ENABLE_LOGGING_OF_ADDRESS_REWRITER_PROXY;
        process.env.ENABLE_LOGGING_OF_ADDRESS_REWRITER_PROXY = "1";
        cleanups.push(() => {
            if (prevEnv === undefined) delete process.env.ENABLE_LOGGING_OF_ADDRESS_REWRITER_PROXY;
            else process.env.ENABLE_LOGGING_OF_ADDRESS_REWRITER_PROXY = prevEnv;
        });

        const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "rewriter-issue157-"));
        cleanups.push(() => fs.rmSync(dataPath, { recursive: true, force: true }));

        // 1. Upstream "HTTP router" that accepts the write but only responds 200 once we release it,
        //    so we can deterministically keep the request in flight across the flush.
        let releaseUpstream!: () => void;
        const upstreamReleased = new Promise<void>((resolve) => (releaseUpstream = resolve));
        const upstream = http.createServer((req, res) => {
            req.resume(); // drain the body
            req.on("end", async () => {
                await upstreamReleased;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ProvideResults: [] }));
            });
        });
        await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
        const upstreamPort = (upstream.address() as { port: number }).port;
        cleanups.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

        // 2. Minimal kubo client stub: enough for the constructor + address-update loop.
        const fakeKubo = {
            id: async (): Promise<{ id: { toString: () => string }; addresses: string[] }> => ({
                id: { toString: () => PEER_ID },
                addresses: []
            }),
            swarm: { addrs: async (): Promise<unknown[]> => [] },
            getEndpointConfig: () => ({ host: "127.0.0.1", port: "5001" }),
            routing: { provide: async function* (): AsyncGenerator<never> {} }
        };
        const fakeStorage = {
            setItem: async (): Promise<void> => {},
            removeItem: async (): Promise<void> => {},
            getItem: async (): Promise<undefined> => undefined
        };

        const proxy = new AddressesRewriterProxyServer({
            kuboClients: [fakeKubo],
            port: 0,
            hostname: "127.0.0.1",
            proxyTargetUrl: `http://127.0.0.1:${upstreamPort}`,
            pkc: { _storage: fakeStorage, dataPath }
        } as unknown as ConstructorParameters<typeof AddressesRewriterProxyServer>[0]);
        await new Promise<void>((resolve) => proxy.listen(() => resolve()));
        cleanups.push(() => proxy.destroy());
        const proxyPort = (proxy.server.address() as { port: number }).port;

        // 3. Fire a single provider-announce PUT through the proxy and track what the CLIENT sees.
        const announceBody = JSON.stringify({
            Providers: [
                {
                    Schema: "bitswap",
                    Protocol: "transport-bitswap",
                    Signature: "mFAKE",
                    Payload: {
                        ID: PEER_ID,
                        Keys: ["bafkreie72q7iitojhbrtt576bum5wr3vu7zt5ep24e4gbazuvyzf6rzb54"],
                        Addrs: []
                    }
                }
            ]
        });
        let clientStatus: number | undefined;
        const clientDone = new Promise<void>((resolve, reject) => {
            const clientReq = http.request(
                {
                    host: "127.0.0.1",
                    port: proxyPort,
                    path: "/routing/v1/providers/",
                    method: "PUT",
                    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(announceBody) }
                },
                (resp) => {
                    clientStatus = resp.statusCode;
                    resp.resume();
                    resp.on("end", () => resolve());
                }
            );
            clientReq.on("error", reject);
            clientReq.end(announceBody);
        });

        // 4. Wait until the entry is buffered (request created + in flight to the upstream).
        const buffer = proxy["_requestLogBuffer"];
        await waitFor(() => buffer.length === 1, "request log entry to be buffered");
        expect(clientStatus, "request should still be in flight (upstream not released yet)").toBeUndefined();

        // 5. Simulate the periodic 5s flush firing *while the request is in flight*.
        await proxy["_writeRequestLogs"]();

        // 6. Release the upstream so it returns 200, and wait for the client to actually receive it.
        releaseUpstream();
        await clientDone;
        expect(clientStatus).toBe(200);

        // 7. Flush again, mimicking the next periodic tick after completion.
        await proxy["_writeRequestLogs"]();

        // 8. Inspect what was persisted to SQLite.
        const dbFile = path.join(dataPath, ".address-rewriter", `address_rewriter_127.0.0.1_5001_127.0.0.1_${upstreamPort}.db`);
        const db = new Database(dbFile, { readonly: true });
        const rows = db.prepare("SELECT success, status_code, error, method FROM request_logs").all() as RequestLogRow[];
        db.close();

        // The client received a 200, so the persisted log must reflect that, NOT a phantom failure.
        const phantomFailures = rows.filter((row) => row.success === 0 && row.status_code === null);
        expect(phantomFailures, "a 200 request must not be persisted as success=0 / status=NULL").toEqual([]);

        const successRows = rows.filter((row) => row.success === 1 && row.status_code === 200);
        expect(successRows.length, "the successful PUT should be logged exactly once as success=1 / status 200").toBe(1);
    });
});
