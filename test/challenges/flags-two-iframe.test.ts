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
// BUG (this is what these tests gate): the orchestrator can only ever surface one interactive challenge
// per request. Once any challenge is pending and the dependency loop stalls, every remaining undecided
// challenge is deferred (src/runtime/node/community/challenges/index.ts Phase 4), and a deferred
// interactive challenge is then silently ignored at verify time. So whichever iframe is reached first is
// shown and the other is dropped — the comment publishes with one of the two challenges never verified.
//
// These tests assert the CORRECT behaviour and are expected to FAIL until the orchestrator is fixed.

type ChallengeVerificationResult = Awaited<ReturnType<typeof getPendingChallengesOrChallengeVerification>>;

const getRandomAddress = () => String(Math.random());

let spamBlockerGet = 0;
let spamBlockerVerify = 0;
let flagsGet = 0;
let flagsVerify = 0;
let aiAllowGet = 0;
let aiReviewGet = 0;
const reset = () => {
    spamBlockerGet = 0;
    spamBlockerVerify = 0;
    flagsGet = 0;
    flagsVerify = 0;
    aiAllowGet = 0;
    aiReviewGet = 0;
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
        return { success: true as const };
    }
});
const aiReviewFactory = () => ({
    type: "text/plain" as const,
    getChallenge: async () => {
        aiReviewGet++;
        return { success: true as const };
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

// Correct flags config for the owner's intent: flags runs for everyone except mods, with NO
// challenge-index excludes (those are what force it to defer behind the spam-blocker iframe).
const FLAGS_EXCLUDE = [{ role: ["owner", "admin", "moderator"] }, { publicationType: { commentModeration: true, communityEdit: true } }];

const buildCommunity = () =>
    ({
        settings: { challenges: [...C0_THROUGH_C4, { name: "mock-flags", exclude: FLAGS_EXCLUDE }] },
        _pkc: makePkc()
    }) as unknown as LocalCommunity;

// A regular author: no `.bso` name and not whitelisted, so C0 and C1 fail and the two iframe challenges
// (spam-blocker + flags) are the ones that must be presented.
const regularRequest = () =>
    ({
        comment: { author: { address: getRandomAddress(), name: "no-bso-name" } }
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
