// Regression test for the deferred-replay crash introduced by the #299 fix: in
// src/community/rpc-remote-community.ts _initRpcUpdateSubscription(), the "error"/"update"
// handler attachment plus emitAllPendingMessages(subscriptionId) replay was moved into a bare
// setTimeout(..., 0). If the caller of update() attaches NO "error" listener (on the community
// or on pkc), the replayed subscribe-time error is emitted on the community, where the only
// listener is the constructor forwarder in remote-community.ts
// (`listenerCount("error") === 1` -> `this._pkc.emit("error", ...)`). pkc has zero "error"
// listeners, so Node's EventEmitter throws ERR_UNHANDLED_ERROR synchronously — but now inside
// the timer callback, where no try/catch exists, so it escapes as an uncaughtException and
// crashes the process. Before the deferral, the identical throw happened inside update()'s
// synchronous replay and surfaced as a catchable rejection of update().
//
// This test asserts the DESIRED behavior: no uncaughtException may fire, and the error must not
// be silently swallowed with the community left "updating" forever — it must either reach a
// catchable path (update() rejecting, or an error listener attached later) or the community must
// terminate cleanly (state "stopped"). A rejection of update() is no longer possible once the
// replay is deferred (update() has already resolved), so the fix contains the throw and stops
// the community; a caller who wants the error itself must attach a listener, as the README
// documents. Without the fix this is RED: the process listener installed below captures the
// ERR_UNHANDLED_ERROR escaping the setTimeout replay (vitest's own uncaughtException handler
// may additionally report an "Unhandled Error" for the same throw — that is the same mechanism,
// not a separate failure).
//
// The subscribe-time error is injected exactly like in
// test/node/rpc/community-error-at-subscribe-time.rpc.test.ts: the in-process PKCWsServer's
// _bindCommunityUpdateSubscription is wrapped so the server-side updating community emits a
// non-retriable error after the subscription listeners are bound and before the subscribe call
// returns, so the notification lands in the client's pending buffer and is replayed by the
// deferred task.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

const RPC_AUTH_KEY = "test-community-error-replay-uncaught-crash";
const INJECTED_MARKER = "injectedSubscribeTimeErrorReplayCrash";

// Matches the injected error both as delivered over RPC (plain object with .details carrying the
// marker) and as rethrown by EventEmitter for an unhandled "error" event (an Error instance is
// rethrown as-is; a non-Error payload is wrapped in ERR_UNHANDLED_ERROR whose message embeds the
// inspected payload, so the marker string appears in the message).
const mentionsInjectedError = (err: unknown): boolean => {
    if (!err || typeof err !== "object") return false;
    const e = err as { details?: Record<string, unknown>; message?: string };
    if (e.details?.[INJECTED_MARKER]) return true;
    if (typeof e.message === "string" && e.message.includes(INJECTED_MARKER)) return true;
    return false;
};

describe("RPC: subscribe-time community error with no listeners attached must not escape as uncaughtException", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.tmp/.pkc-rpc-error-replay-crash-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as {
            _bindCommunityUpdateSubscription: (
                parsedArgs: { name?: string; publicKey?: string },
                connectionId: string,
                subscriptionId: number
            ) => Promise<void>;
        };

        // Emit a non-retriable error on the server-side updating instance after the subscription's
        // listeners are bound but before communityUpdateSubscribe returns its response, so the
        // error notification is buffered client-side and replayed by the deferred task.
        const originalBind = server._bindCommunityUpdateSubscription.bind(rpcServer);
        vi.spyOn(server, "_bindCommunityUpdateSubscription").mockImplementation(async (parsedArgs, connectionId, subscriptionId) => {
            await originalBind(parsedArgs, connectionId, subscriptionId);
            const entry = findUpdatingCommunity(serverPKC, parsedArgs) as RemoteCommunity | undefined;
            if (!entry) throw new Error("Test setup failed: no server-side updating entry after binding the subscription");
            entry.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("subscribe-time error with no listeners is handled without crashing the process", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });

        // Deliberately NO client.on("error") and NO community.on("error") around update(): the
        // caller that never attaches listeners must not crash the process, and the community
        // must not stay "updating" forever on a swallowed error.
        const uncaughtErrors: unknown[] = [];
        const onUncaught = (err: unknown) => {
            uncaughtErrors.push(err);
            // Surface the crash mechanism in the per-test stderr log: the stack should point at
            // the deferred emitAllPendingMessages replay inside _initRpcUpdateSubscription's
            // setTimeout (rpc-remote-community).
            console.error("uncaughtException captured by regression test:", err);
        };
        process.prependListener("uncaughtException", onUncaught);

        try {
            const signer = await client.createSigner();
            const community = await client.createCommunity({ address: signer.address });

            let updateRejection: unknown;
            try {
                await community.update();
            } catch (e) {
                updateRejection = e;
            }

            // Window for the deferred replay (a 0ms macrotask scheduled inside
            // _initRpcUpdateSubscription) to run. Today this is where the emit throws
            // ERR_UNHANDLED_ERROR out of the timer callback.
            await new Promise((resolve) => setTimeout(resolve, 500));

            // A fix may instead deliver the error to listeners attached later; give that path a
            // chance too before judging.
            const lateCommunityErrors: unknown[] = [];
            const latePkcErrors: unknown[] = [];
            community.on("error", (err) => lateCommunityErrors.push(err));
            client.on("error", (err) => latePkcErrors.push(err));

            const deliveredCatchably = (): boolean =>
                mentionsInjectedError(updateRejection) ||
                lateCommunityErrors.some(mentionsInjectedError) ||
                latePkcErrors.some(mentionsInjectedError);
            // The fix's contained-throw path stops the community; capture the state BEFORE the
            // test's own cleanup stop() below so the assertion is not trivially satisfied by it
            const terminatedCleanly = (): boolean => community.state === "stopped";

            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !deliveredCatchably() && !terminatedCleanly() && !uncaughtErrors.some(mentionsInjectedError))
                await new Promise((resolve) => setTimeout(resolve, 100));

            const handledWithoutCrash = deliveredCatchably() || terminatedCleanly();

            await community.stop().catch((): undefined => undefined);

            expect({
                injectedErrorEscapedAsUncaughtException: uncaughtErrors.some(mentionsInjectedError),
                injectedErrorHandledWithoutCrash: handledWithoutCrash
            }).toEqual({
                injectedErrorEscapedAsUncaughtException: false,
                injectedErrorHandledWithoutCrash: true
            });
        } finally {
            process.removeListener("uncaughtException", onUncaught);
            await client.destroy().catch((): undefined => undefined);
        }
    });
});
