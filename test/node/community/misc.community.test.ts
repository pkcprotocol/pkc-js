import {
    mockPKC,
    publishRandomPost,
    createSubWithNoChallenge,
    publishRandomReply,
    generateMockPost,
    itSkipIfRpc,
    itIfRpc,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    describeIfRpc,
    waitTillPostInCommunityPages
} from "../../../dist/node/test/test-util.js";
import { describe, beforeAll, afterAll, it } from "vitest";

import signers from "../../fixtures/signers.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

import type { CommunityIpfsType } from "../../../dist/node/community/types.js";

describe(`community.{lastPostCid, lastCommentCid}`, async () => {
    let pkc: PKC;
    let sub: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKC();
        sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
    });

    afterAll(async () => {
        await sub.delete();
        await pkc.destroy();
    });

    it(`community.lastPostCid and lastCommentCid reflects latest post published`, async () => {
        expect(sub.lastPostCid).to.be.undefined;
        expect(sub.lastCommentCid).to.be.undefined;
        const post = await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
        expect(sub.lastPostCid).to.equal(post.cid);
        expect(sub.lastCommentCid).to.equal(post.cid);
    });

    it(`community.lastPostCid doesn't reflect latest reply`, async () => {
        await publishRandomReply({ parentComment: sub.posts.pages.hot!.comments[0], pkc: pkc });
        expect(sub.lastPostCid).to.equal(sub.posts.pages.hot!.comments[0].cid);
    });

    it(`community.lastCommentCid reflects latest comment (post or reply)`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: sub,
            predicate: async () => (sub.posts.pages.hot?.comments[0]?.replyCount ?? 0) > 0
        });
        expect(sub.lastCommentCid).to.equal(sub.posts.pages.hot!.comments[0].replies!.pages.best!.comments[0].cid);
    });
});

describeSkipIfRpc(`Create a sub with basic auth urls`, async () => {
    it(`Can create a sub with encoded authorization `, async () => {
        const headers = {
            authorization: "Basic " + Buffer.from("username" + ":" + "password").toString("base64")
        };
        const kuboRpcClientsOptions = [
            {
                url: "http://localhost:15001/api/v0",
                headers
            }
        ];
        const pubsubKuboRpcClientsOptions = [
            {
                url: "http://localhost:15002/api/v0",
                headers
            }
        ];

        const pkcOptions = {
            kuboRpcClientsOptions,
            pubsubKuboRpcClientsOptions
        };

        const pkc = await mockPKC(pkcOptions);
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await sub.delete();
        await pkc.destroy();
    });

    it(`Can publish a post with user@password for both ipfs and pubsub http client`, async () => {
        const kuboRpcClientsOptions = [`http://user:password@localhost:15001/api/v0`];
        const pubsubKuboRpcClientsOptions = [`http://user:password@localhost:15002/api/v0`];
        const pkcOptions = {
            kuboRpcClientsOptions,
            pubsubKuboRpcClientsOptions
        };

        const pkc = await mockPKC(pkcOptions);
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
        await sub.delete();
        await pkc.destroy();
    });
});

describe(`community.pubsubTopic`, async () => {
    let community: LocalCommunity | RpcLocalCommunity;
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`community.pubsubTopic is defaulted to address when community is first created`, async () => {
        expect(community.pubsubTopic).to.equal(community.address);
    });
    it(`Publications can be published to a sub with pubsubTopic=undefined`, async () => {
        await community.edit({ pubsubTopic: undefined });
        expect(community.pubsubTopic).to.be.undefined;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        expect(community.pubsubTopic).to.be.undefined;

        const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        // _community is private, use type assertion to access it for testing
        expect((post as Comment & { _community?: Pick<CommunityIpfsType, "pubsubTopic"> })._community?.pubsubTopic).to.be.undefined;
    });
});

