import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    getAvailablePKCConfigsToTestAgainst,
    mockCommentToNotUsePagesForUpdates,
    createCommentUpdateWithInvalidSignature,
    resolveWhenConditionIsTrue,
    mockPostToReturnSpecificCommentUpdate,
    createStaticCommunityRecordForComment
} from "../../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe.concurrent(`comment.clients.ipfsGateways - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });
        // All tests below use PKC instance that doesn't have clients.kuboRpcClients
        it(`comment.clients.ipfsGateways[url] is stopped by default`, async () => {
            const mockPost = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            expect(Object.keys(mockPost.clients.ipfsGateways).length).to.equal(1);
            expect(Object.values(mockPost.clients.ipfsGateways)[0].state).to.equal("stopped");
        });

        it.sequential(
            `Correct order of ipfsGateways state when updating a comment that was created with pkc.createComment({cid})`,
            async () => {
                const sub = await pkc.getCommunity({ address: signers[0].address });

                const mockPost = await pkc.createComment({ cid: sub.posts.pages.hot.comments[0].cid });
                const expectedStates = ["fetching-ipfs", "stopped", "fetching-community-ipns", "fetching-update-ipfs", "stopped"];

                const actualStates: string[] = [];

                const gatewayUrl = Object.keys(mockPost.clients.ipfsGateways)[0];

                mockPost.clients.ipfsGateways[gatewayUrl].on("statechange", (newState) => actualStates.push(newState));

                await mockPost.update();
                mockCommentToNotUsePagesForUpdates(mockPost);
                await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.upvoteCount === "number" });
                await mockPost.stop();

                expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

                const remainingStates = actualStates.slice(expectedStates.length);
                for (const state of remainingStates) {
                    expect(state).to.be.oneOf(["fetching-community-ipns", "fetching-update-ipfs", "stopped"]);
                }
            }
        );

        it(`Correct order of ipfsGateways state when updating a comment that was created with pkc.getComment({cid: cid})`, async () => {
            const sub = await pkc.getCommunity({ address: signers[0].address });

            const mockPost = await pkc.getComment({ cid: sub.posts.pages.hot.comments[0].cid });

            const expectedStates = ["fetching-community-ipns", "fetching-update-ipfs", "stopped"];

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(mockPost.clients.ipfsGateways)[0];

            mockPost.clients.ipfsGateways[gatewayUrl].on("statechange", (newState) => actualStates.push(newState));

            await mockPost.update();
            mockCommentToNotUsePagesForUpdates(mockPost);
            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.upvoteCount === "number" });
            await mockPost.stop();

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it.sequential(`Correct order of ipfsGateways state when publishing a comment (uncached community)`, async () => {
            const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

            mockPost._getCommunityCache = (): ReturnType<typeof mockPost._getCommunityCache> => undefined;

            const expectedStates = ["fetching-community-ipns", "stopped"];

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(mockPost.clients.ipfsGateways)[0];
            mockPost.clients.ipfsGateways[gatewayUrl].on("statechange", (newState) => actualStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ipfsGateways state when publishing a comment (cached community)`, async () => {
            const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

            const expectedStates: string[] = []; // Should be empty since we're using cached community

            const actualStates: string[] = [];

            const gatewayUrl = Object.keys(mockPost.clients.ipfsGateways)[0];
            mockPost.clients.ipfsGateways[gatewayUrl].on("statechange", (newState) => actualStates.push(newState));

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of ipfs gateway clients state when we update a comment but its community is not publishing new updates`, async () => {
            const pkc: PKC = await config.pkcInstancePromise();
            try {
                const { commentCid } = await createStaticCommunityRecordForComment({ pkc: pkc });

                const mockPost = await pkc.createComment({ cid: commentCid });

                const recordedStates: string[] = [];
                const errors: (Error | PKCError)[] = [];

                const gatewayUrl = Object.keys(mockPost.clients.ipfsGateways)[0];

                mockPost.clients.ipfsGateways[gatewayUrl].on("statechange", (newState) => recordedStates.push(newState));
                mockPost.on("error", (err) => errors.push(err));

                await mockPost.update();
                mockCommentToNotUsePagesForUpdates(mockPost);

                await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => errors.length >= 1, eventName: "error" });

                await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 4));

                await mockPost.stop();

                expect(errors.length).to.be.at.least(1);

                const expectedFirstStates = ["fetching-ipfs", "stopped", "fetching-community-ipns"];
                expect(recordedStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

                const noNewUpdateStates = recordedStates.slice(expectedFirstStates.length, recordedStates.length);

                for (let i = 0; i < noNewUpdateStates.length; i += 1) {
                    expect(noNewUpdateStates[i]).to.be.oneOf(["fetching-community-ipns", "fetching-update-ipfs", "stopped"]);
                }
            } finally {
                await pkc.destroy();
            }
        });

        it(`Correct order of ipfs gateway states when we update a comment but its commentupdate is an invalid record (bad signature/schema/etc)`, async () => {
            const pkc: PKC = await config.pkcInstancePromise();

            const sub = await pkc.getCommunity({ address: signers[0].address });

            const commentUpdateWithInvalidSignatureJson = await createCommentUpdateWithInvalidSignature(
                sub.posts.pages.hot.comments[0].cid
            );

            const createdComment = await pkc.createComment({
                cid: commentUpdateWithInvalidSignatureJson.cid
            });

            const ipfsGatewayStates: string[] = [];
            const kuboGatewayUrl = Object.keys(createdComment.clients.ipfsGateways)[0];
            createdComment.clients.ipfsGateways[kuboGatewayUrl].on("statechange", (state) => ipfsGatewayStates.push(state));

            const createErrorPromise = () => new Promise((resolve) => createdComment.once("error", resolve));
            await createdComment.update();

            mockPostToReturnSpecificCommentUpdate(createdComment, JSON.stringify(commentUpdateWithInvalidSignatureJson));

            await createErrorPromise();

            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 3));
            await createdComment.stop();

            expect(createdComment.updatedAt).to.be.undefined; // should not accept the comment update
            const expectedIpfsGatewayStates = [
                "fetching-ipfs", // fetching comment-ipfs
                "stopped",
                "fetching-community-ipns", // fetching community + comment update
                "fetching-update-ipfs",
                "stopped"
            ];

            expect(ipfsGatewayStates.slice(0, expectedIpfsGatewayStates.length)).to.deep.equal(expectedIpfsGatewayStates);

            const restOfIpfsStates = ipfsGatewayStates.slice(expectedIpfsGatewayStates.length, ipfsGatewayStates.length);
            for (let i = 0; i < restOfIpfsStates.length; i += 2) {
                if (restOfIpfsStates[i] === "fetching-community-ipns" && restOfIpfsStates[i + 1] === "fetching-community-ipfs") {
                    expect(restOfIpfsStates[i + 2]).to.equal("fetching-update-ipfs"); // this should be the second attempt to load invalid CommentUpdate
                    expect(restOfIpfsStates[i + 3]).to.equal("stopped");
                }
            }
            expect(ipfsGatewayStates[ipfsGatewayStates.length - 1]).to.equal("stopped");
            await pkc.destroy();
        });
    });
});
