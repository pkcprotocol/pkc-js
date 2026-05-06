import { beforeAll } from "vitest";
import {
    getPendingChallengesOrChallengeVerification,
    getChallengeVerificationFromChallengeAnswers,
    getChallengeVerification,
    pkcJsChallenges,
    getCommunityChallengeFromCommunityChallengeSettings
} from "../../dist/node/runtime/node/community/challenges/index.js";
import type { GetChallengeAnswers } from "../../dist/node/runtime/node/community/challenges/index.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";
import * as remeda from "remeda";
import { PKC, communities, authors, communityAuthors, challengeAnswers, challengeCommentCids, results } from "./fixtures/fixtures.ts";

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

describe("pkcJsChallenges", () => {
    let TextMathFactory = pkcJsChallenges["text-math"];

    it("returns challenges", () => {
        expect(pkcJsChallenges).to.not.equal(undefined);
        expect(typeof pkcJsChallenges).to.equal("object");
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
    for (const community of communities) {
        it(community.title, async () => {
            for (const author of authors) {
                // mock challenge request with mock publication
                const requestFixture = parsePubsubMsgFixture(validChallengeRequestFixture);
                const challengeRequestMessage = {
                    ...requestFixture,
                    comment: {
                        ...validCommentIpfsFixture,
                        author: { ...author, community: communityAuthors[author.address]?.[community.title] }
                    },
                    // some challenges could require including comment cids in other subs, like friendly community karma challenges
                    challengeCommentCids: challengeCommentCids[author.address],
                    // define mock challenge answers in challenge request
                    challengeAnswers: challengeAnswers[author.address]?.[community.title]
                } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

                // get the expected results from fixtures
                const expectedChallengeResult = results[community?.title]?.[author?.address];
                const challengeResult = (await getPendingChallengesOrChallengeVerification({
                    challengeRequestMessage,
                    community: community as unknown as LocalCommunity
                })) as ChallengeVerificationResult & {
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
    const community: { settings: { challenges: Array<Record<string, unknown>> }; _pkc?: ReturnType<typeof PKC> } = {
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
    } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

    beforeAll(async () => {
        community._pkc = await PKC();
    });

    it("only 50% of challenges must succeed", async () => {
        // fail the first challenge answer, should still succeed
        const getChallengeAnswersFail1: GetChallengeAnswers = async (challenges) => {
            return ["wrong", String(eval((challenges[1] as { challenge: string }).challenge))];
        };
        let challengeVerification = (await getChallengeVerification({
            challengeRequestMessage,
            community: community as unknown as LocalCommunity,
            getChallengeAnswers: getChallengeAnswersFail1
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // fail only the second challenge, should still succeed
        const getChallengeAnswersFail2: GetChallengeAnswers = async (challenges) => {
            return ["wrong", String(eval((challenges[1] as { challenge: string }).challenge))];
        };
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage,
            community: community as unknown as LocalCommunity,
            getChallengeAnswers: getChallengeAnswersFail2
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // fail both challenge, should fail
        const getChallengeAnswersFailAll: GetChallengeAnswers = async (_challenges) => {
            return ["wrong", "wrong"];
        };
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage,
            community: community as unknown as LocalCommunity,
            getChallengeAnswers: getChallengeAnswersFailAll
        })) as GetChallengeVerificationResult;
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
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage,
            community: community as unknown as LocalCommunity,
            getChallengeAnswers: getChallengeAnswersSucceedAll
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);
    });

    it("password preanswer and no preanswer", async () => {
        const localCommunity = {
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
            _pkc: await PKC()
        } as unknown as LocalCommunity;

        // correct preanswered
        let mockChallengeRequestMessage = {
            comment: { author },
            challengeAnswers: ["password"]
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        const shouldNotCall = async () => {
            throw Error("should not call");
        };
        let challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: mockChallengeRequestMessage,
            community: localCommunity,
            getChallengeAnswers: shouldNotCall
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // wrong preanswered
        mockChallengeRequestMessage = {
            comment: { author },
            challengeAnswers: ["wrong"]
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: mockChallengeRequestMessage,
            community: localCommunity,
            getChallengeAnswers: shouldNotCall
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors![0]).to.equal("Wrong answer.");

        // correct answered via challenge
        mockChallengeRequestMessage = {
            comment: { author }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        const getChallengeAnswers = async (_challenges: unknown[]): Promise<string[]> => {
            return ["password"];
        };
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: mockChallengeRequestMessage,
            community: localCommunity,
            getChallengeAnswers
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // wrong answered via challenge
        const getChallengeAnswersWrong = async (_challenges: unknown[]): Promise<string[]> => {
            return ["wrong"];
        };
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: mockChallengeRequestMessage,
            community: localCommunity,
            getChallengeAnswers: getChallengeAnswersWrong
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect(challengeVerification.challengeErrors![0]).to.equal("Wrong answer.");
    });

    it("rate limited", async () => {
        const rateLimitCommunity = {
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
            _pkc: await PKC()
        } as unknown as LocalCommunity;

        const rateLimitChallengeRequestMessage = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        const shouldNotCall = async () => {
            throw Error("should not call");
        };

        // first rate limit not triggered
        let challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: rateLimitChallengeRequestMessage,
            community: rateLimitCommunity,
            getChallengeAnswers: shouldNotCall
        })) as GetChallengeVerificationResult;
        expect(challengeVerification.challengeSuccess).to.equal(true);

        // first rate limit triggered
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: rateLimitChallengeRequestMessage,
            community: rateLimitCommunity,
            getChallengeAnswers: shouldNotCall
        })) as GetChallengeVerificationResult;
        expect(challengeVerification).to.deep.equal({ challengeErrors: { 0: "rate limited 1" }, challengeSuccess: false });

        // second rate limit triggered
        challengeVerification = (await getChallengeVerification({
            challengeRequestMessage: rateLimitChallengeRequestMessage,
            community: rateLimitCommunity,
            getChallengeAnswers: shouldNotCall
        })) as GetChallengeVerificationResult;
        expect(challengeVerification).to.deep.equal({
            challengeSuccess: false,
            challengeErrors: { 0: "rate limited 1", 1: "rate limited 2" }
        });
    });

    it("getChallenge function throws", async () => {
        const throwCommunity = {
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
            _pkc: await PKC()
        } as unknown as LocalCommunity;

        const throwChallengeRequestMessage = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        const shouldNotCall = async () => {
            throw Error("should not call");
        };

        let challengeVerification: GetChallengeVerificationResult | undefined;
        let getChallengeError: Error | undefined;
        try {
            challengeVerification = (await getChallengeVerification({
                challengeRequestMessage: throwChallengeRequestMessage,
                community: throwCommunity,
                getChallengeAnswers: shouldNotCall
            })) as GetChallengeVerificationResult;
        } catch (e) {
            getChallengeError = e as Error;
        }
        expect(getChallengeError).to.not.equal(undefined);
        // the error should say something about the answer option missing
        expect(getChallengeError!.message.match(/answer/i)).to.not.equal(undefined);
        expect(challengeVerification).to.equal(undefined);
    });

    it("getChallengeVerificationFromChallengeAnswers", async () => {
        const challengeResult = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage,
            community: community as unknown as LocalCommunity
        })) as ChallengeVerificationResult & {
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
        let challengeVerification = (await getChallengeVerificationFromChallengeAnswers({
            pendingChallenges: pendingChallenges as Parameters<typeof getChallengeVerificationFromChallengeAnswers>[0]["pendingChallenges"],
            challengeAnswers: challengeAnswersFail1,
            community: community as unknown as LocalCommunity
        })) as Awaited<ReturnType<typeof getChallengeVerificationFromChallengeAnswers>>;
        expect(challengeVerification).to.deep.equal({
            challengeSuccess: true,
            pendingApprovalSuccess: false
        });

        // fail only the second challenge, should still succeed
        const challengeAnswersFail2 = [String(eval(pendingChallenges[0].challenge)), "wrong"];
        challengeVerification = (await getChallengeVerificationFromChallengeAnswers({
            pendingChallenges: pendingChallenges as Parameters<typeof getChallengeVerificationFromChallengeAnswers>[0]["pendingChallenges"],
            challengeAnswers: challengeAnswersFail2,
            community: community as unknown as LocalCommunity
        })) as Awaited<ReturnType<typeof getChallengeVerificationFromChallengeAnswers>>;
        expect(challengeVerification).to.deep.equal({
            challengeSuccess: true,
            pendingApprovalSuccess: false
        });

        // fail both challenge, should fail
        const challengeAnswersFailAll = ["wrong", "wrong"];
        challengeVerification = (await getChallengeVerificationFromChallengeAnswers({
            pendingChallenges: pendingChallenges as Parameters<typeof getChallengeVerificationFromChallengeAnswers>[0]["pendingChallenges"],
            challengeAnswers: challengeAnswersFailAll,
            community: community as unknown as LocalCommunity
        })) as Awaited<ReturnType<typeof getChallengeVerificationFromChallengeAnswers>>;
        expect(challengeVerification.challengeSuccess).to.equal(false);
        expect((challengeVerification as { challengeErrors: Record<number, string> }).challengeErrors[1]).to.equal("Wrong answer.");
        expect((challengeVerification as { challengeErrors: Record<number, string> }).challengeErrors[3]).to.equal("Wrong answer.");
        expect("pendingApprovalSuccess" in challengeVerification).to.equal(false);
    });
});

