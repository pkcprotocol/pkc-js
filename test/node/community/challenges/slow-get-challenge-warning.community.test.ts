// Issue #362: a community logs an error when a getChallenge() call runs long.
//
// An automatic challenge sends nothing until the final verification, so every second it spends is
// silence to the publisher, who gives up about two minutes after its last request. The owner of a
// community whose challenge is that slow has no other signal: the publication is accepted on their
// side and looks failed on the author's. See "Time budget" in docs/protocol/challenge-authoring.md.
//
// The contract asserted here: the warning is logged while the call is still running (so a challenge
// that never returns is reported too), the duration is logged once it returns, the call is not
// aborted, and a challenge that finishes inside the threshold logs nothing.
//
// Log lines are captured with the shared-`debug`-sink idiom of
// test/node/helia/destroy-late-logs.helia.test.ts.

import { mockPKC, generateMockPost, publishWithExpectedResult, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, beforeEach, afterEach, afterAll, expect } from "vitest";
import { createRequire } from "node:module";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeFileInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";

interface DebugModule {
    log: (...args: unknown[]) => void;
    enable: (namespaces: string) => void;
    disable: () => string;
}

// `debug` ships no typings and is CJS; createRequire hands back the same cached instance that
// @pkcprotocol/pkc-logger (and therefore dist/) logs through.
const debugModule: DebugModule = createRequire(import.meta.url)("debug");

// Issue #493: callGetChallenge() logs through the community's own logger, so its lines are told apart
// from the rest of the community's output by the mechanical `callGetChallenge: ` prefix, not a namespace.
const CAPTURED_NAMESPACES = "pkc-js:local-community*";
const CAPTURED_PREFIX = "callGetChallenge: ";

function captureDebugOutput(namespaces: string): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const previousLog = debugModule.log;
    const previousNamespaces = debugModule.disable();
    debugModule.enable(namespaces);
    debugModule.log = (...args: unknown[]) => {
        const line = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
        if (line.includes(CAPTURED_PREFIX)) lines.push(line);
    };
    return {
        lines,
        restore: () => {
            debugModule.log = previousLog;
            debugModule.enable(previousNamespaces);
        }
    };
}

type Gate = { waitForRelease: Promise<void>; release: () => void };
const makeGate = (): Gate => {
    let release!: () => void;
    const waitForRelease = new Promise<void>((resolve) => (release = resolve));
    return { waitForRelease, release };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
};

const SLOW_WARNING_MS = 500;
const STILL_RUNNING = "is still running after";
const TOOK = /took \d+s/;

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges, sets a
// private field on the LocalCommunity, and captures the debug output of the process that runs the
// challenge. Under RPC the community lives in the server process.
describeSkipIfRpc("slow getChallenge() warning (#362)", () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let verdictGate: Gate;
    let getChallengeCalls = 0;
    let captured: { lines: string[]; restore: () => void };

    const gatedAutomaticChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => ({
        type: "text/plain",
        description: "Automatic: returns its verdict when the test says so",
        getChallenge: async () => {
            getChallengeCalls += 1;
            await verdictGate.waitForRelease;
            return { success: true };
        }
    });

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "gated-automatic": gatedAutomaticChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { challenges: [{ name: "gated-automatic" }] } });
        community._slowGetChallengeWarningMs = SLOW_WARNING_MS;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    beforeEach(() => {
        verdictGate = makeGate();
        getChallengeCalls = 0;
        captured = captureDebugOutput(CAPTURED_NAMESPACES);
    });

    afterEach(() => {
        verdictGate.release();
        captured.restore();
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("logs while getChallenge() is still running past the threshold, logs its duration when it returns, and does not abort it", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        const published = publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

        await waitFor(() => getChallengeCalls >= 1);
        expect(captured.lines, "nothing is logged before the threshold").to.deep.equal([]);

        // The verdict is still held: the warning must not wait for the call to return.
        await waitFor(() => captured.lines.some((line) => line.includes(STILL_RUNNING)));
        const stillRunningLines = captured.lines.filter((line) => line.includes(STILL_RUNNING));
        expect(stillRunningLines.length).to.equal(1);
        expect(stillRunningLines[0]).to.include("gated-automatic");
        expect(stillRunningLines[0]).to.include(community.address);
        expect(
            captured.lines.some((line) => TOOK.test(line)),
            "the duration is only known once the call returns"
        ).to.be.false;

        // The slow call was not aborted: releasing it lets the publication through.
        verdictGate.release();
        await published;
        expect(post.cid).to.be.a("string");

        const tookLines = captured.lines.filter((line) => TOOK.test(line));
        expect(tookLines.length).to.equal(1);
        expect(tookLines[0]).to.include("gated-automatic");
        expect(captured.lines.filter((line) => line.includes(STILL_RUNNING)).length, "the warning is logged once per call").to.equal(1);
    });

    it("logs nothing for a getChallenge() that returns inside the threshold", async () => {
        verdictGate.release();
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        expect(getChallengeCalls).to.equal(1);

        // Outlast the threshold: a timer left armed after the call returned would fire here.
        await new Promise((resolve) => setTimeout(resolve, SLOW_WARNING_MS * 2));
        expect(captured.lines).to.deep.equal([]);
    });
});
