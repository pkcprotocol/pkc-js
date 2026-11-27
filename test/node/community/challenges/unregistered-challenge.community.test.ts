import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockPKC, generateMockPost, publishWithExpectedResult, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { getCommunityChallengeFromCommunityChallengeSettings } from "../../../../dist/node/runtime/node/community/challenges/index.js";
import { syncChallengesWithRegistry } from "../../../../dist/node/runtime/node/community/local-community/registry-sync.js";
import { updateDbInternalState } from "../../../../dist/node/runtime/node/community/local-community/db-state.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { ChallengeFileFactoryInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type { ChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:unregistered-challenge" });

// Issue #428: a challenge package uninstalled from the registry (bitsocial-cli's `challenge uninstall` deletes its
// entry from PKC.challenges) while settings.challenges still names it. The owner and the publisher must be told which
// challenge is missing instead of a bare Zod error, and start() must refuse to bring the community online, before it
// touches the network, until the owner removes the entry or installs the package again. A community that is already
// running when the package is removed stays up and reports it.

const makeChallenge = (description: string): ChallengeFileFactoryInput =>
    (() => ({
        type: "text/plain",
        description,
        getChallenge: async () => ({ success: true })
    })) as unknown as ChallengeFileFactoryInput;

type LoadFailure = { challengeIndex: number; challengeName?: string; path?: string; error: PKCError };