describe("excluded challenge should not have getChallenge() called", () => {
    it("getChallenge() should not be invoked for an excluded challenge (exclude.challenges)", async () => {
        // Import the tracking challenge whose getChallenge() increments a call counter
        // @ts-expect-error — no declaration file for the .mjs challenge fixture
        const trackingChallenge = (await import("./fixtures/challenges/tracking-challenge.mjs")) as {
            getCallCount: () => number;
            resetCallCount: () => void;
        };
        trackingChallenge.resetCallCount();

        const trackingChallengePath = new URL("./fixtures/challenges/tracking-challenge.mjs", import.meta.url).pathname;

        const author = { address: getRandomAddress() };
        const localCommunity = {
            settings: {
                challenges: [
                    // Challenge 0: question challenge — auto-succeeds via preanswer
                    {
                        name: "question",
                        options: {
                            question: "What is the password?",
                            answer: "password"
                        }
                    },
                    // Challenge 1: tracking challenge — excluded if challenge 0 succeeds
                    // getChallenge() should NOT be called since it's excluded
                    {
                        path: trackingChallengePath,
                        exclude: [{ challenges: [0] }]
                    }
                ]
            },
            _pkc: PKC()
        } as unknown as LocalCommunity;

        const challengeRequestMessage = {
            comment: { author },
            challengeAnswers: ["password"]
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage,
            community: localCommunity
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };

        // Challenge 0 succeeds, challenge 1 is excluded → overall success
        expect(result.challengeSuccess).to.equal(true);

        // Excluded challenge should not have getChallenge() called
        expect(trackingChallenge.getCallCount()).to.equal(0);
    });
});

