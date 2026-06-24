import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    getAvailablePKCConfigsToTestAgainst,
    waitTillPostInCommunityPages,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    describe(`comment.clients.pkcRpcClients`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Correct order of comment.clients.pkcRpcClients states when publishing to a sub with challenge`, async () => {
            const mathCliCommunityAddress = signers[1].address;

            await pkc.getCommunity({ address: mathCliCommunityAddress }); // Do this to cache community so we won't get fetching-community-ipns

            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const mockPost = await generateMockPost({ communityAddress: mathCliCommunityAddress, pkc: pkc });
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

            mockPost.clients.pkcRpcClients[rpcUrl].on("statechange", (newState: string) => actualStates.push(newState));

            mockPost.once("challenge", async (challengeMsg) => {
                await mockPost.publishChallengeAnswers({ challengeAnswers: ["2"] }); // hardcode answer here
            });

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of comment.clients.pkcRpcClients states when updating a comment`, async () => {
            const mockPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await waitTillPostInCommunityPages(mockPost as Comment & { cid: string }, pkc);
            const postToUpdate = await pkc.createComment({ cid: mockPost.cid });

            const recordedStates: string[] = [];
            const currentRpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            postToUpdate.clients.pkcRpcClients[currentRpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await postToUpdate.update();
            await resolveWhenConditionIsTrue({
                toUpdate: postToUpdate,
                predicate: async () => Boolean(postToUpdate.raw.comment && postToUpdate.raw.commentUpdate)
            });
            await postToUpdate.stop();

            expect(postToUpdate.depth).to.be.a("number");
            expect(postToUpdate.updatedAt).to.be.a("number");

            // The RPC server emits one "fetching-*" state per remote fetch it actually performs, each
            // followed by the client returning to "stopped". Which fetches happen depends on what the
            // server already has cached when update() runs, so the exact sequence is non-deterministic:
            //   - CommentIpfs found in the community's cached pages -> skips "fetching-ipfs"
            //   - community already cached                          -> skips the "fetching-community-*" pair
            //   - CommentUpdate already cached                      -> skips "fetching-update-ipfs"
            // Asserting an exact sequence keyed on length is therefore inherently racy (e.g. a warm
            // pages cache yields ["fetching-update-ipfs", "stopped"]). Instead assert the recorded
            // "fetching-*" states appear in canonical order and the stream ends with "stopped".
            const canonicalFetchOrder = ["fetching-ipfs", "fetching-community-ipns", "fetching-community-ipfs", "fetching-update-ipfs"];

            expect(recordedStates.length, "should record at least one state").to.be.greaterThan(0);
            expect(recordedStates[recordedStates.length - 1], "last recorded state should be stopped").to.equal("stopped");

            const fetchStates = recordedStates.filter((state) => state !== "stopped");
            for (const state of fetchStates) expect(canonicalFetchOrder, `unexpected state: ${state}`).to.include(state);

            const fetchOrderIndices = fetchStates.map((state) => canonicalFetchOrder.indexOf(state));
            expect(fetchOrderIndices, "fetching states should be emitted in canonical order").to.deep.equal(
                [...fetchOrderIndices].sort((a, b) => a - b)
            );
        });
    });
});
