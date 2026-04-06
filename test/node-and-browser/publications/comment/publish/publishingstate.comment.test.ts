import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    isPKCFetchingUsingGateways,
    generatePostToAnswerMathQuestion,
    publishCommunityRecordWithExtraProp,
    getAvailablePKCConfigsToTestAgainst,
    createNewIpns,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";

// Helper type for accessing private properties on Comment
type CommentWithInternals = {
    _publishToDifferentProviderThresholdSeconds: number;
    _setProviderFailureThresholdSeconds: number;
    _challengeExchanges: Record<string, unknown>;
};
const communityAddress = signers[0].address;
const mathCliCommunityAddress = signers[1].address;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe(`comment.publishingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });
        it(`comment.publishingState stays as stopped after calling comment.update() - IPFS client`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const commentCid = sub.posts.pages.hot.comments[0].cid;
            const comment = await pkc.createComment({ cid: commentCid });
            expect(comment.publishingState).to.equal("stopped");
            comment.on("publishingstatechange", (newState: string) => {
                if (newState !== "stopped") expect.fail("Should not change publishing state");
            });
            await comment.update();
            await new Promise((resolve) => comment.once("update", resolve)); // comment ipfs
            await new Promise((resolve) => comment.once("update", resolve)); // comment update
            await comment.stop();
        });

        it(`publishing states is in correct order upon publishing a comment with IPFS client (uncached)`, async () => {
            const expectedStates = [
                "fetching-community-ipns",
                "fetching-community-ipfs",
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-answer",
                "waiting-challenge-verification",
                "succeeded"
            ];
            const recordedStates: string[] = [];
            const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);
            mockPost._getCommunityCache = (): ReturnType<typeof mockPost._getCommunityCache> => undefined;

            mockPost.on("publishingstatechange", (newState: string) => recordedStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(recordedStates).to.deep.equal(expectedStates);
        });

        it(`publishing states is in correct order upon publishing a comment with IPFS client (cached)`, async () => {
            const expectedStates = [
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-answer",
                "waiting-challenge-verification",
                "succeeded"
            ];
            const recordedStates: string[] = [];
            const mathCliCommunityAddress = signers[1].address;
            await pkc.getCommunity({ address: mathCliCommunityAddress }); // address of math cli, we fetch it here to make sure it's cached
            const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);

            mockPost.on("publishingstatechange", (newState: string) => recordedStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(recordedStates).to.deep.equal(expectedStates);
        });

        it(`publishing states is in correct order upon publishing a comment to plebbit.bso with IPFS client (uncached)`, async () => {
            const expectedStates = [
                "resolving-community-name",
                "fetching-community-ipns",
                "fetching-community-ipfs",
                "publishing-challenge-request",
                "waiting-challenge",
                "succeeded"
            ];
            const recordedStates: string[] = [];
            const mockPost = await generateMockPost({ communityAddress: "plebbit.bso", plebbit: pkc });
            mockPost._getCommunityCache = (): ReturnType<typeof mockPost._getCommunityCache> => undefined;

            mockPost.on("publishingstatechange", (newState: string) => recordedStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(recordedStates).to.deep.equal(expectedStates);
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc"] }).map((config) => {
    describe.concurrent(`comment.publishingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`comment.publishingState = 'failed' if pubsub provider is down`, async () => {
            const offlinePubsubUrl = "http://localhost:23425";
            const offlinePubsubPKC = await config.plebbitInstancePromise({
                plebbitOptions: { pubsubKuboRpcClientsOptions: [offlinePubsubUrl] }
            });
            offlinePubsubPKC.on("error", () => {});
            const mockPost = await generateMockPost({ communityAddress: signers[1].address, plebbit: offlinePubsubPKC });

            try {
                await mockPost.publish();
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS");
            }

            expect(mockPost.publishingState).to.equal("failed");
            expect(mockPost.clients.pubsubKuboRpcClients[offlinePubsubUrl].state).to.equal("stopped");
            await offlinePubsubPKC.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`comment.publishingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`comment.publishingState stays as stopped after calling comment.update() - IPFS Gateway`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const commentCid = sub.posts.pages.hot.comments[0].cid;
            const comment = await pkc.createComment({ cid: commentCid });
            expect(comment.publishingState).to.equal("stopped");
            comment.on("publishingstatechange", (newState: string) => {
                if (newState !== "stopped") expect.fail("Should not change publishing state");
            });
            await comment.update();
            await new Promise((resolve) => comment.once("update", resolve)); // comment ipfs
            await new Promise((resolve) => comment.once("update", resolve)); // comment update
            await comment.stop();
        });

        it(`publishing states is in correct order upon publishing a comment with gateway (cached)`, async () => {
            const expectedStates = [
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-answer",
                "waiting-challenge-verification",
                "succeeded"
            ];
            const recordedStates: string[] = [];
            await pkc.getCommunity({ address: mathCliCommunityAddress }); // Make sure it's cached
            const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);

            mockPost.on("publishingstatechange", (newState: string) => recordedStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(recordedStates).to.deep.equal(expectedStates);
        });

        it(`publishing states is in correct order upon publishing a comment with gateway (uncached)`, async () => {
            const expectedStates = [
                "fetching-community-ipns",
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-answer",
                "waiting-challenge-verification",
                "succeeded"
            ];
            const recordedStates: string[] = [];
            const mockPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliCommunityAddress }, pkc);
            mockPost._getCommunityCache = (): ReturnType<typeof mockPost._getCommunityCache> => undefined;

            mockPost.on("publishingstatechange", (newState: string) => recordedStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(recordedStates).to.deep.equal(expectedStates);
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`comment.publishingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`publishingState is stopped by default`, async () => {
            const comment = await generateMockPost({ communityAddress: communityAddress, plebbit: pkc });
            expect(comment.publishingState).to.equal("stopped");
        });

        it(`comment.publishingState = 'failed' if user provide incorrect answer`, async () => {
            const mockPost = await generateMockPost({ communityAddress: mathCliCommunityAddress, plebbit: pkc });
            mockPost.removeAllListeners("challenge");

            mockPost.once("challenge", async (challengeMsg) => {
                expect(challengeMsg?.challenges[0]?.challenge).to.be.a("string");
                await mockPost.publishChallengeAnswers(["12345"]); // Wrong answer here
            });

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: false });

            expect(mockPost.publishingState).to.equal("failed");
            await mockPost.stop();
        });

        it(`publishing state is set correctly if publish() is thrown`, async () => {
            const ipnsObj = await createNewIpns();

            await ipnsObj.publishToIpns("<html></html>");

            const mockPost = await generateMockPost({ communityAddress: ipnsObj.signer.address, plebbit: pkc });

            const recordedPublishingStates: string[] = [];

            mockPost.on("publishingstatechange", (newState: string) => recordedPublishingStates.push(newState));

            try {
                await mockPost.publish();
                expect.fail("Should have thrown");
            } catch (e) {
                expect(mockPost.publishingState).to.equal("failed");
            }

            if (!isPKCFetchingUsingGateways(pkc))
                expect(recordedPublishingStates).to.deep.equal(["fetching-community-ipns", "fetching-community-ipfs", "failed"]);
            else expect(recordedPublishingStates).to.deep.equal(["fetching-community-ipns", "failed"]);

            await ipnsObj.plebbit.destroy();

            await mockPost.stop();
        });

        it(`order of publishingState-error-publishingstatechange is correct`, async () => {
            // need to create a mock sub with pubsub topic that's not responding
            // that way we will force the error to be thrown for both rpc and other configs

            const mockedSub = await publishCommunityRecordWithExtraProp();

            const mockPost = await generateMockPost({ communityAddress: mockedSub.ipnsObj.signer.address, plebbit: pkc });
            (mockPost as unknown as CommentWithInternals)._publishToDifferentProviderThresholdSeconds = 1;
            (mockPost as unknown as CommentWithInternals)._setProviderFailureThresholdSeconds = 2;

            const recordedPublishingStates: string[] = [];

            mockPost.on("publishingstatechange", (newState: string) => recordedPublishingStates.push(newState));

            const errorPromise = new Promise<void>((resolve, reject) => {
                mockPost.on("error", () => {
                    if (mockPost.publishingState !== "failed") reject("publishing state should be failed after getting the error");
                    if (recordedPublishingStates.length === 0) reject("should have emitted a publishingstatechange event");
                    if (recordedPublishingStates[recordedPublishingStates.length - 1] === "failed")
                        reject("should not emit an event just yet");
                    resolve();
                });
            });

            await mockPost.publish();
            await errorPromise;
            await resolveWhenConditionIsTrue({
                toUpdate: mockPost,
                predicate: async () => recordedPublishingStates[recordedPublishingStates.length - 1] === "failed",
                eventName: "publishingstatechange"
            });

            expect(mockPost.publishingState).to.equal("failed");
            const expectedPublishingState = ["fetching-community-ipns"].concat(
                ...(isPKCFetchingUsingGateways(pkc) ? [] : ["fetching-community-ipfs"]),
                ...new Array(Object.keys((mockPost as unknown as CommentWithInternals)._challengeExchanges).length).fill([
                    "publishing-challenge-request",
                    "waiting-challenge"
                ]),
                "failed"
            );
            expect(recordedPublishingStates).to.deep.equal(expectedPublishingState);
            await mockedSub.ipnsObj.plebbit.destroy();
            await mockPost.stop();
        });
    });
});
