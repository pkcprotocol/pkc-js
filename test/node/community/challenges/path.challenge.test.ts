import { beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    generateMockPost,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import path from "path";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { DecryptedChallengeMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { CommunityChallengeSetting } from "../../../../dist/node/community/types.js";

describeSkipIfRpc.concurrent(`community.settings.challenges with path`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Can use a challenge via path instead of name`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;

        // Use the built question challenge via path instead of name
        const questionChallengePath = path.resolve(
            process.cwd(),
            "dist/node/runtime/node/community/challenges/pkc-js-challenges/question.js"
        );
        const challenges: CommunityChallengeSetting[] = [
            {
                path: questionChallengePath,
                options: { question: "What is 2+2?", answer: "4" }
            }
        ];

        await community.edit({ settings: { challenges } });
        expect(community._usingDefaultChallenge).to.be.false;
        expect(community?.settings?.challenges).to.deep.equal(challenges);

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const remoteCommunity = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;

        expect(community.updatedAt).to.equal(remoteCommunity.updatedAt);
        for (const _community of [community, remoteCommunity]) {
            expect(_community.challenges![0].challenge).to.equal("What is 2+2?");
            expect(_community.challenges![0].description).to.equal("Ask a question, like 'What is the password?'");
            expect(_community.challenges![0].exclude).to.be.undefined;
            expect(_community.challenges![0].type).to.equal("text/plain");
        }

        // Test with correct answer
        const mockPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                challengeRequest: { challengeAnswers: { "0": "4" } }
            }
        });

        expect(mockPost.challengeRequest!.challengeAnswers).to.deep.equal({ "0": "4" });

        let receivedChallenge = false;
        mockPost.once("challenge", () => {
            receivedChallenge = true;
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        expect(receivedChallenge).to.be.false; // Should not receive challenge since answer is correct

        await community.delete();
    });

    // The schema accepts an empty name next to a path, and the challenge's logger is named after it (issue #493)
    it(`A challenge set by path with an empty name still verifies publications`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;
        const questionChallengePath = path.resolve(
            process.cwd(),
            "dist/node/runtime/node/community/challenges/pkc-js-challenges/question.js"
        );
        await community.edit({
            settings: { challenges: [{ path: questionChallengePath, name: "", options: { question: "What is 2+2?", answer: "4" } }] }
        });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const mockPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: { challengeRequest: { challengeAnswers: { "0": "4" } } }
        });
        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        await community.delete();
    });

    it(`Challenge via path sends challenge when answer is wrong`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;

        const questionChallengePath = path.resolve(
            process.cwd(),
            "dist/node/runtime/node/community/challenges/pkc-js-challenges/question.js"
        );
        const challenges: CommunityChallengeSetting[] = [
            {
                path: questionChallengePath,
                options: { question: "What is the capital of France?", answer: "Paris" }
            }
        ];

        await community.edit({ settings: { challenges } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Test with wrong answer
        const mockPost = await generateMockPost({ communityAddress: community.address, pkc: pkc });
        mockPost.removeAllListeners("challenge");

        let challengeReceived = false;
        let challengeData: DecryptedChallengeMessageType | null = null;
        mockPost.once("challenge", async (msg: DecryptedChallengeMessageType) => {
            challengeReceived = true;
            challengeData = msg;
            await mockPost.publishChallengeAnswers({ challengeAnswers: { "0": "London" } });
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: false }); // Should fail due to wrong answer
        expect(challengeReceived).to.be.true; // Should receive challenge since answer was provided but wrong

        expect(challengeData!.challenges[0].challenge).to.equal("What is the capital of France?");
        expect(challengeData!.challenges[0].type).to.equal("text/plain");

        await community.delete();
    });

    it(`Can use multiple challenges with mix of path and name`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;

        const questionChallengePath = path.resolve(
            process.cwd(),
            "dist/node/runtime/node/community/challenges/pkc-js-challenges/question.js"
        );
        const challenges: CommunityChallengeSetting[] = [
            {
                path: questionChallengePath,
                options: { question: "What is 3+3?", answer: "6" }
            },
            {
                name: "question",
                options: { question: "What is 4+4?", answer: "8" }
            }
        ];

        await community.edit({ settings: { challenges } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const remoteCommunity = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;

        for (const _community of [community, remoteCommunity]) {
            expect(_community.challenges).to.have.length(2);
            expect(_community.challenges![0].challenge).to.equal("What is 3+3?");
            expect(_community.challenges![1].challenge).to.equal("What is 4+4?");
        }

        // Test with correct answers for both challenges
        const mockPost = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                challengeRequest: { challengeAnswers: { "0": "6", "1": "8" } }
            }
        });

        let receivedChallenge = false;
        mockPost.once("challenge", () => {
            receivedChallenge = true;
        });

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        expect(receivedChallenge).to.be.false;

        await community.delete();
    });

    it(`Throws error for invalid challenge path when we try to edit community`, async () => {
        const community = (await pkc.createCommunity({})) as LocalCommunity | RpcLocalCommunity;

        const invalidPath = "/path/to/nonexistent/challenge.js";
        const challenges: CommunityChallengeSetting[] = [
            {
                path: invalidPath,
                options: { question: "What is 2+2?", answer: "4" }
            }
        ];

        try {
            await community.edit({ settings: { challenges } });
            expect.fail("Should have thrown an error for invalid path");
        } catch (error) {
            // the import failure is wrapped with the entry it belongs to, the module error kept in details (issue #428)
            const err = error as { code?: string; details?: { path?: string; error?: { code?: string } } };
            expect(err.code).to.equal("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY");
            expect(err.details?.path).to.equal(invalidPath);
            expect(err.details?.error?.code).to.equal("ERR_MODULE_NOT_FOUND");
        }

        await community.delete();
    });
});
