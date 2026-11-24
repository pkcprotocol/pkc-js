import {
    getPendingChallengesOrChallengeVerification,
    getChallengeVerification
} from "../../dist/node/runtime/node/community/challenges/index.js";
import type { GetChallengeAnswers } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import { PKC } from "./fixtures/fixtures.ts";

// Reproduces the politically-incorrect.bso scenario, where TWO challenges are interactive iframes:
// the spam-blocker (C2) and the flags challenge (C5, https://github.com/bitsocialnet/flags-challenge).
//
// The flags challenge only presents an iframe when the author has *selected* a flag (otherwise its
// getChallenge() returns { success: true } and nothing is shown). The mock below always returns a
// pending iframe, simulating a post that carries a flag selection.
//
// Owner's intent: a non-mod author who selected a flag must verify it, AND must solve the spam-blocker.
// The protocol has a single interactive round (docs/protocol/challenge-flow.md), so BOTH iframes have
// to appear together in the one ChallengeMessage, and the comment must only publish once both are solved.
//
// Why both iframes appear together (and why these tests are green): the orchestrator defers every
// remaining undecided challenge the moment any challenge goes pending (the hasPending branch of
// getPendingChallengesOrChallengeVerification in src/runtime/node/community/challenges/index.ts). So
// whether both iframes surface depends entirely on them becoming "ready" in the SAME orchestrator round.
// The production flags exclude rule { challenges: [0, 1] } (skip flags only if BOTH publication-match and
// whitelist succeeded) is what makes that happen: it holds the flags challenge back until C0 and C1 are
// decided. For a regular author both fail, and on that same round the spam-blocker (whose own excludes
// also depend on C0 and C1) becomes ready too, so both flip to pending together before the defer branch
// can fire. The expensive AI moderation (C3/C4) stays deferred behind them.
//
// An earlier version of this file dropped that { challenges: [0, 1] } rule, which made flags ready in the
// first round and pending alone; the orchestrator then deferred the spam-blocker and silently ignored it
// at verify time, so only one of the two iframes was ever shown and these tests failed. Restoring the
// production exclude (see FLAGS_EXCLUDE below) synchronizes the two iframes, which is the behaviour these
// tests now assert as passing.

type ChallengeVerificationResult = Awaited<ReturnType<typeof getPendingChallengesOrChallengeVerification>>;

const getRandomAddress = () => String(Math.random());

let spamBlockerGet = 0;
let spamBlockerVerify = 0;
let flagsGet = 0;
let flagsVerify = 0;
let aiAllowGet = 0;
let aiReviewGet = 0;
// Per-test knobs (mirroring the existing counter pattern). `spamBlockerShouldFail` lets a test make
// the spam-blocker iframe fail at verify time. `aiVerdict` drives BOTH AI factories from a single
// value, mirroring @bitsocial/ai-moderation-challenge: one AI call yields "allow" | "review", and the
// allow/review branch entries succeed only when their branch matches the verdict.
let spamBlockerShouldFail = false;
let aiVerdict: "allow" | "review" = "allow";
const reset = () => {
    spamBlockerGet = 0;
    spamBlockerVerify = 0;
    flagsGet = 0;
    flagsVerify = 0;
    aiAllowGet = 0;
    aiReviewGet = 0;
    spamBlockerShouldFail = false;
    aiVerdict = "allow";
};

// C2: spam-blocker — pending iframe that verifies successfully once solved.
const spamBlockerFactory = () => ({
    type: "url/iframe" as const,
    getChallenge: async () => {
        spamBlockerGet++;
        return {
            challenge: "https://spamblocker.example.com/verify",
            type: "url/iframe" as const,
            verify: async () => {
                spamBlockerVerify++;
                if (spamBlockerShouldFail) return { success: false as const, error: "spam blocker failed" };
                return { success: true as const };
            }
        };
    }
});

// C5: flags — pending iframe (simulates a flag having been selected), verifies successfully once solved.
const flagsFactory = () => ({
    type: "url/iframe" as const,
    getChallenge: async () => {
        flagsGet++;
        return {
            challenge: "https://flags.example.com/verify",
            type: "url/iframe" as const,
            verify: async () => {
                flagsVerify++;
                return { success: true as const, comment: { "5chan": { flag: { type: "pol", code: "AN" } } } };
            }
        };
    }
});

