// Regression tests for https://github.com/pkcprotocol/pkc-js/issues/158
//
// On RPC server boot, `_autoStartPreviousCommunities()` queues every previously-started
// community, but a concurrent embedded-Kubo restart (triggered by the HTTP-router config
// reconcile, which POSTs /shutdown to the node) kills any `community.start()` that is in-flight
// during the restart window. Those communities used to fail once with `TypeError: fetch failed`
// and were NEVER retried, so they stayed stopped even though the user never disabled them.
//
// Two independent bugs, one test each:
//
//   Bug 1 — the Kubo restart races auto-start instead of preceding it. Auto-start must await the
//           PKC `_addressRewriterSetupPromise` (the router reconcile + shutdown) before dispatching
//           any `community.start()`, so it never runs against a Kubo node about to be shut down.
//
//   Bug 2 — no retry on transient auto-start failure. A `fetch failed` / socket-closed error caused
//           by a transient Kubo restart is exactly the case that should be retried; nothing did.
//
// Both tests inject the failure / timing deterministically (no reliance on a real Kubo shutdown,
// which would break the shared test node), so each is RED against unmodified src and GREEN once
// the ordering + bounded-retry fix lands.

import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import PKCWsServer from "../../../../dist/node/rpc/src/index.js";
import { mockPKC } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../../test/helpers/conditional-tests.js";
import { temporaryDirectory } from "tempy";

import PKC from "../../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CreatePKCWsServerOptions } from "../../../../dist/node/rpc/src/types.js";

type PKCWsServerType = Awaited<ReturnType<typeof PKCWsServer.PKCWsServer>>;

// Interface for accessing private members under test
interface PKCWsServerPrivateAccess {
    _startedCommunities: Record<string, unknown>;
    _autoStartOnBoot: boolean;
    _autoStartPreviousCommunities: () => Promise<void>;
    _internalStartCommunity: (address: string) => Promise<LocalCommunity>;
    pkc: PKCType;
}