describe.skip(`comment.link`, async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = await createSubWithNoChallenge({}, pkc);
        await community.edit({ settings: { ...community.settings!, fetchThumbnailUrls: true } });
        expect(community.settings!.fetchThumbnailUrls).to.be.true;

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    describe.skip(`comment.thumbnailUrl`, async () => {
        it(`comment.thumbnailUrl is generated for youtube video with thumbnailUrlWidth and thumbnailUrlHeight`, async () => {
            const url = "https://www.youtube.com/watch?v=TLysAkFM4cA";
            const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { link: url } });
            const expectedThumbnailUrl = "https://i.ytimg.com/vi/TLysAkFM4cA/maxresdefault.jpg";
            expect(post.thumbnailUrl).to.equal(expectedThumbnailUrl);
            expect(post.thumbnailUrlWidth).to.equal(1280);
            expect(post.thumbnailUrlHeight).to.equal(720);
        });

        it(`generates thumbnail url for html page with thumbnailUrlWidth and thumbnailUrlHeight`, async () => {
            const url =
                "https://www.correiobraziliense.com.br/politica/2023/06/5101828-moraes-determina-novo-bloqueio-das-redes-sociais-e-canais-de-monark.html";
            const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { link: url } });
            const expectedThumbnailUrl =
                "https://midias.correiobraziliense.com.br/_midias/jpg/2022/03/23/675x450/1_monark-7631489.jpg?20230614170105?20230614170105";
            expect(post.thumbnailUrl).to.equal(expectedThumbnailUrl);
            expect(post.thumbnailUrlWidth).to.equal(675);
            expect(post.thumbnailUrlHeight).to.equal(450);
        });

        it(`Generates thumbnail url for html page with no ogWidth and ogHeight correctly with thumbnailUrlWidth and thumbnailUrlHeight`, async () => {
            const url =
                "https://pleb.bz/p/reddit-screenshots.eth/c/QmUBqbdaVNNCaPUYZjqizYYL42wgr4YBfxDAcjxLJ59vid?redirect=plebones.eth.limo";
            const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { link: url } });
            const expectedThumbnailUrl = "https://i.imgur.com/6Ogacyq.png";
            expect(post.thumbnailUrl).to.equal(expectedThumbnailUrl);
            expect(post.thumbnailUrlWidth).to.equal(512);
            expect(post.thumbnailUrlHeight).to.equal(497);
        });

        it.skip(`Generates thumbnail url for twitter urls correctly`, async () => {
            const url = "https://fxtwitter.com/deedydas/status/1914714739432939999";
            const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { link: url } });
            const expectedThumbnailUrl = "https://pbs.twimg.com/media/F3iniP-XcAA1TVU.jpg:large";
            expect(post.thumbnailUrl).to.equal(expectedThumbnailUrl);
            expect(post.thumbnailUrlWidth).to.equal(1125);
            expect(post.thumbnailUrlHeight).to.equal(1315);
        });

        it(`comment.thumbnailUrl and width and height is defined if comment.link is a link of a jpg`, async () => {
            const link = "https://i.ytimg.com/vi/TLysAkFM4cA/maxresdefault.jpg";
            const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { link } });
            expect(post.link).to.equal(link);
            expect(post.thumbnailUrl).to.equal(link);
            expect(post.thumbnailUrlWidth).to.equal(1280);
            expect(post.thumbnailUrlHeight).to.equal(720);
        });

        it.skip(`comment.thumbnailUrl and width and height is defined is undefined if comment.link is a link of a gif`, async () => {
            const link = "https://files.catbox.moe/nlsfav.gif";
            const post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { link } });
            expect(post.link).to.equal(link);
            expect(post.thumbnailUrl).to.equal(link);
            expect(post.thumbnailUrlWidth).to.be.undefined;
            expect(post.thumbnailUrlHeight).to.be.undefined;
        });
    });

    it(`comment.linkWidth and linkHeight is defined if the author defines them`, async () => {
        const link = "https://i.ytimg.com/vi/TLysAkFM4cA/maxresdefault.jpg";
        const linkWidth = 200;
        const linkHeight = 200;
        const post = await publishRandomPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: { link, linkWidth, linkHeight }
        });
        expect(post.link).to.equal(link);
        expect(post.linkHeight).to.equal(linkHeight);
        expect(post.linkWidth).to.equal(linkWidth);

        await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);

        const postInSubPages = community.posts.pages.hot!.comments.find((comment) => comment.cid === post.cid);
        expect(postInSubPages!.link).to.equal(link);
        expect(postInSubPages!.linkHeight).to.equal(linkHeight);
        expect(postInSubPages!.linkWidth).to.equal(linkWidth);
    });
});

