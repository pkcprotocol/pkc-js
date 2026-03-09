import { beforeAll } from "vitest";
import {
    getPendingChallengesOrChallengeVerification,
    getChallengeVerificationFromChallengeAnswers,
    getChallengeVerification,
    plebbitJsChallenges,
    getSubplebbitChallengeFromSubplebbitChallengeSettings
} from "../../dist/node/runtime/node/subplebbit/challenges/index.js";
import type { GetChallengeAnswers } from "../../dist/node/runtime/node/subplebbit/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalSubplebbit } from "../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import * as remeda from "remeda";
import { Plebbit, subplebbits, authors, subplebbitAuthors, challengeAnswers, challengeCommentCids, results } from "./fixtures/fixtures.ts";

// Type for challenge verification results (union of success, pending, failure)
type ChallengeVerificationResult = Awaited<ReturnType<typeof getPendingChallengesOrChallengeVerification>>;

import validChallengeRequestFixture from "../fixtures/signatures/challenges/valid_challenge_request.json" with { type: "json" };
import validCommentIpfsFixture from "../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };

const parsePubsubMsgFixture = (json: Record<string, unknown>): Record<string, unknown> => {
    // Convert stringified pubsub msg with buffers to regular pubsub msg with uint8Array for buffers
    const isBuffer = (obj: Record<string, unknown>): boolean => Object.keys(obj).every((key) => /\d/.test(key));
    const parsed: Record<string, unknown> = {};
    for (const key of Object.keys(json)) {
        if (remeda.isPlainObject(json[key]) && isBuffer(json[key] as Record<string, unknown>))
            parsed[key] = Uint8Array.from(Object.values(json[key] as Record<string, number>));
        else if (remeda.isPlainObject(json[key])) parsed[key] = parsePubsubMsgFixture(json[key] as Record<string, unknown>);
        else parsed[key] = json[key];
    }
    return parsed;
};

// sometimes use random addresses because the rate limiter
// is based on author addresses and doesn't reset between tests
const getRandomAddress = () => String(Math.random());

describe("plebbitJsChallenges", () => {
    let TextMathFactory = plebbitJsChallenges["text-math"];

    it("returns challenges", () => {
        expect(plebbitJsChallenges).to.not.equal(undefined);
        expect(typeof plebbitJsChallenges).to.equal("object");
        expect(typeof TextMathFactory).to.equal("function");
    });

    it("text-math challenge answer can be eval", async () => {
        const textMath = TextMathFactory({} as Parameters<typeof TextMathFactory>[0]);
        const getChallengeResult = await textMath.getChallenge({} as Parameters<typeof textMath.getChallenge>[0]);
        const { challenge, verify } = getChallengeResult as {
            challenge: string;
            verify: (answer: string) => Promise<{ success: boolean; error?: string }>;
        };
        // the challenge can be eval
        expect(await verify(String(eval(challenge)))).to.deep.equal({ success: true });
        expect(await verify("wrong")).to.deep.equal({ success: false, error: "Wrong answer." });
    });
});

describe("getPendingChallengesOrChallengeVerification", () => {
    for (const subplebbit of subplebbits) {
        it(subplebbit.title, async () => {
            for (const author of authors) {
                // mock challenge request with mock publication
                const requestFixture = parsePubsubMsgFixture(validChallengeRequestFixture);
                const challengeRequestMessage = {
                    ...requestFixture,
                    comment: {
                        ...validCommentIpfsFixture,
                        author: { ...author, subplebbit: subplebbitAuthors[author.address]?.[subplebbit.title] }
                    },
                    // some challenges could require including comment cids in other subs, like friendly subplebbit karma challenges
                    challengeCommentCids: challengeCommentCids[author.address],
                    // define mock challenge answers in challenge request
                    challengeAnswers: challengeAnswers[author.address]?.[subplebbit.title]
                } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;

                // get the expected results from fixtures
                const expectedChallengeResult = results[subplebbit?.title]?.[author?.address];
                const challengeResult = (await getPendingChallengesOrChallengeVerification(
                    challengeRequestMessage,
                    subplebbit as unknown as LocalSubplebbit
                )) as ChallengeVerificationResult & {
                    challengeSuccess?: boolean;
                    challengeErrors?: Record<number, string>;
                    pendingChallenges?: Array<{ type: string; challenge: string; verify: Function; index: number }>;
                };
                // console.dir({challengeResult, expectedChallengeResult}, {depth: null}) // debug fixtures results

                expect(expectedChallengeResult).to.not.equal(undefined);
                expect(challengeResult.challengeSuccess).to.equal(expectedChallengeResult.challengeSuccess);
                expect(challengeResult.challengeErrors).to.deep.equal(expectedChallengeResult.challengeErrors);
                expect(challengeResult.pendingChallenges?.length).to.equal(expectedChallengeResult.pendingChallenges?.length);
                if (challengeResult.pendingChallenges?.length) {
                    for (const [challengeIndex] of challengeResult.pendingChallenges.entries()) {
                        expect(challengeResult.pendingChallenges[challengeIndex].type).to.not.equal(undefined);
                        expect(challengeResult.pendingChallenges[challengeIndex].challenge).to.not.equal(undefined);
                        expect(typeof challengeResult.pendingChallenges[challengeIndex].verify).to.equal("function");
                        expect(typeof challengeResult.pendingChallenges[challengeIndex].index).to.equal("number");
                        expect(challengeResult.pendingChallenges[challengeIndex].type).to.equal(
                            expectedChallengeResult.pendingChallenges[challengeIndex].type
                        );
                        expect(typeof challengeResult.pendingChallenges[challengeIndex].challenge).to.equal(
                            typeof expectedChallengeResult.pendingChallenges[challengeIndex].challenge
                        );
                    }
                }
            }
        });
    }
});