describe("real-world config: AI moderation getChallenge() fires even when excluded", () => {
    // Reproduces the production challenge config where:
    //   C0: publication-match (immediate — checks author.name regex)
    //   C1: whitelist (immediate — checks author address)
    //   C2: spam-blocker (pending iframe)
    //   C3: ai-moderation "allow" branch (calls OpenAI)
    //   C4: ai-moderation "review" branch (calls OpenAI)
    //
    // Desired: AI moderation (C3, C4) should only run if spam-blocker (C2) succeeds,
    // and should NOT run if publication-match (C0) or whitelist (C1) already passed.
    //
    // Actual: getChallenge() is called for ALL challenges before exclude rules are checked.

    let spamBlockerCallCount = 0;
    let aiModerationAllowCallCount = 0;
    let aiModerationReviewCallCount = 0;

    const resetCallCounts = () => {
        spamBlockerCallCount = 0;
        aiModerationAllowCallCount = 0;
        aiModerationReviewCallCount = 0;
    };

    // Mock spam-blocker: returns a pending iframe challenge, tracks calls
    const mockSpamBlockerFactory = () => ({
        type: "url/iframe" as const,
        getChallenge: async () => {
            spamBlockerCallCount++;
            return {
                challenge: "https://spamblocker.example.com/verify",
                verify: async () => ({ success: true as const }),
                type: "url/iframe" as const
            };
        }
    });

    // Mock AI moderation (allow branch): returns immediate success, tracks calls
    const mockAiModerationAllowFactory = () => ({
        type: "text/plain" as const,
        getChallenge: async () => {
            aiModerationAllowCallCount++;
            return { success: true as const };
        }
    });

    // Mock AI moderation (review branch): returns immediate success with pendingApproval, tracks calls
    const mockAiModerationReviewFactory = () => ({
        type: "text/plain" as const,
        getChallenge: async () => {
            aiModerationReviewCallCount++;
            return { success: true as const };
        }
    });

    const createCommunity = () => {
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = {
            challenges: {
                "mock-spam-blocker": mockSpamBlockerFactory,
                "mock-ai-moderation-allow": mockAiModerationAllowFactory,
                "mock-ai-moderation-review": mockAiModerationReviewFactory
            }
        };
        return {
            settings: {
                challenges: [
                    // C0: publication-match — succeeds if author.name ends with .bso
                    {
                        name: "publication-match",
                        options: {
                            matches: '[{"propertyName":"author.name","regexp":"\\\\.(bso)$"}]',
                            error: "Posting requires a name ending with .bso"
                        },
                        exclude: [{ role: ["moderator", "admin", "owner"] }, { challenges: [1] }, { challenges: [2] }]
                    },
                    // C1: whitelist — succeeds if author address is whitelisted
                    {
                        name: "whitelist",
                        options: { addresses: "whitelisted-author.bso" },
                        exclude: [{ role: ["moderator", "admin", "owner"] }, { challenges: [0] }, { challenges: [2] }]
                    },
                    // C2: spam-blocker — pending iframe
                    {
                        name: "mock-spam-blocker",
                        exclude: [{ challenges: [0] }, { challenges: [1] }, { role: ["owner", "admin", "moderator"] }]
                    },
                    // C3: ai-moderation "allow" — calls OpenAI
                    {
                        name: "mock-ai-moderation-allow",
                        exclude: [{ challenges: [0] }, { challenges: [1] }, { challenges: [4] }, { role: ["owner", "admin", "moderator"] }]
                    },
                    // C4: ai-moderation "review" — calls OpenAI, pendingApproval
                    {
                        name: "mock-ai-moderation-review",
                        exclude: [{ challenges: [0] }, { challenges: [1] }, { challenges: [3] }, { role: ["owner", "admin", "moderator"] }],
                        pendingApproval: true
                    }
                ]
            },
            _pkc: pkc
        };
    };

    it("publication-match succeeds → AI moderation getChallenge() should not be called", async () => {
        resetCallCounts();
        // Author name ends with .bso → publication-match (C0) succeeds
        // C1-C4 should all be excluded, so getChallenge() should NOT fire for them
        const community = createCommunity() as unknown as LocalCommunity;
        const request = {
            comment: { author: { address: getRandomAddress(), name: "testuser.bso" } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };

        expect(result.challengeSuccess).to.equal(true);
        // Excluded challenges should not have getChallenge() called at all
        expect(spamBlockerCallCount).to.equal(0);
        expect(aiModerationAllowCallCount).to.equal(0);
        expect(aiModerationReviewCallCount).to.equal(0);
    });

    it("whitelist succeeds → AI moderation getChallenge() should not be called", async () => {
        resetCallCounts();
        // Author is whitelisted → C1 succeeds
        // C0 excluded (by C1), C2-C4 excluded, so getChallenge() should NOT fire
        const community = createCommunity() as unknown as LocalCommunity;
        const request = {
            comment: { author: { address: "whitelisted-author.bso" } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };

        expect(result.challengeSuccess).to.equal(true);
        // Excluded challenges should not have getChallenge() called at all
        expect(spamBlockerCallCount).to.equal(0);
        expect(aiModerationAllowCallCount).to.equal(0);
        expect(aiModerationReviewCallCount).to.equal(0);
    });

    it("neither match nor whitelist → AI moderation should not run before spam-blocker is solved", async () => {
        resetCallCounts();
        // Author doesn't match .bso name and isn't whitelisted
        // C0 fails, C1 fails → C2 pending (iframe) → C3, C4 should NOT run yet
        const community = createCommunity() as unknown as LocalCommunity;
        const request = {
            comment: { author: { address: getRandomAddress(), name: "no-bso-name" } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
            pendingChallenges?: unknown[];
        };

        // Spam-blocker is pending (not yet solved), so overall result is pending
        expect(result.challengeSuccess).to.equal(undefined);
        // AI moderation should only fire AFTER spam-blocker verify returns success
        expect(aiModerationAllowCallCount).to.equal(0);
        expect(aiModerationReviewCallCount).to.equal(0);
    });
});

describe("request-only excludes fire before getChallenge()", () => {
    it("role exclude on a single challenge skips getChallenge()", async () => {
        let callCount = 0;
        const trackingFactory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                callCount++;
                return { success: true as const };
            }
        });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "tracking-role-exclude": trackingFactory } };

        const community = {
            settings: {
                challenges: [
                    {
                        name: "tracking-role-exclude",
                        exclude: [{ role: ["moderator", "admin", "owner"] }]
                    }
                ]
            },
            roles: { "mod-author.bso": { role: "moderator" } },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: { author: { address: "mod-author.bso" } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };
        expect(result.challengeSuccess).to.equal(true);
        expect(callCount).to.equal(0);
    });

    it("karma exclude (postScore) on a single challenge skips getChallenge()", async () => {
        let callCount = 0;
        const trackingFactory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                callCount++;
                return { success: true as const };
            }
        });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "tracking-karma-exclude": trackingFactory } };

        const community = {
            settings: {
                challenges: [
                    {
                        name: "tracking-karma-exclude",
                        exclude: [{ postScore: 100 }]
                    }
                ]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: {
                author: { address: getRandomAddress(), community: { postScore: 200 } }
            }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };
        expect(result.challengeSuccess).to.equal(true);
        expect(callCount).to.equal(0);
    });
});

