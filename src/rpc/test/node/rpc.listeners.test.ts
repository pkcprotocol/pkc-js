import { beforeAll, afterAll, afterEach } from "vitest";
import tempy from "tempy";

import PKCWsServerModule from "../../../../dist/node/rpc/src/index.js";
import { restorePKCJs } from "../../../../dist/node/rpc/src/lib/pkc-js/index.js";
import { findStartedCommunity } from "../../../../dist/node/pkc/tracked-instance-registry-util.js";
import { describeSkipIfRpc, mockRpcServerForTests, mockRpcServerPKC } from "../../../../dist/node/test/test-util.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

const { PKCWsServer: createPKCWsServer, setPKCJs } = PKCWsServerModule;

type PKCWsServerType = Awaited<ReturnType<typeof createPKCWsServer>>;

// Standalone interface for accessing private members via unknown casting
// Using a separate interface avoids TypeScript's intersection-with-private-members issue
interface PKCWsServerPrivateAccess {
    _onSettingsChange: Record<string, Record<string, unknown>>;
    _trackCommunityListener: (community: LocalCommunity, event: string, listener: () => void) => void;
    _trackedCommunityListeners: Map<LocalCommunity, Map<string, Set<() => void>>>;
    _serializeSettingsFromPKC: (pkc: PKCWsServerType["pkc"]) => {
        challenges: Record<string, { type?: string; challenge?: string; description?: string }>;
    };
}

const STARTED_EVENT_NAMES = [
    "challengerequest",
    "challenge",
    "challengeanswer",
    "challengeverification",
    "error",
    "startedstatechange",
    "update"
] as const;

const getTestPort = (() => {
    let offset = 0;
    return () => {
        offset += 1;
        return 19000 + offset;
    };
})();

const cloneTrackedListeners = (trackedMap: Map<string, Set<() => void>>) =>
    new Map([...trackedMap.entries()].map(([event, listeners]) => [event, new Set(listeners)]));

const setupConnectionContext = (rpcServer: PKCWsServerType, connectionId: string) => {
    rpcServer.subscriptionCleanups[connectionId] = {};
    rpcServer.connections[connectionId] = { send: () => {} } as unknown as PKCWsServerType["connections"][string];
    (rpcServer as unknown as PKCWsServerPrivateAccess)._onSettingsChange[connectionId] = {};
};

