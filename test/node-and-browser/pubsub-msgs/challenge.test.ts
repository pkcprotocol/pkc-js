import signers from "../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    publishRandomPost,
    generatePostToAnswerMathQuestion,
    mockRemotePlebbit,
    getAvailablePlebbitConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { RemoteSubplebbit } from "../../../dist/node/subplebbit/remote-subplebbit.js";

const mathCliSubplebbitAddress = signers[1].address;

describe.skip(`Stress test challenge exchange`, async () => {
    const num = 50;
    let plebbit: Plebbit, subplebbit: RemoteSubplebbit;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Initiate ${num} challenge exchange in parallel`, async () => {
        const promises = new Array(num)
            .fill(null)
            .map(() => publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit }));
        await Promise.all(promises);
    });
});

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`math-cli - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it("can post after answering correctly", async function () {
            const mockPost = await generatePostToAnswerMathQuestion({ subplebbitAddress: mathCliSubplebbitAddress }, plebbit);
            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        });
        it("Throws an error when user fails to solve mathcli captcha", async function () {
            const mockPost = await generateMockPost({
                subplebbitAddress: mathCliSubplebbitAddress,
                plebbit: plebbit,
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
