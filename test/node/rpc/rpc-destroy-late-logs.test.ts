// Regression test for #325: PKCRpcClient.destroy() and PKCWsServer.destroy() used to resolve
// before their websockets had actually closed, so the "close"/"disconnection" handlers kept
// logging a few milliseconds AFTER the caller believed teardown was done.
//
// Why that matters: under --per-test-logs, test/vitest-node-setup.js routes the `debug` module
// through console.error, and vitest forwards every console line from the worker to the main
// process over its birpc channel (onUserConsoleLog). A line that lands while vitest is already
// tearing the worker down (an RPC suite's afterAll was the last thing in that worker) is
// rejected with `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`,
// which vitest counts as an unhandled error and turns an all-green run into exit 1 (CI run
// 33630856165 on master, blamed on start-error-replay-stop-race.rpc.test.ts).
//
// The contract asserted here: once destroy() resolves, the endpoint's socket(s) are closed and
// it emits no further debug output. The capture hooks the shared `debug` sink (the same singleton
// dist/ logs through, which is what the setup file relies on), so any late line from the
// endpoint's namespaces shows up in `lateLines`.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { once } from "node:events";
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from "ws";
import PKC from "../../../dist/node/index.js";
import PKCRpcClient from "../../../dist/node/clients/rpc-client/pkc-rpc-client.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

interface DebugModule {
    log: (...args: unknown[]) => void;
    enable: (namespaces: string) => void;
    disable: () => string;
}

// `debug` ships no typings and is CJS; createRequire hands back the same cached instance that
// @pkcprotocol/pkc-logger (and therefore dist/) logs through.
const debugModule: DebugModule = createRequire(import.meta.url)("debug");

const CLIENT_NAMESPACES = "pkc-js:pkc-rpc-client*,pkc-js:PKCRpcClient*";
const SERVER_NAMESPACES = "pkc-js:PKCWsServer*,pkc-js-rpc:pkc-ws-server*";

// Enable the given namespaces and divert the debug sink into an array. restore() puts back
// whatever sink and namespace selection were active before (the per-test-logs redirect, DEBUG
// env), so the capture never leaks into other suites in the worker.
function captureDebugOutput(namespaces: string): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const previousLog = debugModule.log;
    const previousNamespaces = debugModule.disable();
    debugModule.enable(namespaces);
    debugModule.log = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    };
    return {
        lines,
        restore: () => {
            debugModule.log = previousLog;
            debugModule.enable(previousNamespaces);
        }
    };
}

// The rpc-websockets "close" event is emitted on a setTimeout(0) after the raw socket closes, so
// a late log from either endpoint arrives within a couple of macrotasks. 500ms is a generous
// window for it to show up in `lateLines`.
const LATE_LOG_SETTLE_MS = 500;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const WS_READY_STATE_CLOSED = 3;

// Just enough JSON-RPC to let PKCRpcClient open a connection and get one response back.
class MinimalRpcServer {
    private constructor(
        readonly wss: WebSocketServer,
        readonly port: number
    ) {
        wss.on("connection", (socket: WsSocket) => {
            socket.on("message", (raw: RawData) => {
                const message = JSON.parse(raw.toString()) as { id?: number };
                if (typeof message.id !== "number") return;
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
            });
        });
    }

    static async create(): Promise<MinimalRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new MinimalRpcServer(wss, address.port);
    }

    async destroy() {
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
    }
}

type RpcClientInternals = { _webSocketClient: { socket?: { readyState: number } } };
type RpcServerInternals = { rpcWebsockets: { wss: { clients: Set<unknown> } } };