// C3/C4: AI moderation — immediate results, expensive (must stay deferred behind the iframes, per issue #81).
const aiAllowFactory = () => ({
    type: "text/plain" as const,
    getChallenge: async () => {
        aiAllowGet++;
        return aiVerdict === "allow" ? { success: true as const } : { success: false as const, error: "not allow" };
    }
});
const aiReviewFactory = () => ({
    type: "text/plain" as const,
    getChallenge: async () => {
        aiReviewGet++;
        return aiVerdict === "review" ? { success: true as const } : { success: false as const, error: "needs review" };
    }
});

const makePkc = () => {
    const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
    pkc.settings = {
        challenges: {
            "mock-spam-blocker": spamBlockerFactory,
            "mock-flags": flagsFactory,
            "mock-ai-allow": aiAllowFactory,
            "mock-ai-review": aiReviewFactory
        }
    };
    return pkc;
};

// C0-C4 mirror the production politically-incorrect.bso config (publication-match, whitelist,
// spam-blocker, ai-moderation allow, ai-moderation review).
// if user has .bso, they can post immedietly without AI review, but they still need to run the flags challenge
// if user is mod/admin/owner, they dont need to run any challenge including flags
// if a user is whitelisted, they only need to run the flags challenge
// if regular user solves spam blocker (iframe url challenge), then mock-ai-review will decide if it goes to pending approval or not. After solving the spam blocker user should also get iframe url of flags challenge
// if user fails spam blocker, then it wont go to AI review (cause of the token cost)
const C0_THROUGH_C4 = [
    {
        name: "publication-match",
        options: {
            matches: '[{"propertyName":"author.name","regexp":"\\\\.(bso)$"}]',
            error: "Posting requires a name ending with .bso"
        },
        exclude: [{ role: ["moderator", "admin", "owner"] }, { challenges: [1] }, { challenges: [2] }]
    },
    {
        name: "whitelist",
        options: { addresses: "whitelisted-author.bso" },
        exclude: [{ role: ["moderator", "admin", "owner"] }, { challenges: [0] }, { challenges: [2] }]
    },
    {
        name: "mock-spam-blocker",
        exclude: [{ challenges: [0] }, { challenges: [1] }, { role: ["owner", "admin", "moderator"] }]
    },
    {
        name: "mock-ai-allow",
        exclude: [{ challenges: [0] }, { challenges: [1] }, { challenges: [4] }, { role: ["owner", "admin", "moderator"] }]
    },
    {
        name: "mock-ai-review",
        exclude: [{ challenges: [0] }, { challenges: [1] }, { challenges: [3] }, { role: ["owner", "admin", "moderator"] }],
        pendingApproval: true
    }
];

// Flags config matching production politically-incorrect.bso: runs for everyone except mods, and is
// skipped only when BOTH publication-match (0) and whitelist (1) succeeded. The { challenges: [0, 1] }
// rule is load-bearing: it delays the flags challenge's readiness until C0 and C1 are decided, which
// lines it up with the spam-blocker so both iframes surface in the same ChallengeMessage. Dropping it
// makes flags ready first and pending alone, and the spam-blocker then gets deferred and silently dropped.
const FLAGS_EXCLUDE = [
    { role: ["owner", "admin", "moderator"] },
    { publicationType: { commentModeration: true, communityEdit: true } },
    { challenges: [0, 1] }
];

const buildCommunity = (roles?: Record<string, { role: string }>) =>
    ({
        roles,
        settings: { challenges: [...C0_THROUGH_C4, { name: "mock-flags", exclude: FLAGS_EXCLUDE }] },
        _pkc: makePkc()
    }) as unknown as LocalCommunity;

// A regular author: no `.bso` name and not whitelisted, so C0 and C1 fail and the two iframe challenges
// (spam-blocker + flags) are the ones that must be presented.
const regularRequest = () =>
    ({
        comment: { author: { address: getRandomAddress(), name: "no-bso-name" } }
    }) as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

// A `.bso` author: passes C0 (publication-match on author.name), which excludes C1-C4 via
// `{ challenges: [0] }`, leaving only the flags challenge.
const bsoRequest = () =>
    ({
        comment: { author: { address: getRandomAddress(), name: "alice.bso" } }
    }) as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

