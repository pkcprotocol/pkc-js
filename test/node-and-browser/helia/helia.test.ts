import {
    generatePostToAnswerMathQuestion,
    publishWithExpectedResult,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    mockPKCV2,
    addStringToIpfs
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { IpfsHttpClientPubsubMessage } from "../../../dist/node/types.js";

const mathCliNoMockedPubsubCommunityAddress = signers[5].address; // this community is connected to a pkc instance whose pubsub is not mocked

// should connect to a kubo node and exchange pubsub messages with it
// DO NOT MOCK PUBSUB
//flaky
// for(let i =0;i <50; i++)
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`Test publishing pubsub in real environment - ${config.name}`, { retry: 2 }, async () => {
        let pkc: PKC;
        let publishedPost: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise({ forceMockPubsub: false });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Can fetch community`, async () => {
            const community = await pkc.getCommunity({ address: mathCliNoMockedPubsubCommunityAddress });
            expect(community.updatedAt).to.be.a("number");
            expect(community.settings).to.be.undefined; // make sure it's not loading local community
        });

        it("can post after answering correctly", async function () {
            publishedPost = await generatePostToAnswerMathQuestion({ communityAddress: mathCliNoMockedPubsubCommunityAddress }, pkc);
            await publishWithExpectedResult({ publication: publishedPost, expectedChallengeSuccess: true });
        });

        it(`Can fetch Comment IPFS`, async () => {
            const commentCid = publishedPost.cid;
            expect(commentCid).to.be.a("string");
            const comment = await pkc.getComment({ cid: commentCid! });
            expect(comment.signature).to.be.a("object");
        });

        it(`Can fetch comment update`, async () => {
            const commentCid = publishedPost.cid;
            expect(commentCid).to.be.a("string");
            const comment = await pkc.getComment({ cid: commentCid! });
            expect(comment.signature).to.be.a("object");

            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
            expect(comment.author.community).to.be.a("object");
            await comment.stop();
        });

        it(`It should connect to peers if we're publishing over pubsub`, async () => {
            const testPKC = await config.pkcInstancePromise({
                forceMockPubsub: false
            });

            const kuboPKC = await mockPKCV2({
                pkcOptions: { pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"] },
                forceMockPubsub: false,
                remotePKC: true
            });

            const kuboRpc = Object.values(kuboPKC.clients.pubsubKuboRpcClients)[0];

            const pubsubMsgs: IpfsHttpClientPubsubMessage[] = [];

            kuboRpc._client.pubsub.subscribe(mathCliNoMockedPubsubCommunityAddress, (msg: IpfsHttpClientPubsubMessage) => {
                pubsubMsgs.push(msg);
            });

            const libp2pJsClient = Object.values(testPKC.clients.libp2pJsClients)[0];
            const numOfPeersBeforePublishing = libp2pJsClient._helia.libp2p.getConnections().length;
            expect(numOfPeersBeforePublishing).to.equal(0);
            const heliaWithKuboRpcClientFunctions = libp2pJsClient.heliaWithKuboRpcClientFunctions;

            await heliaWithKuboRpcClientFunctions.pubsub.publish(mathCliNoMockedPubsubCommunityAddress, new TextEncoder().encode("test"));

            const numOfPeersAfterPublishing = libp2pJsClient._helia.libp2p.getConnections().length;
            expect(numOfPeersAfterPublishing).to.be.greaterThan(numOfPeersBeforePublishing);

            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(pubsubMsgs.length).to.equal(1);
            expect(pubsubMsgs[0].data.toString()).to.equal("116,101,115,116"); // uint8 array representation of "test"

            await testPKC.destroy();
            await kuboPKC.destroy();
        });

        it(`should connect to peers if we're subscribing over pubsub`, async () => {
            const testPKC = await config.pkcInstancePromise({
                forceMockPubsub: false
            });

            const kuboPKC = await mockPKCV2({
                pkcOptions: { pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"] },
                forceMockPubsub: false,
                remotePKC: true
            });

            const kuboRpc = Object.values(kuboPKC.clients.pubsubKuboRpcClients)[0];

            const libp2pJsClient = Object.values(testPKC.clients.libp2pJsClients)[0];
            const numOfPeersBeforeSubscribing = libp2pJsClient._helia.libp2p.getConnections().length;
            expect(numOfPeersBeforeSubscribing).to.equal(0);
            const heliaWithKuboRpcClientFunctions = libp2pJsClient.heliaWithKuboRpcClientFunctions;

            const pubsubMsgs: IpfsHttpClientPubsubMessage[] = [];

            await heliaWithKuboRpcClientFunctions.pubsub.subscribe(
                mathCliNoMockedPubsubCommunityAddress,
                (msg: IpfsHttpClientPubsubMessage) => {
                    pubsubMsgs.push(msg);
                }
            );

            const numOfPeersAfterSubscribing = libp2pJsClient._helia.libp2p.getConnections().length;
            expect(numOfPeersAfterSubscribing).to.be.greaterThan(numOfPeersBeforeSubscribing);

            await kuboRpc._client.pubsub.publish(mathCliNoMockedPubsubCommunityAddress, new TextEncoder().encode("test"));

            await new Promise((resolve) => setTimeout(resolve, 2000));
            expect(pubsubMsgs.length).to.equal(1);
            expect(pubsubMsgs[0].data.toString()).to.equal("116,101,115,116"); // uint8 array representation of "test"

            await testPKC.destroy();
            await kuboPKC.destroy();
        });
        it(`it should connect if we're fetching content by CID`, async () => {
            const testPKC = await config.pkcInstancePromise({
                forceMockPubsub: false
            });

            const libp2pJsClient = Object.values(testPKC.clients.libp2pJsClients)[0];
            const numOfPeersBeforeFetching = libp2pJsClient._helia.libp2p.getConnections().length;
            expect(numOfPeersBeforeFetching).to.equal(0);

            const newContentCid = await addStringToIpfs("test");

            const { content: contentLoadedByHelia } = await testPKC.fetchCid({ cid: newContentCid });
            expect(contentLoadedByHelia).to.equal("test");

            const numOfPeersAfterFetching = libp2pJsClient._helia.libp2p.getConnections().length;
            expect(numOfPeersAfterFetching).to.be.greaterThan(numOfPeersBeforeFetching);

            await testPKC.destroy();
        });

        it(`We can fetch the IPNS using pubsub only`, async () => {
            // pkc-js sets up helia to use two routers for IPNS:
            // 1. Pubsub router: Joins pubsub topic, and awaits for the IPNS record to be published
            // 2. Fetch router: requests the IPNS record from peers in the pubsub topic

            // We need to test if we can fetch the IPNS using pubsub only

            const testPKC = await config.pkcInstancePromise({
                forceMockPubsub: false
            });

            const libp2pJsClient = Object.values(testPKC.clients.libp2pJsClients)[0];
            libp2pJsClient._heliaIpnsRouter.routers = libp2pJsClient._heliaIpnsRouter.routers.slice(1); // remove the fetch router

            const community = await testPKC.createCommunity({ address: mathCliNoMockedPubsubCommunityAddress });
            const errors: Error[] = [];
            community.on("error", (error: Error) => errors.push(error));

            await community.update();
            await new Promise((resolve) => community.once("update", resolve));

            expect(community.updatedAt).to.be.a("number");
            expect(community.settings).to.be.undefined; // make sure it's not loading local community

            await testPKC.destroy();
        });
    });

    describe(`Helia parallel lifecycle - ${config.name}`, () => {
        it("reuses a shared libp2pjs client across parallel creations and tears it down only after the last destroy", async () => {
            const parallelClients = 20;
            const sharedKey = `helia-parallel-${Date.now()}`;
            const plebbitFactory = () =>
                config.pkcInstancePromise({
                    forceMockPubsub: true,
                    pkcOptions: {
                        libp2pJsClientsOptions: [
                            {
                                key: sharedKey,
                                libp2pOptions: { connectionGater: { denyDialMultiaddr: async () => false } }
                            }
                        ]
                    }
                });
            const plebbits = await Promise.all(Array.from({ length: parallelClients }, () => plebbitFactory()));

            const sharedClients = plebbits.map((plebbitInstance) => {
                const clients = Object.values(plebbitInstance.clients.libp2pJsClients);
                expect(clients.length).to.be.greaterThan(0);
                return clients[0];
            });

            const referenceClient = sharedClients[0];
            sharedClients.forEach((client) => expect(client).to.equal(referenceClient));
            expect(referenceClient.countOfUsesOfInstance).to.equal(parallelClients);

            const midway = Math.floor(parallelClients / 2);
            await Promise.all(plebbits.slice(0, midway).map((plebbitInstance) => plebbitInstance.destroy()));

            expect(referenceClient.countOfUsesOfInstance).to.equal(parallelClients - midway);
            expect(referenceClient._helia.libp2p.status).to.not.equal("stopped");

            await Promise.all(plebbits.slice(midway).map((plebbitInstance) => plebbitInstance.destroy()));

            expect(referenceClient.countOfUsesOfInstance).to.equal(0);
            expect(referenceClient._helia.libp2p.status).to.equal("stopped");
        }, 30000);
    });
});