describe("PKCRpcClient.destroy() closes its websocket before resolving (#325)", () => {
    let server: MinimalRpcServer;

    beforeAll(async () => {
        server = await MinimalRpcServer.create();
    });

    afterAll(async () => {
        await server.destroy();
    });

    it("the socket is closed when destroy() resolves and no rpc-client debug output follows", async () => {
        const client = new PKCRpcClient(`ws://127.0.0.1:${server.port}`);
        await client.rpcCall("ping", []); // opens the connection
        expect(client.state).toBe("connected");

        const capture = captureDebugOutput(CLIENT_NAMESPACES);
        try {
            await client.destroy();
            // rpc-websockets clears .socket once the underlying socket has fully closed
            const socket = (client as unknown as RpcClientInternals)._webSocketClient.socket;
            const socketClosedWhenDestroyResolved = socket === undefined || socket.readyState === WS_READY_STATE_CLOSED;
            const linesWhenDestroyResolved = capture.lines.length;

            await sleep(LATE_LOG_SETTLE_MS);

            expect({
                socketClosedWhenDestroyResolved,
                lateLines: capture.lines.slice(linesWhenDestroyResolved)
            }).toEqual({
                socketClosedWhenDestroyResolved: true,
                lateLines: []
            });
        } finally {
            capture.restore();
        }
    });
});

// Needs the in-process PKCWsServer, which is backed by a Node-side PKC pointed at the local test
// Kubo like every other in-process RPC suite here, so it runs in the RPC configs only.
describeIfRpc("PKCWsServer.destroy() closes its clients before resolving (#325)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-rpc-destroy-late-logs-test") });
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "test-rpc-destroy-late-logs" }));
    });

    let serverDestroyedByTest = false;

    afterAll(async () => {
        // PKCWsServer.destroy() is not idempotent (it destroys its PKC), so only clean up here if
        // the test did not get as far as destroying the server itself
        if (rpcServer && !serverDestroyedByTest) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    it("a still-connected client is disconnected when destroy() resolves and no server debug output follows", async () => {
        const client = new PKCRpcClient(rpcUrl);
        const wss = (rpcServer as unknown as RpcServerInternals).rpcWebsockets.wss;
        const capture = captureDebugOutput(SERVER_NAMESPACES);
        try {
            await client.initalizeCommunitieschangeEvent(); // opens the connection and leaves a live subscription for destroy() to clean up
            expect(wss.clients.size).toBe(1);

            serverDestroyedByTest = true;
            await rpcServer.destroy();
            const clientsWhenDestroyResolved = wss.clients.size;
            const linesWhenDestroyResolved = capture.lines.length;

            await sleep(LATE_LOG_SETTLE_MS);

            expect({
                clientsWhenDestroyResolved,
                lateLines: capture.lines.slice(linesWhenDestroyResolved)
            }).toEqual({
                clientsWhenDestroyResolved: 0,
                lateLines: []
            });
        } finally {
            capture.restore();
            await client.destroy();
        }
    });
});

// The exact teardown shape of the failing CI run: the test destroys its client PKC, then afterAll
// destroys the in-process server and the server PKC, and the worker is torn down right after.
describeIfRpc("client PKC then PKCWsServer teardown emits no debug output after the last destroy() resolves (#325)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-rpc-destroy-sequence-test") });
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "test-rpc-destroy-sequence" }));
    });

    let serverDestroyedByTest = false;

    afterAll(async () => {
        if (rpcServer && !serverDestroyedByTest) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    it("no client or server debug output lands after the teardown sequence resolves", async () => {
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        const capture = captureDebugOutput(`${CLIENT_NAMESPACES},${SERVER_NAMESPACES}`);
        try {
            const rpcClient = client.clients.pkcRpcClients[rpcUrl];
            await rpcClient.initalizeCommunitieschangeEvent(); // opens the connection with a live subscription, like a real client
            expect(rpcClient.state).toBe("connected");

            await client.destroy();
            serverDestroyedByTest = true;
            await rpcServer.destroy(); // also destroys serverPKC
            if (!serverPKC.destroyed) await serverPKC.destroy();
            const linesWhenTeardownResolved = capture.lines.length;

            await sleep(LATE_LOG_SETTLE_MS);

            expect(capture.lines.slice(linesWhenTeardownResolved)).toEqual([]);
        } finally {
            capture.restore();
            if (!client.destroyed) await client.destroy();
        }
    });
});
