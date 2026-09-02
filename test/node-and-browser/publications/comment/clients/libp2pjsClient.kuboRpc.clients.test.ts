import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    getAvailablePKCConfigsToTestAgainst,
    mockGatewayPKC,
    createCommentUpdateWithInvalidSignature,
    mockCommentToNotUsePagesForUpdates,
    resolveWhenConditionIsTrue,
    mockPostToReturnSpecificCommentUpdate,
    publishStaticCommunityWithPostInPages
} from "../../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";

type ClientsRecord = Record<string, Record<string, { on: (event: string, handler: (state: string) => void) => void; state: string }>>;

const communityAddress = signers[0].address;

const clientsFieldName: Record<string, string> = {
    "remote-libp2pjs": "libp2pJsClients",
    "remote-kubo-rpc": "kuboRpcClients"
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describe(`comment.clients.${clientFieldName} - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`comment.clients.${clientFieldName} is undefined for gateway pkc`, async () => {
            const gatewayPKC = await mockGatewayPKC();
            const mockPost = await generateMockPost({ communityAddress: communityAddress, pkc: gatewayPKC });
            expect((mockPost.clients as Record<string, unknown>)[clientFieldName]).to.be.undefined;
            await gatewayPKC.destroy();
        });

        it(`comment.clients.${clientFieldName}[key] is stopped by default`, async () => {
            const mockPost = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            expect(Object.keys(mockPost.clients[clientFieldName as keyof typeof mockPost.clients]).length).to.equal(1);
            expect(
                (Object.values(mockPost.clients[clientFieldName as keyof typeof mockPost.clients])[0] as { state: string }).state
            ).to.equal("stopped");
        });

        it(`Correct order of ${clientFieldName} state when updating a post that was created with pkc.createComment({cid})`, async () => {
            // A STATIC community (fresh key, published once) instead of the shared live
            // signers[0]: this asserts the WHOLE state sequence with deep.equal, so a new
            // signers[0] record published by any concurrently-running suite mid-test inserts a
            // community fetch cycle anywhere in the array (arrival-driven update loop, issue
            // #308) and fails it — the PR #311 CI flake class.
            const staticCommunity = await publishStaticCommunityWithPostInPages();
            const mockPost = await pkc.createComment({ cid: staticCommunity.commentCid });

            const expectedStates = [
                "fetching-ipfs",
                "stopped",
                "fetching-community-ipns",
                "fetching-community-ipfs",
                "stopped",
                "fetching-update-ipfs",
                "stopped"
            ];

            const actualStates: string[] = [];

            const keyOfClient = Object.keys((mockPost.clients as unknown as ClientsRecord)[clientFieldName])[0];

            (mockPost.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (newState: string) =>
                actualStates.push(newState)
            );

            await mockPost.update();
            mockCommentToNotUsePagesForUpdates(mockPost);

            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.upvoteCount === "number" });
            await mockPost.stop();

            expect(actualStates).to.deep.equal(expectedStates);
            await staticCommunity.ipnsObj.pkc.destroy();
        });

        it(`Correct order of ${clientFieldName} state when updating a reply that was created with pkc.createComment({cid}) and the post has a single preloaded page`, async () => {
            const pkc: PKC = await config.pkcInstancePromise();
            const community = await pkc.getCommunity({ address: signers[0].address });
            const replyCid = community.posts.pages.hot.comments.find((post) => post.replies).replies.pages.best.comments[0].cid;
            const reply = await pkc.createComment({ cid: replyCid });

            const expectedStates = [
                "fetching-ipfs", // fetching comment ipfs of reply
                "stopped",
                "fetching-ipfs", // fetching comment-ipfs of post
                "stopped",
                "fetching-community-ipns",
                "fetching-community-ipfs",
                "stopped"
            ];

            const actualStates: string[] = [];

            const keyOfClient = Object.keys((reply.clients as unknown as ClientsRecord)[clientFieldName])[0];

            (reply.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (newState: string) =>
                actualStates.push(newState)
            );

            await reply.update();

            await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });
            await reply.stop();

            expect(actualStates).to.deep.equal(expectedStates);
            await pkc.destroy();
        });

        it(
            `Correct order of ${clientFieldName} state when updating a reply that was created with pkc.createComment({cid}) and the post has multiple pages`
        );

        it(`Correct order of ${clientFieldName} state when updating a post that was created with pkc.getComment({cid: cid})`, async () => {
            // A STATIC community (fresh key, published once) instead of the shared live
            // signers[0]: this asserts the WHOLE state sequence with deep.equal, so a new
            // signers[0] record published by any concurrently-running suite mid-test inserts a
            // community fetch cycle anywhere in the array (arrival-driven update loop, issue
            // #308) and fails it — the PR #311 CI flake class.
            const staticCommunity = await publishStaticCommunityWithPostInPages();

            const mockPost = await pkc.getComment({ cid: staticCommunity.commentCid });

            const expectedStates = ["fetching-community-ipns", "fetching-community-ipfs", "stopped", "fetching-update-ipfs", "stopped"];

            const actualStates: string[] = [];

            const keyOfClient = Object.keys((mockPost.clients as unknown as ClientsRecord)[clientFieldName])[0];

            (mockPost.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (newState: string) =>
                actualStates.push(newState)
            );

            await mockPost.update();
            mockCommentToNotUsePagesForUpdates(mockPost);
            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.updatedAt === "number" });
            await mockPost.stop();

            expect(actualStates).to.deep.equal(expectedStates);
            await staticCommunity.ipnsObj.pkc.destroy();
        });

        it(`Correct order of ${clientFieldName} state when updating a reply that was created with pkc.getComment({cid: cid})`);

        it(`Correct order of ${clientFieldName} state when publishing a comment (uncached)`, async () => {
            const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });
            mockPost._getCommunityCache = (): ReturnType<typeof mockPost._getCommunityCache> => undefined;
            const expectedStates = ["fetching-community-ipns", "fetching-community-ipfs", "stopped"];

            const actualStates: string[] = [];

            const keyOfClient = Object.keys((mockPost.clients as unknown as ClientsRecord)[clientFieldName])[0];

            (mockPost.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (newState: string) =>
                actualStates.push(newState)
            );

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`Correct order of ${clientFieldName} state when publishing a comment (cached)`, async () => {
            const mockPost = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

            const actualStates: string[] = [];

            const keyOfClient = Object.keys((mockPost.clients as unknown as ClientsRecord)[clientFieldName])[0];

            (mockPost.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (newState: string) =>
                actualStates.push(newState)
            );

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

            if (config.testConfigCode === "remote-kubo-rpc") {
                expect(actualStates).to.deep.equal([]); // it's empty because we're not fetching anything due to caching
            } else if (config.testConfigCode === "remote-libp2pjs") {
                expect(actualStates).to.deep.equal(["subscribing-pubsub", "publishing-challenge-request", "waiting-challenge", "stopped"]); // libp2pjs will publish and include its states
            } else {
                expect.fail("Unexpected test config code");
            }
        });

        it(`Correct order of ${clientFieldName} when we update a post but its community is not publishing new community records`, async () => {
            const customPKC = await config.pkcInstancePromise();

            // A STATIC community under its own fresh IPNS key, published exactly once: the title's
            // "not publishing new community records" is literal, no resolve stubbing needed. It
            // must NOT be a shared live community (signers[0]): every concurrent suite publishes
            // there, and since the update loop reacts to gossip arrivals (issue #308) each of
            // those publishes would start a fetch cycle at a random moment, racing the exact
            // state-sequence assertions below (the PR #311 CI flake).
            const staticCommunity = await publishStaticCommunityWithPostInPages();

            const community = await customPKC.createCommunity({ address: staticCommunity.communityAddress });

            // now pkc._updatingCommunities will be defined

            const updatePromise = new Promise((resolve) => community.once("update", resolve));
            await community.update();
            await updatePromise;

            const mockPost = await customPKC.createComment({ cid: community.posts.pages.hot.comments[0].cid });

            const recordedStates: string[] = [];

            const keyOfClient = Object.keys((mockPost.clients as unknown as ClientsRecord)[clientFieldName])[0];

            (mockPost.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (newState: string) =>
                recordedStates.push(newState)
            );

            await mockPost.update();
            mockCommentToNotUsePagesForUpdates(mockPost);

            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.updatedAt === "number" });

            await new Promise((resolve) => setTimeout(resolve, customPKC.updateInterval * 4));

            await mockPost.stop();

            const expectedFirstStates = ["fetching-update-ipfs", "stopped"]; // CommentIpfs is already loaded from updating community preloaded pages
            expect(recordedStates.slice(0, expectedFirstStates.length)).to.deep.equal(expectedFirstStates);

            const noNewUpdateStates = recordedStates.slice(expectedFirstStates.length, recordedStates.length); // should be just 'fetching-ipns' and 'succeeded

            // the rest should be just ["fetching-community-ipns", "stopped"]
            // because it can't find a new record
            for (let i = 0; i < noNewUpdateStates.length; i += 2) {
                expect(noNewUpdateStates[i]).to.equal("fetching-community-ipns");
                expect(noNewUpdateStates[i + 1]).to.equal("stopped");
            }

            await community.stop();
            await staticCommunity.ipnsObj.pkc.destroy();
        });

        it(`Correct order of ${clientFieldName} when we update a post but its commentupdate is an invalid record (bad signature/schema/etc)`, async () => {
            const pkc: PKC = await config.pkcInstancePromise();

            const community = await pkc.getCommunity({ address: signers[0].address });

            const commentUpdateWithInvalidSignatureJson = await createCommentUpdateWithInvalidSignature(
                community.posts.pages.hot.comments[0].cid
            );

            const createdComment = await pkc.createComment({
                cid: commentUpdateWithInvalidSignatureJson.cid
            });

            const clientStates: string[] = [];
            const keyOfClient = Object.keys((createdComment.clients as unknown as ClientsRecord)[clientFieldName])[0];
            (createdComment.clients as unknown as ClientsRecord)[clientFieldName][keyOfClient].on("statechange", (state: string) =>
                clientStates.push(state)
            );

            const createErrorPromise = () =>
                new Promise<void>((resolve) =>
                    createdComment.once("error", (err) => {
                        if ((err as PKCError).code === "ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID") resolve();
                    })
                );
            await createdComment.update();
            mockPostToReturnSpecificCommentUpdate(createdComment, JSON.stringify(commentUpdateWithInvalidSignatureJson));

            await createErrorPromise();

            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 3));
            await createdComment.stop();

            expect(createdComment.updatedAt).to.be.undefined; // should not accept the comment update

            const expectedIpfsClientStates = [
                "fetching-ipfs", // fetching comment-ipfs
                "stopped",
                "fetching-community-ipns", // fetching community
                "fetching-community-ipfs",
                "stopped",
                "fetching-update-ipfs", // fetching comment update
                "stopped"
            ];

            expect(clientStates.slice(0, expectedIpfsClientStates.length)).to.deep.equal(expectedIpfsClientStates);

            const restOfIpfsStates = clientStates.slice(expectedIpfsClientStates.length);

            // Check the remaining states follow valid patterns
            let i = 0;
            while (i < restOfIpfsStates.length) {
                // Check for the first state in any valid pattern
                expect(restOfIpfsStates[i]).to.equal(
                    "fetching-community-ipns",
                    `State at position ${i} should be 'fetching-community-ipns'`
                );

                i++;
                if (i >= restOfIpfsStates.length) break;

                // Check for two possible patterns:
                // 1. No new community record: fetching-community-ipns -> stopped
                // 2. New community record: fetching-community-ipns -> fetching-community-ipfs -> stopped -> fetching-update-ipfs -> stopped

                if (restOfIpfsStates[i] === "stopped") {
                    // Pattern 1: No new community record found
                    i++;
                } else if (restOfIpfsStates[i] === "fetching-community-ipfs") {
                    // Pattern 2: Found new community record
                    expect(restOfIpfsStates[i]).to.equal(
                        "fetching-community-ipfs",
                        `State at position ${i} should be 'fetching-community-ipfs'`
                    );
                    i++;

                    if (i < restOfIpfsStates.length) {
                        expect(restOfIpfsStates[i]).to.equal("stopped", `State at position ${i} should be 'stopped'`);
                        i++;
                    }

                    if (i < restOfIpfsStates.length) {
                        expect(restOfIpfsStates[i]).to.equal(
                            "fetching-update-ipfs",
                            `State at position ${i} should be 'fetching-update-ipfs'`
                        );
                        i++;
                    }

                    if (i < restOfIpfsStates.length) {
                        expect(restOfIpfsStates[i]).to.equal("stopped", `State at position ${i} should be 'stopped'`);
                        i++;
                    }
                } else {
                    throw new Error(`Unexpected state '${restOfIpfsStates[i]}' at position ${i}`);
                }
            }

            // Ensure the very last state is "stopped"
            expect(clientStates[clientStates.length - 1]).to.equal("stopped", "The last state should be 'stopped'");
            await pkc.destroy();
        });
    });
});
