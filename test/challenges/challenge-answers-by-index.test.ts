import { beforeAll, describe, expect, it } from "vitest";
import {
    getChallengeVerification,
    getCommunityChallengeFromCommunityChallengeSettings,
    getPendingChallengesOrChallengeVerification
} from "../../dist/node/runtime/node/community/challenges/index.js";
import type { GetChallengeAnswers } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import { ChallengeAnswersByIndexSchema, CreatePublicationUserOptionsSchema } from "../../dist/node/schema/schema.js";
import { DecryptedChallengeAnswerSchema, DecryptedChallengeSchema } from "../../dist/node/pubsub-messages/schema.js";
import { RpcPublishChallengeAnswersParamSchema } from "../../dist/node/clients/rpc-client/schema.js";
import { PKC } from "./fixtures/fixtures.ts";
import Logger from "@pkcprotocol/pkc-logger";

// Community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:challenge-answers-by-index" });

// Issue #567: challenge answers travel as records keyed by challenge index, so a client can answer only the challenges it chooses to

const question = (q: string, answer: string) => ({ name: "question", options: { question: q, answer } });

// question challenges at indexes 0, 1 and 2, so a pre-answer for index 2 must not disturb the challenge at index 0
const challengeSettings = [question("First?", "a"), question("Second?", "b"), question("Third?", "c")];

type MockCommunity = {
    _log: typeof testLog;
    settings: { challenges: typeof challengeSettings };
    _pkc: ReturnType<typeof PKC>;
    challenges?: unknown[];
};

const requestWith = (challengeAnswers?: Record<string, string>) =>
    ({
        comment: { author: { address: "author-comment" } },
        ...(challengeAnswers ? { challengeAnswers } : {})
    }) as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

describe("challenge answers keyed by challenge index (issue #567)", () => {
    let community: MockCommunity;

    beforeAll(async () => {
        community = { _log: testLog, settings: { challenges: challengeSettings }, _pkc: await PKC() };
        community.challenges = await Promise.all(
            challengeSettings.map(
                async (communityChallengeSettings) =>
                    (await getCommunityChallengeFromCommunityChallengeSettings({ communityChallengeSettings, log: testLog }))
                        .communityChallenge
            )
        );
    });

    const verify = (
        challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
        getChallengeAnswers: GetChallengeAnswers
    ) => getChallengeVerification({ challengeRequestMessage, community: community as unknown as LocalCommunity, getChallengeAnswers });

    it("a pre-answer for index 2 alone leaves the challenges at index 0 and 1 to be asked, instead of failing them", async () => {
        const res = await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: requestWith({ "2": "c" }),
            community: community as unknown as LocalCommunity
        });
        expect("pendingChallenges" in res).to.equal(true);
        if (!("pendingChallenges" in res)) throw Error("expected pending challenges");
        expect(res.pendingChallenges.map((pending) => pending.index)).to.deep.equal([0, 1]);
    });

    it("a wrong pre-answer still fails only its own challenge", async () => {
        const verification = await verify(requestWith({ "2": "wrong" }), async (challenges) =>
            Object.fromEntries(Object.keys(challenges).map((index) => [index, challengeSettings[Number(index)].options.answer]))
        );
        expect(verification.challengeSuccess).to.equal(false);
        expect(Object.keys(verification.challengeErrors!)).to.deep.equal(["2"]);
    });

    it("the CHALLENGE handed to the author is keyed by index and holds only the challenges that still need an answer", async () => {
        let received: Parameters<GetChallengeAnswers>[0] | undefined;
        const verification = await verify(requestWith({ "1": "b" }), async (challenges) => {
            received = challenges;
            return { "0": "a", "2": "c" };
        });
        expect(Object.keys(received!)).to.deep.equal(["0", "2"]);
        expect(received!["0"].challenge).to.equal("First?");
        expect(received!["2"].challenge).to.equal("Third?");
        expect(verification.challengeSuccess).to.equal(true);
    });

    it("answers are matched to challenges by index, not by position in the CHALLENGE", async () => {
        // pending challenges are 0 and 2; swapping which index carries which answer must fail both
        const verification = await verify(requestWith({ "1": "b" }), async () => ({ "0": "c", "2": "a" }));
        expect(verification.challengeSuccess).to.equal(false);
        expect(Object.keys(verification.challengeErrors!).sort()).to.deep.equal(["0", "2"]);
    });

    it("a pending challenge with no key in the answer fails as unanswered, and unknown keys are ignored", async () => {
        const verification = await verify(requestWith({ "1": "b" }), async () => ({ "0": "a", "9": "ignored" }));
        expect(verification.challengeSuccess).to.equal(false);
        expect(Object.keys(verification.challengeErrors!)).to.deep.equal(["2"]);
        expect(verification.challengeErrors!["2"]).to.equal("No answer.");
    });
});