describeSkipIfRpc("PKCWsServer listener lifecycle", function () {
    let rpcServer: PKCWsServerType | undefined;

    beforeAll(() => {
        setPKCJs(async (options: Record<string, unknown>) => mockRpcServerPKC({ dataPath: tempy.directory(), ...(options || {}) }));
    });

    afterAll(() => {
        restorePKCJs();
    });

    afterEach(async () => {
        if (rpcServer) {
            try {
                await rpcServer.destroy();
            } catch (error) {
                console.error("rpc.listeners.test destroy error", error);
            }
            rpcServer = undefined;
        }
    });

    it("does not track listeners when creating a community", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const trackedCalls: { community: LocalCommunity; event: string; listener: () => void }[] = [];
        const rpcServerWithPrivate = rpcServer as unknown as PKCWsServerPrivateAccess;
        const originalTrack = rpcServerWithPrivate._trackCommunityListener;
        rpcServerWithPrivate._trackCommunityListener = function (community: LocalCommunity, event: string, listener: () => void) {
            trackedCalls.push({ community, event, listener });
            return originalTrack.call(this, community, event, listener);
        };

        try {
            const created = await rpcServer.createCommunity([{}]);
            expect(created.localCommunity.address).to.be.a("string");
            expect(trackedCalls).to.have.length(0, "createCommunity should not track event listeners");
        } finally {
            rpcServerWithPrivate._trackCommunityListener = originalTrack;
        }
    });

    it("preserves built-in challenge metadata when setPKCJs injects a plain function", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const rpcServerWithPrivate = rpcServer as unknown as PKCWsServerPrivateAccess;
        const settings = rpcServerWithPrivate._serializeSettingsFromPKC(rpcServer.pkc);

        expect(settings.challenges.question).to.be.an("object");
        expect(settings.challenges.question.type).to.be.a("string");
    });

    it("tracks listeners on startCommunity and removes them on stopCommunity", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const connectionId = "start-stop-connection";
        setupConnectionContext(rpcServer, connectionId);

        const createResponse = await rpcServer.createCommunity([{}]);
        const address = createResponse.localCommunity.address;
        expect(address).to.be.a("string");

        let capturedCommunity: LocalCommunity | undefined;
        const originalSetup = rpcServer._setupStartedEvents;
        rpcServer._setupStartedEvents = function (community: LocalCommunity, connId: string, subscriptionId: number) {
            capturedCommunity = community;
            return originalSetup.call(this, community, connId, subscriptionId);
        };

        try {
            const subscriptionId = await rpcServer.startCommunity([{ address }], connectionId);
            expect(subscriptionId).to.be.a("number");
            expect(capturedCommunity).to.exist;

            const rpcServerWithPrivate = rpcServer as unknown as PKCWsServerPrivateAccess;
            const trackedListenersMap = rpcServerWithPrivate._trackedCommunityListeners;
            const tracked = trackedListenersMap.get(capturedCommunity!);
            expect(tracked).to.exist;

            STARTED_EVENT_NAMES.forEach((event) => {
                expect(tracked!.has(event)).to.equal(true, `Missing tracked listeners for event ${event}`);
                const listeners = tracked!.get(event);
                expect(listeners!.size).to.equal(1, `Expected one tracked listener for event ${event}`);
                listeners!.forEach((listener) => {
                    const emitterListeners = capturedCommunity!.listeners(event as Parameters<typeof capturedCommunity.listeners>[0]);
                    expect(emitterListeners).to.include(listener, `Listener for ${event} not attached to community`);
                });
            });

            const trackedSnapshot = cloneTrackedListeners(tracked!);

            await rpcServer.stopCommunity([{ address }]);

            expect(trackedListenersMap.get(capturedCommunity!)).to.equal(undefined, "Tracked listeners should be removed after stop");

            trackedSnapshot.forEach((listeners, event) => {
                const emitterListeners = capturedCommunity!.listeners(event as Parameters<typeof capturedCommunity.listeners>[0]);
                listeners.forEach((listener) => {
                    expect(emitterListeners).to.not.include(listener, `Listener for ${event} should be removed on stop`);
                });
            });
        } finally {
            rpcServer._setupStartedEvents = originalSetup;
        }
    });

    it("removes tracked listeners when deleting a started community", async function () {
        rpcServer = await createPKCWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const connectionId = "delete-connection";
        setupConnectionContext(rpcServer, connectionId);

        const createResponse = await rpcServer.createCommunity([{}]);
        const address = createResponse.localCommunity.address;
        expect(address).to.be.a("string");

        let capturedCommunity: LocalCommunity | undefined;
        const originalSetup = rpcServer._setupStartedEvents;
        rpcServer._setupStartedEvents = function (community: LocalCommunity, connId: string, subscriptionId: number) {
            capturedCommunity = community;
            return originalSetup.call(this, community, connId, subscriptionId);
        };

        try {
            await rpcServer.startCommunity([{ address }], connectionId);
            expect(capturedCommunity).to.exist;

            const rpcServerWithPrivate = rpcServer as unknown as PKCWsServerPrivateAccess;
            const trackedListenersMap = rpcServerWithPrivate._trackedCommunityListeners;
            const tracked = trackedListenersMap.get(capturedCommunity!);
            expect(tracked).to.exist;
            const trackedSnapshot = cloneTrackedListeners(tracked!);

            const deleteResult = await rpcServer.deleteCommunity([{ address }]);
            expect(deleteResult).to.equal(true);

            expect(trackedListenersMap.get(capturedCommunity!)).to.equal(undefined, "Tracked listeners should be removed after delete");
            expect(findStartedCommunity(rpcServer.pkc, { address })).to.equal(
                undefined,
                "Started community list should not contain deleted community"
            );

            trackedSnapshot.forEach((listeners, event) => {
                const emitterListeners = capturedCommunity!.listeners(event as Parameters<typeof capturedCommunity.listeners>[0]);
                listeners.forEach((listener) => {
                    expect(emitterListeners).to.not.include(listener, `Listener for ${event} should be removed on delete`);
                });
            });
        } finally {
            rpcServer._setupStartedEvents = originalSetup;
        }
    });
});