describe("incremental cycle-break", () => {
    it("two-challenge cycle: lowest index wins, other excluded", async () => {
        let c0CallCount = 0;
        let c1CallCount = 0;
        const c0Factory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                c0CallCount++;
                return { success: true as const };
            }
        });
        const c1Factory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                c1CallCount++;
                return { success: true as const };
            }
        });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "cycle-c0": c0Factory, "cycle-c1": c1Factory } };

        const community = {
            settings: {
                challenges: [
                    { name: "cycle-c0", exclude: [{ challenges: [1] }] },
                    { name: "cycle-c1", exclude: [{ challenges: [0] }] }
                ]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };
        expect(result.challengeSuccess).to.equal(true);
        expect(c0CallCount).to.equal(1);
        expect(c1CallCount).to.equal(0);
    });

    it("two-challenge cycle: lowest fails, other called and recovers", async () => {
        let c0CallCount = 0;
        let c1CallCount = 0;
        const c0Factory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                c0CallCount++;
                return { success: false as const, error: "c0 failed" };
            }
        });
        const c1Factory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                c1CallCount++;
                return { success: true as const };
            }
        });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "cycle-fail-c0": c0Factory, "cycle-fail-c1": c1Factory } };

        const community = {
            settings: {
                challenges: [
                    { name: "cycle-fail-c0", exclude: [{ challenges: [1] }] },
                    { name: "cycle-fail-c1", exclude: [{ challenges: [0] }] }
                ]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
        };
        // C0 failure is excluded by C1's success at classification → overall success.
        expect(result.challengeSuccess).to.equal(true);
        expect(c0CallCount).to.equal(1);
        expect(c1CallCount).to.equal(1);
    });
});

