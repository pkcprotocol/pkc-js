// Regression test for the start-path variant of the stop-in-flight replay race (found by review
// on PR #313). RpcLocalCommunity.start() defers its handler attachment and buffered replay via
// attachSubscriptionHandlersDeferred, guarded by `this._startRpcSubscriptionId !== subscriptionId
// || !subscriptionActive(id)`. But stop()'s started branch used to await the stopCommunity RPC
// round trip BEFORE _cleanUpRpcConnection cleared _startRpcSubscriptionId
// (src/community/rpc-local-community.ts, stop()), so in the natural sequence
// `await community.start(); await community.stop();` the 0ms timer fired while stopCommunity was
// still in flight, both guard halves passed, and the buffered start notifications were replayed
// into a community that was stopping. This was hit unconditionally, not just when an error is
// injected: the server's startCommunityImpl emits an initial "update" notification before
// returning { subscriptionId } (src/rpc/src/index.ts), so at least one message is always
// buffered.
//
// The desired behavior asserted here mirrors community-error-replay-stop-race.rpc.test.ts: once
// stop() has been initiated, a buffered start-subscribe-time error must not be delivered
// anywhere, in particular it must not bubble to pkc as a stray unhandled error via the
// listenerCount("error") === 1 rule. The fix is the shape the other four teardown sites already
// used: stop() now captures and clears the subscription id synchronously before the awaited
// stopCommunity call, so the deferred timer no-ops as soon as a stop begins.
//
// The injection harness is identical to start-error-at-subscribe-time.rpc.test.ts: the in-process
// PKCWsServer's _setupStartedEvents is wrapped so the server-side started community emits a
// non-retriable error right after the subscription listeners are bound, guaranteeing the error
// notification sits in the client's pending buffer before start() resolves.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import PKC from "../../../dist/node/index.js";
import {
    createInProcessRpcServer,
    makeInjectedErrorMatcher,
    pollUntil,
    uniqueTmpDataPath,
    wrapStartedEventsSetup,
    type PKCWsServerType
} from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

const RPC_AUTH_KEY = "test-start-error-replay-stop-race";
const INJECTED_MARKER = "injectedStartStopRaceError313";

const isInjectedError = makeInjectedErrorMatcher(INJECTED_MARKER);

describe("RPC: buffered start-subscribe-time error must not be replayed into a community that is stopping", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = uniqueTmpDataPath("pkc-rpc-start-stop-race-test");
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        // Emit a non-retriable error on the server-side started instance after the start
        // subscription's listeners are bound and before startCommunity returns its response, so
        // the error notification sits in the client's pending buffer when start() resolves.
        wrapStartedEventsSetup({
            rpcServer,
            onSetup: (community) => {
                community.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
            }
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("stopping right after start() does not leak the buffered start-subscribe-time error to pkc", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        // Collect pkc-level errors instead of letting them throw: without this listener the
        // leaked replay would surface as an uncaught pkc "error" emission, which is a separate
        // failure mode; here we only assert on delivery.
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        try {
            const signer = await client.createSigner();
            // Passing the signer makes this an owned community the RPC server hosts locally, so
            // start() goes through the startCommunity subscription path under test.
            const community = <RpcLocalCommunity>await client.createCommunity({ signer });

            // No community-level error listener on purpose: the caller started and immediately
            // changed its mind. The injected error notification is already buffered client-side
            // when start() resolves; the stopCommunity round trip is still in flight when the
            // deferred setTimeout(0) replay from start() fires.
            await community.start();
            await community.stop();

            // Generous settle window so the deferred replay (and any later delivery a fix might
            // introduce) has fired before we assert. Exit early if the leak already happened.
            await pollUntil(() => pkcLevelErrors.some(isInjectedError), { timeoutMs: 2_000, intervalMs: 50 });

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
