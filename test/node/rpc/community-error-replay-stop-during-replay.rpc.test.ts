// Regression test for the per-message granularity of the #299 deferred replay's stop guard
// (found by review on PR #313). attachSubscriptionHandlersDeferred checks
// `opts.isStale() || !subscriptionActive(id)` ONCE, before draining the pending buffer, but
// emitAllPendingMessages then loops over every buffered notification with no re-check between
// messages. If a replayed handler calls stop(), the stop's synchronous prefix clears the
// subscription id immediately (src/community/rpc-remote-community.ts, stop()), yet the client only
// deletes _subscriptionEvents[id] after the awaited wire unsubscribe resolves, so the forEach keeps
// going and delivers the REMAINING buffered notifications into an instance that is already
// stopping. This is the per-message sibling of the timer-level stop race covered by
// community-error-replay-stop-race.rpc.test.ts.
//
// The README's own recommended pattern (call community.stop() from inside the first event handler)
// hits this whenever two or more notifications were buffered before the subscribe response.
//
// Desired behavior asserted here: once a replayed handler initiates stop(), the rest of the
// buffered notifications are dropped - the listener sees exactly the first injected error and
// nothing is delivered afterwards, neither to the community listener nor to pkc. Today this test
// is RED because the replay loop delivers the second buffered error after stop() was called.
//
// The injection harness is identical to community-error-at-subscribe-time.rpc.test.ts, except the
// wrapped _bindCommunityUpdateSubscription emits TWO ordinal-tagged non-retriable errors on the
// server-side updating instance before the subscribe response, guaranteeing both notifications sit
// in the client's pending buffer when the deferred replay fires.
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

const RPC_AUTH_KEY = "test-community-error-replay-stop-during-replay";
const INJECTED_MARKER = "injectedStopDuringReplayError313";

const injectedOrdinal = (err: unknown): number | undefined => {
    const details = (err as { details?: Record<string, unknown> } | undefined)?.details;
    if (!details?.[INJECTED_MARKER]) return undefined;
    return typeof details.ordinal === "number" ? details.ordinal : undefined;
};

describe("RPC: buffered replay stops delivering once a replayed handler calls stop()", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.tmp/.pkc-rpc-stop-during-replay-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as {
            _bindCommunityUpdateSubscription: (
                parsedArgs: { name?: string; publicKey?: string },
                connectionId: string,
                subscriptionId: number
            ) => Promise<void>;
        };

        // Emit two ordinal-tagged non-retriable errors on the server-side updating instance after
        // the subscription's listeners are bound but before communityUpdateSubscribe returns its
        // response. Both error notifications are written to the websocket ahead of the subscribe
        // response, so the client buffers both in _pendingSubscriptionMsgs before update() resolves
        // and the deferred replay drains them back to back in one synchronous loop.
        const originalBind = server._bindCommunityUpdateSubscription.bind(rpcServer);
        vi.spyOn(server, "_bindCommunityUpdateSubscription").mockImplementation(async (parsedArgs, connectionId, subscriptionId) => {
            await originalBind(parsedArgs, connectionId, subscriptionId);
            const entry = findUpdatingCommunity(serverPKC, parsedArgs) as RemoteCommunity | undefined;
            if (!entry) throw new Error("Test setup failed: no server-side updating entry after binding the subscription");
            entry.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true, ordinal: 1 }));
            entry.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true, ordinal: 2 }));
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("calling stop() from the error handler drops the remaining buffered notifications", async () => {
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

            const communityLevelOrdinals: (number | undefined)[] = [];
            await community.update();
            // The README's recommended pattern: react to the first event by stopping. stop()'s
            // synchronous prefix clears the subscription id, so from this point on the replay loop
            // no longer owns the subscription and must not deliver the second buffered error.
            community.on("error", (err) => {
                communityLevelOrdinals.push(injectedOrdinal(err));
                if (injectedOrdinal(err) === 1)
                    community.stop().catch((stopError) => communityLevelOrdinals.push(injectedOrdinal(stopError)));
            });

            // Wait for the first injected error to be replayed to the listener.
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !communityLevelOrdinals.includes(1)) await new Promise((resolve) => setTimeout(resolve, 100));

            // Extra settle window: in the buggy code the second buffered error arrives in the very
            // same synchronous replay loop, but give any deferred delivery a fix might introduce
            // ample time to land before asserting it never does.
            await new Promise((resolve) => setTimeout(resolve, 500));

            expect({
                ordinalsAtCommunityListener: communityLevelOrdinals.filter((ordinal) => ordinal !== undefined),
                pkcGotInjectedErrorAsUnhandled: pkcLevelErrors.some((err) => injectedOrdinal(err) !== undefined)
            }).toEqual({
                ordinalsAtCommunityListener: [1], // only the error that triggered stop(); the second buffered one is dropped
                pkcGotInjectedErrorAsUnhandled: false
            });
        } finally {
            await client.destroy();
        }
    });
});
