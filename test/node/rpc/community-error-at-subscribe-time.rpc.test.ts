// Regression test for issue #299: over PKC RPC, RpcRemoteCommunity._initRpcUpdateSubscription()
// used to attach the "error" forwarder and synchronously call emitAllPendingMessages(subscriptionId)
// INSIDE update(), replaying every buffered notification before the caller of update() got a
// chance to attach an "error" listener. Any error the server emitted at subscribe time (before
// the JSON-RPC subscribe response) then bubbled to pkc via the listenerCount("error") === 1 rule
// in remote-community.ts, so callers following the natural `await community.update();
// community.on("error", ...)` order never saw it and pkc emitted it as unhandled instead. The fix
// defers the handler attachment and the buffered replay to a macrotask, so a listener attached
// synchronously after `await update()` resolves receives the subscribe-time error.
//
// The server sends notifications for a subscription before returning the subscribe response
// (src/rpc/src/index.ts _bindCommunityUpdateSubscription awaits community.update() before
// communityUpdateSubscribe resolves), and the client buffers notifications for subscription ids
// it does not know yet (src/clients/rpc-client/pkc-rpc-client.ts _pendingSubscriptionMsgs), so
// this ordering is reachable in production whenever the server-side updating instance fails at
// subscribe time (e.g. a stale, already-failed shared instance being reused).
//
// To make that window deterministic, this test runs the PKCWsServer in-process and wraps its
// _bindCommunityUpdateSubscription so the server-side updating community emits a non-retriable
// error right after the subscription listeners are bound and before the subscribe call returns.
// That is exactly "an error the server emitted at subscribe time": the error notification is
// written to the websocket ahead of the subscribe response, lands in the client's pending
// buffer, and is replayed synchronously inside community.update().
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

const RPC_AUTH_KEY = "test-community-error-at-subscribe-time";
const INJECTED_MARKER = "injectedSubscribeTimeError299";

const isInjectedError = (err: unknown): boolean =>
    Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[INJECTED_MARKER]);

describe("RPC: community error emitted at subscribe time reaches a listener attached after update() (#299)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.tmp/.pkc-rpc-subscribe-time-error-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
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
        // listeners are bound but before communityUpdateSubscribe returns its response. The error
        // notification is written to the websocket ahead of the subscribe response, which is the
        // deterministic version of a stale, already-failed server-side instance being reused.
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

    itIfRpc("listener attached right after await community.update() receives the subscribe-time error", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        try {
            const signer = await client.createSigner();
            const community = await client.createCommunity({ address: signer.address });

            const communityLevelErrors: unknown[] = [];
            await community.update();
            // The natural listener order from the caller's perspective: subscribe first, then
            // listen. Nothing has yielded to the event loop between update() resolving and this
            // attach, yet the injected error has already been replayed inside update().
            community.on("error", (err) => communityLevelErrors.push(err));

            // Give delivery ample time in case a fix defers the replay to a later tick.
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !communityLevelErrors.some(isInjectedError))
                await new Promise((resolve) => setTimeout(resolve, 100));

            // Extra settle window so a duplicate delivery (e.g. a replay that runs twice or a
            // buffer that isn't cleared after draining) would have time to arrive and fail the
            // exactly-once assertion below.
            await new Promise((resolve) => setTimeout(resolve, 500));

            await community.stop();

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
