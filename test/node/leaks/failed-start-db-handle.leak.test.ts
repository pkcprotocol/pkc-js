// Leak suite (#496): start() that fails before the started state (an unregistered challenge, #428) opened
// the db in initBeforeStarting and its catch calls stop(), which does nothing for a community that never started.
import { beforeAll, afterAll, it, expect } from "vitest";
import { mockPKC } from "../../../dist/node/test/test-util.js";
import { countOpenFdsOnPath } from "../../helpers/leak-detection.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeFileFactoryInput } from "../../../dist/node/community/types.js";

const INSTANCES = 5;
const dbIsOpen = (community: LocalCommunity) => (community._dbHandler as unknown as { _db?: unknown })._db !== undefined;

// Skipped under RPC: the db handle belongs to the LocalCommunity in the RPC server process
describeSkipIfRpc("leak: db handle after a start() that fails early", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = {
            "my-challenge": (() => ({
                type: "text/plain",
                description: "my challenge",
                getChallenge: async () => ({ success: true })
            })) as unknown as ChallengeFileFactoryInput
        };
        community = (await pkc.createCommunity({})) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "my-challenge" }] } });
        delete pkc.settings.challenges!["my-challenge"];
    });

    afterAll(async () => {
        await community?.delete();
        await pkc?.destroy();
    });

    it(`${INSTANCES} instances whose start() fails leave no db connection open`, async () => {
        const held: LocalCommunity[] = []; // kept referenced: the claim is that only GC closes the handle
        // Descriptors on the community's files (its DB, WAL and start lock sidecar), not the whole process's:
        // that count also saw the sockets of mockPKC()'s mock pubsub client, which is still connecting when
        // this starts, and reported one of them as a leak whenever the setup above was quick enough.
        const countDbFds = () => countOpenFdsOnPath(community.address); // undefined off Linux: the db handle checks below still run there
        const fdsBefore = countDbFds();
        let openBeforeStart = 0;
        let startsThatThrew = 0;
        let openAfterFailedStart = 0;
        for (let i = 0; i < INSTANCES; i++) {
            const instance = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
            instance.on("error", () => {});
            if (dbIsOpen(instance)) openBeforeStart++;
            try {
                await instance.start();
            } catch {
                startsThatThrew++;
            }
            if (dbIsOpen(instance)) openAfterFailedStart++;
            held.push(instance);
        }
        const result = {
            openBeforeStart,
            startsThatThrew,
            states: [...new Set(held.map((instance) => instance.state))],
            openAfterFailedStart,
            fdGrowth: fdsBefore === undefined ? 0 : countDbFds()! - fdsBefore
        };
        for (const instance of held) (instance._dbHandler as unknown as { destoryConnection: () => void }).destoryConnection();
        expect(result).toEqual({
            openBeforeStart: 0,
            startsThatThrew: INSTANCES,
            states: ["stopped"],
            openAfterFailedStart: 0,
            fdGrowth: 0
        });

        // the count does see a handle on the community's DB, so a zero above is a real zero
        if (fdsBefore !== undefined) {
            const dbHandler = held[0]._dbHandler as unknown as { initDbIfNeeded: () => Promise<void>; destoryConnection: () => void };
            await dbHandler.initDbIfNeeded();
            try {
                expect(countDbFds()).to.be.greaterThan(fdsBefore);
            } finally {
                dbHandler.destoryConnection();
            }
            expect(countDbFds()).to.equal(fdsBefore);
        }
    });
});
