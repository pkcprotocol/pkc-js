// Regression test for the stop-in-flight window of the #299 deferred replay (found on PR #313).
// RpcRemoteCommunity._initRpcUpdateSubscription() defers attaching the subscription handlers and
// replaying buffered notifications to a setTimeout(0) macrotask, guarded by
// `this._updateRpcSubscriptionId !== subscriptionId || !rpcClient?.subscriptionActive(subscriptionId)`.
// But stop() used to clear _updateRpcSubscriptionId only AFTER awaiting the unsubscribe RPC
// round trip (src/community/rpc-remote-community.ts, stop()), and the client deletes
// _subscriptionEvents[id] only after the websocket "unsubscribe" call resolves
// (src/clients/rpc-client/pkc-rpc-client.ts, unsubscribe()). So in the natural sequence
// `await community.update(); await community.stop();` the 0ms timer fired while stop()'s
// unsubscribe was still in flight, both guard halves passed, the handlers attached, and a
// buffered subscribe-time error notification was replayed into a community that was stopping and
// had no user error listener. The bubbling rule in remote-community.ts
// (`listenerCount("error") === 1` forwards to pkc) then emitted it as a stray pkc-level error -
// the exact #299 symptom, narrowed to the stop-in-flight window.
//
// The desired behavior asserted here: once stop() has been initiated, the buffered subscribe-time
// error must not be delivered anywhere - in particular it must not surface as an unhandled
// pkc-level error. Before the fix (stop() now clears the subscription id synchronously before
// the awaited unsubscribe) this test was RED because the deferred replay won the race.
//
// The injection harness is identical to community-error-at-subscribe-time.rpc.test.ts: the
// PKCWsServer runs in-process and its _bindCommunityUpdateSubscription is wrapped so the
// server-side updating community emits a non-retriable error after the subscription listeners are
// bound but before the subscribe response, guaranteeing the error notification sits in the
// client's pending buffer before update() resolves.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import PKC from "../../../dist/node/index.js";
import {
    createInProcessRpcServer,
    makeInjectedErrorMatcher,
    pollUntil,
    uniqueTmpDataPath,
    wrapCommunityUpdateSubscriptionBind,
    type PKCWsServerType
} from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const RPC_AUTH_KEY = "test-community-error-replay-stop-race";
const INJECTED_MARKER = "injectedStopRaceError313";

const isInjectedError = makeInjectedErrorMatcher(INJECTED_MARKER);

describe("RPC: buffered subscribe-time error must not be replayed into a community that is stopping", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = uniqueTmpDataPath("pkc-rpc-stop-race-test");
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        // Emit a non-retriable error on the server-side updating instance after the subscription's
        // listeners are bound but before communityUpdateSubscribe returns its response. The error
        // notification is written to the websocket ahead of the subscribe response, so the client
        // buffers it in _pendingSubscriptionMsgs before update() resolves.
        wrapCommunityUpdateSubscriptionBind({
            rpcServer,
            serverPKC,
            onBound: (entry) => {
                entry.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
            }
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
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
            await pollUntil(() => pkcLevelErrors.some(isInjectedError), { timeoutMs: 2_000, intervalMs: 50 });

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
