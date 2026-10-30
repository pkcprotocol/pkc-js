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
        const takeStartLockEvents = () => filenames.splice(0).filter((filename) => filename === path.basename(lockfilePath));
        const countsAsChange = (events: (string | null)[]) => events.map((filename) => isCommunitiesListChangeEvent({ pkc, filename }));
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        // update is clamped to at least 1000ms, so 3.5s holds about 3 touches
        const release = await lockfile.lock(dbPath, { lockfilePath, update: 1000, stale: 2000, onCompromised: () => {} });
        await wait(300);
        const takenEvents = takeStartLockEvents();
        expect(takenEvents.length).to.be.greaterThan(0);
        expect(countsAsChange(takenEvents)).to.include(true);
        listed.started = true; // what the refresh it triggers lists

        await wait(3500);
        const touchEvents = takeStartLockEvents();
        expect(touchEvents.length).to.be.greaterThan(0); // the touches do reach the watcher
        expect(countsAsChange(touchEvents)).to.not.include(true);

        await release();
        await wait(300);
        const releasedEvents = takeStartLockEvents();
        expect(releasedEvents.length).to.be.greaterThan(0);
        expect(countsAsChange(releasedEvents)).to.include(true);
    });
});
