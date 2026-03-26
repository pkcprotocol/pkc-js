import { beforeAll, afterAll, afterEach } from "vitest";
import tempy from "tempy";

import PlebbitWsServerModule from "../../../../dist/node/rpc/src/index.js";
import { restorePlebbitJs } from "../../../../dist/node/rpc/src/lib/plebbit-js/index.js";
import { findStartedSubplebbit } from "../../../../dist/node/plebbit/tracked-instance-registry-util.js";
import { describeSkipIfRpc, mockRpcServerForTests, mockRpcServerPlebbit } from "../../../../dist/node/test/test-util.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";

const { PlebbitWsServer: createPlebbitWsServer, setPlebbitJs } = PlebbitWsServerModule;

type PlebbitWsServerType = Awaited<ReturnType<typeof createPlebbitWsServer>>;

// Standalone interface for accessing private members via unknown casting
// Using a separate interface avoids TypeScript's intersection-with-private-members issue
interface PlebbitWsServerPrivateAccess {
    _onSettingsChange: Record<string, Record<string, unknown>>;
    _trackSubplebbitListener: (subplebbit: LocalSubplebbit, event: string, listener: () => void) => void;
    _trackedSubplebbitListeners: Map<LocalSubplebbit, Map<string, Set<() => void>>>;
    _serializeSettingsFromPlebbit: (plebbit: PlebbitWsServerType["plebbit"]) => {
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

const setupConnectionContext = (rpcServer: PlebbitWsServerType, connectionId: string) => {
    rpcServer.subscriptionCleanups[connectionId] = {};
    rpcServer.connections[connectionId] = { send: () => {} } as unknown as PlebbitWsServerType["connections"][string];
    (rpcServer as unknown as PlebbitWsServerPrivateAccess)._onSettingsChange[connectionId] = {};
};

describeSkipIfRpc("PlebbitWsServer listener lifecycle", function () {
    let rpcServer: PlebbitWsServerType | undefined;

    beforeAll(() => {
        setPlebbitJs(async (options: Record<string, unknown>) => mockRpcServerPlebbit({ dataPath: tempy.directory(), ...(options || {}) }));
    });

    afterAll(() => {
        restorePlebbitJs();
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

    it("does not track listeners when creating a subplebbit", async function () {
        rpcServer = await createPlebbitWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const trackedCalls: { subplebbit: LocalSubplebbit; event: string; listener: () => void }[] = [];
        const rpcServerWithPrivate = rpcServer as unknown as PlebbitWsServerPrivateAccess;
        const originalTrack = rpcServerWithPrivate._trackSubplebbitListener;
        rpcServerWithPrivate._trackSubplebbitListener = function (subplebbit: LocalSubplebbit, event: string, listener: () => void) {
            trackedCalls.push({ subplebbit, event, listener });
            return originalTrack.call(this, subplebbit, event, listener);
        };

        try {
            const created = await rpcServer.createSubplebbit([{}]);
            expect(created.address).to.be.a("string");
            expect(trackedCalls).to.have.length(0, "createSubplebbit should not track event listeners");
        } finally {
            rpcServerWithPrivate._trackSubplebbitListener = originalTrack;
        }
    });

    it("preserves built-in challenge metadata when setPlebbitJs injects a plain function", async function () {
        rpcServer = await createPlebbitWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const rpcServerWithPrivate = rpcServer as unknown as PlebbitWsServerPrivateAccess;
        const settings = rpcServerWithPrivate._serializeSettingsFromPlebbit(rpcServer.plebbit);

        expect(settings.challenges.question).to.be.an("object");
        expect(settings.challenges.question.type).to.be.a("string");
    });

    it("tracks listeners on startSubplebbit and removes them on stopSubplebbit", async function () {
        rpcServer = await createPlebbitWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const connectionId = "start-stop-connection";
        setupConnectionContext(rpcServer, connectionId);

        const createResponse = await rpcServer.createSubplebbit([{}]);
        const address = createResponse.address;
        expect(address).to.be.a("string");

        let capturedSubplebbit: LocalSubplebbit | undefined;
        const originalSetup = rpcServer._setupStartedEvents;
        rpcServer._setupStartedEvents = function (subplebbit: LocalSubplebbit, connId: string, subscriptionId: number) {
            capturedSubplebbit = subplebbit;
            return originalSetup.call(this, subplebbit, connId, subscriptionId);
        };

        try {
            const subscriptionId = await rpcServer.startSubplebbit([{ address }], connectionId);
            expect(subscriptionId).to.be.a("number");
            expect(capturedSubplebbit).to.exist;

            const rpcServerWithPrivate = rpcServer as unknown as PlebbitWsServerPrivateAccess;
            const trackedListenersMap = rpcServerWithPrivate._trackedSubplebbitListeners;
            const tracked = trackedListenersMap.get(capturedSubplebbit!);
            expect(tracked).to.exist;

            STARTED_EVENT_NAMES.forEach((event) => {
                expect(tracked!.has(event)).to.equal(true, `Missing tracked listeners for event ${event}`);
                const listeners = tracked!.get(event);
                expect(listeners!.size).to.equal(1, `Expected one tracked listener for event ${event}`);
                listeners!.forEach((listener) => {
                    const emitterListeners = capturedSubplebbit!.listeners(event as Parameters<typeof capturedSubplebbit.listeners>[0]);
                    expect(emitterListeners).to.include(listener, `Listener for ${event} not attached to subplebbit`);
                });
            });

            const trackedSnapshot = cloneTrackedListeners(tracked!);

            await rpcServer.stopSubplebbit([{ address }]);

            expect(trackedListenersMap.get(capturedSubplebbit!)).to.equal(undefined, "Tracked listeners should be removed after stop");

            trackedSnapshot.forEach((listeners, event) => {
                const emitterListeners = capturedSubplebbit!.listeners(event as Parameters<typeof capturedSubplebbit.listeners>[0]);
                listeners.forEach((listener) => {
                    expect(emitterListeners).to.not.include(listener, `Listener for ${event} should be removed on stop`);
                });
            });
        } finally {
            rpcServer._setupStartedEvents = originalSetup;
        }
    });

    it("removes tracked listeners when deleting a started subplebbit", async function () {
        rpcServer = await createPlebbitWsServer({ port: getTestPort() });
        mockRpcServerForTests(rpcServer);

        const connectionId = "delete-connection";
        setupConnectionContext(rpcServer, connectionId);

        const createResponse = await rpcServer.createSubplebbit([{}]);
        const address = createResponse.address;
        expect(address).to.be.a("string");

        let capturedSubplebbit: LocalSubplebbit | undefined;
        const originalSetup = rpcServer._setupStartedEvents;
        rpcServer._setupStartedEvents = function (subplebbit: LocalSubplebbit, connId: string, subscriptionId: number) {
            capturedSubplebbit = subplebbit;
            return originalSetup.call(this, subplebbit, connId, subscriptionId);
        };

        try {
            await rpcServer.startSubplebbit([{ address }], connectionId);
            expect(capturedSubplebbit).to.exist;

            const rpcServerWithPrivate = rpcServer as unknown as PlebbitWsServerPrivateAccess;
            const trackedListenersMap = rpcServerWithPrivate._trackedSubplebbitListeners;
            const tracked = trackedListenersMap.get(capturedSubplebbit!);
            expect(tracked).to.exist;
            const trackedSnapshot = cloneTrackedListeners(tracked!);

            const deleteResult = await rpcServer.deleteSubplebbit([{ address }]);
            expect(deleteResult).to.equal(true);

            expect(trackedListenersMap.get(capturedSubplebbit!)).to.equal(undefined, "Tracked listeners should be removed after delete");
            expect(findStartedSubplebbit(rpcServer.plebbit, { address })).to.equal(
                undefined,
                "Started sub list should not contain deleted sub"
            );

            trackedSnapshot.forEach((listeners, event) => {
                const emitterListeners = capturedSubplebbit!.listeners(event as Parameters<typeof capturedSubplebbit.listeners>[0]);
                listeners.forEach((listener) => {
                    expect(emitterListeners).to.not.include(listener, `Listener for ${event} should be removed on delete`);
                });
            });
        } finally {
            rpcServer._setupStartedEvents = originalSetup;
        }
    });
});
