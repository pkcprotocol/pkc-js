import { beforeAll } from "vitest";
import {
    getChallengeVerification,
    getCommunityChallengeFromCommunityChallengeSettings
} from "../../dist/node/runtime/node/community/challenges/index.js";
import type { GetChallengeAnswers } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import { PKC } from "./fixtures/fixtures.ts";

// Wrapper function for type assertion boilerplate
const testGetChallengeVerification = (challengeRequestMessage: unknown, community: unknown, getChallengeAnswers: GetChallengeAnswers) => {
    return getChallengeVerification(
        challengeRequestMessage as DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
        community as LocalCommunity,
        getChallengeAnswers
    );
};

interface MockChallengeSettings {
    name: string;
    options?: { question: string; answer: string };
    pendingApproval?: boolean;
    exclude?: Array<{ challenges?: number[]; address?: string[]; rateLimit?: number; rateLimitChallengeSuccess?: boolean }>;
}

interface MockCommunityWithChallenges {
    settings: { challenges: MockChallengeSettings[] };
    _pkc: ReturnType<typeof PKC>;
    challenges?: unknown[];
}

const createCommunityWithChallenges = async (
    pkcInstance: ReturnType<typeof PKC>,
    challengeSettings: MockChallengeSettings[]
): Promise<MockCommunityWithChallenges> => {
    const community: MockCommunityWithChallenges = {
        settings: { challenges: challengeSettings },
        _pkc: pkcInstance
    };
    community.challenges = await Promise.all(
        challengeSettings.map((challenge) => getCommunityChallengeFromCommunityChallengeSettings(challenge))
    );
    return community;
};

describe("pending approval", () => {
    let pkc: ReturnType<typeof PKC>;

    beforeAll(async () => {
        pkc = await PKC();
    });

    const wrongAnswers = async (challenges: unknown[]): Promise<string[]> => challenges.map(() => "wrong");

    it("fails comments when pending-approval challenges are answered incorrectly", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Password?", answer: "password-1" },
                pendingApproval: true
            },
            {
                name: "question",
                options: { question: "Second password?", answer: "password-2" },
                pendingApproval: true
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "author-comment" } } };

        const verification = await testGetChallengeVerification(challengeRequestMessage, community, wrongAnswers);

        expect(verification.pendingApproval).to.equal(undefined);
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors[0]).to.equal("Wrong answer.");
        expect(verification.challengeErrors[1]).to.equal("Wrong answer.");
    });

    it("sends comments with correct challenge answers to pending approval", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Password?", answer: "password-1" },
                pendingApproval: true
            },
            {
                name: "question",
                options: { question: "Second password?", answer: "password-2" },
                pendingApproval: true
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "author-comment" } } };

        const answers = async () => ["password-1", "password-2"];
        const verification = await testGetChallengeVerification(challengeRequestMessage, community, answers);

        expect(verification.pendingApproval).to.equal(true);
        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.challengeErrors).to.equal(undefined);
    });

    it("does not send non-comment publications to pending approval", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Password?", answer: "password" },
                pendingApproval: true
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { vote: { author: { address: "author-vote" } } };

        const correctAnswers = async () => ["password"];
        const verification = await testGetChallengeVerification(challengeRequestMessage, community, correctAnswers);

        expect(verification.pendingApproval).to.equal(undefined);
        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.challengeErrors).to.equal(undefined);
    });

    it("requires every failing challenge to have pendingApproval enabled", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Password?", answer: "password-1" },
                pendingApproval: true
            },
            {
                name: "question",
                options: { question: "Second password?", answer: "password-2" }
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "author-comment" } } };

        const verification = await testGetChallengeVerification(challengeRequestMessage, community, wrongAnswers);

        expect(verification.pendingApproval).to.equal(undefined);
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors[0]).to.equal("Wrong answer.");
        expect(verification.challengeErrors[1]).to.equal("Wrong answer.");
    });

    it("fails mixed success/failure comments even when challenges require pending approval", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "First?", answer: "first" },
                pendingApproval: true
            },
            {
                name: "question",
                options: { question: "Second?", answer: "second" },
                pendingApproval: true
            },
            {
                name: "question",
                options: { question: "Third?", answer: "third" },
                pendingApproval: true
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "author-comment" } } };

        const answers = async () => ["first", "wrong", "wrong"];
        const verification = await testGetChallengeVerification(challengeRequestMessage, community, answers);

        expect(verification.pendingApproval).to.equal(undefined);
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors[1]).to.equal("Wrong answer.");
        expect(verification.challengeErrors[2]).to.equal("Wrong answer.");
    });

    it("ignores excluded failing challenges when determining pending approval", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "First?", answer: "first" }
            },
            {
                name: "question",
                options: { question: "Second?", answer: "second" },
                pendingApproval: true,
                exclude: [{ challenges: [0] }]
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "author-comment" } } };

        const answers = async () => ["first", "wrong"];
        const verification = await testGetChallengeVerification(challengeRequestMessage, community, answers);

        expect(verification.pendingApproval).to.equal(undefined);
        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.challengeErrors).to.equal(undefined);
    });

    it("does not send excluded pending-approval challenges to pending approval", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Password?", answer: "password" },
                pendingApproval: true,
                exclude: [{ address: ["author-comment"] }]
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "author-comment" } } };

        const verification = await testGetChallengeVerification(challengeRequestMessage, community, wrongAnswers);

        expect(verification.pendingApproval).to.equal(undefined);
        expect(verification.challengeSuccess).to.equal(true);
        expect(verification.challengeErrors).to.equal(undefined);
    });

    it("keeps failing rate-limited authors that answer pending-approval challenges incorrectly", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Rate limited?", answer: "yes" },
                pendingApproval: true,
                exclude: [{ rateLimit: 0, rateLimitChallengeSuccess: false }]
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);
        const challengeRequestMessage = { comment: { author: { address: "rate-limited-author" } } };

        const wrongAnswer = async () => ["wrong"];
        const first = await testGetChallengeVerification(challengeRequestMessage, community, wrongAnswer);
        const second = await testGetChallengeVerification(challengeRequestMessage, community, wrongAnswer);

        for (const verification of [first, second]) {
            expect(verification.pendingApproval).to.equal(undefined);
            expect(verification.challengeSuccess).to.equal(false);
            expect(verification.challengeErrors[0]).to.equal("Wrong answer.");
        }
    });

    it("respects pending approval for pre-answered submissions", async () => {
        const challengeSettings = [
            {
                name: "question",
                options: { question: "Password?", answer: "secret" },
                pendingApproval: true
            }
        ];
        const community = await createCommunityWithChallenges(pkc, challengeSettings);

        const wrongRequest = {
            comment: { author: { address: "author-comment" } },
            challengeAnswers: ["wrong"]
        };
        const wrongVerification = await testGetChallengeVerification(wrongRequest, community, async () => ["wrong"]);
        expect(wrongVerification.pendingApproval).to.equal(undefined);
        expect(wrongVerification.challengeSuccess).to.equal(false);
        expect(wrongVerification.challengeErrors[0]).to.equal("Wrong answer.");

        const correctRequest = {
            comment: { author: { address: "author-comment" } },
            challengeAnswers: ["secret"]
        };
        const correctVerification = await testGetChallengeVerification(correctRequest, community, async () => ["secret"]);
        expect(correctVerification.pendingApproval).to.equal(true);
        expect(correctVerification.challengeSuccess).to.equal(true);
        expect(correctVerification.challengeErrors).to.equal(undefined);
    });
});
