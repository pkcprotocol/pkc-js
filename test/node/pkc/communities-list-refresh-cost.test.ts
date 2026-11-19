import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";

// The start lock check is replaced by a set the tests control, and every call to it is counted: the cost under test is
// how many communities' locks a change makes the list look at, not how a lock is implemented.
// The watcher is replaced too, so the tests deliver filesystem events themselves.
const { lockedAddresses, lockChecks, watchCallbacks } = vi.hoisted(() => ({
    lockedAddresses: new Set<string>(),
    lockChecks: [] as string[],
    watchCallbacks: [] as ((eventType: string, filename: string | null) => void)[]
}));

vi.mock("../../../dist/node/runtime/node/community/start-lock.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        isCommunityStartLockedSync: ({ communityAddress }: { communityAddress: string }) => {
            lockChecks.push(communityAddress);
            return lockedAddresses.has(communityAddress);
        }
    };
});

vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const watch = (_path: string, _options: object, callback: (eventType: string, filename: string | null) => void) => {
        watchCallbacks.push(callback);
        return { close: (): void => undefined };
    };
    return { ...original, default: { ...original, watch }, watch };
});

import { monitorCommunitiesDirectory, refreshCommunitiesList } from "../../../dist/node/runtime/node/util.js";
import { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import { STORAGE_KEYS } from "../../../dist/node/constants.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";

// Node-only: real community DB files on disk. It needs no PKC instance, only what the communities list reads from one,
// so it runs under every config.
//
// A full refresh of pkc.communities reads the directory and checks the start lock of every community in it. That is
// the right thing when the set of communities may have changed. It used to run as well every time one community
// started or stopped, and every time a community's DB file was written to, which is every checkpoint of every started
// community. With N communities that is N lock checks per start and per DB write: a node starting 1,600 communities
// spent all of its main thread in the refresh (issue #576).
describe("pkc.communities: what a change costs with many communities", () => {
    const dataPath = path.join(process.cwd(), ".tmp", `communities-list-refresh-cost-${uuidv4()}`);
    const communitiesPath = path.join(dataPath, "communities");
    const communityCount = 30;
    const addresses = Array.from({ length: communityCount }, (_, i) => `refresh-cost-${String(i).padStart(2, "0")}.bso`);
    const internalStateKey = `keyv:${STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]}`;

    const createCommunityDb = (address: string) => {
        const db = new Database(path.join(communitiesPath, address));
        db.exec("CREATE TABLE keyv(key VARCHAR(255) PRIMARY KEY, value TEXT)");
        db.prepare("INSERT INTO keyv (key, value) VALUES (?, ?)").run(
            internalStateKey,
            JSON.stringify({ value: { signer: { address: `12D3KooW${address}` } } })
        );
        db.close();
    };

    const createFakePkc = () => {
        const emitted: PKCCommunitiesEntry[][] = [];
        const pkc = {
            dataPath,
            communities: [] as PKCCommunitiesEntry[],
            emit: (_eventName: string, { communities }: { communities: PKCCommunitiesEntry[] }) => {
                pkc.communities = communities;
                emitted.push(communities);
                return true;
            }
        };
        return { pkc: pkc as unknown as PKC, emitted };
    };

    // What start() and stop() run once the lock is taken or released: the real method, on an object with only what it reads
    const updateStartedValueOf = async ({ pkc, address, started }: { pkc: PKC; address: string; started: boolean }) => {
        const community: LocalCommunity = Object.create(LocalCommunity.prototype);
        Object.assign(community, { address, _pkc: pkc, _dbHandler: { isCommunityStartLocked: async () => started } });
        await community._updateStartedValue();
        return community;
    };

    const startedAddresses = (pkc: PKC) => pkc.communities.filter((entry) => entry.started).map((entry) => entry.address);

    beforeAll(() => {
        fs.mkdirSync(communitiesPath, { recursive: true });
        for (const address of addresses) createCommunityDb(address);
    });

    beforeEach(() => {
        lockedAddresses.clear();
        lockChecks.length = 0;
        watchCallbacks.length = 0;
    });

    afterAll(() => {
        fs.rmSync(dataPath, { recursive: true, force: true });
    });

    it("a community that starts or stops is marked in the list without checking any other community's lock", async () => {
        const { pkc, emitted } = createFakePkc();
        refreshCommunitiesList(pkc);
        expect(pkc.communities.length).to.equal(communityCount);
        expect(startedAddresses(pkc)).to.deep.equal([]);
        lockChecks.length = 0;
        emitted.length = 0;

        lockedAddresses.add(addresses[7]);
        const community = await updateStartedValueOf({ pkc, address: addresses[7], started: true });
        expect(community.started).to.equal(true);
        expect(startedAddresses(pkc)).to.deep.equal([addresses[7]]);
        expect(emitted.length).to.equal(1);
        expect(lockChecks.filter((address) => address !== addresses[7])).to.deep.equal([]);

        lockedAddresses.delete(addresses[7]);
        await updateStartedValueOf({ pkc, address: addresses[7], started: false });
        expect(startedAddresses(pkc)).to.deep.equal([]);
        expect(emitted.length).to.equal(2);
        expect(lockChecks.filter((address) => address !== addresses[7])).to.deep.equal([]);
    });

    it("marking a community whose `started` is already listed emits nothing", async () => {
        const { pkc, emitted } = createFakePkc();
        lockedAddresses.add(addresses[3]);
        refreshCommunitiesList(pkc);
        expect(startedAddresses(pkc)).to.deep.equal([addresses[3]]);
        emitted.length = 0;

        await updateStartedValueOf({ pkc, address: addresses[3], started: true });
        expect(emitted.length).to.equal(0);
    });

    it("a community that is not listed yet is found by a full refresh when it starts", async () => {
        const { pkc } = createFakePkc();
        refreshCommunitiesList(pkc);
        const newAddress = "refresh-cost-new.bso";
        createCommunityDb(newAddress);
        try {
            lockedAddresses.add(newAddress);
            await updateStartedValueOf({ pkc, address: newAddress, started: true });
            expect(pkc.communities.length).to.equal(communityCount + 1);
            expect(startedAddresses(pkc)).to.deep.equal([newAddress]);
        } finally {
            fs.rmSync(path.join(communitiesPath, newAddress), { force: true });
        }
    });

    it("a write to a listed community's DB file does not refresh the list", async () => {
        const { pkc, emitted } = createFakePkc();
        await monitorCommunitiesDirectory(pkc);
        expect(watchCallbacks.length).to.equal(1);
        expect(pkc.communities.length).to.equal(communityCount);
        lockChecks.length = 0;
        emitted.length = 0;

        for (let i = 0; i < 10; i++) watchCallbacks[0]("change", addresses[i]);
        expect(lockChecks).to.deep.equal([]);
        expect(emitted.length).to.equal(0);
    });

    it("a file that appears or disappears still refreshes the list, and so does a write to a file that is not listed", async () => {
        const { pkc } = createFakePkc();
        await monitorCommunitiesDirectory(pkc);
        const newAddress = "refresh-cost-appears.bso";
        try {
            // an event with no filename, as some platforms send
            lockChecks.length = 0;
            watchCallbacks[0]("change", null);
            expect(lockChecks.length).to.equal(communityCount);

            // created without its internal state: listed only once a later write adds it
            const db = new Database(path.join(communitiesPath, newAddress));
            db.exec("CREATE TABLE keyv(key VARCHAR(255) PRIMARY KEY, value TEXT)");
            watchCallbacks[0]("rename", newAddress);
            expect(pkc.communities.length).to.equal(communityCount);

            db.prepare("INSERT INTO keyv (key, value) VALUES (?, ?)").run(
                internalStateKey,
                JSON.stringify({ value: { signer: { address: "12D3KooWAppears" } } })
            );
            db.close();
            watchCallbacks[0]("change", newAddress);
            expect(pkc.communities.map((entry) => entry.address)).to.include(newAddress);

            fs.rmSync(path.join(communitiesPath, newAddress), { force: true });
            watchCallbacks[0]("rename", newAddress);
            expect(pkc.communities.length).to.equal(communityCount);
            expect(pkc.communities.map((entry) => entry.address)).to.not.include(newAddress);
        } finally {
            fs.rmSync(path.join(communitiesPath, newAddress), { force: true });
        }
    });
});
