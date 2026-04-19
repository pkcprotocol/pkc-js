import {
    mockPKC,
    publishWithExpectedResult,
    generateMockPost,
    resolveWhenConditionIsTrue,
    mockPKCNoDataPathWithOnlyKuboClient
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc, describeIfRpc } from "../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    CommunityChallengeSetting
} from "../../../dist/node/community/types.js";
import type { ChallengeVerificationMessageType, DecryptedChallengeMessageType } from "../../../dist/node/pubsub-messages/types.js";

// A custom challenge factory that asks "What color is the sky?" and accepts "blue"
const customSkyChallenge = ({ challengeSettings }: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
    const type: ChallengeInput["type"] = "text/plain";
    const description = "A custom challenge asking about the sky color.";
    const challenge = "What color is the sky?";

    const getChallenge = async ({
        challengeRequestMessage,
        challengeIndex
    }: GetChallengeArgsInput): Promise<ChallengeInput | ChallengeResultInput> => {
        const challengeAnswer = challengeRequestMessage?.challengeAnswers?.[challengeIndex];

        if (challengeAnswer === undefined) {
            return {
                challenge,
                verify: async (answer: string): Promise<ChallengeResultInput> => {
                    if (answer.toLowerCase() === "blue") return { success: true };
                    return { success: false, error: "Wrong color." };
                },
                type
            };
        }

        if (challengeAnswer.toLowerCase() !== "blue") {
            return { success: false, error: "Wrong color." };
        }
        return { success: true };
    };

    return { getChallenge, type, challenge, description };
};

// A custom challenge factory that overrides the built-in "question" challenge
const overriddenQuestionChallenge = ({ challengeSettings }: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
    const type: ChallengeInput["type"] = "text/plain";
    const description = "Overridden question challenge.";
    const customAnswer = challengeSettings?.options?.answer || "42";

    const getChallenge = async ({
        challengeRequestMessage,
        challengeIndex
    }: GetChallengeArgsInput): Promise<ChallengeInput | ChallengeResultInput> => {
        const challengeAnswer = challengeRequestMessage?.challengeAnswers?.[challengeIndex];

        if (challengeAnswer === undefined) {
            return {
                challenge: "What is the answer to life?",
                verify: async (answer: string): Promise<ChallengeResultInput> => {
                    if (answer === customAnswer) return { success: true };
                    return { success: false, error: "Not the answer to life." };
                },
                type
            };
        }

        if (challengeAnswer !== customAnswer) {
            return { success: false, error: "Not the answer to life." };
        }
        return { success: true };
    };

    return { getChallenge, type, challenge: "What is the answer to life?", description };
};

describe("pkc.settings.challenges", async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
        // Register custom challenges on the pkc instance
        pkc.settings.challenges = {
            "sky-color": customSkyChallenge
        };
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`pkc.settings.challenges is initialized from constructor options`, async () => {
        expect(pkc.settings).to.be.an("object");
        expect(pkc.settings.challenges).to.be.an("object");
        expect(pkc.settings.challenges!["sky-color"]).to.equal(customSkyChallenge);
    });

    it(`pkc.settings.challenges can be modified at runtime`, async () => {
        const newPKC = await mockPKC();
        expect(newPKC.settings.challenges).to.be.undefined;

        newPKC.settings.challenges = { "sky-color": customSkyChallenge };
        expect(newPKC.settings.challenges["sky-color"]).to.equal(customSkyChallenge);

        newPKC.settings.challenges["another-challenge"] = overriddenQuestionChallenge;
        expect(newPKC.settings.challenges["another-challenge"]).to.equal(overriddenQuestionChallenge);
        await newPKC.destroy();
    });

    itSkipIfRpc(`community can use a custom challenge from pkc.settings.challenges`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity;
        const challenges: CommunityChallengeSetting[] = [{ name: "sky-color" }];
        await community.edit({ settings: { challenges } });

        expect(community.settings!.challenges).to.deep.equal(challenges);

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Verify community.challenges reflects the custom challenge
        expect(community.challenges).to.have.length(1);
        expect(community.challenges![0].type).to.equal("text/plain");
        expect(community.challenges![0].description).to.equal("A custom challenge asking about the sky color.");
        expect(community.challenges![0].challenge).to.equal("What color is the sky?");

        // Verify remote community also sees the challenge metadata
        const remoteCommunity = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;
        expect(remoteCommunity.challenges).to.have.length(1);
        expect(remoteCommunity.challenges![0].type).to.equal("text/plain");
        expect(remoteCommunity.challenges![0].description).to.equal("A custom challenge asking about the sky color.");
        expect(remoteCommunity.challenges![0].challenge).to.equal("What color is the sky?");

        await community.delete();
    });

    itSkipIfRpc(`custom challenge correctly verifies pre-answered challenge`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity;
        await community.edit({ settings: { challenges: [{ name: "sky-color" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Publish with correct pre-answer
        const correctPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                challengeRequest: { challengeAnswers: ["blue"] }
            }
        });
        await publishWithExpectedResult({ publication: correctPost, expectedChallengeSuccess: true });

        // Publish with wrong pre-answer
        const challengeVerificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            community.once("challengeverification", resolve)
        );
        const wrongPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                challengeRequest: { challengeAnswers: ["red"] }
            }
        });
        await publishWithExpectedResult({ publication: wrongPost, expectedChallengeSuccess: false });
        const verification = await challengeVerificationPromise;
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors?.["0"]).to.equal("Wrong color.");

        await community.delete();
    });

    itSkipIfRpc(`user-defined challenge shadows a built-in challenge with the same name`, async () => {
        const pkcWithOverride = await mockPKC();
        pkcWithOverride.settings.challenges = {
            question: overriddenQuestionChallenge
        };

        const community = (await pkcWithOverride.createCommunity({})) as LocalCommunity;
        // Use the "question" name — should resolve to the overridden version
        await community.edit({
            settings: { challenges: [{ name: "question", options: { answer: "42" } }] }
        });

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // The overridden challenge should be used
        expect(community.challenges![0].description).to.equal("Overridden question challenge.");
        expect(community.challenges![0].challenge).to.equal("What is the answer to life?");

        // Verify correct answer works
        const correctPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkcWithOverride,
            postProps: {
                challengeRequest: { challengeAnswers: ["42"] }
            }
        });
        await publishWithExpectedResult({ publication: correctPost, expectedChallengeSuccess: true });

        // Verify wrong answer fails
        const verificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            community.once("challengeverification", resolve)
        );
        const wrongPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkcWithOverride,
            postProps: {
                challengeRequest: { challengeAnswers: ["wrong"] }
            }
        });
        await publishWithExpectedResult({ publication: wrongPost, expectedChallengeSuccess: false });
        const verification = await verificationPromise;
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors?.["0"]).to.equal("Not the answer to life.");

        await community.delete();
        await pkcWithOverride.destroy();
    });
});

describeIfRpc("pkc.settings.challenges RPC error handling", async () => {
    it("RPC client throws when setting a challenge name that doesn't exist on the server", async () => {
        const pkc = await mockPKC();
        const community = await pkc.createCommunity({});
        try {
            await community.edit({ settings: { challenges: [{ name: "nonexistent-challenge" }] } });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_RPC_CLIENT_CHALLENGE_NAME_NOT_AVAILABLE_ON_SERVER");
        }
        await community.delete();
        await pkc.destroy();
    });
});