// The registry lives in the process that owns the community, so an RPC client cannot uninstall a package from it, and
// planting a persisted `path` that edit() would reject means writing the internal DB state directly.
describeSkipIfRpc("unregistered challenge in settings.challenges (issue #428)", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeEach(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "my-challenge": makeChallenge("my challenge"), "other-challenge": makeChallenge("other challenge") };
        community = (await pkc.createCommunity({})) as LocalCommunity;
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await community.delete();
        await pkc.destroy();
    });

    it("loading an unregistered name throws ERR_CHALLENGE_NOT_REGISTERED naming the challenge", async () => {
        let thrown: unknown;
        try {
            await getCommunityChallengeFromCommunityChallengeSettings({
                communityChallengeSettings: { name: "not-installed" },
                pkc,
                log: testLog
            });
        } catch (e) {
            thrown = e;
        }
        expect(thrown, "loading should have thrown").to.exist;
        const error = thrown as PKCError;
        expect(error.code).to.equal("ERR_CHALLENGE_NOT_REGISTERED");
        expect(error.details.challengeName).to.equal("not-installed");
        // built-ins and the registered ones
        expect(error.details.availableChallengeNames).to.include.members(["my-challenge", "other-challenge", "question", "text-math"]);
    });

    it("start() throws ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD listing every unloadable entry, before touching the network", async () => {
        await community.edit({
            settings: {
                ...community.settings,
                challenges: [
                    { name: "my-challenge" },
                    { name: "question", options: { question: "q?", answer: "a" } },
                    { name: "other-challenge" }
                ]
            }
        });
        delete pkc.settings.challenges!["my-challenge"];
        delete pkc.settings.challenges!["other-challenge"];

        const fetchSpy = vi.spyOn(globalThis, "fetch");
        // a failed start must not run the running-community teardown either: it unsubscribes from pubsub and unpins
        const unsubscribeSpy = vi.spyOn(community._clientsManager, "pubsubUnsubscribe");
        const startedStates: string[] = [];
        community.on("startedstatechange", (state) => startedStates.push(state));
        const states: string[] = [];
        community.on("statechange", (state) => states.push(state));

        let thrown: unknown;
        try {
            await community.start();
        } catch (e) {
            thrown = e;
        }
        expect(thrown, "start() should have thrown").to.exist;
        const error = thrown as PKCError;
        expect(error.code).to.equal("ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD");
        expect(error.details.communityAddress).to.equal(community.address);
        expect(error.details.availableChallengeNames).to.include("question");
        expect(error.details.availableChallengeNames).to.not.include("my-challenge");
        const failures = error.details.failures as LoadFailure[];
        expect(failures.map((f) => [f.challengeIndex, f.challengeName, f.error.code])).to.deep.equal([
            [0, "my-challenge", "ERR_CHALLENGE_NOT_REGISTERED"],
            [2, "other-challenge", "ERR_CHALLENGE_NOT_REGISTERED"]
        ]);

        // nothing went online: no key import into kubo, no publishing state
        const kuboKeyImports = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/key/import"));
        expect(kuboKeyImports).to.have.length(0);
        expect(startedStates).to.not.include("publishing-ipns");
        expect(unsubscribeSpy).not.toHaveBeenCalled();
        expect(states).to.not.include("started");
        expect(community.started).to.be.false;
    });

    it("start() succeeds once the owner removes the entry", async () => {
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "my-challenge" }] } });
        delete pkc.settings.challenges!["my-challenge"];
        await expect(community.start()).rejects.toMatchObject({ code: "ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD" });

        await community.edit({ settings: { ...community.settings, challenges: [{ name: "other-challenge" }] } });
        await community.start();
        expect(community.started).to.be.true;
        expect(community.challenges?.map((c) => c.description)).to.deep.equal(["other challenge"]);
    });

    it("start() succeeds once the package is installed again", async () => {
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "my-challenge" }] } });
        delete pkc.settings.challenges!["my-challenge"];
        await expect(community.start()).rejects.toMatchObject({ code: "ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD" });

        pkc.settings.challenges!["my-challenge"] = makeChallenge("my challenge reinstalled");
        await community.start();
        expect(community.started).to.be.true;
        expect(community.challenges?.map((c) => c.description)).to.deep.equal(["my challenge reinstalled"]);
    });

    it("start() reports a persisted path that no longer imports as ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", async () => {
        const missingPath = "/nonexistent/issue-428/challenge.js";
        const challenges: CommunityChallengeSetting[] = [{ path: missingPath }];
        community.settings = { ...community.settings, challenges };
        community._usingDefaultChallenge = false;
        await updateDbInternalState(community, { settings: community.settings, _usingDefaultChallenge: false });

        let thrown: unknown;
        try {
            await community.start();
        } catch (e) {
            thrown = e;
        }
        expect((thrown as PKCError)?.code).to.equal("ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD");
        const failures = (thrown as PKCError).details.failures as LoadFailure[];
        expect(failures).to.have.length(1);
        expect(failures[0].challengeIndex).to.equal(0);
        expect(failures[0].path).to.equal(missingPath);
        expect(failures[0].error.code).to.equal("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY");
    });

    it("a running community keeps running, keeps its record and reports the removal once", async () => {
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "my-challenge" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const errors: PKCError[] = [];
        community.on("error", (e) => errors.push(e as PKCError));
        delete pkc.settings.challenges!["my-challenge"];

        await syncChallengesWithRegistry(community);
        await syncChallengesWithRegistry(community); // still missing: nothing new to report
        const loadErrors = errors.filter((e) => e.code === "ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD");
        expect(loadErrors).to.have.length(1);
        expect((loadErrors[0].details.failures as LoadFailure[])[0].challengeName).to.equal("my-challenge");

        expect(community.started).to.be.true;
        expect(community.challenges?.map((c) => c.description)).to.deep.equal(["my challenge"]);
    });

    it("a running community reports a different challenge failing at the same index", async () => {
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "my-challenge" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const errors: PKCError[] = [];
        community.on("error", (e) => errors.push(e as PKCError));
        delete pkc.settings.challenges!["my-challenge"];
        await syncChallengesWithRegistry(community);

        // the owner swaps in another package, which is then uninstalled before the next cycle succeeds
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "other-challenge" }] } });
        delete pkc.settings.challenges!["other-challenge"];
        await syncChallengesWithRegistry(community);

        const loadErrors = errors.filter((e) => e.code === "ERR_COMMUNITY_CHALLENGES_FAILED_TO_LOAD");
        expect(loadErrors.map((e) => (e.details.failures as LoadFailure[])[0].challengeName)).to.deep.equal([
            "my-challenge",
            "other-challenge"
        ]);
    });

    it("a publisher is told which challenge is not registered, and the owner gets the details", async () => {
        await community.edit({ settings: { ...community.settings, challenges: [{ name: "my-challenge" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const errors: PKCError[] = [];
        community.on("error", (e) => errors.push(e as PKCError));
        delete pkc.settings.challenges!["my-challenge"];

        const verificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            community.once("challengeverification", resolve)
        );
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: false });
        const verification = await verificationPromise;

        expect(verification.reason).to.include(`"my-challenge"`);
        expect(verification.reason).to.not.include("Invalid input");
        // the publisher never learns which packages the node has installed
        expect(verification.reason).to.not.include("other-challenge");

        const notRegistered = errors.find((e) => e.code === "ERR_CHALLENGE_NOT_REGISTERED");
        expect(notRegistered, `owner got no ERR_CHALLENGE_NOT_REGISTERED, got ${errors.map((e) => e.code)}`).to.exist;
        expect(notRegistered!.details.challengeName).to.equal("my-challenge");
        expect(notRegistered!.details.challengeIndex).to.equal(0);
        expect(notRegistered!.details.availableChallengeNames).to.include("other-challenge");
    });
});
