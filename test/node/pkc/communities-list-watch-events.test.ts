import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import lockfile from "@pkcprotocol/proper-lock-file";
import { isCommunitiesListChangeEvent } from "../../../dist/node/runtime/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";

// Node-only: drives a real filesystem watcher on a directory on disk. It needs no PKC instance or community, only the
// pkc.dataPath and pkc.communities the filter reads, so it runs under every config.
//
// pkc.communities is refreshed on filesystem events in dataPath/communities, and `started` comes from each community's
// start lock (issue #455). proper-lockfile creates the lock on lock(), removes it on unlock(), and touches its mtime every
// few seconds while held, and the watcher reports the touch with the same event type as the other two ("rename" on
// Linux). A refresh stats every community's lock, so refreshing on each touch cost O(started × communities) sync work
// every few seconds per PKC instance, which on the Windows CI runner blocked the event loop long enough to time out
// gateway fetches. Only an event that flips the community's `started` may trigger a refresh.
describe("isCommunitiesListChangeEvent with a held start lock", () => {
    const dataPath = path.join(process.cwd(), ".tmp", `communities-watch-events-${uuidv4()}`);
    const communitiesPath = path.join(dataPath, "communities");
    const communityAddress = "watch-events.bso";
    const dbPath = path.join(communitiesPath, communityAddress);
    const lockfilePath = `${dbPath}.start.lock`;
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
        fs.writeFileSync(dbPath, "");
        watcher = fs.watch(communitiesPath, (_eventType, filename) => filenames.push(filename));
    });

    afterAll(() => {
        watcher?.close();
        fs.rmSync(dataPath, { recursive: true, force: true });
    });

    it("counts the lock being taken and released, not the lock's periodic touches", async () => {
        // Collects the start lock's events until `count` have arrived, not for a fixed time, so a slow watcher on a busy
        // runner only makes the test wait longer. The bound only turns a missing event into a failed assertion below
        const takeStartLockEvents = async ({ count, timeoutMs }: { count: number; timeoutMs: number }) => {
            const collected: (string | null)[] = [];
            const deadline = Date.now() + timeoutMs;
            while (collected.length < count && Date.now() < deadline) {
                collected.push(...filenames.splice(0).filter((filename) => filename === path.basename(lockfilePath)));
                if (collected.length < count) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return collected;
        };
        const countsAsChange = (events: (string | null)[]) => events.map((filename) => isCommunitiesListChangeEvent({ pkc, filename }));

        const release = await lockfile.lock(dbPath, { lockfilePath, update: 1000, stale: 2000, onCompromised: () => {} });
        const takenEvents = await takeStartLockEvents({ count: 1, timeoutMs: 10_000 });
        expect(takenEvents.length).to.be.greaterThan(0);
        expect(countsAsChange(takenEvents)).to.include(true);
        listed.started = true; // what the refresh it triggers lists

        // update is clamped to at least 1000ms, so two touches arrive about 2s after the lock is taken
        const touchEvents = await takeStartLockEvents({ count: 2, timeoutMs: 10_000 });
        expect(touchEvents.length).to.be.greaterThan(0); // the touches do reach the watcher
        expect(countsAsChange(touchEvents)).to.not.include(true);

        await release();
        const releasedEvents = await takeStartLockEvents({ count: 1, timeoutMs: 10_000 });
        expect(releasedEvents.length).to.be.greaterThan(0);
        expect(countsAsChange(releasedEvents)).to.include(true);
    });
});

// The filter runs inside the watcher callback, where a throw is an uncaught exception that can end the process. A start
// lock check that fails with anything but ENOENT (EACCES, EIO, ENOTDIR) must not escape it
describe("isCommunitiesListChangeEvent when the start lock check fails", () => {
    const parentFile = path.join(process.cwd(), ".tmp", `communities-watch-events-not-a-dir-${uuidv4()}`);

    beforeAll(() => {
        fs.mkdirSync(path.dirname(parentFile), { recursive: true });
        fs.writeFileSync(parentFile, ""); // a file where the dataPath's directory should be: stat fails with ENOTDIR
    });

    afterAll(() => {
        fs.rmSync(parentFile, { force: true });
    });

    it("does not throw, and counts the event as a change so the refresh decides", () => {
        const communityAddress = "lock-check-fails.bso";
        const pkc = {
            dataPath: path.join(parentFile, "data"),
            communities: [{ name: communityAddress, publicKey: "12D3KooWLockCheckFails", address: communityAddress, started: false }]
        } as unknown as PKC;
        let result: boolean | undefined;
        expect(() => (result = isCommunitiesListChangeEvent({ pkc, filename: `${communityAddress}.start.lock` }))).to.not.throw();
        expect(result).to.equal(true);
    });

    it("counts an event without a filename as a change", () => {
        const pkc = { dataPath: path.join(parentFile, "data"), communities: [] } as unknown as PKC;
        expect(isCommunitiesListChangeEvent({ pkc, filename: null })).to.equal(true);
    });
});
