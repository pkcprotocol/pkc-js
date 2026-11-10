// Overlapping start(), stop() and update() calls on a LocalCommunity (lifecycle.ts).
// Offline: a real LocalCommunity with its real DB and start lock under .tmp/, and fake kubo and pubsub clients, so start()
// and stop() run their own code and each test can hold one of their awaits open. The three mocks below replace the only
// calls that would otherwise reach kubo: importing the signer's key, providing the pubsub topics' routing blocks, and the
// publish cycle, which fails like a cycle against an unreachable kubo unless a test holds it open.
//
// describeSkipIfRpc: with USE_RPC=1 the PKC is an RPC client, and createCommunity() returns a community that runs on the
// RPC server, without the in-process DB, start lock and fake kubo and pubsub clients these tests drive.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import { mockPKCV2 } from "../../../../dist/node/test/test-util.js";
import { syncIpnsWithDb } from "../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js";
import { providePubsubTopicRoutingCidsIfNeeded } from "../../../../dist/node/runtime/node/community/local-community/pubsub.js";
import { communityChallengePubsubTopic } from "../../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import { isCommunityStartLocked } from "../../../../dist/node/runtime/node/community/start-lock.js";
import { findUpdatingCommunity } from "../../../../dist/node/pkc/tracked-instance-registry-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

vi.mock("../../../../dist/node/runtime/node/util.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../../dist/node/runtime/node/util.js")>()),
    importSignerIntoKuboNode: vi.fn(async () => undefined)
}));
vi.mock("../../../../dist/node/runtime/node/community/local-community/pubsub.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../../dist/node/runtime/node/community/local-community/pubsub.js")>()),
    providePubsubTopicRoutingCidsIfNeeded: vi.fn(async () => undefined)
}));
vi.mock("../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js")>()),
    syncIpnsWithDb: vi.fn(async () => {
        throw new Error("offline test: kubo is unreachable");
    })
}));

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Every method a test does not stub throws at once, so nothing here waits on a network retry
const offlineClient = (name: string, stubs: object): unknown =>
    new Proxy(stubs, {
        get(target, prop) {
            if (typeof prop !== "string" || prop === "then") return undefined;
            if (prop in target) return (target as Record<string, unknown>)[prop];
            return offlineClient(`${name}.${prop}`, () => {
                throw new Error(`offline test: ${name}.${prop} is not available`);
            });
        }
    });

type OfflineCommunity = {
    pkc: PKC;
    community: LocalCommunity;
    kuboFiles: { stat: (path: string) => Promise<unknown> };
    subscribedTopics: () => string[];
    isStartLocked: () => Promise<boolean>;
};

const START_FAILURE = "offline test: start() fails after entering the started state";

// Makes the next start() fail once it is in the started state and holds the start lock, before it subscribes to challenge
// requests; it waits for `release` first
function failStartAfterItEnteredTheStartedState(): { held: Deferred; release: Deferred } {
    const held = deferred();
    const release = deferred();
    vi.mocked(providePubsubTopicRoutingCidsIfNeeded).mockImplementationOnce(async () => {
        held.resolve();
        await release.promise;
        throw new Error(START_FAILURE);
    });
    return { held, release };
}

