import {
    generatePostToAnswerMathQuestion,
    publishWithExpectedResult,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    mockPKCV2,
    addStringToIpfs,
    createMockedCommunityIpns
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { IpfsHttpClientPubsubMessage } from "../../../dist/node/types.js";
import { ipnsNameToIpnsOverPubsubTopic } from "../../../dist/node/util.js";

async function firstFromAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T> {
    for await (const value of iterable) return value;
    throw new Error("AsyncIterable produced no values");
}

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

    // Regression tests for commit a14fd225d ("upgrade helia/libp2p packages and drop custom IPNS fetch router").
    // @helia/ipns 9.2.x pubsub router throws NotFoundError when there are zero subscribers for the
    // topic at .get() time, and the connectToPubsubPeers warmup wired into pubsub.subscribe is
    // fire-and-forget — so the resolver router peeks at an empty subscriber list before the warmup
    // has time to populate it.
    describe(`IPNS resolve cold-start race - ${config.name}`, () => {
        it("name.resolve resolves a freshly-published record on first cold call", async () => {
            const { communityAddress } = await createMockedCommunityIpns({});

            const resolverPKC = await config.pkcInstancePromise();
            try {
                const heliaShape = Object.values(resolverPKC.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions;
                const resolved = await firstFromAsyncIterable(
                    heliaShape.name.resolve(communityAddress, { nocache: true, recursive: true })
                );
                expect(resolved).to.be.a("string");
                expect(resolved).to.match(/^\/ipfs\//);
            } finally {
                await resolverPKC.destroy();
            }
        });

        it("name.resolve populates pubsub subscribers before @helia/ipns inspects them", async () => {
            const { communityAddress } = await createMockedCommunityIpns({});
            const resolverPKC = await config.pkcInstancePromise();
            try {
                const heliaClient = Object.values(resolverPKC.clients.libp2pJsClients)[0];
                const heliaShape = heliaClient.heliaWithKuboRpcClientFunctions;
                const pubsubSvc = heliaClient._helia.libp2p.services.pubsub;
                const topic = ipnsNameToIpnsOverPubsubTopic(communityAddress);

                expect(pubsubSvc.getSubscribers(topic).length).to.equal(0);

                let lastReadCount: number | undefined;
                const original = pubsubSvc.getSubscribers.bind(pubsubSvc);
                pubsubSvc.getSubscribers = (t: string) => {
                    const list = original(t);
                    if (t === topic) lastReadCount = list.length;
                    return list;
                };

                try {
                    await firstFromAsyncIterable(heliaShape.name.resolve(communityAddress, { nocache: true, recursive: true }));
                } finally {
                    pubsubSvc.getSubscribers = original;
                }

                // The @helia/ipns pubsub router's final read (the for-loop over peers) must see
                // a populated subscriber list — that's what the warmup is for.
                expect(lastReadCount, "subscribers must be populated by the time @helia/ipns reads them").to.be.greaterThan(0);
            } finally {
                await resolverPKC.destroy();
            }
        });

        // Deterministic repro for the firefox CI flake on
        // https://github.com/pkcprotocol/pkc-js/actions/runs/25484199180:
        // connectToPubsubPeers in src/helia/util.ts returns as soon as findProviders exhausts
        // (or maxPeers is reached), without waiting for the gossipsub graft to register the
        // dialed peer in pubsub.getSubscribers(topic). When the graft is slow, the warmup
        // returns with subscribers=[], the resolver walks an empty list, and Helia throws
        // RecordNotFoundError -> ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED.
        // We simulate the slow graft by stubbing pubsub.getSubscribers to return [] for the
        // first SUPPRESS_MS of the resolve. A correct warmup must keep waiting past the
        // window so the resolver eventually sees real subscribers and resolve succeeds.
        it("name.resolve waits past a slow gossipsub graft and resolves successfully", async () => {
            const { communityAddress } = await createMockedCommunityIpns({});
            const resolverPKC = await config.pkcInstancePromise();
            try {
                const heliaClient = Object.values(resolverPKC.clients.libp2pJsClients)[0];
                const heliaShape = heliaClient.heliaWithKuboRpcClientFunctions;
                const pubsubSvc = heliaClient._helia.libp2p.services.pubsub;
                const topic = ipnsNameToIpnsOverPubsubTopic(communityAddress);

                const SUPPRESS_MS = 5000;
                const stubStart = Date.now();
                const original = pubsubSvc.getSubscribers.bind(pubsubSvc);
                let suppressedReadCount = 0;
                pubsubSvc.getSubscribers = (t: string) => {
                    if (t === topic && Date.now() - stubStart < SUPPRESS_MS) {
                        suppressedReadCount++;
                        return [];
                    }
                    return original(t);
                };

                try {
                    const resolved = await firstFromAsyncIterable(
                        heliaShape.name.resolve(communityAddress, { nocache: true, recursive: true })
                    );
                    expect(resolved).to.be.a("string");
                    expect(resolved).to.match(/^\/ipfs\//);
                } finally {
                    pubsubSvc.getSubscribers = original;
                }

                expect(suppressedReadCount, "stub must intercept getSubscribers reads at least once").to.be.greaterThan(0);
            } finally {
                await resolverPKC.destroy();
            }
        }, 30000);
    });

    // The @helia/ipns IPNS class constructs `routers = [localStoreRouting, heliaRouting, ...userRouters]`.
    // pkc-js passes `[ourPubsubRouter]` and then does `routers = routers.slice(1)`, leaving
    // `[heliaRouting, ourPubsubRouter]`. This shape is load-bearing: future @helia/ipns
    // versions could re-order the array and silently drop the pubsub router (or keep the
    // local-store cache that nothing populates). This test pins the current shape so any
    // upgrade that breaks it surfaces here instead of at runtime.
    describe(`IPNS router shape - ${config.name}`, () => {
        it("ipnsNameResolver.routers contains exactly heliaRouting and our pubsub router", async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const heliaClient = Object.values(pkc.clients.libp2pJsClients)[0];
                const routers = heliaClient._heliaIpnsRouter.routers;

                expect(routers.length, `expected exactly 2 routers (heliaRouting + pubsub), got ${routers.length}`).to.equal(2);

                const constructorNames = routers.map((r) => r?.constructor?.name);
                // pubsub router should be present
                expect(constructorNames, `routers: ${constructorNames.join(", ")}`).to.include("PubSubRouting");
                // localStoreRouting should NOT be present (we slice it off intentionally so reads don't
                // hit a cache we never populate)
                expect(constructorNames, `localStoreRouting must be sliced off, got: ${constructorNames.join(", ")}`).to.not.include(
                    "LocalStoreRouting"
                );
            } finally {
                await pkc.destroy();
            }
        });

        it("helia.routing.routers does not include the HTTP gateway router", async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const heliaClient = Object.values(pkc.clients.libp2pJsClients)[0];
                //@ts-expect-error — helia.routing.routers is internal
                const routers: unknown[] = heliaClient._helia.routing.routers;
                const constructorNames = routers.map((r) => (r as { constructor?: { name?: string } })?.constructor?.name);
                // We slice helia.routing.routers down to a single non-gateway router (line 95 of helia-for-pkc.ts).
                // Block requests over an HTTP gateway are not what we want via IPNS resolution.
                expect(routers.length, `expected exactly 1 routing router, got ${routers.length}`).to.equal(1);
                expect(
                    constructorNames.some((n) => typeof n === "string" && n.toLowerCase().includes("gateway")),
                    `helia.routing.routers must not include gateway-class router, got: ${constructorNames.join(", ")}`
                ).to.be.false;
            } finally {
                await pkc.destroy();
            }
        });
    });

    // Regression test for B2 (helia-for-pkc.ts:30 TODO): the IPNS pubsub router (PubSubRouting)
    // maintains its own list of subscribed topics in `getSubscriptions()`. When we destroy a
    // PKC instance the wrapper unsubscribes pubsub topics on gossipsub but never calls the
    // router's stop()/cancel(), so the router-level subscriptions outlive helia and leak.
    describe(`IPNS pubsub router lifecycle - ${config.name}`, () => {
        it("router subscriptions are torn down on destroy", async () => {
            const { communityAddress } = await createMockedCommunityIpns({});
            const pkc = await config.pkcInstancePromise();
            const heliaClient = Object.values(pkc.clients.libp2pJsClients)[0];
            const heliaShape = heliaClient.heliaWithKuboRpcClientFunctions;

            // Trigger an IPNS resolve so the pubsub router records a subscription internally.
            await firstFromAsyncIterable(heliaShape.name.resolve(communityAddress, { nocache: true, recursive: true }));

            // Find the pubsub router by class name (matches the shape pinned in the
            // "IPNS router shape" suite above).
            const pubsubRouter = heliaClient._heliaIpnsRouter.routers.find((r) => r?.constructor?.name === "PubSubRouting") as
                | (import("@helia/ipns/routing").PubsubRoutingComponents extends never ? never : unknown)
                | undefined;
            expect(pubsubRouter, "expected to find a PubSubRouting in _heliaIpnsRouter.routers").to.exist;

            const routerWithLifecycle = pubsubRouter as {
                getSubscriptions: () => string[];
                stop: () => void | Promise<void>;
            };
            const subsBeforeDestroy = routerWithLifecycle.getSubscriptions();
            expect(
                subsBeforeDestroy.length,
                `pubsub router should track at least one subscription after a successful resolve, got ${subsBeforeDestroy.length}`
            ).to.be.greaterThan(0);

            const stopSpy = vi.spyOn(routerWithLifecycle, "stop");

            await pkc.destroy();

            expect(
                stopSpy.mock.calls.length,
                "PubSubRouting.stop() must be called during PKC.destroy() so the router cleans up internal subscriptions"
            ).to.be.greaterThan(0);
        });
    });

    // Regression test for O4 (helia-for-pkc.ts:194-206): heliaFs.cat() must honor the caller's
    // AbortSignal — without it, a fetch for a CID nobody is providing would hang forever.
    describe(`Helia cat() honors AbortSignal - ${config.name}`, () => {
        it("cat() rejects within the abort window when no peer has the block", async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const heliaClient = Object.values(pkc.clients.libp2pJsClients)[0];
                const heliaShape = heliaClient.heliaWithKuboRpcClientFunctions;

                // A v0 CID for content nobody in the test environment is providing. Generated
                // offline and pinned to this test (so it stays unknown).
                const cidNoOneHas = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

                const TIMEOUT_MS = 2000;
                const start = Date.now();
                let rejected = false;
                try {
                    // cat() returns AsyncIterable<Uint8Array>; iterate to trigger fetching.
                    for await (const _chunk of heliaShape.cat(cidNoOneHas, { signal: AbortSignal.timeout(TIMEOUT_MS) })) {
                        // any chunk means someone served it - shouldn't happen in this test
                    }
                } catch (err) {
                    rejected = true;
                    const elapsed = Date.now() - start;
                    // Allow generous slack for CI: must reject within 4x the timeout.
                    expect(
                        elapsed,
                        `cat() rejected after ${elapsed}ms, expected within ${TIMEOUT_MS * 4}ms (signal must be forwarded)`
                    ).to.be.lessThan(TIMEOUT_MS * 4);
                }
                expect(rejected, "cat() must reject when AbortSignal fires before any block arrives").to.be.true;
            } finally {
                await pkc.destroy();
            }
        }, 15000);
    });
});
