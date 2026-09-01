// Regression test for the stop-in-flight window of the #299 deferred replay (found on PR #313).
// RpcRemoteCommunity._initRpcUpdateSubscription() defers attaching the subscription handlers and
// replaying buffered notifications to a setTimeout(0) macrotask, guarded by
// `this._updateRpcSubscriptionId !== subscriptionId || !rpcClient?.subscriptionActive(subscriptionId)`.
// But stop() clears _updateRpcSubscriptionId only AFTER awaiting the unsubscribe RPC round trip
// (src/community/rpc-remote-community.ts, stop()), and the client deletes _subscriptionEvents[id]
// only after the websocket "unsubscribe" call resolves (src/clients/rpc-client/pkc-rpc-client.ts,
// unsubscribe()). So in the natural sequence `await community.update(); await community.stop();`
// the 0ms timer fires while stop()'s unsubscribe is still in flight, both guard halves pass, the
// handlers attach, and a buffered subscribe-time error notification is replayed into a community
// that is stopping and has no user error listener. The bubbling rule in remote-community.ts
// (`listenerCount("error") === 1` forwards to pkc) then emits it as a stray pkc-level error - the
// exact #299 symptom, narrowed to the stop-in-flight window.
//
// The desired behavior asserted here: once stop() has been initiated, the buffered subscribe-time
// error must not be delivered anywhere - in particular it must not surface as an unhandled
// pkc-level error. Today this test is RED because the deferred replay wins the race against
// stop()'s awaited unsubscribe.
//
// The injection harness is identical to community-error-at-subscribe-time.rpc.test.ts: the
// PKCWsServer runs in-process and its _bindCommunityUpdateSubscription is wrapped so the
// server-side updating community emits a non-retriable error after the subscription listeners are
// bound but before the subscribe response, guaranteeing the error notification sits in the
// client's pending buffer before update() resolves.
import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

const RPC_AUTH_KEY = "test-community-error-replay-stop-race";
const INJECTED_MARKER = "injectedStopRaceError313";

const isInjectedError = (err: unknown): boolean =>
    Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[INJECTED_MARKER]);

describe("RPC: buffered subscribe-time error must not be replayed into a community that is stopping", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.tmp/.pkc-rpc-stop-race-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as Record<string, Function>;

        // Emit a non-retriable error on the server-side updating instance after the subscription's
        // listeners are bound but before communityUpdateSubscribe returns its response. The error
        // notification is written to the websocket ahead of the subscribe response, so the client
        // buffers it in _pendingSubscriptionMsgs before update() resolves.
        const originalBind = server._bindCommunityUpdateSubscription.bind(rpcServer);
        server._bindCommunityUpdateSubscription = async (
            parsedArgs: { name?: string; publicKey?: string },
            connectionId: string,
            subscriptionId: number
        ) => {
            await originalBind(parsedArgs, connectionId, subscriptionId);
            const entry = findUpdatingCommunity(serverPKC, parsedArgs) as RemoteCommunity | undefined;
            if (!entry) throw new Error("Test setup failed: no server-side updating entry after binding the subscription");
            entry.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
        };
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("stopping right after update() does not leak the buffered subscribe-time error to pkc", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        // Collect pkc-level errors instead of letting them throw. Without this listener the leaked
        // replay would surface as an uncaught pkc "error" emission and crash the process, which is
        // a separate bug; here we only assert on delivery.
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        try {
            const signer = await client.createSigner();
            const community = await client.createCommunity({ address: signer.address });

            // No community-level error listener on purpose: the caller subscribed and immediately
            // changed its mind. The injected error notification is already buffered client-side
            // when update() resolves; stop()'s unsubscribe round trip is still in flight when the
            // deferred setTimeout(0) replay from _initRpcUpdateSubscription fires.
            await community.update();
            await community.stop();

            // Generous settle window so the deferred replay (and any later delivery a fix might
            // introduce) has fired before we assert. Exit early if the leak already happened.
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline && !pkcLevelErrors.some(isInjectedError)) await new Promise((resolve) => setTimeout(resolve, 50));

            // Desired behavior: once stop() was initiated, the buffered subscribe-time error is
            // dropped - nothing is delivered to a community with no listeners, and nothing bubbles
            // to pkc as an unhandled error.
            expect({
                pkcGotInjectedErrorAfterStop: pkcLevelErrors.some(isInjectedError)
            }).toEqual({
                pkcGotInjectedErrorAfterStop: false
            });
        } finally {
            await client.destroy();
        }
    });
});
