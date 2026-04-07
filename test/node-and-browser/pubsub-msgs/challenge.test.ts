import signers from "../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    publishRandomPost,
    generatePostToAnswerMathQuestion,
    mockRemotePKC,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

const mathCliCommunityAddress = signers[1].address;

describe.skip(`Stress test challenge exchange`, async () => {
    const num = 50;
    let pkc: PKC, community: RemoteCommunity;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        community = await pkc.getCommunity({ address: signers[0].address });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Initiate ${num} challenge exchange in parallel`, async () => {
        const promises = new Array(num).fill(null).map(() => publishRandomPost({ communityAddress: community.address, pkc: pkc }));
        await Promise.all(promises);
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`math-cli - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it("can post after answering correctly", async function () {
            const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);
            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        });
        it("Throws an error when user fails to solve mathcli captcha", async function () {
            const mockPost = await generateMockPost({
                communityAddress: mathCliCommunityAddress,
                pkc: pkc,
                postProps: { signer: signers[0] }
            });
            mockPost.removeAllListeners();
            mockPost.once("challenge", (challengeMessage: unknown) => {
                mockPost.publishChallengeAnswers(["3"]); // wrong answer
            });
            let challengeverification: { challengeErrors: Record<number, string>; challengeSuccess: boolean } | undefined;
            mockPost.once("challengeverification", (msg) => {
                challengeverification = msg as { challengeErrors: Record<number, string>; challengeSuccess: boolean };
            });
            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: false });
            expect(challengeverification!.challengeErrors).to.deep.equal({ 0: "Wrong answer." });
            expect(challengeverification!.challengeSuccess).to.be.false;
        });
    });
});
