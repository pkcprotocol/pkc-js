// Regression test for the blast radius of start()'s onReplayError containment (found by review on
// PR #313). When the deferred replay of buffered start notifications throws (for example a
// start-subscribe-time error bubbling to a pkc instance with zero "error" listeners, which makes
// EventEmitter throw ERR_UNHANDLED_ERROR into the replay try/catch), the onReplayError handler in
// RpcLocalCommunity.start() calls this.stop(). But stop()'s started branch issues a stopCommunity
// RPC, which halts the community ON THE SERVER, for every connected client. Pre-PR the same throw
// was a catchable rejection of the awaited start() call and left the community running; a purely
// client-local containment (stopWithoutRpcCall(), which tears down only this client's
// subscription and state) matches that blast radius.
//
// Desired behavior asserted here: a replay throw on one client must not stop the server-side
// community. Today this test is RED because onReplayError escalates to a node-wide stopCommunity.
//
// The injection harness is identical to start-error-at-subscribe-time.rpc.test.ts: the in-process
// PKCWsServer's _setupStartedEvents is wrapped so the server-side started community emits a
// non-retriable error before the startCommunity response. The client attaches NO error listeners
// anywhere (neither on the community nor on pkc), which is what turns the replayed error into a
// throw inside the deferred replay.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { findStartedCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

const RPC_AUTH_KEY = "test-start-error-replay-node-wide-stop";
const INJECTED_MARKER = "injectedStartNodeWideStopError313";

describe("RPC: a replay throw on one client must not stop the community for every connected client", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(process.cwd(), `.tmp/.pkc-rpc-start-node-wide-stop-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
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

    itIfRpc("the server-side started community keeps running after a client-local replay throw", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });

        try {
            const signer = await client.createSigner();
            const community = <RpcLocalCommunity>await client.createCommunity({ signer });

            // Deliberately NO error listener on the community and NONE on pkc: the replayed error
            // bubbles via the listenerCount("error") === 1 rule to pkc.emit("error"), which throws
            // ERR_UNHANDLED_ERROR into the deferred replay's try/catch and triggers onReplayError.
            await community.start();

            const lookup = { name: community.name, publicKey: community.publicKey };
            const serverEntryStopped = () => {
                const entry = findStartedCommunity(serverPKC, lookup);
                return !entry || entry.state !== "started";
            };

            // Settle window: exit early if the node-wide stop already happened (onReplayError's
            // stop() awaits a stopCommunity round trip, so give it ample time to land).
            const deadline = Date.now() + 3_000;
            while (Date.now() < deadline && !serverEntryStopped()) await new Promise((resolve) => setTimeout(resolve, 50));

            const serverEntry = findStartedCommunity(serverPKC, lookup);
            expect({
                serverCommunityStillTracked: Boolean(serverEntry),
                serverCommunityState: serverEntry?.state
            }).toEqual({
                serverCommunityStillTracked: true,
                serverCommunityState: "started"
            });
        } finally {
            await client.destroy();
        }
    });
});