describe.concurrent(`community.clients (Local)`, async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    describeSkipIfRpc.concurrent(`community.clients.kuboRpcClients`, async () => {
        it(`community.clients.kuboRpcClients[url] is stopped by default`, async () => {
            const mockSub = await createSubWithNoChallenge({}, pkc);
            expect(Object.keys(mockSub.clients.kuboRpcClients).length).to.equal(1);
            expect(Object.values(mockSub.clients.kuboRpcClients)[0].state).to.equal("stopped");
        });

        it(`community.clients.kuboRpcClients.state is publishing-ipns before publishing a new IPNS`, async () => {
            const sub = await createSubWithNoChallenge({}, pkc);

            let publishStateTime: number | undefined;
            let updateTime: number | undefined;

            const ipfsUrl = Object.keys(sub.clients.kuboRpcClients)[0];

            sub.clients.kuboRpcClients[ipfsUrl].on(
                "statechange",
                (newState) => newState === "publishing-ipns" && (publishStateTime = Date.now())
            );

            sub.once("update", () => (updateTime = Date.now()));

            const updatePromise = new Promise((resolve) => sub.once("update", resolve));
            await sub.start();
            await updatePromise;
            await sub.stop();

            expect(publishStateTime).to.be.a("number");
            expect(updateTime).to.be.a("number");
            expect(publishStateTime).to.be.lessThan(updateTime!);
        });
    });

    describeSkipIfRpc.concurrent(`community.clients.pubsubKuboRpcClients`, async () => {
        it(`community.clients.pubsubKuboRpcClients[url].state is stopped by default`, async () => {
            const mockSub = await createSubWithNoChallenge({}, pkc);
            expect(Object.keys(mockSub.clients.pubsubKuboRpcClients).length).to.equal(3);
            expect(Object.values(mockSub.clients.pubsubKuboRpcClients)[0].state).to.equal("stopped");
        });

        it(`correct order of pubsubKuboRpcClients state when receiving a comment while skipping challenge`, async () => {
            const mockSub = await createSubWithNoChallenge({}, pkc);

            const expectedStates = ["waiting-challenge-requests", "publishing-challenge-verification", "waiting-challenge-requests"];

            const actualStates: string[] = [];

            const pubsubUrl = Object.keys(mockSub.clients.pubsubKuboRpcClients)[0];

            mockSub.clients.pubsubKuboRpcClients[pubsubUrl].on("statechange", (newState) => actualStates.push(newState));

            await mockSub.start();

            await resolveWhenConditionIsTrue({ toUpdate: mockSub, predicate: async () => typeof mockSub.updatedAt === "number" });

            const challengeVerificationPromise = new Promise((resolve) => mockSub.once("challengeverification", resolve));
            await publishRandomPost({ communityAddress: mockSub.address, pkc: pkc });

            await challengeVerificationPromise;

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct order of pubsubKuboRpcClients when receiving a comment while mandating challenge`, async () => {
            const mockSub = await pkc.createCommunity({});

            await mockSub.edit({ settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] } });

            const expectedStates = [
                "waiting-challenge-requests",
                "publishing-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-verification",
                "waiting-challenge-requests"
            ];

            const actualStates: string[] = [];

            const pubsubUrl = Object.keys(mockSub.clients.pubsubKuboRpcClients)[0];

            mockSub.clients.pubsubKuboRpcClients[pubsubUrl].on("statechange", (newState) => actualStates.push(newState));

            await mockSub.start();

            await resolveWhenConditionIsTrue({ toUpdate: mockSub, predicate: async () => typeof mockSub.updatedAt === "number" });

            const post = await generateMockPost({ communityAddress: mockSub.address, pkc: pkc });
            post.once("challenge", async () => {
                await post.publishChallengeAnswers(["2"]);
            });
            await post.publish();

            await new Promise((resolve) => mockSub.once("challengeverification", resolve));

            expect(actualStates).to.deep.equal(expectedStates);

            await mockSub.delete();
        });
    });

    describeSkipIfRpc.concurrent(`community.clients.nameResolvers`, async () => {
        let mockSub: LocalCommunity | RpcLocalCommunity;
        beforeAll(async () => {
            mockSub = await createSubWithNoChallenge({}, pkc);
        });

        afterAll(async () => {
            await mockSub.delete();
        });
        it(`community.clients.nameResolvers[resolverKey].state is stopped by default`, async () => {
            expect(Object.keys(mockSub.clients.nameResolvers).length).to.be.greaterThanOrEqual(1);
            for (const resolverKey of Object.keys(mockSub.clients.nameResolvers))
                expect(mockSub.clients.nameResolvers[resolverKey].state).to.equal("stopped");
        });

        it(`correct order of nameResolvers state when receiving a comment with a domain for author.address`, async () => {
            const expectedStates = ["resolving-author-name", "stopped"];

            const actualStates: string[] = [];
            const resolverKey = Object.keys(mockSub.clients.nameResolvers)[0];
            mockSub.clients.nameResolvers[resolverKey].on("statechange", (newState: string) => actualStates.push(newState));

            await mockSub.start();

            await new Promise((resolve) => mockSub.once("update", resolve));

            const challengeVerificationPromise = new Promise((resolve) => mockSub.once("challengeverification", resolve));
            await publishRandomPost({
                communityAddress: mockSub.address,
                pkc: pkc,
                postProps: { author: { address: "plebbit.bso" }, signer: signers[3] }
            });

            await challengeVerificationPromise;

            expect(actualStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);
        });
    });

    describeIfRpc(`community.clients.pkcRpcClients (local community ran over RPC)`, async () => {
        it(`community.clients.pkcRpcClients[rpcUrl] is stopped by default`, async () => {
            const sub = (await pkc.createCommunity({})) as RpcLocalCommunity;
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            expect(sub.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
        });

        it(`community.clients.pkcRpcClients states are set correctly prior to publishing IPNS`, async () => {
            const sub = (await pkc.createCommunity({})) as RpcLocalCommunity;
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];

            sub.clients.pkcRpcClients[rpcUrl].on("statechange", (newState) => recordedStates.push(newState));

            await sub.start();

            await new Promise((resolve) => sub.once("update", resolve));
            await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval / 2)); // until stopped state is transmitted

            expect(recordedStates).to.deep.equal(["publishing-ipns", "stopped"]);

            await sub.delete();
        });

        it(`community.clients.pkcRpcClients states are set correctly if it receives a comment while having no challenges`, async () => {
            const sub = (await createSubWithNoChallenge({}, pkc)) as RpcLocalCommunity;
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];

            const expectedStates = [
                "publishing-ipns",
                "stopped",
                "waiting-challenge-requests",
                "publishing-challenge-verification",
                "waiting-challenge-requests",
                "publishing-ipns"
            ];
            sub.clients.pkcRpcClients[rpcUrl].on("statechange", (newState) => recordedStates.push(newState));

            await sub.start();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            const post = await publishRandomPost({ communityAddress: sub.address, pkc: pkc });
            await waitTillPostInCommunityPages(post as Comment & { cid: string }, pkc);
            if (recordedStates[recordedStates.length - 1] === "stopped")
                expect(recordedStates).to.deep.equal([...expectedStates, "stopped"]);
            else expect(recordedStates).to.deep.equal(expectedStates);

            await sub.delete();
        });

        it(`community.clients.pkcRpcClients states are set correctly if it receives a comment while mandating challenge`, async () => {
            const sub = (await pkc.createCommunity({})) as RpcLocalCommunity;
            await sub.edit({ settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] } });

            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];

            const expectedStates = [
                "publishing-ipns",
                "stopped",
                "waiting-challenge-requests",
                "publishing-challenge",
                "waiting-challenge-answers",
                "publishing-challenge-verification",
                "waiting-challenge-requests",
                "publishing-ipns",
                "stopped"
            ];
            sub.clients.pkcRpcClients[rpcUrl].on("statechange", (newState) => recordedStates.push(newState));

            await sub.start();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            const mockPost = await generateMockPost({ communityAddress: sub.address, pkc: pkc });

            mockPost.once("challenge", async () => {
                await mockPost.publishChallengeAnswers(["2"]);
            });

            await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
            await new Promise((resolve) => sub.once("update", resolve));
            await new Promise((resolve) => sub.once("startedstatechange", resolve)); // wait for the last stopped state to be emitted
            expect(recordedStates.slice(0, expectedStates.length)).to.deep.equal(expectedStates);

            await sub.delete();
        });
    });
});