// `_addressRewriterSetupPromise` is private on PKC; this narrow view lets the test stub it.
type PKCWithRewriterPromise = { _addressRewriterSetupPromise?: Promise<void> };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// describeSkipIfRpc: these tests drive a real local Kubo through the RPC server and poke its
// private auto-start internals; they cannot run against a remote RPC server.
describeSkipIfRpc(`RPC auto-start survives boot-time Kubo restart (issue #158)`, async () => {
    let basePKC: PKCType;

    beforeAll(async () => {
        basePKC = await mockPKC();
    });

    afterAll(async () => {
        await basePKC.destroy();
    });

    // Helper: stand up an RPC server whose state DB already records `communityAddress` as
    // wasStarted=1 / wasExplicitlyStopped=0, with auto-start NOT firing on boot (so the test
    // controls exactly when and how `_autoStartPreviousCommunities()` runs).
    const seedStartedCommunityState = async (dataPath: string, rpcServerPort: number): Promise<string> => {
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            pkcOptions: {
                kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: basePKC.httpRoutersOptions,
                dataPath
            },
            startStartedCommunitiesOnStartup: true
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options);
        const rpcUrl = `ws://localhost:${rpcServerPort}`;
        const clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        const community = (await clientPKC.createCommunity({})) as RpcLocalCommunity;
        const communityAddress = community.address;
        await community.start();
        // Destroy without stopping (simulating crash/restart) -> state persisted wasStarted=1.
        await clientPKC.destroy();
        await rpcServer.destroy();
        return communityAddress;
    };

    // Boot a fresh server with auto-start disabled so the boot-time fire-and-forget no-ops; the
    // test flips `_autoStartOnBoot` on and invokes `_autoStartPreviousCommunities()` itself.
    const bootServerWithoutAutoStart = async (dataPath: string, rpcServerPort: number): Promise<PKCWsServerType> => {
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            pkcOptions: {
                kuboRpcClientsOptions: basePKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: basePKC.httpRoutersOptions,
                dataPath
            },
            startStartedCommunitiesOnStartup: false
        };
        return PKCWsServer.PKCWsServer(options);
    };

    const cleanup = async (rpcServer: PKCWsServerType, rpcServerPort: number, communityAddress: string) => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [`ws://localhost:${rpcServerPort}`],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        const community = (await clientPKC.createCommunity({ address: communityAddress })) as RpcLocalCommunity;
        await community.stop().catch(() => {});
        await community.delete().catch(() => {});
        await clientPKC.destroy();
        await rpcServer.destroy();
    };

    describe("Bug 1: auto-start waits for the HTTP-router / Kubo-restart reconcile before dispatching", () => {
        it("does not dispatch community.start() until _addressRewriterSetupPromise resolves", async () => {
            const dataPath = temporaryDirectory();
            const rpcServerPort = 19170;
            const communityAddress = await seedStartedCommunityState(dataPath, rpcServerPort);

            const rpcServer = await bootServerWithoutAutoStart(dataPath, rpcServerPort);
            const priv = rpcServer as unknown as PKCWsServerPrivateAccess;
            priv._autoStartOnBoot = true;

            // Simulate the background router reconcile: a promise that resolves only when we say so
            // (in production it resolves after the /shutdown POST + Kubo restart settle).
            let resolveRewriterSetup!: () => void;
            (priv.pkc as unknown as PKCWithRewriterPromise)._addressRewriterSetupPromise = new Promise<void>((resolve) => {
                resolveRewriterSetup = resolve;
            });

            let startDispatched = false;
            const realInternalStart = priv._internalStartCommunity.bind(rpcServer);
            vi.spyOn(
                rpcServer as unknown as { _internalStartCommunity: (a: string) => Promise<LocalCommunity> },
                "_internalStartCommunity"
            ).mockImplementation(async (address: string) => {
                startDispatched = true;
                return realInternalStart(address);
            });

            // Kick off auto-start WITHOUT awaiting it.
            const autoStartDone = priv._autoStartPreviousCommunities();

            // Give auto-start ample time to (incorrectly) dispatch a start while the reconcile is
            // still pending. With the fix it must block on _addressRewriterSetupPromise.
            await sleep(1000);
            expect(startDispatched, "auto-start dispatched community.start() before the Kubo-restart reconcile settled").to.be.false;

            // Now let the reconcile settle; auto-start should proceed and start the community.
            resolveRewriterSetup();
            await autoStartDone;

            expect(startDispatched).to.be.true;
            expect(communityAddress in priv._startedCommunities).to.be.true;
            expect(priv._startedCommunities[communityAddress]).to.not.equal("pending");

            vi.restoreAllMocks();
            await cleanup(rpcServer, rpcServerPort, communityAddress);
        });
    });

    describe("Bug 2: auto-start retries a community whose start hit a transient Kubo blip", () => {
        it("retries `fetch failed` and ends with the community started", async () => {
            const dataPath = temporaryDirectory();
            const rpcServerPort = 19171;
            const communityAddress = await seedStartedCommunityState(dataPath, rpcServerPort);

            const rpcServer = await bootServerWithoutAutoStart(dataPath, rpcServerPort);
            const priv = rpcServer as unknown as PKCWsServerPrivateAccess;
            priv._autoStartOnBoot = true;

            // First two attempts fail exactly like an in-flight start hitting a dying Kubo socket;
            // the third delegates to the real start, which succeeds against the (healthy) test node.
            const realInternalStart = priv._internalStartCommunity.bind(rpcServer);
            let attempts = 0;
            vi.spyOn(
                rpcServer as unknown as { _internalStartCommunity: (a: string) => Promise<LocalCommunity> },
                "_internalStartCommunity"
            ).mockImplementation(async (address: string) => {
                attempts++;
                if (attempts <= 2) throw new TypeError("fetch failed");
                return realInternalStart(address);
            });

            await priv._autoStartPreviousCommunities();

            expect(attempts, "auto-start did not retry the transient failure").to.be.greaterThanOrEqual(3);
            expect(communityAddress in priv._startedCommunities, "community was left stopped after a transient failure").to.be.true;
            expect(priv._startedCommunities[communityAddress]).to.not.equal("pending");

            vi.restoreAllMocks();
            await cleanup(rpcServer, rpcServerPort, communityAddress);
        });
    });
});
