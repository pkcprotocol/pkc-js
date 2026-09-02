// Regression test for the start-path variant of the stop-in-flight replay race (found by review
// on PR #313). RpcLocalCommunity.start() defers its handler attachment and buffered replay via
// attachSubscriptionHandlersDeferred, guarded by `this._startRpcSubscriptionId !== subscriptionId
// || !subscriptionActive(id)`. But stop()'s started branch awaits the stopCommunity RPC round
// trip BEFORE _cleanUpRpcConnection clears _startRpcSubscriptionId
// (src/community/rpc-local-community.ts, stop()), so in the natural sequence
// `await community.start(); await community.stop();` the 0ms timer fires while stopCommunity is
// still in flight, both guard halves pass, and the buffered start notifications are replayed into
// a community that is stopping. This is hit unconditionally, not just when an error is injected:
// the server's startCommunityImpl emits an initial "update" notification before returning
// { subscriptionId } (src/rpc/src/index.ts), so at least one message is always buffered.
//
// The desired behavior asserted here mirrors community-error-replay-stop-race.rpc.test.ts: once
// stop() has been initiated, a buffered start-subscribe-time error must not be delivered
// anywhere, in particular it must not bubble to pkc as a stray unhandled error via the
// listenerCount("error") === 1 rule. The fix shape is the one the other four teardown sites
// already use: capture and clear the subscription id synchronously before the first awaited call
// of the teardown.
//
// The injection harness is identical to start-error-at-subscribe-time.rpc.test.ts: the in-process
// PKCWsServer's _setupStartedEvents is wrapped so the server-side started community emits a
// non-retriable error right after the subscription listeners are bound, guaranteeing the error
// notification sits in the client's pending buffer before start() resolves.
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

const RPC_AUTH_KEY = "test-start-error-replay-stop-race";
const INJECTED_MARKER = "injectedStartStopRaceError313";

const isInjectedError = (err: unknown): boolean =>
    Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[INJECTED_MARKER]);

describe("RPC: buffered start-subscribe-time error must not be replayed into a community that is stopping", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.tmp/.pkc-rpc-start-stop-race-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as {
            _setupStartedEvents: (community: LocalCommunity, connectionId: string, subscriptionId: number) => void;
        };

        // Emit a non-retriable error on the server-side started instance after the start
        // subscription's listeners are bound and before startCommunity returns its response, so
        // the error notification sits in the client's pending buffer when start() resolves.
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
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline && !pkcLevelErrors.some(isInjectedError)) await new Promise((resolve) => setTimeout(resolve, 50));

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
