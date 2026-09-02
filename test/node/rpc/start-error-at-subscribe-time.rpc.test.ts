// Regression test for issue #314: over PKC RPC, RpcLocalCommunity.start() still attaches its
// notification handlers and synchronously calls emitAllPendingMessages(subscriptionId) INSIDE the
// awaited start() call (src/community/rpc-local-community.ts), replaying every buffered
// notification before the caller of start() gets a chance to attach an "error" listener. PR #313
// fixed the equivalent race for RpcRemoteCommunity.update() only (macrotask-deferred replay in
// _initRpcUpdateSubscription), leaving the start() subscription path behind. Any error the server
// emitted at start-subscribe time (before the JSON-RPC startCommunity response) then bubbles to
// pkc via the listenerCount("error") === 1 rule in remote-community.ts, so callers following the
// natural `await community.start(); community.on("error", ...)` order never see it and pkc emits
// it as unhandled instead.
//
// The server sends notifications for a start subscription before returning the subscribe response
// by design: startCommunity's startCommunityImpl (src/rpc/src/index.ts) binds the subscription's
// listeners via _setupStartedEvents, emits an "update" notification, and awaits
// community.start(), all before `return { subscriptionId }`. The client buffers notifications for
// subscription ids it does not know yet (src/clients/rpc-client/pkc-rpc-client.ts
// _pendingSubscriptionMsgs), so this ordering is reachable in production whenever the server-side
// started instance fails between listener binding and the startCommunity response (e.g. an IPNS
// publish failure during the awaited server-side start()).
//
// To make that window deterministic, this test runs the PKCWsServer in-process and wraps its
// _setupStartedEvents so the server-side started community emits a non-retriable error right
// after the subscription listeners are bound and before startCommunity returns its response. That
// is exactly "an error the server emitted at start-subscribe time": the error notification is
// written to the websocket ahead of the startCommunity response, lands in the client's pending
// buffer, and is replayed synchronously inside community.start().
//
// NOTE: this repro targets ONLY the start() subscription path. The exports subscription path in
// rpc-local-community.ts deliberately relies on the synchronous replay ordering and is out of
// scope here.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

const RPC_AUTH_KEY = "test-start-error-at-subscribe-time";
const INJECTED_MARKER = "injectedStartSubscribeTimeError314";

const isInjectedError = (err: unknown): boolean =>
    Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[INJECTED_MARKER]);

describe("RPC: community error emitted at start-subscribe time reaches a listener attached after start() (#314)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.tmp/.pkc-rpc-start-subscribe-time-error-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as {
            _setupStartedEvents: (community: LocalCommunity, connectionId: string, subscriptionId: number) => void;
        };

        // Emit a non-retriable error on the server-side started instance after the start
        // subscription's listeners are bound (startCommunityImpl calls _setupStartedEvents before
        // it awaits community.start() and before startCommunity returns { subscriptionId }). The
        // error notification is written to the websocket ahead of the startCommunity response,
        // which is the deterministic version of a server-side failure during the awaited start.
        const originalSetup = server._setupStartedEvents.bind(rpcServer);
        vi.spyOn(server, "_setupStartedEvents").mockImplementation((community, connectionId, subscriptionId) => {
            originalSetup(community, connectionId, subscriptionId);
            community.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("listener attached right after await community.start() receives the start-subscribe-time error", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        try {
            const signer = await client.createSigner();
            // Passing the signer makes this an owned community the RPC server hosts locally, so
            // start() goes through the startCommunity subscription path under test.
            const community = <RpcLocalCommunity>await client.createCommunity({ signer });

            const communityLevelErrors: unknown[] = [];
            await community.start();
            // The natural listener order from the caller's perspective: start first, then listen.
            // Nothing has yielded to the event loop between start() resolving and this attach,
            // yet the injected error has already been replayed inside start().
            community.on("error", (err) => communityLevelErrors.push(err));

            try {
                // Give delivery ample time in case a fix defers the replay to a later tick.
                const deadline = Date.now() + 5_000;
                while (Date.now() < deadline && !communityLevelErrors.some(isInjectedError))
                    await new Promise((resolve) => setTimeout(resolve, 100));

                // Extra settle window so a duplicate delivery (e.g. a replay that runs twice or a
                // buffer that isn't cleared after draining) would have time to arrive and fail the
                // exactly-once assertion below.
                await new Promise((resolve) => setTimeout(resolve, 500));
            } finally {
                await community.stop();
            }

            expect({
                injectedErrorsAtCommunityListener: communityLevelErrors.filter(isInjectedError).length,
                pkcGotInjectedErrorAsUnhandled: pkcLevelErrors.some(isInjectedError)
            }).toEqual({
                injectedErrorsAtCommunityListener: 1, // exactly once: not dropped, not duplicated
                pkcGotInjectedErrorAsUnhandled: false
            });
        } finally {
            await client.destroy();
        }
    });
});