// A whitelisted author: address matches C1's `addresses` option. C1 passing excludes C0's failure and
// C2-C4, leaving only the flags challenge.
const whitelistedRequest = () =>
    ({
        comment: { author: { address: "whitelisted-author.bso", name: "no-bso-name" } }
    }) as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

// A request from an author with a fixed address so it can be matched against community.roles.
const roleRequest = (address: string) =>
    ({
        comment: { author: { address, name: "no-bso-name" } }
    }) as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const answerEverything: GetChallengeAnswers = async (challenges) => challenges.map(() => "any-answer");

describe("flags + spam-blocker: two interactive iframe challenges must share one ChallengeMessage", () => {
    it("presents BOTH the spam-blocker and the flags iframe in a single ChallengeMessage", async () => {
        reset();
        const community = buildCommunity();
        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
            pendingChallenges?: { index: number; challenge: string }[];
        };

        // Both interactive challenges (C2 spam-blocker and C5 flags) appear in the one round.
        expect(result.pendingChallenges?.map((p) => p.index).sort((a, b) => a - b)).to.deep.equal([2, 5]);
        const urls = result.pendingChallenges?.map((p) => p.challenge).sort();
        expect(urls).to.deep.equal(["https://flags.example.com/verify", "https://spamblocker.example.com/verify"]);
    });

    it("the ChallengeMessage payload carries BOTH challenges (not just getChallenge being called)", async () => {
        reset();
        const community = buildCommunity();

        // The `challenges` array handed to getChallengeAnswers is exactly what publishChallenges() puts
        // into `DecryptedChallenge.challenges` — i.e. the encrypted payload of the ChallengeMessage wire
        // message (src/runtime/node/community/local-community/challenges.ts). Capture it and assert on its
        // shape so we test the message the author actually receives, not merely the getChallenge() calls.
        let challengeMessagePayload: Omit<{ challenge: string; type: string }, never>[] | undefined;
        const captureChallengeAnswers: GetChallengeAnswers = async (challenges) => {
            challengeMessagePayload = challenges as { challenge: string; type: string }[];
            return challenges.map(() => "any-answer");
        };

        await getChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community,
            getChallengeAnswers: captureChallengeAnswers
        });

        expect(challengeMessagePayload, "ChallengeMessage was never published").to.not.equal(undefined);
        // Exactly two challenges in the single ChallengeMessage.
        expect(challengeMessagePayload).to.have.lengthOf(2);
        // Both are iframe challenges carrying their URL, and verify functions are stripped from the wire.
        for (const challenge of challengeMessagePayload!) {
            expect(challenge.type).to.equal("url/iframe");
            expect(challenge).to.not.have.property("verify");
            expect(challenge).to.not.have.property("index");
        }
        expect(challengeMessagePayload!.map((c) => c.challenge).sort()).to.deep.equal([
            "https://flags.example.com/verify",
            "https://spamblocker.example.com/verify"
        ]);
    });

    it("verifies BOTH iframes — neither is silently dropped — and only then publishes", async () => {
        reset();
        const community = buildCommunity();
        const result = await getChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community,
            getChallengeAnswers: answerEverything
        });

        expect(result.challengeSuccess).to.equal(true);
        // Both iframes were shown and both verify() ran — neither was dropped.
        expect(spamBlockerGet).to.equal(1);
        expect(spamBlockerVerify).to.equal(1);
        expect(flagsGet).to.equal(1);
        expect(flagsVerify).to.equal(1);
        // The flag assertion the flags challenge returned must survive into the aggregated comment.
        expect((result as { aggregatedComment?: Record<string, unknown> }).aggregatedComment).to.have.property("5chan");
    });

    it("keeps expensive AI moderation deferred behind the iframes (issue #81 must not regress)", async () => {
        reset();
        const community = buildCommunity();
        // At request time, before either iframe is solved, AI moderation must not have run.
        const pending = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community
        })) as ChallengeVerificationResult;
        expect("pendingChallenges" in pending).to.equal(true);
        expect(aiAllowGet).to.equal(0);
        expect(aiReviewGet).to.equal(0);
    });
});