describe("deferred challenge resolution at verify time", () => {
    // C0 is a mock pending iframe; C1 is excluded if C0 succeeds. The full getChallengeVerification
    // flow must skip C1's getChallenge() when C0's verify returns success — the load-bearing case
    // for issue #81 (AI moderation should not fire when spam-blocker passes).
    const buildIframeAndDeferred = (verifyResult: { success: boolean; error?: string }) => {
        let iframeGetChallengeCount = 0;
        let iframeVerifyCount = 0;
        let deferredGetChallengeCount = 0;
        const iframeFactory = () => ({
            type: "url/iframe" as const,
            getChallenge: async () => {
                iframeGetChallengeCount++;
                return {
                    challenge: "https://iframe.example.com/verify",
                    type: "url/iframe" as const,
                    verify: async () => {
                        iframeVerifyCount++;
                        return verifyResult as { success: true } | { success: false; error: string };
                    }
                };
            }
        });
        const deferredFactory = () => ({
            type: "text/plain" as const,
            getChallenge: async () => {
                deferredGetChallengeCount++;
                return { success: true as const };
            }
        });
        return {
            iframeFactory,
            deferredFactory,
            counts: () => ({ iframeGetChallengeCount, iframeVerifyCount, deferredGetChallengeCount })
        };
    };

    it("deferred challenge excluded when pending iframe verify returns success", async () => {
        const { iframeFactory, deferredFactory, counts } = buildIframeAndDeferred({ success: true });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "iframe-defer": iframeFactory, "deferred-target": deferredFactory } };

        const community = {
            settings: {
                challenges: [{ name: "iframe-defer" }, { name: "deferred-target", exclude: [{ challenges: [0] }] }]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const getChallengeAnswers: GetChallengeAnswers = async () => ["any-answer"];
        const result = await getChallengeVerification({ challengeRequestMessage: request, community, getChallengeAnswers });

        const c = counts();
        expect(result.challengeSuccess).to.equal(true);
        expect(c.iframeGetChallengeCount).to.equal(1);
        expect(c.iframeVerifyCount).to.equal(1);
        expect(c.deferredGetChallengeCount).to.equal(0);
    });

    it("deferred challenge runs when pending iframe verify returns failure", async () => {
        const { iframeFactory, deferredFactory, counts } = buildIframeAndDeferred({ success: false, error: "iframe denied" });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "iframe-fail": iframeFactory, "deferred-after-fail": deferredFactory } };

        const community = {
            settings: {
                challenges: [{ name: "iframe-fail" }, { name: "deferred-after-fail", exclude: [{ challenges: [0] }] }]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const getChallengeAnswers: GetChallengeAnswers = async () => ["any-answer"];
        const result = await getChallengeVerification({ challengeRequestMessage: request, community, getChallengeAnswers });

        const c = counts();
        expect(result.challengeSuccess).to.equal(false);
        expect(result.challengeErrors?.[0]).to.equal("iframe denied");
        expect(c.iframeGetChallengeCount).to.equal(1);
        expect(c.iframeVerifyCount).to.equal(1);
        // C0 failure stands (it has no exclude.challenges of its own); C1 is resolved at verify time
        // because its exclude.challenges = [0] does not match (C0 failed, not succeeded), so
        // getChallenge fires for it.
        expect(c.deferredGetChallengeCount).to.equal(1);
    });

    it("deferred bucket carried in pending response shape", async () => {
        const { iframeFactory, deferredFactory } = buildIframeAndDeferred({ success: true });
        const pkc = PKC() as ReturnType<typeof PKC> & { settings: { challenges: Record<string, unknown> } };
        pkc.settings = { challenges: { "iframe-shape": iframeFactory, "deferred-shape": deferredFactory } };

        const community = {
            settings: {
                challenges: [{ name: "iframe-shape" }, { name: "deferred-shape", exclude: [{ challenges: [0] }] }]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;

        const request = {
            comment: { author: { address: getRandomAddress() } }
        } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: request,
            community
        })) as ChallengeVerificationResult & {
            pendingChallenges?: { index: number }[];
            deferredChallenges?: { index: number }[];
            partialResults?: unknown[];
        };

        expect(result.pendingChallenges?.map((p) => p.index)).to.deep.equal([0]);
        expect(result.deferredChallenges?.map((d) => d.index)).to.deep.equal([1]);
        expect(result.partialResults).to.have.lengthOf(2);
        // Slot 0 is the pending {challenge, verify, type}; slot 1 is undefined (deferred).
        expect(result.partialResults?.[0]).to.have.property("verify");
        expect(result.partialResults?.[1]).to.equal(undefined);
    });
});

