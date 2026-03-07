import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    getAvailablePlebbitConfigsToTestAgainst,
    waitTillPostInSubplebbitPages
} from "../../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../../dist/node/plebbit/plebbit.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-plebbit-rpc"] }).map((config) => {
    describe(`comment.clients.plebbitRpcClients`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Correct order of comment.clients.plebbitRpcClients states when publishing to a sub with challenge`, async () => {
            const mathCliSubplebbitAddress = signers[1].address;

            await plebbit.getSubplebbit({ address: mathCliSubplebbitAddress }); // Do this to cache subplebbit so we won't get fetching-subplebbit-ipns

            const rpcUrl = Object.keys(plebbit.clients.plebbitRpcClients)[0];
            const mockPost = await generateMockPost({ subplebbitAddress: mathCliSubplebbitAddress, plebbit: plebbit });
            mockPost.removeAllListeners();

            const expectedStates = [
                "subscribing-pubsub",
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-answer",
                "waiting-challenge-verification",
                "stopped"
            ];

            const actualStates: string[] = [];

            mockPost.clients.plebbitRpcClients[rpcUrl].on("statechange", (newState: string) => actualStates.push(newState));

            mockPost.once("challenge", async (challengeMsg) => {
                await mockPost.publishChallengeAnswers(["2"]); // hardcode answer here
            });

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of comment.clients.plebbitRpcClients states when updating a comment`, async () => {
            const mockPost = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
            await waitTillPostInSubplebbitPages(mockPost as CommentIpfsWithCidDefined, plebbit);
            const postToUpdate = await plebbit.createComment({ cid: mockPost.cid });

            const recordedStates: string[] = [];
            const currentRpcUrl = Object.keys(plebbit.clients.plebbitRpcClients)[0];
            postToUpdate.clients.plebbitRpcClients[currentRpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await postToUpdate.update();

            await new Promise((resolve) => postToUpdate.once("update", resolve)); // CommentIpfs update
            await new Promise((resolve) => postToUpdate.once("update", resolve)); // CommentUpdate update
            await postToUpdate.stop();

            expect(postToUpdate.depth).to.be.a("number");
            expect(postToUpdate.updatedAt).to.be.a("number");

            if (recordedStates.length === 2) expect(recordedStates).to.deep.equal(["fetching-ipfs", "stopped"]);
            else {
                expect(recordedStates.slice(0, 4)).to.deep.equal([
                    "fetching-ipfs",
                    "stopped",
                    "fetching-subplebbit-ipns",
                    "fetching-subplebbit-ipfs"
                ]);

                if (recordedStates.length === 5)
                    // the rpc server did not fetch update-ipfs
                    expect(recordedStates.slice(4)).to.deep.equal(["stopped"]);
                else expect(recordedStates.slice(4)).to.deep.equal(["fetching-update-ipfs", "stopped"]);
            }
        });
    });
});