describe("challenge answer schemas reject the positional array form (issue #567)", () => {
    it("ChallengeAnswersByIndexSchema accepts a sparse record", () => {
        expect(ChallengeAnswersByIndexSchema.safeParse({ "2": "answer" }).success).to.equal(true);
    });

    it("ChallengeAnswersByIndexSchema rejects an empty record, a non-integer key, and an array", () => {
        expect(ChallengeAnswersByIndexSchema.safeParse({}).success).to.equal(false);
        expect(ChallengeAnswersByIndexSchema.safeParse({ first: "answer" }).success).to.equal(false);
        expect(ChallengeAnswersByIndexSchema.safeParse({ "-1": "answer" }).success).to.equal(false);
        expect(ChallengeAnswersByIndexSchema.safeParse(["answer"]).success).to.equal(false);
        expect(ChallengeAnswersByIndexSchema.safeParse({ "0": 1 }).success).to.equal(false);
    });

    it("CHALLENGEREQUEST challengeAnswers: optional, record only", () => {
        const parse = (challengeRequest: unknown) => CreatePublicationUserOptionsSchema.shape.challengeRequest.safeParse(challengeRequest);
        expect(parse(undefined).success).to.equal(true);
        expect(parse({}).success).to.equal(true);
        expect(parse({ challengeAnswers: { "2": "answer" } }).success).to.equal(true);
        expect(parse({ challengeAnswers: ["answer"] }).success).to.equal(false);
        expect(parse({ challengeAnswers: {} }).success).to.equal(false);
    });

    it("CHALLENGEANSWER challengeAnswers: record only", () => {
        expect(DecryptedChallengeAnswerSchema.safeParse({ challengeAnswers: { "0": "answer" } }).success).to.equal(true);
        expect(DecryptedChallengeAnswerSchema.safeParse({ challengeAnswers: ["answer"] }).success).to.equal(false);
        expect(DecryptedChallengeAnswerSchema.safeParse({ challengeAnswers: {} }).success).to.equal(false);
    });

    it("RPC publishChallengeAnswers params: record only", () => {
        expect(
            RpcPublishChallengeAnswersParamSchema.safeParse({ subscriptionId: 1, challengeAnswers: { "0": "answer" } }).success
        ).to.equal(true);
        expect(RpcPublishChallengeAnswersParamSchema.safeParse({ subscriptionId: 1, challengeAnswers: ["answer"] }).success).to.equal(
            false
        );
    });

    it("CHALLENGE challenges: a non-empty record keyed by index, never an array or empty", () => {
        const challenge = { challenge: "1+1=?", type: "text/plain", caseInsensitive: true };
        expect(DecryptedChallengeSchema.safeParse({ challenges: { "1": challenge, "3": challenge } }).success).to.equal(true);
        expect(DecryptedChallengeSchema.safeParse({ challenges: [challenge] }).success).to.equal(false);
        expect(DecryptedChallengeSchema.safeParse({ challenges: {} }).success).to.equal(false);
        expect(DecryptedChallengeSchema.safeParse({ challenges: { first: challenge } }).success).to.equal(false);
    });
});