// TODO: enable once ignoreChallenge is implemented (see challenge-optional-flag-proposal.md)
describe.skip("cascading challenge fallthrough (whitelist → mintpass → spam-blocker)", () => {
    // These tests reproduce the scenario described in challenge-optional-flag-proposal.md.
    // They simulate a whitelist → mintpass → spam-blocker cascading challenge architecture
    // using mutual exclude.challenges and the proposed ignoreChallenge flag.
    //
    // Challenge setup (mutual exclusion):
    //   C0: whitelist — immediate success/false based on address list
    //        exclude: [{ challenges: [1] }, { challenges: [2] }] — excluded if C1 or C2 passes/pending
    //   C1: mock-nft-check (like mintpass) — success:true if author has wallets.eth, pending iframe if not
    //        exclude: [{ challenges: [0] }, { challenges: [2] }] — excluded if C0 or C2 passes/pending
    //        ignoreChallenge: true — don't show mintpass iframe to user
    //   C2: mock-spam-blocker — always returns pending challenge URL
    //        exclude: [{ challenges: [0] }, { challenges: [1] }] — excluded if C0 or C1 passes

    // Mock challenge: simulates mintpass NFT check (https://github.com/bitsocialnet/mintpass)
    // Returns success:true if author has wallets.eth, pending iframe challenge if not
    const mockNftCheckFactory = () => ({
        getChallenge: async ({
            challengeRequestMessage
        }: {
            challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor;
        }) => {
            const publication = (challengeRequestMessage as unknown as Record<string, unknown>).comment as Record<string, unknown>;
            const author = publication?.author as Record<string, unknown>;
            const wallets = author?.wallets as Record<string, unknown> | undefined;
            if (wallets?.eth) {
                return { success: true as const };
            }
            // No NFT — return pending challenge with iframe URL (like mintpass does)
            return {
                challenge: `https://mintpass.example.com/request/${author?.address}`,
                verify: async (_answer: string) => ({ success: false as const, error: "No NFT found after verification" }),
                type: "url/iframe" as const
            };
        },
        type: "url/iframe",
        description: "Mock NFT check challenge (simulates mintpass)"
    });

    // Mock challenge: simulates spam-blocker (https://github.com/bitsocialnet/spam-blocker)
    // Always returns a pending challenge URL
    const mockSpamBlockerFactory = () => ({
        getChallenge: async () => ({
            challenge: "https://spam-blocker.example.com/verify/session123",
            verify: async (_answer: string) => ({ success: true as const }),
            type: "url/iframe" as const
        }),
        type: "url/iframe",
        description: "Mock spam blocker challenge"
    });

    const whitelistedAuthor = { address: "whitelisted-user.bso" };
    const nftHolderAuthor = { address: "nft-holder.bso", wallets: { eth: { address: "0xabc", signature: "0x..." } } };
    const regularAuthor = { address: `regular-user-${Math.random()}.bso` };

    const createCascadingCommunity = () => {
        const pkc = {
            getComment: () => {},
            createComment: () => {},
            settings: {
                challenges: {
                    "mock-nft-check": mockNftCheckFactory,
                    "mock-spam-blocker": mockSpamBlockerFactory
                }
            }
        };
        return {
            settings: {
                challenges: [
                    // C0: whitelist — excluded if C1 or C2 passes/pending
                    {
                        name: "whitelist",
                        options: { addresses: "whitelisted-user.bso" },
                        exclude: [{ challenges: [1] }, { challenges: [2] }]
                    },
                    // C1: NFT check — excluded if C0 or C2 passes/pending, ignoreChallenge drops iframe
                    {
                        name: "mock-nft-check",
                        ignoreChallenge: true,
                        exclude: [{ challenges: [0] }, { challenges: [2] }]
                    },
                    // C2: spam blocker — excluded if C0 or C1 passes
                    {
                        name: "mock-spam-blocker",
                        exclude: [{ challenges: [0] }, { challenges: [1] }]
                    }
                ]
            },
            _pkc: pkc
        } as unknown as LocalCommunity;
    };

    const createChallengeRequest = (author: Record<string, unknown>) =>
        ({
            ...parsePubsubMsgFixture(validChallengeRequestFixture),
            comment: { ...validCommentIpfsFixture, author }
        }) as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

    it("scenario 1: whitelisted user passes immediately", async () => {
        const community = createCascadingCommunity();
        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: createChallengeRequest(whitelistedAuthor),
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
            challengeErrors?: Record<number, string>;
            pendingChallenges?: unknown[];
        };

        // C0 whitelist succeeds → C1 excluded (C0 passed) → C2 excluded (C0 passed) → overall success
        expect(result.challengeSuccess).to.equal(true);
        expect(result.pendingChallenges).to.equal(undefined);
    });

    it("scenario 2: NFT holder (not whitelisted) should pass via NFT check", async () => {
        const community = createCascadingCommunity();
        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: createChallengeRequest(nftHolderAuthor),
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
            challengeErrors?: Record<number, string>;
            pendingChallenges?: unknown[];
        };

        // C0 fails (not whitelisted) — but excluded by C1 success
        // C1 succeeds (has NFT)
        // C2 excluded (C1 passed)
        // → overall success
        expect(result.challengeSuccess).to.equal(true);
        expect(result.pendingChallenges).to.equal(undefined);
    });

    it("scenario 3: user has neither — should get spam-blocker challenge only (requires ignoreChallenge)", async () => {
        const community = createCascadingCommunity();
        const result = (await getPendingChallengesOrChallengeVerification({
            challengeRequestMessage: createChallengeRequest(regularAuthor),
            community
        })) as ChallengeVerificationResult & {
            challengeSuccess?: boolean;
            challengeErrors?: Record<number, string>;
            pendingChallenges?: Array<{ challenge: string; type: string; index: number }>;
        };

        // C0 fails → excluded by C2 pending (pending excludes non-pending)
        // C1 returns pending iframe → ignoreChallenge drops it (NOT shown to user)
        // C2 runs → user sees spam-blocker URL only
        // This test will FAIL until ignoreChallenge is implemented — currently both C1 and C2 iframes are shown
        expect(result.challengeSuccess).to.equal(undefined);
        expect(result.pendingChallenges?.length).to.equal(1);
        expect(result.pendingChallenges?.[0].challenge).to.equal("https://spam-blocker.example.com/verify/session123");
        expect(result.pendingChallenges?.[0].type).to.equal("url/iframe");
        expect(result.pendingChallenges?.[0].index).to.equal(2);
    });
});

