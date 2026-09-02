// Shared harness for tests that run a PKCWsServer in-process against a Node-side PKC instance
// (#315, #316). Replaces the per-file copies of getAvailablePort + PKCWsServer + _initPKC:
//
// - Binds the server with port 0 so the OS assigns the port atomically: the old
//   reserve-a-port-then-close-then-rebind helper could lose the port to another process between
//   the probe and the real listen (EADDRINUSE in beforeAll).
// - Injects the caller's PKC instance via the setPKCJs hook, so the PKCWsServer factory never
//   constructs the throwaway PKC from pkcOptions that _initPKC(serverPKC) used to orphan (its
//   handles leaked for the rest of the worker lifetime).
//
// Typical use:
//
//   serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("my-test") });
//   ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "my-test" }));
//   // wrap rpcServer internals as needed, then point a client PKC at rpcUrl
//
// Teardown stays with the test: `await rpcServer.destroy()` then `await serverPKC.destroy()`.
//
// Also home to the shared plumbing of the subscribe-time-injection suites: the wrap-and-inject
// helpers for the community update and start subscriptions, the injected-error matcher, the
// unique .tmp dataPath template, and the assert-after-deadline poll loop.
import { once } from "node:events";
import path from "node:path";
import type { Server as HTTPServer } from "node:http";
import { vi } from "vitest";
import PKCWsServer from "../../dist/node/rpc/src/index.js";
import { restorePKCJs, setPKCJs } from "../../dist/node/rpc/src/lib/pkc-js/index.js";
import { findUpdatingCommunity } from "../../dist/node/pkc/tracked-instance-registry-util.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../dist/node/community/remote-community.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

export type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

export async function createInProcessRpcServer(opts: { serverPKC: PKCType; authKey: string }): Promise<{
    rpcServer: PKCWsServerType;
    rpcUrl: string;
    port: number;
}> {
    setPKCJs(async () => opts.serverPKC);
    let rpcServer: PKCWsServerType;
    try {
        rpcServer = await PKCWsServer.PKCWsServer({ port: 0, authKey: opts.authKey });
    } finally {
        // The injected factory has been consumed by now; never leak it to other suites in the worker
        restorePKCJs();
    }

    const httpServer = (rpcServer as unknown as { _httpServer: HTTPServer })._httpServer;
    try {
        // once() rejects if the server emits "error" before "listening" (EMFILE/EACCES) and
        // removes both of its listeners itself
        if (!httpServer.listening) await once(httpServer, "listening");
        const address = httpServer.address();
        if (!address || typeof address !== "object") throw new Error("PKCWsServer's http server has no bound address after listening");
        return { rpcServer, rpcUrl: `ws://localhost:${address.port}`, port: address.port };
    } catch (e) {
        // Don't leak the constructed server (and its websocket listeners) for the rest of the
        // worker when binding fails during beforeAll
        await rpcServer.destroy().catch((): undefined => undefined);
        throw e;
    }
}

// Unique per-suite dataPath under .tmp/ in the project root (never /tmp, which is RAM-backed;
// the test server cleans .tmp/ up on startup)
export function uniqueTmpDataPath(prefix: string): string {
    return path.join(process.cwd(), `.tmp/.${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
}

// Matcher for errors injected with a `{ [marker]: true }` details entry, the shape that survives
// RPC error serialization. Tests that must also match rethrown/wrapped forms (e.g. the
// ERR_UNHANDLED_ERROR message-embedding in the uncaught-crash suite) compose this with their own
// additional checks.
export function makeInjectedErrorMatcher(marker: string): (err: unknown) => boolean {
    return (err: unknown): boolean =>
        Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[marker]);
}

// Poll until the predicate holds or the deadline passes, resolving either way: the caller's
// assertions after the poll produce the actual failure message
export async function pollUntil(predicate: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const intervalMs = opts?.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

// Wrap the in-process server's _bindCommunityUpdateSubscription (via vi.spyOn, restored by
// vi.restoreAllMocks in the suite's afterAll) so onBound runs on the server-side updating entry
// after the subscription's listeners are bound and BEFORE communityUpdateSubscribe returns its
// response: anything the entry emits inside onBound is written to the websocket ahead of the
// subscribe response, lands in the client's pending buffer, and is delivered by the deferred
// replay - the deterministic version of a server-side event at subscribe time.
export function wrapCommunityUpdateSubscriptionBind(opts: {
    rpcServer: PKCWsServerType;
    serverPKC: PKCType;
    onBound: (entry: RemoteCommunity) => void;
}): void {
    const server = opts.rpcServer as unknown as {
        _bindCommunityUpdateSubscription: (
            parsedArgs: { name?: string; publicKey?: string },
            connectionId: string,
            subscriptionId: number
        ) => Promise<void>;
    };
    const originalBind = server._bindCommunityUpdateSubscription.bind(opts.rpcServer);
    vi.spyOn(server, "_bindCommunityUpdateSubscription").mockImplementation(async (parsedArgs, connectionId, subscriptionId) => {
        await originalBind(parsedArgs, connectionId, subscriptionId);
        const entry = findUpdatingCommunity(opts.serverPKC, parsedArgs) as RemoteCommunity | undefined;
        if (!entry) throw new Error("Test setup failed: no server-side updating entry after binding the subscription");
        opts.onBound(entry);
    });
}

// Same idea for the start subscription: onSetup runs on the server-side started community after
// _setupStartedEvents binds the start subscription's listeners and before startCommunity returns
// its response, so anything it emits precedes { subscriptionId } on the wire.
export function wrapStartedEventsSetup(opts: { rpcServer: PKCWsServerType; onSetup: (community: LocalCommunity) => void }): void {
    const server = opts.rpcServer as unknown as {
        _setupStartedEvents: (community: LocalCommunity, connectionId: string, subscriptionId: number) => void;
    };
    const originalSetup = server._setupStartedEvents.bind(opts.rpcServer);
    vi.spyOn(server, "_setupStartedEvents").mockImplementation((community, connectionId, subscriptionId) => {
        originalSetup(community, connectionId, subscriptionId);
        opts.onSetup(community);
    });
}