// How many times stop() ran the running-community teardown, counted by its release of the start lock
function countStartUnlocks(community: LocalCommunity): () => number {
    let unlocks = 0;
    const unlockCommunityStart = community._dbHandler.unlockCommunityStart.bind(community._dbHandler);
    community._dbHandler.unlockCommunityStart = async (...args: Parameters<typeof unlockCommunityStart>) => {
        unlocks++;
        return unlockCommunityStart(...args);
    };
    return () => unlocks;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createOfflineCommunity(): Promise<OfflineCommunity> {
    const dataPath = path.join(process.cwd(), ".tmp", `lifecycle-races-${uuidV4()}`);
    fs.mkdirSync(dataPath, { recursive: true });
    const kuboUrl = "http://127.0.0.1:1/api/v0"; // never contacted: both clients are replaced below
    const pkc = await mockPKCV2({
        pkcOptions: { dataPath, kuboRpcClientsOptions: [kuboUrl], pubsubKuboRpcClientsOptions: [kuboUrl], httpRoutersOptions: [] }
    });
    const subscriptions = new Map<string, Set<unknown>>();
    const pubsub = {
        ls: async () => [...subscriptions.keys()],
        subscribe: async (topic: string, handler: unknown) => {
            if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
            subscriptions.get(topic)!.add(handler);
        },
        unsubscribe: async (topic: string, handler?: unknown) => {
            const handlers = subscriptions.get(topic);
            if (handlers && handler) handlers.delete(handler);
            if (!handlers?.size || !handler) subscriptions.delete(topic);
        },
        publish: async (): Promise<void> => {}
    };
    for (const client of Object.values(pkc.clients.pubsubKuboRpcClients))
        (client as unknown as { _client: unknown })._client = offlineClient("pubsub-kubo", { pubsub: offlineClient("pubsub", pubsub) });
    // the postUpdates folder exists, so start() does not rewrite every CommentUpdate
    const kuboFiles = { stat: async (_path: string): Promise<unknown> => ({ blocks: 0, size: 0, cumulativeSize: 0, type: "directory" }) };
    for (const client of Object.values(pkc.clients.kuboRpcClients))
        (client as unknown as { _client: unknown })._client = offlineClient("kubo", { files: offlineClient("files", kuboFiles) });

    const community = (await pkc.createCommunity({})) as LocalCommunity;
    community.on("error", () => {}); // the failing publish cycles emit errors; a test that cares checks state instead
    cleanups.push(async () => {
        await pkc.destroy();
        fs.rmSync(dataPath, { recursive: true, force: true });
    });
    return {
        pkc,
        community,
        kuboFiles,
        subscribedTopics: () => [...subscriptions.keys()],
        isStartLocked: () => isCommunityStartLocked({ dataPath, communityAddress: community.address })
    };
}

// Not over RPC: drives a LocalCommunity in this process with fake kubo and pubsub clients (see the header)
describeSkipIfRpc("stop() while start() is in flight", () => {
    it("tears down what start() set up: the stopped community keeps no challenge subscription, start lock or publish loop", async () => {
        const { community, kuboFiles, subscribedTopics, isStartLocked } = await createOfflineCommunity();
        const challengeTopic = communityChallengePubsubTopic(community);
        expect(challengeTopic).to.be.a("string");

        // Hold start() at the kubo call that checks the postUpdates folder: it is in the started state and holds the lock,
        // and has not subscribed to challenge requests yet
        const startHeld = deferred();
        const releaseStart = deferred();
        const stat = kuboFiles.stat;
        kuboFiles.stat = async (path) => {
            startHeld.resolve();
            await releaseStart.promise;
            return stat(path);
        };

        const startPromise = community.start();
        await startHeld.promise;
        expect(community.state).to.equal("started");

        const stopPromise = community.stop();
        // Gives a stop() that does not wait for start() the time to finish its teardown (it takes a few ms here) before
        // start() resumes. A stop() that waits for start() waits whatever this delay is.
        await Promise.race([stopPromise, sleep(500)]);
        releaseStart.resolve();
        const [startResult, stopResult] = await Promise.allSettled([startPromise, stopPromise]);

        expect(stopResult.status).to.equal("fulfilled");
        expect(startResult.status).to.equal("fulfilled");
        expect(community.state).to.equal("stopped");
        expect(subscribedTopics()).to.not.include(challengeTopic);
        expect(await isStartLocked()).to.equal(false);
        expect(community._publishLoopPromise).to.equal(undefined);
    });

    it("waits for a start() that then fails, and leaves the teardown to the failed start(): it runs once", async () => {
        const { community, subscribedTopics, isStartLocked } = await createOfflineCommunity();
        const challengeTopic = communityChallengePubsubTopic(community);
        const { held, release } = failStartAfterItEnteredTheStartedState();
        const countUnlocks = countStartUnlocks(community);

        const startPromise = community.start();
        await held.promise;
        expect(community.state).to.equal("started");

        const stopPromise = community.stop();
        await Promise.race([stopPromise, sleep(500)]); // room for a stop() that does not wait for start()
        release.resolve();
        const [startResult, stopResult] = await Promise.allSettled([startPromise, stopPromise]);

        expect(startResult.status).to.equal("rejected");
        expect(((startResult as PromiseRejectedResult).reason as Error).message).to.equal(START_FAILURE);
        expect(stopResult.status).to.equal("fulfilled");
        expect(community.state).to.equal("stopped");
        expect(countUnlocks()).to.equal(1); // the failed start()'s own stop(); the stop() that waited found nothing to tear down
        expect(subscribedTopics()).to.not.include(challengeTopic);
        expect(await isStartLocked()).to.equal(false);
    });

    it("still waits for a start() that a 'stopped' listener begins during a failed start()'s teardown", async () => {
        const { community, kuboFiles, subscribedTopics, isStartLocked } = await createOfflineCommunity();
        const challengeTopic = communityChallengePubsubTopic(community);
        const { release: releaseFirstStart } = failStartAfterItEnteredTheStartedState();
        releaseFirstStart.resolve(); // the first start() fails as soon as it is in the started state

        let restart: Promise<void> | undefined;
        community.on("statechange", (state) => {
            if (state === "stopped" && !restart) restart = community.start();
        });
        // Hold the restart where the first test holds start(): started, locked, not subscribed yet
        const restartHeld = deferred();
        const releaseRestart = deferred();
        const stat = kuboFiles.stat;
        kuboFiles.stat = async (path) => {
            restartHeld.resolve();
            await releaseRestart.promise;
            return stat(path);
        };

        await expect(community.start()).rejects.toThrow(START_FAILURE);
        expect(restart).to.not.equal(undefined);
        await restartHeld.promise;
        expect(community.state).to.equal("started");

        const stopPromise = community.stop();
        await Promise.race([stopPromise, sleep(500)]); // room for a stop() that does not wait for the restart
        releaseRestart.resolve();
        const [restartResult, stopResult] = await Promise.allSettled([restart!, stopPromise]);

        expect(restartResult.status).to.equal("fulfilled");
        expect(stopResult.status).to.equal("fulfilled");
        expect(community.state).to.equal("stopped");
        expect(subscribedTopics()).to.not.include(challengeTopic);
        expect(await isStartLocked()).to.equal(false);
        expect(community._publishLoopPromise).to.equal(undefined);
    });

    it("that waits for a failing start() also stops the start() a 'stopped' listener begins during its teardown", async () => {
        const { community, subscribedTopics, isStartLocked } = await createOfflineCommunity();
        const challengeTopic = communityChallengePubsubTopic(community);
        const { held, release } = failStartAfterItEnteredTheStartedState();

        let restart: Promise<void> | undefined;
        community.on("statechange", (state) => {
            if (state === "stopped" && !restart) restart = community.start();
        });

        const startPromise = community.start();
        await held.promise;
        const stopPromise = community.stop(); // called before the restart, so it stops it too
        await Promise.race([stopPromise, sleep(500)]);
        release.resolve();
        const [startResult, stopResult] = await Promise.allSettled([startPromise, stopPromise]);

        expect(startResult.status).to.equal("rejected");
        expect(stopResult.status).to.equal("fulfilled");
        expect(restart).to.not.equal(undefined);
        await restart; // stop() waited for it, so it has settled
        expect(community.state).to.equal("stopped");
        expect(subscribedTopics()).to.not.include(challengeTopic);
        expect(await isStartLocked()).to.equal(false);
        expect(community._publishLoopPromise).to.equal(undefined);
    });
});

// Not over RPC: drives a LocalCommunity in this process with fake kubo and pubsub clients (see the header)
describeSkipIfRpc("start() while stop() is in flight", () => {
    it("is refused without touching the stop: stop() still finishes once the publish cycle it waits for ends", async () => {
        const { community } = await createOfflineCommunity();

        // Hold the first publish cycle open, so stop() is waiting for the publish loop when start() is called
        const cycleHeld = deferred();
        const releaseCycle = deferred();
        vi.mocked(syncIpnsWithDb).mockImplementationOnce(async () => {
            cycleHeld.resolve();
            await releaseCycle.promise;
        });
        await community.start();
        await cycleHeld.promise;

        const stopPromise = community.stop();
        let stopFinished = false;
        stopPromise.then(() => (stopFinished = true)).catch(() => {});
        try {
            await expect(community.start()).rejects.toMatchObject({ code: "ERR_COMMUNITY_ALREADY_STARTED" });
            releaseCycle.resolve();
            // The loop checks for a stop every 100ms; publishInterval here is 1s, so 3s is well past the next check
            await Promise.race([stopPromise, sleep(3000)]);
            expect(stopFinished).to.equal(true);
            expect(community.state).to.equal("stopped");
        } finally {
            releaseCycle.resolve();
            if (!stopFinished) await community.stop(); // sets the flag again, which releases the first stop() too
            await stopPromise;
        }
    });
});

// Not over RPC: drives a LocalCommunity in this process with fake kubo and pubsub clients (see the header)
describeSkipIfRpc("stop() while update() loads the community the first time", () => {
    it("leaves the stopped instance out of the updating registry", async () => {
        const { pkc, community } = await createOfflineCommunity();

        // Hold update()'s first updateOnce at its first DB read, before it decides to track or mirror
        const updateHeld = deferred();
        const releaseUpdate = deferred();
        const updateStartedValue = community._updateStartedValue.bind(community);
        let held = false;
        community._updateStartedValue = async () => {
            if (!held) {
                held = true;
                updateHeld.resolve();
                await releaseUpdate.promise;
            }
            return updateStartedValue();
        };

        const updatePromise = community.update();
        await updateHeld.promise;
        expect(community.state).to.equal("updating");

        const stopPromise = community.stop();
        // Same as above: room for a stop() that does not wait for update() to finish first
        await Promise.race([stopPromise, sleep(500)]);
        releaseUpdate.resolve();
        await Promise.all([updatePromise, stopPromise]);

        expect(community.state).to.equal("stopped");
        expect(findUpdatingCommunity(pkc, { publicKey: community.publicKey, name: community.name })).to.equal(undefined);
        expect(community._updateLoopPromise).to.equal(undefined);
        expect(community._mirroredStartedOrUpdatingCommunity).to.equal(undefined);
    });

    it("also when an 'updating' statechange listener calls stop() before update() has awaited anything", async () => {
        const { pkc, community } = await createOfflineCommunity();
        let stopPromise: Promise<void> | undefined;
        community.on("statechange", (state) => {
            if (state === "updating" && !stopPromise) stopPromise = community.stop();
        });

        await community.update();
        expect(stopPromise).to.not.equal(undefined);
        await stopPromise;

        expect(community.state).to.equal("stopped");
        expect(findUpdatingCommunity(pkc, { publicKey: community.publicKey, name: community.name })).to.equal(undefined);
        expect(community._updateLoopPromise).to.equal(undefined);
        expect(community._dbHandler._db?.open ?? false).to.equal(false);
    });
});

// Holds each start() at lockCommunityStart until both calls are there, or until one of them settled without reaching it
function holdLockUntilBothArrive(instances: LocalCommunity[], starts: () => Promise<unknown>[]) {
    let arrived = 0;
    const bothArrived = deferred();
    for (const instance of instances) {
        const lockCommunityStart = instance._dbHandler.lockCommunityStart.bind(instance._dbHandler);
        instance._dbHandler.lockCommunityStart = async (...args: Parameters<typeof lockCommunityStart>) => {
            if (++arrived === 2) bothArrived.resolve();
            await bothArrived.promise;
            return lockCommunityStart(...args);
        };
    }
    const promises = starts();
    for (const promise of promises) promise.then(bothArrived.resolve, bothArrived.resolve);
    return Promise.allSettled(promises);
}

// Not over RPC: drives a LocalCommunity in this process with fake kubo and pubsub clients (see the header)
describeSkipIfRpc("start() calls that race for the start lock", () => {
    it("two instances: the one that loses does not release the lock the winner holds", async () => {
        const { pkc, community, isStartLocked } = await createOfflineCommunity();
        const sameCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        sameCommunity.on("error", () => {});
        expect(sameCommunity).to.not.equal(community);
        await sameCommunity.initDbHandlerIfNeeded();

        const results = await holdLockUntilBothArrive([community, sameCommunity], () => [community.start(), sameCommunity.start()]);

        const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        expect(rejected.length).to.equal(1);
        expect((rejected[0].reason as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        const winner = results[0].status === "fulfilled" ? community : sameCommunity;
        const loser = winner === community ? sameCommunity : community;
        expect(winner.state).to.equal("started");
        expect(loser.state).to.equal("stopped");
        // initBeforeStarting() opened the loser's DB; a stopped community keeps no connection (an open one also blocks
        // deleting the file on Windows)
        expect(loser._dbHandler._db?.open ?? false).to.equal(false);
        expect(await isStartLocked()).to.equal(true);
        await winner._updateStartedValue();
        expect(winner.started).to.equal(true);
        await winner.stop();
    });

    it("one instance called twice: the second call does not tear down the first", async () => {
        const { community, isStartLocked } = await createOfflineCommunity();

        const results = await holdLockUntilBothArrive([community], () => [community.start(), community.start()]);

        expect(results.map((result) => result.status).sort()).to.deep.equal(["fulfilled", "rejected"]);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
        expect((rejected.reason as PKCError).code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        expect(community.state).to.equal("started");
        expect(await isStartLocked()).to.equal(true);
        expect(community._publishLoopPromise).to.not.equal(undefined);
        await community.stop();
    });
});