describe("await getCommunityChallengeFromCommunityChallengeSettings", () => {
    // skip these tests when soloing communities
    if (communities.length < 5) {
        return;
    }

    it("has challenge prop", async () => {
        const community = communities.filter((community) => community.title === "password challenge community")[0];
        const { communityChallenge } = await getCommunityChallengeFromCommunityChallengeSettings({
            communityChallengeSettings: community.settings.challenges[0]
        });
        expect(typeof communityChallenge.challenge).to.equal("string");
        expect(communityChallenge.challenge).to.equal(community.settings.challenges[0].options.question);
    });

    it("has description prop", async () => {
        const community = communities.filter((community) => community.title === "text-math challenge community")[0];
        const { communityChallenge } = await getCommunityChallengeFromCommunityChallengeSettings({
            communityChallengeSettings: community.settings.challenges[0]
        });
        expect(typeof communityChallenge.description).to.equal("string");
        expect(communityChallenge.description).to.equal(community.settings.challenges[0].description);
    });

    it("has exclude prop", async () => {
        const community = communities.filter((community) => community.title === "exclude high karma challenge community")[0];
        const { communityChallenge } = await getCommunityChallengeFromCommunityChallengeSettings({
            communityChallengeSettings: community.settings.challenges[0]
        });
        expect(communityChallenge.exclude).to.not.equal(undefined);
        expect(communityChallenge.exclude).to.deep.equal(community.settings.challenges[0].exclude);
    });
});
