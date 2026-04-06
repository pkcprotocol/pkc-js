import {
    mockPKC,
    publishWithExpectedResult,
    generateMockPost,
    resolveWhenConditionIsTrue,
    itSkipIfRpc,
    mockPKCNoDataPathWithOnlyKuboClient,
    describeIfRpc
} from "../../../dist/node/test/test-util.js";
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

describe("plebbit.settings.challenges", async () => {
    let plebbit: PKCType;
    let remotePKC: PKCType;

    beforeAll(async () => {
        plebbit = await mockPKC();
        // Register custom challenges on the plebbit instance
        plebbit.settings.challenges = {
            "sky-color": customSkyChallenge
        };
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it(`plebbit.settings.challenges is initialized from constructor options`, async () => {
        expect(plebbit.settings).to.be.an("object");
        expect(plebbit.settings.challenges).to.be.an("object");
        expect(plebbit.settings.challenges!["sky-color"]).to.equal(customSkyChallenge);
    });

    it(`plebbit.settings.challenges can be modified at runtime`, async () => {
        const newPKC = await mockPKC();
        expect(newPKC.settings.challenges).to.be.undefined;

        newPKC.settings.challenges = { "sky-color": customSkyChallenge };
        expect(newPKC.settings.challenges["sky-color"]).to.equal(customSkyChallenge);

        newPKC.settings.challenges["another-challenge"] = overriddenQuestionChallenge;
        expect(newPKC.settings.challenges["another-challenge"]).to.equal(overriddenQuestionChallenge);
        await newPKC.destroy();
    });

    itSkipIfRpc(`subplebbit can use a custom challenge from plebbit.settings.challenges`, async () => {
        const subplebbit = (await plebbit.createCommunity({})) as LocalCommunity;
        const challenges: CommunityChallengeSetting[] = [{ name: "sky-color" }];
        await subplebbit.edit({ settings: { challenges } });

        expect(subplebbit.settings!.challenges).to.deep.equal(challenges);

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Verify subplebbit.challenges reflects the custom challenge
        expect(subplebbit.challenges).to.have.length(1);
        expect(subplebbit.challenges![0].type).to.equal("text/plain");
        expect(subplebbit.challenges![0].description).to.equal("A custom challenge asking about the sky color.");
        expect(subplebbit.challenges![0].challenge).to.equal("What color is the sky?");

        // Verify remote sub also sees the challenge metadata
        const remoteSub = (await remotePKC.getCommunity({ address: subplebbit.address })) as RemoteCommunity;
        expect(remoteSub.challenges).to.have.length(1);
        expect(remoteSub.challenges![0].type).to.equal("text/plain");
        expect(remoteSub.challenges![0].description).to.equal("A custom challenge asking about the sky color.");
        expect(remoteSub.challenges![0].challenge).to.equal("What color is the sky?");

        await subplebbit.delete();
    });

    itSkipIfRpc(`custom challenge correctly verifies pre-answered challenge`, async () => {
        const subplebbit = (await plebbit.createCommunity({})) as LocalCommunity;
        await subplebbit.edit({ settings: { challenges: [{ name: "sky-color" }] } });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish with correct pre-answer
        const correctPost = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: {
                challengeRequest: { challengeAnswers: ["blue"] }
            }
        });
        await publishWithExpectedResult({ publication: correctPost, expectedChallengeSuccess: true });

        // Publish with wrong pre-answer
        const challengeVerificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            subplebbit.once("challengeverification", resolve)
        );
        const wrongPost = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: {
                challengeRequest: { challengeAnswers: ["red"] }
            }
        });
        await publishWithExpectedResult({ publication: wrongPost, expectedChallengeSuccess: false });
        const verification = await challengeVerificationPromise;
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors?.["0"]).to.equal("Wrong color.");

        await subplebbit.delete();
    });

    itSkipIfRpc(`user-defined challenge shadows a built-in challenge with the same name`, async () => {
        const plebbitWithOverride = await mockPKC();
        plebbitWithOverride.settings.challenges = {
            question: overriddenQuestionChallenge
        };

        const subplebbit = (await plebbitWithOverride.createCommunity({})) as LocalCommunity;
        // Use the "question" name — should resolve to the overridden version
        await subplebbit.edit({
            settings: { challenges: [{ name: "question", options: { answer: "42" } }] }
        });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // The overridden challenge should be used
        expect(subplebbit.challenges![0].description).to.equal("Overridden question challenge.");
        expect(subplebbit.challenges![0].challenge).to.equal("What is the answer to life?");

        // Verify correct answer works
        const correctPost = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbitWithOverride,
            postProps: {
                challengeRequest: { challengeAnswers: ["42"] }
            }
        });
        await publishWithExpectedResult({ publication: correctPost, expectedChallengeSuccess: true });

        // Verify wrong answer fails
        const verificationPromise = new Promise<ChallengeVerificationMessageType>((resolve) =>
            subplebbit.once("challengeverification", resolve)
        );
        const wrongPost = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbitWithOverride,
            postProps: {
                challengeRequest: { challengeAnswers: ["wrong"] }
            }
        });
        await publishWithExpectedResult({ publication: wrongPost, expectedChallengeSuccess: false });
        const verification = await verificationPromise;
        expect(verification.challengeSuccess).to.equal(false);
        expect(verification.challengeErrors?.["0"]).to.equal("Not the answer to life.");

        await subplebbit.delete();
        await plebbitWithOverride.destroy();
    });
});

describeIfRpc("plebbit.settings.challenges RPC error handling", async () => {
    it("RPC client throws when setting a challenge name that doesn't exist on the server", async () => {
        const plebbit = await mockPKC();
        const subplebbit = await plebbit.createCommunity({});
        try {
            await subplebbit.edit({ settings: { challenges: [{ name: "nonexistent-challenge" }] } });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_RPC_CLIENT_CHALLENGE_NAME_NOT_AVAILABLE_ON_SERVER");
        }
        await subplebbit.delete();
        await plebbit.destroy();
    });
});
