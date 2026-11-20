import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import { isCommunitiesListChangeEvent } from "../../../dist/node/runtime/node/util.js";
import {
    getStartLockPath,
    isCommunityStartLockedSync,
    releaseStartLock,
    takeStartLock
} from "../../../dist/node/runtime/node/community/start-lock.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";

// Node-only: drives a real filesystem watcher on a directory on disk. It needs no PKC instance or community, only the
// pkc.dataPath and pkc.communities the filter reads, so it runs under every config.
//
// pkc.communities is refreshed on filesystem events in dataPath/communities, and `started` comes from each community's
// start lock (issue #455). The lock is a file lock on the community's sidecar (issue #561): taking it writes the sidecar
// and releasing it touches the sidecar's mtime, and nothing touches it in between. The lock this replaced refreshed its
// mtime every few seconds while held, and a refresh on each of those touches cost O(started × communities) sync work
// per PKC instance. Only an event that flips the community's `started` may trigger a refresh.
describe("isCommunitiesListChangeEvent with a held start lock", () => {
    const dataPath = path.join(process.cwd(), ".tmp", `communities-watch-events-${uuidv4()}`);
    const communitiesPath = path.join(dataPath, "communities");
    const communityAddress = "watch-events.bso";
    const dbPath = path.join(communitiesPath, communityAddress);
    const lockfilePath = getStartLockPath({ dataPath, communityAddress });
    const filenames: (string | null)[] = [];
    const listed: PKCCommunitiesEntry = {
        name: communityAddress,
        publicKey: "12D3KooWWatchEvents",
        address: communityAddress,
        started: false
    };
    const pkc = { dataPath, communities: [listed] } as unknown as PKC;
    let watcher: fs.FSWatcher;

    beforeAll(() => {
        fs.mkdirSync(communitiesPath, { recursive: true });
        new Database(dbPath).close();
        watcher = fs.watch(communitiesPath, (_eventType, filename) => filenames.push(filename));
    });

    afterAll(() => {
        watcher?.close();
        fs.rmSync(dataPath, { recursive: true, force: true });
    });

    it("counts the lock being taken and released, and a held lock sends no events in between", async () => {
        // Collects the start lock's events until `count` have arrived, not for a fixed time, so a slow watcher on a busy
        // runner only makes the test wait longer. The bound only turns a missing event into a failed assertion below
        const takeStartLockEvents = async ({ count, timeoutMs }: { count: number; timeoutMs: number }) => {
            const collected: (string | null)[] = [];
            const deadline = Date.now() + timeoutMs;
            // Reads what has arrived at least once, also with no time to wait
            for (;;) {
                collected.push(...filenames.splice(0).filter((filename) => filename === path.basename(lockfilePath)));
                if (collected.length >= count || Date.now() >= deadline) return collected;
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        };
        const countsAsChange = (events: (string | null)[]) => events.map((filename) => isCommunitiesListChangeEvent({ pkc, filename }));

        const db = new Database(dbPath);
        try {
            expect(takeStartLock({ db, dataPath, communityAddress })).to.equal(true);
            const takenEvents = await takeStartLockEvents({ count: 1, timeoutMs: 10_000 });
            expect(takenEvents.length).to.be.greaterThan(0);
            expect(countsAsChange(takenEvents)).to.include(true);
            listed.started = true; // what the refresh it triggers lists

            // Whatever is left of the events of taking the lock no longer counts, and a held lock sends none of its own
            await new Promise((resolve) => setTimeout(resolve, 2500));
            const heldEvents = await takeStartLockEvents({ count: 1, timeoutMs: 0 });
            expect(countsAsChange(heldEvents)).to.not.include(true);

            releaseStartLock({ db, dataPath, communityAddress });
        } finally {
            db.close();
        }
        const releasedEvents = await takeStartLockEvents({ count: 1, timeoutMs: 10_000 });
        expect(releasedEvents.length).to.be.greaterThan(0);
        expect(countsAsChange(releasedEvents)).to.include(true);
    });
});

// The filter runs inside the watcher callback, where a throw is an uncaught exception that can end the process. A start
// lock check that fails must not escape it. The failure here is a directory where the sidecar should be, which the check
// can read on no platform.
describe("isCommunitiesListChangeEvent when the start lock check fails", () => {
    const dataPath = path.join(process.cwd(), ".tmp", `communities-watch-events-check-fails-${uuidv4()}`);

    it("does not throw, and counts the event as a change so the refresh decides", () => {
        const communityAddress = "lock-check-fails.bso";
        const pkc = {
            dataPath,
            communities: [{ name: communityAddress, publicKey: "12D3KooWLockCheckFails", address: communityAddress, started: false }]
        } as unknown as PKC;
        const startLockPath = getStartLockPath({ dataPath, communityAddress });
        fs.mkdirSync(startLockPath, { recursive: true });
        let result: boolean | undefined;
        try {
            expect(() => isCommunityStartLockedSync({ dataPath, communityAddress })).to.throw(); // the check does fail
            expect(() => (result = isCommunitiesListChangeEvent({ pkc, filename: path.basename(startLockPath) }))).to.not.throw();
        } finally {
            fs.rmSync(dataPath, { recursive: true, force: true });
        }
        expect(result).to.equal(true);
    });

    it("counts an event without a filename as a change", () => {
        const pkc = { dataPath, communities: [] } as unknown as PKC;
        expect(isCommunitiesListChangeEvent({ pkc, filename: null })).to.equal(true);
    });
});
