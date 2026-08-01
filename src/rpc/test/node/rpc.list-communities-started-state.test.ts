import { beforeAll, afterAll, afterEach } from "vitest";
import { temporaryDirectory } from "tempy";

import PKCWsServerModule from "../../../../dist/node/rpc/src/index.js";
import { restorePKCJs } from "../../../../dist/node/rpc/src/lib/pkc-js/index.js";
import { mockRpcServerForTests, mockRpcServerPKC } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../../test/helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

const { PKCWsServer: createPKCWsServer, setPKCJs } = PKCWsServerModule;

type PKCWsServerType = Awaited<ReturnType<typeof createPKCWsServer>>;

const getTestPort = (() => {
    let offset = 0;
    return () => {
        offset += 1;
        return 19400 + offset;
    };
})();

interface PKCWsServerPrivateAccess {
    _onSettingsChange: Record<string, Record<string, unknown>>;
}

const setupConnectionContext = (rpcServer: PKCWsServerType, connectionId: string) => {
    rpcServer.subscriptionCleanups[connectionId] = {};
    rpcServer.connections[connectionId] = { send: () => {} } as unknown as PKCWsServerType["connections"][string];
    (rpcServer as unknown as PKCWsServerPrivateAccess)._onSettingsChange[connectionId] = {};
};

// listCommunitiesStartedState is a performance shortcut: it answers `started` for every community
// from start-lockfile checks alone, instead of the caller doing one createCommunity round trip per
// community (each of which ships that community's entire internal record just to read one boolean
// off it). The shortcut is only safe while it agrees with the slow path, so the tests below assert
// equivalence against the LocalCommunity `started` rather than against hardcoded expectations.
//
// Cannot run under RPC: these drive PKCWsServer directly, and USE_RPC points the suite at an
// already-running external RPC server whose internals are not reachable from here.
describeSkipIfRpc("rpcServer.listCommunitiesStartedState", function () {
    let rpcServer: PKCWsServerType | undefined;

    beforeAll(() => {
        setPKCJs(async (options: Record<string, unknown>) => mockRpcServerPKC({ dataPath: temporaryDirectory(), ...(options || {}) }));
    });

    afterAll(() => {
        restorePKCJs();
    });

    afterEach(async () => {
        if (rpcServer) {
            try {
                await rpcServer.destroy();
            } catch (error) {
                console.error("rpc.list-communities-started-state.test destroy error", error);
            }
            rpcServer = undefined;
        }
    });

    const startedStateOf = async (server: PKCWsServerType, address: string) => {
        const { communities } = await server.listCommunitiesStartedState();
        const entry = communities.find((community) => community.address === address);
        expect(entry, `${address} missing from listCommunitiesStartedState`).to.exist;
        return entry!.started;
    };

    it("reports every community the node has, with no communities started", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const first = (await rpcServer.createCommunity([{}])).localCommunity.address;
        const second = (await rpcServer.createCommunity([{}])).localCommunity.address;

        const { communities } = await rpcServer.listCommunitiesStartedState();

        expect(communities.map((c) => c.address).sort()).to.deep.equal([...rpcServer.pkc.communities].sort());
        expect(communities.map((c) => c.address)).to.include(first);
        expect(communities.map((c) => c.address)).to.include(second);
        communities.forEach((community) => {
            expect(community.started).to.equal(false, `${community.address} should not be started`);
        });
    });

    it("agrees with the LocalCommunity `started` across a start and a stop", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const connectionId = "started-state-connection";
        setupConnectionContext(rpcServer, connectionId);

        const started = (await rpcServer.createCommunity([{}])).localCommunity.address;
        const untouched = (await rpcServer.createCommunity([{}])).localCommunity.address;

        // The slow path the shortcut replaces. A client asking for `started` ends up here: the node
        // builds a LocalCommunity for the address and `started` on the wire is whatever that
        // instance reports (LocalCommunity._updateStartedValue -> the start lockfile).
        const viaLocalCommunity = async (address: string) =>
            ((await rpcServer!.pkc.createCommunity({ address })) as unknown as LocalCommunity).started;

        expect(await startedStateOf(rpcServer, started)).to.equal(await viaLocalCommunity(started));
        expect(await startedStateOf(rpcServer, untouched)).to.equal(await viaLocalCommunity(untouched));

        await rpcServer.startCommunity([{ publicKey: started }], connectionId);

        expect(await startedStateOf(rpcServer, started)).to.equal(true, "started community should read as started");
        expect(await startedStateOf(rpcServer, started)).to.equal(await viaLocalCommunity(started));
        // starting one community must not flip the other
        expect(await startedStateOf(rpcServer, untouched)).to.equal(false);
        expect(await startedStateOf(rpcServer, untouched)).to.equal(await viaLocalCommunity(untouched));

        await rpcServer.stopCommunity([{ publicKey: started }]);

        expect(await startedStateOf(rpcServer, started)).to.equal(false, "stopped community should read as not started");
        expect(await startedStateOf(rpcServer, started)).to.equal(await viaLocalCommunity(started));
    });

    it("does not construct a LocalCommunity per community", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        await rpcServer.createCommunity([{}]);
        await rpcServer.createCommunity([{}]);

        // Building a community is the gateway to the expensive path: it is what produces the full
        // internal record a subscription then serializes. If a future refactor routes this method
        // back through pkc.createCommunity the latency regression returns silently, so assert it.
        const pkc = rpcServer.pkc as unknown as { createCommunity: (...args: unknown[]) => Promise<LocalCommunity> };
        const originalCreateCommunity = pkc.createCommunity;
        let createCommunityCalls = 0;
        pkc.createCommunity = function (...args: unknown[]) {
            createCommunityCalls += 1;
            return originalCreateCommunity.apply(this, args);
        };

        try {
            const { communities } = await rpcServer.listCommunitiesStartedState();
            expect(communities).to.have.length(2);
            expect(createCommunityCalls).to.equal(0, "listCommunitiesStartedState must not build communities");
        } finally {
            pkc.createCommunity = originalCreateCommunity;
        }
    });
});
