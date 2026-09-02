// Regression test for the visibility of a listener throw during the deferred replay (found by
// review on PR #313). If a user's own event listener throws synchronously while the buffered
// subscribe-time notifications are being replayed (for example a listener choking on an
// unexpected value), the throw escapes the sync re-emit chain into the deferred replay's
// try/catch and onReplayError stops the instance. Pre-PR the same throw rejected the awaited
// update() call, visibly; post-deferral the only signal was a debug-namespace log, so the user
// saw a resolved update() and an instance that silently went to "stopped".
//
// Desired behavior asserted here: the contained throw is emitted as an "error" event on the
// instance before it is stopped, so a caller following the README's recommended pattern (attach
// listeners before calling update()) sees why their community died. Today this test is RED
// because onReplayError only logs and stops.
//
// Note the warm-start snapshot of a server-OWNED community is emitted synchronously inside
// update() itself (pre-deferral), where a listener throw already surfaces as an update()
// rejection; that path is not the bug. To land deterministically in the deferred replay instead,
// this test wraps the in-process server's _bindCommunityUpdateSubscription (same harness as
// community-error-at-subscribe-time.rpc.test.ts) to emit an "updatingstatechange" notification
// after the subscription listeners are bound and before the subscribe response, so it is buffered
// client-side and delivered to the throwing listener by the deferred replay.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

const RPC_AUTH_KEY = "test-community-update-listener-throw-visibility";
const LISTENER_THROW_MESSAGE = "injectedListenerThrow313: listener choked on the replayed notification";

describe("RPC: a listener throw during the deferred replay is surfaced as an error event, not a silent stop", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.tmp/.pkc-rpc-listener-throw-visibility-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPKC = await mockRpcServerPKC({ dataPath });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as {
            _bindCommunityUpdateSubscription: (
                parsedArgs: { name?: string; publicKey?: string },
                connectionId: string,
                subscriptionId: number
            ) => Promise<void>;
        };

        // Emit an updatingstatechange on the server-side updating instance after the
        // subscription's listeners are bound but before communityUpdateSubscribe returns its
        // response, so the notification is buffered client-side and delivered by the deferred
        // replay, where the client's throwing listener is reachable.
        const originalBind = server._bindCommunityUpdateSubscription.bind(rpcServer);
        vi.spyOn(server, "_bindCommunityUpdateSubscription").mockImplementation(async (parsedArgs, connectionId, subscriptionId) => {
            await originalBind(parsedArgs, connectionId, subscriptionId);
            const entry = findUpdatingCommunity(serverPKC, parsedArgs) as RemoteCommunity | undefined;
            if (!entry) throw new Error("Test setup failed: no server-side updating entry after binding the subscription");
            entry.emit("updatingstatechange", "fetching-ipns");
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("the throw from the updatingstatechange listener reaches the community error listener", async () => {
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

            // The README's recommended order: listeners first, then update(). The listener throws
            // on the injected replayed state only, so other deliveries are unaffected.
            const communityLevelErrors: unknown[] = [];
            let threw = false;
            community.on("updatingstatechange", (newState) => {
                if (newState !== "fetching-ipns" || threw) return;
                threw = true;
                throw new Error(LISTENER_THROW_MESSAGE);
            });
            community.on("error", (err) => communityLevelErrors.push(err));

            await community.update();

            const isListenerThrow = (err: unknown): boolean =>
                Boolean(err && typeof err === "object" && (err as Error).message === LISTENER_THROW_MESSAGE);

            // Wait for the deferred replay to deliver the buffered notification, throw, and
            // (desired) surface the contained throw as an error event.
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !communityLevelErrors.some(isListenerThrow))
                await new Promise((resolve) => setTimeout(resolve, 100));

            expect({
                listenerSawTheReplayedNotification: threw,
                listenerThrowSurfacedAsErrorEvent: communityLevelErrors.some(isListenerThrow),
                listenerThrowLeakedToPkcAsUnhandled: pkcLevelErrors.some(isListenerThrow)
            }).toEqual({
                listenerSawTheReplayedNotification: true,
                listenerThrowSurfacedAsErrorEvent: true,
                listenerThrowLeakedToPkcAsUnhandled: false
            });

            await community.stop();
        } finally {
            await client.destroy();
        }
    });
});