// The same C0-C5 config, exercised across every user type the comment block above describes. These
// assert the OWNER'S INTENT (the comment), not whatever the current orchestrator happens to do.
describe("politically-incorrect.bso config: per-user-type scenarios", () => {
    it("mods/admins/owners run NO challenges at all (not even flags)", async () => {
        for (const role of ["owner", "admin", "moderator"]) {
            reset();
            const address = getRandomAddress();
            const result = await getChallengeVerification({
                challengeRequestMessage: roleRequest(address),
                community: buildCommunity({ [address]: { role } }),
                getChallengeAnswers: answerEverything
            });
            expect(result.challengeSuccess, `role ${role}`).to.equal(true);
            expect(spamBlockerGet, `role ${role}`).to.equal(0);
            expect(flagsGet, `role ${role}`).to.equal(0);
            expect(aiAllowGet, `role ${role}`).to.equal(0);
            expect(aiReviewGet, `role ${role}`).to.equal(0);
        }
    });

    it(".bso authors skip the spam-blocker and AI moderation, but still run the flags challenge", async () => {
        reset();
        const pending = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: bsoRequest(),
            community: buildCommunity()
        })) as ChallengeVerificationResult & { pendingChallenges?: { index: number; challenge: string }[] };
        // Only the flags challenge is presented.
        expect(pending.pendingChallenges?.map((p) => p.index)).to.deep.equal([5]);
        expect(pending.pendingChallenges?.[0].challenge).to.equal("https://flags.example.com/verify");
        expect(spamBlockerGet).to.equal(0);
        expect(aiAllowGet).to.equal(0);
        expect(aiReviewGet).to.equal(0);

        // And solving it publishes the comment (with the flag assertion carried through).
        reset();
        const result = await getChallengeVerification({
            challengeRequestMessage: bsoRequest(),
            community: buildCommunity(),
            getChallengeAnswers: answerEverything
        });
        expect(result.challengeSuccess).to.equal(true);
        expect(flagsVerify).to.equal(1);
        expect((result as { aggregatedComment?: Record<string, unknown> }).aggregatedComment).to.have.property("5chan");
    });

    it("whitelisted authors skip the spam-blocker and AI moderation, but still run the flags challenge", async () => {
        reset();
        const pending = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: whitelistedRequest(),
            community: buildCommunity()
        })) as ChallengeVerificationResult & { pendingChallenges?: { index: number; challenge: string }[] };
        expect(pending.pendingChallenges?.map((p) => p.index)).to.deep.equal([5]);
        expect(pending.pendingChallenges?.[0].challenge).to.equal("https://flags.example.com/verify");
        expect(spamBlockerGet).to.equal(0);
        expect(aiAllowGet).to.equal(0);
        expect(aiReviewGet).to.equal(0);

        reset();
        const result = await getChallengeVerification({
            challengeRequestMessage: whitelistedRequest(),
            community: buildCommunity(),
            getChallengeAnswers: answerEverything
        });
        expect(result.challengeSuccess).to.equal(true);
        expect(flagsVerify).to.equal(1);
        expect((result as { aggregatedComment?: Record<string, unknown> }).aggregatedComment).to.have.property("5chan");
    });

    it("regular author whose content the AI allows publishes normally (no pending approval)", async () => {
        reset();
        aiVerdict = "allow";
        const result = await getChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community: buildCommunity(),
            getChallengeAnswers: answerEverything
        });
        expect(result.challengeSuccess).to.equal(true);
        expect(result.pendingApproval).to.not.equal(true);
        expect(aiAllowGet).to.equal(1);
    });

    it("regular author whose content the AI flags for review goes to pending approval", async () => {
        reset();
        aiVerdict = "review";
        const result = await getChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community: buildCommunity(),
            getChallengeAnswers: answerEverything
        });
        expect(result.challengeSuccess).to.equal(true);
        expect(result.pendingApproval).to.equal(true);
        expect(aiReviewGet).to.equal(1);
    });

    it("does NOT run AI moderation when the spam-blocker is failed (token-cost guard)", async () => {
        reset();
        spamBlockerShouldFail = true;
        const result = await getChallengeVerification({
            challengeRequestMessage: regularRequest(),
            community: buildCommunity(),
            getChallengeAnswers: answerEverything
        });
        expect(result.challengeSuccess).to.equal(false);
        expect(aiAllowGet).to.equal(0);
        expect(aiReviewGet).to.equal(0);
    });
});
