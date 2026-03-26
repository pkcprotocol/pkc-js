import {
    mockPlebbit,
    publishWithExpectedResult,
    generateMockPost,
    resolveWhenConditionIsTrue,
    itSkipIfRpc,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    describeIfRpc
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RemoteSubplebbit } from "../../../dist/node/subplebbit/remote-subplebbit.js";
import type {
    ChallengeFileInput,
    ChallengeInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    SubplebbitChallengeSetting
} from "../../../dist/node/subplebbit/types.js";
import type { ChallengeVerificationMessageType, DecryptedChallengeMessageType } from "../../../dist/node/pubsub-messages/types.js";

// A custom challenge factory that asks "What color is the sky?" and accepts "blue"
const customSkyChallenge = ({ challengeSettings }: { challengeSettings: SubplebbitChallengeSetting }): ChallengeFileInput => {
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
const overriddenQuestionChallenge = ({ challengeSettings }: { challengeSettings: SubplebbitChallengeSetting }): ChallengeFileInput => {
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
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        // Register custom challenges on the plebbit instance
        plebbit.settings.challenges = {
            "sky-color": customSkyChallenge
        };
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`plebbit.settings.challenges is initialized from constructor options`, async () => {
        expect(plebbit.settings).to.be.an("object");
        expect(plebbit.settings.challenges).to.be.an("object");
        expect(plebbit.settings.challenges!["sky-color"]).to.equal(customSkyChallenge);
    });

    it(`plebbit.settings.challenges can be modified at runtime`, async () => {
        const newPlebbit = await mockPlebbit();
        expect(newPlebbit.settings.challenges).to.be.undefined;

        newPlebbit.settings.challenges = { "sky-color": customSkyChallenge };
        expect(newPlebbit.settings.challenges["sky-color"]).to.equal(customSkyChallenge);

        newPlebbit.settings.challenges["another-challenge"] = overriddenQuestionChallenge;
        expect(newPlebbit.settings.challenges["another-challenge"]).to.equal(overriddenQuestionChallenge);
        await newPlebbit.destroy();
    });

    itSkipIfRpc(`subplebbit can use a custom challenge from plebbit.settings.challenges`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit;
        const challenges: SubplebbitChallengeSetting[] = [{ name: "sky-color" }];
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
        const remoteSub = (await remotePlebbit.getSubplebbit({ address: subplebbit.address })) as RemoteSubplebbit;
        expect(remoteSub.challenges).to.have.length(1);
        expect(remoteSub.challenges![0].type).to.equal("text/plain");
        expect(remoteSub.challenges![0].description).to.equal("A custom challenge asking about the sky color.");
        expect(remoteSub.challenges![0].challenge).to.equal("What color is the sky?");

        await subplebbit.delete();
    });

    itSkipIfRpc(`custom challenge correctly verifies pre-answered challenge`, async () => {
        const subplebbit = (await plebbit.createSubplebbit({})) as LocalSubplebbit;
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
        const plebbitWithOverride = await mockPlebbit();
        plebbitWithOverride.settings.challenges = {
            question: overriddenQuestionChallenge
        };

        const subplebbit = (await plebbitWithOverride.createSubplebbit({})) as LocalSubplebbit;
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
        const plebbit = await mockPlebbit();
        const subplebbit = await plebbit.createSubplebbit({});
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