// Helper type for getChallengeVerification result
type GetChallengeVerificationResult = Awaited<ReturnType<typeof getChallengeVerification>>;

describe("getChallengeVerification", () => {
    const author = { address: "Qm..." };
    const subplebbit: { settings: { challenges: Array<Record<string, unknown>> }; _plebbit?: ReturnType<typeof Plebbit> } = {
        settings: {
            challenges: [
                // add random exlcuded challenges to tests
                { name: "fail", exclude: [{ address: [author.address] }] },
                // exlcude if other math challenge succeeds
                { name: "text-math", exclude: [{ challenges: [3] }] },
                { name: "fail", exclude: [{ address: [author.address] }] },
                // exlcude if other math challenge succeeds
                { name: "text-math", exclude: [{ challenges: [1] }] },
                { name: "fail", exclude: [{ address: [author.address] }] },
                {
                    name: "question",
                    options: {
                        question: "What is the password?",
                        answer: "password"
                    }
                }
            ]
        }
    };
    const challengeRequestMessage = {
        comment: { author },
        // define mock challenge answers in challenge request
        challengeAnswers: [undefined, undefined, undefined, undefined, undefined, "password"]
    } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;

    beforeAll(async () => {
        subplebbit._plebbit = await Plebbit();
    });

    it("only 50% of challenges must succeed", async () => {
        // fail the first challenge answer, should still succeed
        const getChallengeAnswersFail1: GetChallengeAnswers = async (challenges) => {
            return ["wrong", String(eval((challenges[1] as { challenge: string }).challenge))];
        };
        let challengeVerification = (await getChallengeVerification(
            challengeRequestMessage,
            subplebbit as unknown as LocalSubplebbit,
            getChallengeAnswersFail1
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // fail only the second challenge, should still succeed
        const getChallengeAnswersFail2: GetChallengeAnswers = async (challenges) => {
            return ["wrong", String(eval((challenges[1] as { challenge: string }).challenge))];
        };
        challengeVerification = (await getChallengeVerification(
            challengeRequestMessage,
            subplebbit as unknown as LocalSubplebbit,
            getChallengeAnswersFail2
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // fail both challenge, should fail
        const getChallengeAnswersFailAll: GetChallengeAnswers = async (_challenges) => {
            return ["wrong", "wrong"];
        };
        challengeVerification = (await getChallengeVerification(
            challengeRequestMessage,
            subplebbit as unknown as LocalSubplebbit,
            getChallengeAnswersFailAll
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors![1]).to.equal("Wrong answer.");
        expect(challengeVerification.challengeErrors![3]).to.equal("Wrong answer.");

        // succeed both challenge
        const getChallengeAnswersSucceedAll: GetChallengeAnswers = async (challenges) => {
            return [
                String(eval((challenges[0] as { challenge: string }).challenge)),
                String(eval((challenges[1] as { challenge: string }).challenge))
            ];
        };
        challengeVerification = (await getChallengeVerification(
            challengeRequestMessage,
            subplebbit as unknown as LocalSubplebbit,
            getChallengeAnswersSucceedAll
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);
    });

    it("password preanswer and no preanswer", async () => {
        const localSubplebbit = {
            settings: {
                challenges: [
                    {
                        name: "question",
                        options: {
                            question: "What is the password?",
                            answer: "password"
                        }
                    }
                ]
            },
            _plebbit: await Plebbit()
        } as unknown as LocalSubplebbit;

        // correct preanswered
        let mockChallengeRequestMessage = {
            comment: { author },
            challengeAnswers: ["password"]
        } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;
        const shouldNotCall = async () => {
            throw Error("should not call");
        };
        let challengeVerification = (await getChallengeVerification(
            mockChallengeRequestMessage,
            localSubplebbit,
            shouldNotCall
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // wrong preanswered
        mockChallengeRequestMessage = {
            comment: { author },
            challengeAnswers: ["wrong"]
        } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;
        challengeVerification = (await getChallengeVerification(
            mockChallengeRequestMessage,
            localSubplebbit,
            shouldNotCall
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors![0]).to.equal("Wrong answer.");

        // correct answered via challenge
        mockChallengeRequestMessage = {
            comment: { author }
        } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;
        const getChallengeAnswers = async (_challenges: unknown[]): Promise<string[]> => {
            return ["password"];
        };
        challengeVerification = (await getChallengeVerification(
            mockChallengeRequestMessage,
            localSubplebbit,
            getChallengeAnswers
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // wrong answered via challenge
        const getChallengeAnswersWrong = async (_challenges: unknown[]): Promise<string[]> => {
            return ["wrong"];
        };
        challengeVerification = (await getChallengeVerification(
            mockChallengeRequestMessage,
            localSubplebbit,
            getChallengeAnswersWrong
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors![0]).to.equal("Wrong answer.");
    });

    it("rate limited", async () => {
        const rateLimitSubplebbit = {
            settings: {
                challenges: [
                    {
                        name: "fail",
                        options: {
                            error: "rate limited 1"
                        },
                        exclude: [{ rateLimit: 1 }]
                    },
                    {
                        name: "fail",
                        options: {
                            error: "rate limited 2"
                        },
                        exclude: [{ rateLimit: 1, rateLimitChallengeSuccess: false }]
                    }
                ]
            },
            _plebbit: await Plebbit()
        } as unknown as LocalSubplebbit;

        const rateLimitChallengeRequestMessage = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;
        const shouldNotCall = async () => {
            throw Error("should not call");
        };

        // first rate limit not triggered
        let challengeVerification = (await getChallengeVerification(
            rateLimitChallengeRequestMessage,
            rateLimitSubplebbit,
            shouldNotCall
        )) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // first rate limit triggered
        challengeVerification = (await getChallengeVerification(
            rateLimitChallengeRequestMessage,
            rateLimitSubplebbit,
            shouldNotCall
        )) as GetChallengeVerificationResult;
        expect(challengeVerification).to.deep.equal({ challengeErrors: { 0: "rate limited 1" }, challengeSuccess: false });

        // second rate limit triggered
        challengeVerification = (await getChallengeVerification(
            rateLimitChallengeRequestMessage,
            rateLimitSubplebbit,
            shouldNotCall
        )) as GetChallengeVerificationResult;
        expect(challengeVerification).to.deep.equal({
            challengeSuccess: false,
            challengeErrors: { 0: "rate limited 1", 1: "rate limited 2" }
        });
    });

    it("getChallenge function throws", async () => {
        const throwSubplebbit = {
            settings: {
                challenges: [
                    {
                        name: "question",
                        options: {
                            // undefined answer will cause question challenge to throw
                            answer: undefined
                        }
                    }
                ]
            },
            _plebbit: await Plebbit()
        } as unknown as LocalSubplebbit;

        const throwChallengeRequestMessage = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor;
        const shouldNotCall = async () => {
            throw Error("should not call");
        };

        let challengeVerification: GetChallengeVerificationResult | undefined;
        let getChallengeError: Error | undefined;
        try {
            challengeVerification = (await getChallengeVerification(
                throwChallengeRequestMessage,
                throwSubplebbit,
                shouldNotCall
            )) as GetChallengeVerificationResult;
        } catch (e) {
            getChallengeError = e as Error;
        }
        expect(getChallengeError).to.not.equal(undefined);
        // the error should say something about the answer option missing
        expect(getChallengeError!.message.match(/answer/i)).to.not.equal(undefined);
        expect(challengeVerification).to.equal(undefined);
    });

    it("getChallengeVerificationFromChallengeAnswers", async () => {
        const challengeResult = (await getPendingChallengesOrChallengeVerification(
            challengeRequestMessage,
            subplebbit as unknown as LocalSubplebbit
        )) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
            challengeErrors?: Record<number, string>;
            pendingChallenges?: Array<{ type: string; challenge: string; verify: Function; index: number }>;
        };
        expect(challengeResult.challengeSuccess).to.equal(undefined);
        expect(challengeResult.challengeErrors).to.deep.equal(undefined);
        expect(challengeResult.pendingChallenges?.length).to.equal(2);

        const pendingChallenges = challengeResult.pendingChallenges!;
        expect(pendingChallenges[0].index).to.equal(1);
        expect(pendingChallenges[1].index).to.equal(3);

        // fail only the first challenge, should still succeed
        const challengeAnswersFail1 = ["wrong", String(eval(pendingChallenges[1].challenge))];
        let challengeVerification = (await getChallengeVerificationFromChallengeAnswers(
            pendingChallenges as Parameters<typeof getChallengeVerificationFromChallengeAnswers>[0],
            challengeAnswersFail1,
            subplebbit as unknown as LocalSubplebbit
        )) as Awaited<ReturnType<typeof getChallengeVerificationFromChallengeAnswers>>;
        expect(challengeVerification).to.deep.equal({
            challengeSuccess: true,
            pendingApprovalSuccess: false
        });

        // fail only the second challenge, should still succeed
        const challengeAnswersFail2 = [String(eval(pendingChallenges[0].challenge)), "wrong"];
        challengeVerification = (await getChallengeVerificationFromChallengeAnswers(
            pendingChallenges as Parameters<typeof getChallengeVerificationFromChallengeAnswers>[0],
            challengeAnswersFail2,
            subplebbit as unknown as LocalSubplebbit
        )) as Awaited<ReturnType<typeof getChallengeVerificationFromChallengeAnswers>>;
        expect(challengeVerification).to.deep.equal({
            challengeSuccess: true,
            pendingApprovalSuccess: false
        });

        // fail both challenge, should fail
        const challengeAnswersFailAll = ["wrong", "wrong"];
        challengeVerification = (await getChallengeVerificationFromChallengeAnswers(
            pendingChallenges as Parameters<typeof getChallengeVerificationFromChallengeAnswers>[0],
            challengeAnswersFailAll,
            subplebbit as unknown as LocalSubplebbit
        )) as Awaited<ReturnType<typeof getChallengeVerificationFromChallengeAnswers>>;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect((challengeVerification as { challengeErrors: Record<number, string> }).challengeErrors[1]).to.equal("Wrong answer.");
        expect((challengeVerification as { challengeErrors: Record<number, string> }).challengeErrors[3]).to.equal("Wrong answer.");
        expect("pendingApprovalSuccess" in challengeVerification).to.equal(false);
    });
});

describe("await getSubplebbitChallengeFromSubplebbitChallengeSettings", () => {
    // skip these tests when soloing subplebbits
    if (subplebbits.length < 5) {
        return;
    }

    it("has challenge prop", async () => {
        const subplebbit = subplebbits.filter((subplebbit) => subplebbit.title === "password challenge subplebbit")[0];
        const subplebbitChallenge = await getSubplebbitChallengeFromSubplebbitChallengeSettings(subplebbit.settings.challenges[0]);
        expect(typeof subplebbitChallenge.challenge).to.equal("string");
        expect(subplebbitChallenge.challenge).to.equal(subplebbit.settings.challenges[0].options.question);
    });

    it("has description prop", async () => {
        const subplebbit = subplebbits.filter((subplebbit) => subplebbit.title === "text-math challenge subplebbit")[0];
        const subplebbitChallenge = await getSubplebbitChallengeFromSubplebbitChallengeSettings(subplebbit.settings.challenges[0]);
        expect(typeof subplebbitChallenge.description).to.equal("string");
        expect(subplebbitChallenge.description).to.equal(subplebbit.settings.challenges[0].description);
    });

    it("has exclude prop", async () => {
        const subplebbit = subplebbits.filter((subplebbit) => subplebbit.title === "exclude high karma challenge subplebbit")[0];
        const subplebbitChallenge = await getSubplebbitChallengeFromSubplebbitChallengeSettings(subplebbit.settings.challenges[0]);
        expect(subplebbitChallenge.exclude).to.not.equal(undefined);
        expect(subplebbitChallenge.exclude).to.deep.equal(subplebbit.settings.challenges[0].exclude);
    });
});
