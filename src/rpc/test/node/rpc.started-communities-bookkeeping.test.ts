// PKCWsServer files every community it runs in _startedCommunities ("pending" while a start is in progress), and
// stopCommunity and the auto-start queue both go through that map:
//
// - The auto-start queue picks its communities once, then starts them one by one. One a client started while it waited
//   in the queue (or in a retry backoff) used to be overwritten with "pending", fail with
//   ERR_COMMUNITY_ALREADY_STARTED, and be deleted from the map while it kept running, so stopCommunity said it was not
//   running. A call waiting on a "pending" start that then failed got undefined: stopCommunity, deleteCommunity and
//   getCommunityPage threw a TypeError. editCommunity fell back to the stored community, as it does for one that is not
//   started, and deleteCommunity, getCommunityPage and auto-start now do the same. An auto-start that waited fetches
//   the pkc only afterwards, since a setSettings during the wait swaps it.
//
// No kubo is needed: start() and stop() of LocalCommunity are replaced by stand-ins that keep the started registry.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
    createInProcessRpcServer,
    pollUntil,
    uniqueTmpDataPath,
    type PKCWsServerType
} from "../../../../test/helpers/rpc-server-harness.js";
import { mockRpcServerPKC } from "../../../../dist/node/test/test-util.js";
import { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import {
    findStartedCommunity,
    trackStartedCommunity,
    untrackStartedCommunity
} from "../../../../dist/node/pkc/tracked-instance-registry-util.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";
import { BasePages } from "../../../../dist/node/pages/pages.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

interface ServerInternals {
    _startedCommunities: Record<string, "pending" | LocalCommunity>;
    _autoStartConcurrency: number;
    _autoStartPreviousCommunities: () => Promise<void>;
    _internalStartCommunity: (address: string) => Promise<LocalCommunity>;
    _waitForStartedCommunity: (args: { address: string }) => Promise<LocalCommunity | undefined>;
    _updateCommunityState: (address: string, update: { wasStarted?: boolean; wasExplicitlyStopped?: boolean }) => void;
    _retirePKCIfNeeded: (pkc: PKCType) => Promise<void>;
    _onSettingsChange: Record<string, Record<number, unknown>>;
}

interface Notification {
    subscription: number;
    event: string;
    result: { communities?: { publicKey: string }[] };
}

const internals = (rpcServer: PKCWsServerType) => rpcServer as unknown as ServerInternals;

// The CID of an empty UnixFS directory, as the page CID of a getCommunityPage whose fetch is stubbed
const emptyDirectoryCid = "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn";

// A start() that waits until the test releases it, so the test can act while a start is in progress
interface StartGate {
    enteredBy?: string;
    release: (error?: Error) => void;
    promise: Promise<void>;
}

describe("PKCWsServer bookkeeping of started communities", () => {
    let serverPKC: PKCType;
    let rpcServer: PKCWsServerType;
    let serverErrors: Error[];
    // Communities the stand-in start() is running
    let running: Set<LocalCommunity>;
    let nextStartGate: StartGate | undefined;

    const gateNextStart = (): StartGate => {
        let release!: StartGate["release"];
        const promise = new Promise<void>((resolve, reject) => (release = (error) => (error ? reject(error) : resolve())));
        nextStartGate = { release, promise };
        return nextStartGate;
    };

    // Like the connection handler, plus a socket that records what the server sends
    const openConnection = (connectionId: string): Notification[] => {
        const notifications: Notification[] = [];
        rpcServer.subscriptionCleanups[connectionId] = {};
        rpcServer.connections[connectionId] = {
            send: (json: string) => notifications.push((JSON.parse(json) as { params: Notification }).params)
        } as unknown as PKCWsServerType["connections"][string];
        internals(rpcServer)._onSettingsChange[connectionId] = {};
        return notifications;
    };

    const createCommunity = async (): Promise<string> => (await rpcServer.createCommunity([{}])).localCommunity.address;

    // A client's startCommunity whose start() is held until the test fails it, so the community stays "pending"
    const holdAClientStartThatWillFail = async (address: string) => {
        openConnection("client");
        const start = gateNextStart();
        const startCall = rpcServer.startCommunity([{ publicKey: address }], "client").then(
            (): undefined => undefined,
            (error: Error) => error
        );
        await pollUntil(() => start.enteredBy !== undefined, { intervalMs: 10 });
        expect(startedEntry(address)).to.equal("pending");
        return { startCall, failStart: () => start.release(new Error("injected start failure")) };
    };

    // A call reaches its wait on a "pending" entry within microtasks, so after one macrotask it is waiting
    const letPendingCallsReachTheirWait = () => new Promise<void>((resolve) => setImmediate(resolve));

    const startedEntry = (address: string) => internals(rpcServer)._startedCommunities[address];

    // What a client's setSettings sends: the current options over JSON, with one value changed
    const setSettingsWithNewPublishInterval = async () => {
        const { nameResolvers: _nameResolvers, ...pkcOptions } = JSON.parse(JSON.stringify(rpcServer.pkc.parsedPKCOptions)) as Record<
            string,
            unknown
        >;
        await rpcServer.setSettings([{ pkcOptions: { ...pkcOptions, publishInterval: Number(pkcOptions.publishInterval) + 1 } }]);
    };

    // setSettings retires the old pkc a minute later; this is that step
    const retirePKC = async (pkc: PKCType) => internals(rpcServer)._retirePKCIfNeeded(pkc);

    beforeEach(async () => {
        running = new Set();
        nextStartGate = undefined;
        // Installed before any community instance exists, since the constructors bind start and stop
        vi.spyOn(LocalCommunity.prototype, "start").mockImplementation(async function (this: LocalCommunity) {
            const gate = nextStartGate;
            nextStartGate = undefined;
            if (gate) {
                gate.enteredBy = this.address;
                await gate.promise;
            }
            // as lifecycle.ts start() does
            if (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }))
                throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });
            trackStartedCommunity(this._pkc, this);
            running.add(this);
        });
        vi.spyOn(LocalCommunity.prototype, "stop").mockImplementation(async function (this: LocalCommunity) {
            untrackStartedCommunity(this._pkc, this);
            running.delete(this);
        });

        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("rpc-started-communities"), httpRoutersOptions: [] });
        ({ rpcServer } = await createInProcessRpcServer({ serverPKC, authKey: "started-communities-bookkeeping" }));
        serverErrors = [];
        rpcServer.on("error", (error) => serverErrors.push(error));
    });

    afterEach(async () => {
        // Destroys the server's current pkc, which is serverPKC unless a test swapped it
        await rpcServer.destroy();
        if (!serverPKC.destroyed) await serverPKC.destroy();
        vi.restoreAllMocks();
    });

    // A start in progress is filed as "pending", and other calls for the same community wait for it to finish
    describe("calls waiting on a start that fails", () => {
        it("stopCommunity gets an error, not a TypeError", async () => {
            const address = await createCommunity();
            const { startCall, failStart } = await holdAClientStartThatWillFail(address);

            const stopCall = rpcServer.stopCommunity([{ publicKey: address }]).then(
                (): undefined => undefined,
                (error: Error) => error
            );
            await letPendingCallsReachTheirWait();
            failStart();

            expect((await startCall)?.message).to.equal("injected start failure");
            const stopError = await stopCall;
            expect(stopError, "stopCommunity must reject").to.be.instanceOf(Error);
            expect(stopError).to.not.be.instanceOf(TypeError);
            expect(stopError!.message).to.include("failed");
        });

        it("editCommunity edits the stored community, as it does for one that is not started", async () => {
            const address = await createCommunity();
            const { startCall, failStart } = await holdAClientStartThatWillFail(address);

            const editCall = rpcServer.editCommunity([{ publicKey: address, editOptions: { title: "edited while a start failed" } }]);
            await letPendingCallsReachTheirWait();
            failStart();

            expect((await startCall)?.message).to.equal("injected start failure");
            await editCall;
            const stored = (await rpcServer.pkc.createCommunity({ address })) as LocalCommunity;
            expect(stored.title, "the edit must be applied").to.equal("edited while a start failed");
        });

        it("deleteCommunity deletes the stored community, as it does for one that is not started", async () => {
            const deleted: string[] = [];
            vi.spyOn(LocalCommunity.prototype, "delete").mockImplementation(async function (this: LocalCommunity) {
                deleted.push(this.address);
            });
            const address = await createCommunity();
            const { startCall, failStart } = await holdAClientStartThatWillFail(address);

            const deleteCall = rpcServer.deleteCommunity([{ publicKey: address }]);
            await letPendingCallsReachTheirWait();
            failStart();

            expect((await startCall)?.message).to.equal("injected start failure");
            expect(await deleteCall).to.deep.equal({ success: true });
            expect(deleted).to.deep.equal([address]);
        });

        it("getCommunityPage fetches the page through a new instance, as it does for a community that is not started", async () => {
            const fetchedFrom: string[] = [];
            vi.spyOn(BasePages.prototype, "_fetchAndVerifyPage").mockImplementation(async function (this: BasePages) {
                fetchedFrom.push(this._community.publicKey);
                return { page: { comments: [] } } as unknown as Awaited<ReturnType<BasePages["_fetchAndVerifyPage"]>>;
            });
            const address = await createCommunity();
            const { startCall, failStart } = await holdAClientStartThatWillFail(address);

            const pageCall = rpcServer.getCommunityPage([
                { cid: emptyDirectoryCid, communityPublicKey: address, type: "posts", pageMaxSize: 1024 }
            ]);
            await letPendingCallsReachTheirWait();
            failStart();

            expect((await startCall)?.message).to.equal("injected start failure");
            expect((await pageCall).page).to.deep.equal({ comments: [] });
            expect(fetchedFrom).to.deep.equal([address]);
        });
    });

    describe("auto-start", () => {
        it("a community a client started while it waited in the auto-start queue stays filed, and stopCommunity stops it", async () => {
            const firstAddress = await createCommunity();
            const secondAddress = await createCommunity();
            for (const address of [firstAddress, secondAddress])
                internals(rpcServer)._updateCommunityState(address, { wasStarted: true, wasExplicitlyStopped: false });
            internals(rpcServer)._autoStartConcurrency = 1;

            // The queue starts one community at a time; hold the first so the other one waits behind it
            const firstStart = gateNextStart();
            const autoStart = internals(rpcServer)._autoStartPreviousCommunities();
            await pollUntil(() => firstStart.enteredBy !== undefined, { intervalMs: 10 });
            const queuedAddress = firstStart.enteredBy === firstAddress ? secondAddress : firstAddress;

            openConnection("client");
            await rpcServer.startCommunity([{ publicKey: queuedAddress }], "client");
            const startedByClient = startedEntry(queuedAddress);
            expect(startedByClient).to.be.instanceOf(LocalCommunity);

            firstStart.release();
            await autoStart;

            expect(serverErrors.map((error) => (error as PKCError).code)).to.not.include("ERR_COMMUNITY_ALREADY_STARTED");
            expect(startedEntry(queuedAddress), "the running community must stay filed under its address").to.equal(startedByClient);
            expect(await rpcServer.stopCommunity([{ publicKey: queuedAddress }])).to.deep.equal({ success: true });
            expect(running.has(startedByClient as LocalCommunity)).to.be.false;
        });

        it("an auto-start waiting on a client's start that fails starts the community itself", async () => {
            const address = await createCommunity();
            const { startCall, failStart } = await holdAClientStartThatWillFail(address);

            const autoStart = internals(rpcServer)._internalStartCommunity(address);
            await letPendingCallsReachTheirWait();
            failStart();

            expect((await startCall)?.message).to.equal("injected start failure");
            const community = await autoStart;
            expect(running.has(community), "auto-start must not give up on a start that was not its own").to.be.true;
            expect(startedEntry(address)).to.equal(community);
            expect(await rpcServer.stopCommunity([{ publicKey: address }])).to.deep.equal({ success: true });
            expect(running.has(community)).to.be.false;
        });

        it("an auto-start that waited across a setSettings starts the community on the new pkc", async () => {
            const address = await createCommunity();
            const { startCall, failStart } = await holdAClientStartThatWillFail(address);
            const oldPKC = rpcServer.pkc;

            // Hold the auto-start's wait for the client's start until setSettings is done, so it resumes after the swap
            const waitForStartedCommunity = internals(rpcServer)._waitForStartedCommunity.bind(rpcServer);
            let resumeAutoStart!: () => void;
            const autoStartResumes = new Promise<void>((resolve) => (resumeAutoStart = resolve));
            vi.spyOn(internals(rpcServer), "_waitForStartedCommunity").mockImplementationOnce(async (args) => {
                const startedCommunity = await waitForStartedCommunity(args);
                await autoStartResumes;
                return startedCommunity;
            });
            const autoStart = internals(rpcServer)._internalStartCommunity(address);
            await letPendingCallsReachTheirWait();

            const settingsCall = setSettingsWithNewPublishInterval();
            await pollUntil(() => rpcServer.pkc !== oldPKC, { intervalMs: 10 });
            failStart();
            expect((await startCall)?.message).to.equal("injected start failure");
            await settingsCall;

            resumeAutoStart();
            const community = await autoStart;
            expect(community._pkc, "the community must be started on the pkc setSettings switched to").to.equal(rpcServer.pkc);
            await retirePKC(oldPKC);
            expect(running.has(community), "the community must still run after the old pkc is destroyed").to.be.true;
            expect(startedEntry(address)).to.equal(community);
        });
    });
});
