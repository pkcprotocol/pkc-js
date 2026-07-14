import {
    generatePostToAnswerMathQuestion,
    publishWithExpectedResult,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    mockPKCV2,
    addStringToIpfs,
    createMockedCommunityIpns,
    mockCommentToNotUsePagesForUpdates
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import validPageFixture from "../../fixtures/valid_page.json" with { type: "json" };
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { IpfsHttpClientPubsubMessage } from "../../../dist/node/types.js";
import { ipnsNameToIpnsOverPubsubTopic } from "../../../dist/node/util.js";
import { CommentClientsManager } from "../../../dist/node/publications/comment/comment-client-manager.js";
import { importer } from "ipfs-unixfs-importer";
import { peerIdFromString } from "@libp2p/peer-id";
import { multihashToIPNSRoutingKey } from "ipns";

async function firstFromAsyncIterable<T>(iterable: AsyncIterable<T>): Promise<T> {
    for await (const value of iterable) return value;
    throw new Error("AsyncIterable produced no values");
}

const mathCliNoMockedPubsubCommunityAddress = signers[5].address; // this community is connected to a pkc instance whose pubsub is not mocked

// should connect to a kubo node and exchange pubsub messages with it
// DO NOT MOCK PUBSUB
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`Test publishing pubsub in real environment - ${config.name}`, async () => {
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

        // The direct-fetch fast path (issue #185) resolves the record over libp2p/fetch without
        // blocking on the gossipsub subscriber floor (TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS, up to 10s),
        // so it intentionally does NOT wait for pubsub.getSubscribers(topic) to be populated before
        // returning. It MUST, however, still subscribe to the IPNS-over-pubsub topic (and kick a
        // fire-and-forget warmup) so future pushed record updates keep arriving. This asserts that
        // the subscription survives the resolve — the guarantee that replaced the old
        // warmup-before-first-get behavior.
        it("name.resolve keeps the pubsub topic subscribed so pushed updates keep flowing", async () => {
            const { communityAddress } = await createMockedCommunityIpns({});
            const resolverPKC = await config.pkcInstancePromise();
            try {
                const heliaClient = Object.values(resolverPKC.clients.libp2pJsClients)[0];
                const heliaShape = heliaClient.heliaWithKuboRpcClientFunctions;
                const pubsubSvc = heliaClient._helia.libp2p.services.pubsub;
                const topic = ipnsNameToIpnsOverPubsubTopic(communityAddress);

                expect(pubsubSvc.getTopics(), "topic must not be subscribed before resolve").to.not.include(topic);

                const resolved = await firstFromAsyncIterable(
                    heliaShape.name.resolve(communityAddress, { nocache: true, recursive: true })
                );
                expect(resolved).to.be.a("string");
                expect(resolved).to.match(/^\/ipfs\//);

                expect(pubsubSvc.getTopics(), "resolve must leave the IPNS pubsub topic subscribed for future pushed updates").to.include(
                    topic
                );
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

            // Find the pubsub router by class name (matches the shape pinned in the
            // "IPNS router shape" suite above).
            const pubsubRouter = heliaClient._heliaIpnsRouter.routers.find((r) => r?.constructor?.name === "PubSubRouting") as
                | (import("@helia/ipns/routing").PubsubRoutingComponents extends never ? never : unknown)
                | undefined;
            expect(pubsubRouter, "expected to find a PubSubRouting in _heliaIpnsRouter.routers").to.exist;

            const routerWithLifecycle = pubsubRouter as {
                get: (routingKey: Uint8Array, options?: { signal?: AbortSignal }) => Promise<unknown>;
                getSubscriptions: () => string[];
                stop: () => void | Promise<void>;
            };

            // Seed a router-level subscription. name.resolve() no longer records one on its own:
            // the direct-fetch fast path (issue #185) pre-subscribes the topic on gossipsub and
            // returns before PubSubRouting.get() ever runs, and even the legacy fallback's get()
            // skips adding the subscription because the topic is already in pubsub.getTopics().
            // So we call the router's get() directly on a not-yet-subscribed topic to create the
            // leak surface this test guards. get() subscribes and records the subscription before
            // it awaits/fetches, so it is recorded even though get() then throws NotFoundError.
            const routingKey = multihashToIPNSRoutingKey(peerIdFromString(communityAddress).toMultihash());
            await routerWithLifecycle.get(routingKey, { signal: AbortSignal.timeout(2000) }).catch(() => {
                // NotFoundError (no subscriber serves the record) or abort — the subscription is
                // still recorded before get() rejects, which is all this test needs.
            });

            const subsBeforeDestroy = routerWithLifecycle.getSubscriptions();
            expect(
                subsBeforeDestroy.length,
                `pubsub router should track at least one subscription after get(), got ${subsBeforeDestroy.length}`
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

    // Regression test for the helia cat() wrapper (helia-for-pkc.ts). A CommentUpdate is fetched
    // from a community's postUpdates via a multi-segment IPFS path (`<root>/<bucket>/update`), not a
    // bare CID. With multiformats 14 at our top level but @helia/unixfs + ipfs-unixfs-exporter still
    // on 13, @helia/unixfs's cat() resolves a sub-path to an intermediate CID *object* and re-enters
    // the exporter with it; the exporter's strict `CID.asCID(path) === path` identity check rejects
    // that foreign-multiformats-copy CID with "Path must be string or CID". Bare-CID fetches dodge
    // this (the string flows straight to the exporter's string branch), which is why only sub-path
    // fetches broke. See PR #140.
    describe(`Helia cat() resolves a directory sub-path - ${config.name}`, () => {
        it("fetches <dirCid>/<file> via _fetchCidP2P (postUpdates-style path)", async () => {
            const pkc = await config.pkcInstancePromise({ forceMockPubsub: true });
            try {
                const heliaClient = Object.values(pkc.clients.libp2pJsClients)[0];
                const blockstore = heliaClient._helia.blockstore;

                // Build a unixfs directory { update: <bytes> } directly in the client's own
                // blockstore — exactly what @helia/unixfs does internally — so the fetch is a local
                // blockstore read with no network dependency.
                const payload = JSON.stringify({ updated: true, nonce: Math.random() });
                let dirCid: string | undefined;
                let fileCid: string | undefined;
                for await (const entry of importer(
                    [{ path: "update", content: new TextEncoder().encode(payload) }],
                    // helia's blockstore and the top-level importer reference different multiformats
                    // copies (14 vs the nested 13 helia 6 still uses), so their CID types differ at
                    // the type level only — the same mf-copy split this test exists to cover. The
                    // runtime contract (put/get by multihash) is identical, mirroring the
                    // `as unknown as` bridge in helia-for-pkc.ts.
                    blockstore as unknown as Parameters<typeof importer>[1],
                    { wrapWithDirectory: true }
                )) {
                    if (entry.path === "") dirCid = entry.cid.toString();
                    else if (entry.path === "update") fileCid = entry.cid.toString();
                }
                expect(dirCid, "importer should yield a wrapping directory CID").to.be.a("string");
                expect(fileCid, "importer should yield the file CID").to.be.a("string");

                // Sub-path fetch (the regression): this is how a CommentUpdate is loaded from postUpdates.
                const fetchedViaSubPath = await pkc._clientsManager._fetchCidP2P(`${dirCid}/update`, {
                    maxFileSizeBytes: 1024 * 1024,
                    timeoutMs: 15000
                });
                expect(fetchedViaSubPath).to.equal(payload);

                // Bare-CID fetch must keep working too (guards the unified code path).
                const fetchedViaBareCid = await pkc._clientsManager._fetchCidP2P(fileCid!, {
                    maxFileSizeBytes: 1024 * 1024,
                    timeoutMs: 15000
                });
                expect(fetchedViaBareCid).to.equal(payload);
            } finally {
                await pkc.destroy();
            }
        }, 30000);
    });

    // Regression test for helia-for-pkc.ts:277-291: pubsub.subscribe() must honor the caller's
    // AbortSignal. warmupForTopic dedupes in-flight warmups by topic, and the monkey-patched
    // native pubsub.subscribe also kicks off a warmup with no options — if our explicit
    // warmupForTopic(topic, options) ran AFTER it, the dedup would return the signal-less
    // promise and silently drop the caller's signal. For a topic nobody subscribes to,
    // warmup's subscriber-wait would otherwise hang for ~10s (TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS).
    describe(`Helia pubsub.subscribe() honors AbortSignal - ${config.name}`, () => {
        it("subscribe() rejects within the abort window when no peer subscribes to the topic", async () => {
            // forceMockPubsub: false → use the real helia subscribe path (mockPKCWithHeliaConfig
            // otherwise replaces heliaWithKuboRpcClientFunctions.pubsub with a stub that resolves
            // immediately and never exercises this signal path).
            const pkc = await config.pkcInstancePromise({ forceMockPubsub: false });
            try {
                const heliaShape = Object.values(pkc.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions;

                // A unique random topic — no peer in the test environment is subscribed to it,
                // so warmup will sit on subscriberAppearedPromise until aborted or timed out.
                const unknownTopic = `abort-signal-test-${Math.random().toString(36).slice(2)}-${Date.now()}`;

                const TIMEOUT_MS = 200;
                const start = Date.now();
                let rejected = false;
                let resolvedDurationMs: number | undefined;
                try {
                    await heliaShape.pubsub.subscribe(unknownTopic, () => {}, { signal: AbortSignal.timeout(TIMEOUT_MS) });
                    resolvedDurationMs = Date.now() - start;
                } catch {
                    rejected = true;
                    const elapsed = Date.now() - start;
                    // Without signal propagation, warmup would run to its ~13s budget
                    // (10s subscriber-wait + 3s mesh-wait). 2s gives generous CI slack.
                    expect(
                        elapsed,
                        `subscribe() rejected after ${elapsed}ms, expected well under the ~13s warmup budget (signal must be forwarded)`
                    ).to.be.lessThan(2000);
                }
                expect(
                    rejected,
                    `subscribe() must reject when AbortSignal fires before any peer subscribes (instead resolved in ${resolvedDurationMs}ms)`
                ).to.be.true;
            } finally {
                await pkc.destroy();
            }
        }, 15000);
    });

    // Issue #189: every block fetched over the helia transport used to go through
    // @helia/bitswap's want(), which fires network.findAndConnect(cid) — a routing
    // findProviders query against ALL configured HTTP routers — once PER BLOCK (aborted when
    // the block arrives). A multi-block DAG therefore multiplied router load by its block
    // count. cat() now fetches each DAG through a bitswap session seeded with
    // already-connected peers: per-block wants go only to session peers (wantSessionBlock),
    // and routing is queried at most once per DAG (the session's initial provider search).
    describe(`Helia cat() fetches DAGs through a bitswap session - ${config.name}`, () => {
        // Build content large enough to span multiple unixfs blocks (kubo's default chunker
        // is 256KiB). Randomized so leaf blocks are unique — repeating chunks would dedupe
        // into a single block and defeat the multi-block setup.
        const generateMultiBlockContent = (): string => {
            let content = "";
            while (content.length < 700 * 1024) content += Math.random().toString(36).slice(2);
            return content;
        };

        it("fetching a multi-block DAG issues at most one routing findProviders query, not one per block", async () => {
            const testPKC = await config.pkcInstancePromise({ forceMockPubsub: true });
            const heliaClient = Object.values(testPKC.clients.libp2pJsClients)[0];
            const routing = heliaClient._helia.routing;
            const originalFindProviders = routing.findProviders.bind(routing);
            // The stalled-session failover (issue #218) races helia.blockstore.get after 2.5s,
            // and that broadcast path runs its own findAndConnect routing query. On slow CI
            // runners (Firefox) a block can legitimately stall, adding a findProviders call this
            // test would miscount as a per-block leak. Push the stall window beyond the test
            // timeout so only the session path can query routing here.
            heliaClient.heliaWithKuboRpcClientFunctions._bitswapSessionStalledGetFailoverMs = 10 * 60 * 1000;
            try {
                const content = generateMultiBlockContent();
                const cid = await addStringToIpfs(content);

                let findProvidersCalls = 0;
                routing.findProviders = function (...args: Parameters<typeof originalFindProviders>) {
                    findProvidersCalls++;
                    return originalFindProviders(...args);
                };

                const { content: fetched } = await testPKC.fetchCid({ cid });
                expect(fetched).to.equal(content);
                expect(
                    findProvidersCalls,
                    `a ${Math.ceil((700 * 1024) / (256 * 1024)) + 1}-block DAG must not trigger a routing lookup per block — expected at most 1 per-DAG session query, got ${findProvidersCalls}`
                ).to.be.at.most(1);
            } finally {
                routing.findProviders = originalFindProviders;
                // The libp2p-js client instance is shared/reused across tests — restore the default.
                delete heliaClient.heliaWithKuboRpcClientFunctions._bitswapSessionStalledGetFailoverMs;
                await testPKC.destroy();
            }
        }, 90000);

        it("an already-connected peer seeds the session: multi-block fetch succeeds even when routing finds no providers", async () => {
            const testPKC = await config.pkcInstancePromise({ forceMockPubsub: true });
            const heliaClient = Object.values(testPKC.clients.libp2pJsClients)[0];
            const routing = heliaClient._helia.routing;
            const originalFindProviders = routing.findProviders.bind(routing);
            try {
                // First fetch discovers + dials the kubo node that serves test content, so the
                // client has a connected peer that provides the blocks of the second fetch.
                const firstCid = await addStringToIpfs("session-seed-connection " + Math.random());
                const { content: first } = await testPKC.fetchCid({ cid: firstCid });
                expect(first).to.include("session-seed-connection");
                expect(heliaClient._helia.libp2p.getPeers().length).to.be.greaterThan(0);

                // Blind the routing layer entirely: only a session seeded with the
                // already-connected kubo peer can serve the blocks now.
                routing.findProviders = async function* () {};

                const content = generateMultiBlockContent();
                const cid = await addStringToIpfs(content);
                const { content: fetched } = await testPKC.fetchCid({ cid });
                expect(fetched).to.equal(content);
            } finally {
                routing.findProviders = originalFindProviders;
                await testPKC.destroy();
            }
        }, 90000);
    });

    // Issue #202: every CID fetched over the helia transport belongs to a community, and that
    // community's record server (a subscriber of its IPNS-over-pubsub topic) by construction
    // provides every block under it. Fetch call sites therefore pass the community's IPNS record
    // pubsub topic through _fetchCidP2P -> cat() as a seed scope, so the bitswap session seeds
    // subscribers of THAT topic first instead of a global recent-record-servers list that can
    // point at another community's server in multi-community apps.
    describe(`Bitswap session seeds are scoped to the community being fetched (issue #202) - ${config.name}`, () => {
        const getScopeOfCatCall = (options: unknown): string | undefined =>
            (options as { bitswapSessionSeedScopeIpnsPubsubTopic?: string } | undefined)?.bitswapSessionSeedScopeIpnsPubsubTopic;

        it("fetching a page passes the community's IPNS record pubsub topic as the session seed scope", async () => {
            const testPKC = await config.pkcInstancePromise({ forceMockPubsub: true });
            try {
                const heliaClient = Object.values(testPKC.clients.libp2pJsClients)[0];
                const mockCommunity = await testPKC.createCommunity({ address: signers[0].address });
                expect(mockCommunity.ipnsPubsubTopic).to.be.a("string");

                const pageCid = await addStringToIpfs(JSON.stringify(validPageFixture));
                mockCommunity.posts.pageCids = { ...mockCommunity.posts.pageCids, hot: pageCid };

                const catSpy = vi.spyOn(heliaClient.heliaWithKuboRpcClientFunctions, "cat");
                try {
                    await mockCommunity.posts.getPage({ cid: pageCid });
                    const pageCatCall = catSpy.mock.calls.find(([path]) => path === pageCid);
                    expect(pageCatCall, `expected a cat() call for page cid ${pageCid}`).to.exist;
                    expect(getScopeOfCatCall(pageCatCall![1])).to.equal(mockCommunity.ipnsPubsubTopic);
                } finally {
                    catSpy.mockRestore();
                }
            } finally {
                await testPKC.destroy();
            }
        }, 90000);

        it("fetching the community record CID passes the community's IPNS record pubsub topic as the session seed scope", async () => {
            const testPKC = await config.pkcInstancePromise({ forceMockPubsub: false });
            try {
                const heliaClient = Object.values(testPKC.clients.libp2pJsClients)[0];
                const catSpy = vi.spyOn(heliaClient.heliaWithKuboRpcClientFunctions, "cat");
                try {
                    const community = await testPKC.createCommunity({ address: mathCliNoMockedPubsubCommunityAddress });
                    await community.update();
                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => typeof community.updatedAt === "number"
                    });
                    await community.stop();
                    expect(community.updateCid).to.be.a("string");
                    const recordCatCall = catSpy.mock.calls.find(([path]) => path === community.updateCid);
                    expect(recordCatCall, `expected a cat() call for community record cid ${community.updateCid}`).to.exist;
                    expect(getScopeOfCatCall(recordCatCall![1])).to.equal(community.ipnsPubsubTopic);
                } finally {
                    catSpy.mockRestore();
                }
            } finally {
                await testPKC.destroy();
            }
        }, 90000);

        it("fetching CommentIpfs and the postUpdates CommentUpdate walk pass the community's session seed scope", async () => {
            const testPKC = await config.pkcInstancePromise({ forceMockPubsub: false });
            try {
                const post = await generatePostToAnswerMathQuestion({ communityAddress: mathCliNoMockedPubsubCommunityAddress }, testPKC);
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
                expect(post.cid).to.be.a("string");

                const heliaClient = Object.values(testPKC.clients.libp2pJsClients)[0];
                const comment = await testPKC.createComment({ cid: post.cid!, communityAddress: mathCliNoMockedPubsubCommunityAddress });
                const catSpy = vi.spyOn(heliaClient.heliaWithKuboRpcClientFunctions, "cat");
                // The update loop takes the CommentUpdate from the updating community's preloaded
                // posts pages when the post happens to be in them, skipping the postUpdates walk
                // entirely — whether that shortcut hits depends on how many posts the shared test
                // community has accumulated, so without stubbing it out this test is racy. Force
                // the walk so the scope assertion below is deterministic.
                const findInPagesSpy = vi
                    .spyOn(CommentClientsManager.prototype, "_findCommentInPagesOfUpdatingCommentsOrCommunity")
                    .mockReturnValue(undefined);
                try {
                    await comment.update();
                    // If the freshly published post has already landed in the community's regenerated
                    // preloaded pages, the CommentUpdate is taken from there and the postUpdates walk
                    // (and its cat() call asserted below) never runs — force the walk path.
                    mockCommentToNotUsePagesForUpdates(comment);
                    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
                    await comment.stop();

                    const expectedScope = ipnsNameToIpnsOverPubsubTopic(mathCliNoMockedPubsubCommunityAddress);

                    const commentIpfsCatCall = catSpy.mock.calls.find(([path]) => path === post.cid);
                    expect(commentIpfsCatCall, `expected a cat() call for CommentIpfs cid ${post.cid}`).to.exist;
                    expect(getScopeOfCatCall(commentIpfsCatCall![1])).to.equal(expectedScope);

                    const updateWalkCatCall = catSpy.mock.calls.find(
                        ([path]) => typeof path === "string" && path.endsWith(`/${post.cid}/update`)
                    );
                    expect(updateWalkCatCall, `expected a cat() call for the postUpdates walk of ${post.cid}`).to.exist;
                    expect(getScopeOfCatCall(updateWalkCatCall![1])).to.equal(expectedScope);
                } finally {
                    findInPagesSpy.mockRestore();
                    catSpy.mockRestore();
                }
            } finally {
                await testPKC.destroy();
            }
        }, 120000);
    });
});
