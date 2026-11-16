// Documents the behavior of loading a comment by CID with no prior community
// subscription. Two scenarios:
//
//   1. The comment IS reachable (community is up, CID is fetchable from a community
//      peer). Both `comment.update()` and `pkc.getComment()` start a community
//      connect at the same moment as the CID fetch (issue #562): they call
//      `pkc.getCommunity` so we connect to the community's peers, and bitswap then
//      fetches the comment block from one of those peers. Loads in about a second on
//      libp2pjs even when no provider record exists for the comment CID; instant on
//      kubo when local.
//
//   2. The comment is UNREACHABLE (CID doesn't exist anywhere). Behavior splits by
//      caller:
//        - `comment.update()` returns immediately and the loop runs in the
//          background; retriable errors emit "error" events on the comment but the
//          load loop retries forever (`retry.operation({ forever: true })`).
//        - `pkc.getComment(cid)` wraps the load in a 60s `comment-ipfs` timeout and
//          throws a `TimeoutError`.

import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";

import {
    createSubWithNoChallenge,
    publishRandomPost,
    mockPKC,
    mockGatewayPKC,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";

// Test server's mock delegated router (test/server/test-server.js:setupMockDelegatedRouter).
// Returns the test kubo nodes' libp2p addresses for any CID query — we use it
// as the source of truth for provider entries we copy into our own MockHttpRouter.
const TEST_SERVER_HTTP_ROUTER_URL = "http://localhost:20001";

let publisherPkc: PKC;
let community: LocalCommunity;
let publishedPost: Comment;
let unreachableCid: string;
let mockHttpRouter: MockHttpRouter;

beforeAll(async () => {
    publisherPkc = await mockPKC();
    community = (await createSubWithNoChallenge({}, publisherPkc)) as LocalCommunity;
    await community.start();
    await new Promise<void>((resolve) => community.once("update", () => resolve()));

    publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: publisherPkc });
    expect(publishedPost.cid).to.be.a("string");

    // Stand up a real HTTP router for the libp2pjs resolver. The router has
    // no record for the comment CID — mirrors the production case where
    // peers.pleb.bot returns {"Providers":null} for the comment CID. It DOES
    // have a provider for the community IPNS pubsub topic so the on-failure
    // community-update fallback can connect to a pubsub peer and resolve IPNS.
    mockHttpRouter = new MockHttpRouter();
    await mockHttpRouter.start();

    expect(community.ipnsPubsubTopicRoutingCid, "ipnsPubsubTopicRoutingCid should be set after community.start()").to.be.a("string");
    const ipnsPubsubTopicCid = community.ipnsPubsubTopicRoutingCid!;

    // Copy provider entries for the IPNS pubsub topic CID from the test
    // server's HTTP router into our mock. Comment CID stays unregistered, so
    // GET /routing/v1/providers/<commentCid> on our mock returns 404 with
    // {Providers: null} — the "undefined" record case under test.
    const upstreamRes = await fetch(`${TEST_SERVER_HTTP_ROUTER_URL}/routing/v1/providers/${ipnsPubsubTopicCid}`);
    if (!upstreamRes.ok) throw new Error(`Test server router returned ${upstreamRes.status} for ${ipnsPubsubTopicCid}`);
    const upstreamBody = (await upstreamRes.json()) as {
        Providers: Array<{ Schema?: string; ID: string; Addrs: string[]; Protocols?: string[] }> | null;
    };
    if (!upstreamBody.Providers?.length)
        throw new Error(`Test server router returned no providers for the community IPNS pubsub topic CID ${ipnsPubsubTopicCid}`);

    const putBody = {
        Providers: upstreamBody.Providers.map((p) => ({
            Schema: p.Schema ?? "peer",
            Payload: { Keys: [ipnsPubsubTopicCid], ID: p.ID, Addrs: p.Addrs, Protocols: p.Protocols }
        }))
    };
    const putRes = await fetch(`${mockHttpRouter.url}/routing/v1/providers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(putBody)
    });
    if (!putRes.ok) throw new Error(`Mock router PUT failed with ${putRes.status}`);

    expect(
        mockHttpRouter.hasProvidersFor(ipnsPubsubTopicCid),
        "mock http router should have providers for the community IPNS pubsub topic CID"
    ).to.be.true;
    expect(
        mockHttpRouter.hasProvidersFor(publishedPost.cid!),
        "mock http router must NOT have providers for the comment CID — that's the case under test"
    ).to.be.false;

    // A CID that's syntactically valid but doesn't correspond to any block on the
    // network — used to exercise the "unreachable" path.
    unreachableCid = "QmZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
}, 90_000);

afterAll(async () => {
    if (community) {
        try {
            await community.stop();
        } catch {}
    }
    if (publisherPkc) await publisherPkc.destroy();
    if (mockHttpRouter) await mockHttpRouter.destroy();
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs", "remote-kubo-rpc"] }).map((config) => {
    describe(`Direct-thread URL: load comment by CID with community hint, no prior subscription - ${config.name}`, () => {
        const isLibp2pjs = config.testConfigCode === "remote-libp2pjs";

        it("mock http router has a provider for the community IPNS pubsub topic and none for the comment CID", () => {
            expect(mockHttpRouter.hasProvidersFor(community.ipnsPubsubTopicRoutingCid!)).to.be.true;
            const providers = mockHttpRouter.getProvidersFor(community.ipnsPubsubTopicRoutingCid!);
            expect(providers.length).to.be.at.least(1);
            for (const provider of providers) {
                expect(provider.ID).to.be.a("string").and.to.have.length.greaterThan(0);
                expect(provider.Addrs).to.be.an("array").and.to.have.length.greaterThan(0);
            }
            expect(mockHttpRouter.hasProvidersFor(publishedPost.cid!)).to.be.false;
        });

        // How soon after the load starts pkc.getCommunity must have been called. The connect is
        // started synchronously with the fetch, so this only has to absorb scheduling jitter.
        const GET_COMMUNITY_MUST_START_WITHIN_MS = 1_000;
        // Loose bound on the whole load against a local kubo node (measured: well under 2s).
        const COLD_LOAD_DEADLINE_MS = 6_000;

        // A cold client: its own helia node (forceMockPubsub: false gives a random client key, so no
        // connections or blocks are shared with another test) whose only router lists the community
        // but not the comment CID.
        const createColdResolverPkc = async () =>
            config.pkcInstancePromise(
                isLibp2pjs ? { forceMockPubsub: false, pkcOptions: { httpRoutersOptions: [mockHttpRouter.url] } } : {}
            );

        // Records when pkc.getCommunity is called and with what, and still runs the real call.
        const recordGetCommunityCalls = (pkc: PKC) => {
            const calls: { atMs: number; args: Parameters<PKC["getCommunity"]>[0] }[] = [];
            const startedAt = Date.now();
            const original = pkc.getCommunity.bind(pkc);
            const spy = vi.spyOn(pkc, "getCommunity").mockImplementation((args) => {
                calls.push({ atMs: Date.now() - startedAt, args });
                return original(args);
            });
            return { calls, startedAt, restore: () => spy.mockRestore() };
        };

        it("comment.update() starts the community connect at once and loads the comment", async () => {
            const resolverPkc = await createColdResolverPkc();
            const comment = await resolverPkc.createComment({ cid: publishedPost.cid!, communityPublicKey: community.publicKey });
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                await comment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: comment,
                    predicate: async () => typeof comment.raw.comment === "object"
                });
                const elapsedMs = Date.now() - recorded.startedAt;
                console.log(
                    `[issue-562] update() ${config.testConfigCode}: loaded in ${elapsedMs}ms, getCommunity at`,
                    recorded.calls[0]?.atMs
                );
                expect(elapsedMs, `comment IPFS should load within ${COLD_LOAD_DEADLINE_MS}ms (took ${elapsedMs}ms)`).to.be.lessThan(
                    COLD_LOAD_DEADLINE_MS
                );
                // The kubo config shares the publisher's kubo node, so the block is local and the load
                // can finish before anything else matters; only libp2pjs depends on the connect.
                if (isLibp2pjs) {
                    expect(recorded.calls.length, "the community connect should have called pkc.getCommunity").to.be.greaterThan(0);
                    expect(recorded.calls[0].args).to.include({ publicKey: community.publicKey });
                    expect(recorded.calls[0].atMs, "the community connect must not wait before starting").to.be.lessThan(
                        GET_COMMUNITY_MUST_START_WITHIN_MS
                    );
                }
                await comment.stop();
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment({ cid, communityPublicKey }) starts the community connect at once and loads the comment", async () => {
            const resolverPkc = await createColdResolverPkc();
            resolverPkc._timeouts["comment-ipfs"] = 15_000;
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                const comment = await resolverPkc.getComment({ cid: publishedPost.cid!, communityPublicKey: community.publicKey });
                const elapsedMs = Date.now() - recorded.startedAt;
                console.log(
                    `[issue-562] getComment() ${config.testConfigCode}: loaded in ${elapsedMs}ms, getCommunity at`,
                    recorded.calls[0]?.atMs
                );
                expect(comment.raw.comment, "comment IPFS should have loaded").to.be.an("object");
                expect(elapsedMs, `getComment should resolve within ${COLD_LOAD_DEADLINE_MS}ms (took ${elapsedMs}ms)`).to.be.lessThan(
                    COLD_LOAD_DEADLINE_MS
                );
                if (isLibp2pjs) {
                    expect(recorded.calls.length, "getComment should have called pkc.getCommunity").to.be.greaterThan(0);
                    expect(recorded.calls[0].args).to.include({ publicKey: community.publicKey });
                    expect(recorded.calls[0].atMs).to.be.lessThan(GET_COMMUNITY_MUST_START_WITHIN_MS);
                }
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment({ cid, communityName }) starts the community connect with the name", async () => {
            // No community publishes under this name, so the load cannot succeed; the test is about
            // the name reaching pkc.getCommunity.
            const resolverPkc = await createColdResolverPkc();
            resolverPkc._timeouts["comment-ipfs"] = 3_000;
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                await resolverPkc.getComment({ cid: unreachableCid, communityName: "issue-562-nobody.bso" }).catch(() => {});
                expect(recorded.calls.length, "getComment should have called pkc.getCommunity").to.be.greaterThan(0);
                expect(recorded.calls[0].args).to.include({ name: "issue-562-nobody.bso" });
                expect(recorded.calls[0].atMs).to.be.lessThan(GET_COMMUNITY_MUST_START_WITHIN_MS);
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment({ cid }) with no community identity starts no community connect", async () => {
            const resolverPkc = await createColdResolverPkc();
            resolverPkc._timeouts["comment-ipfs"] = 3_000;
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                await resolverPkc.getComment({ cid: unreachableCid }).catch(() => {});
                expect(recorded.calls.length).to.equal(0);
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment() aborts its community load once the comment has loaded", async () => {
            const resolverPkc = await createColdResolverPkc();
            resolverPkc._timeouts["comment-ipfs"] = 15_000;
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                await resolverPkc.getComment({ cid: publishedPost.cid!, communityPublicKey: community.publicKey });
                if (isLibp2pjs || recorded.calls.length > 0) {
                    const abortSignal = recorded.calls[0]?.args.abortSignal;
                    expect(abortSignal, "the community load should be given an abort signal").to.be.instanceOf(AbortSignal);
                    expect(abortSignal!.aborted, "the community load should be aborted when getComment resolves").to.be.true;
                }
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment() aborts its community load when it times out", async () => {
            const resolverPkc = await createColdResolverPkc();
            resolverPkc._timeouts["comment-ipfs"] = 3_000;
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                const unpublishedCommunityKey = (await resolverPkc.createSigner()).address;
                let thrown: Error | undefined;
                await resolverPkc
                    .getComment({ cid: unreachableCid, communityPublicKey: unpublishedCommunityKey })
                    .catch((e) => (thrown = e));
                expect(thrown).to.be.instanceOf(Error);
                const abortSignal = recorded.calls[0]?.args.abortSignal;
                expect(abortSignal, "the community load should be given an abort signal").to.be.instanceOf(AbortSignal);
                expect(abortSignal!.aborted, "the community load should be aborted when getComment times out").to.be.true;
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment() reports a failed community load in the details of the error it throws", async () => {
            const resolverPkc = await createColdResolverPkc();
            // The community load has to fail before getComment itself gives up
            resolverPkc._timeouts["community-ipns"] = 1_500;
            resolverPkc._timeouts["comment-ipfs"] = 6_000;
            try {
                const unpublishedCommunityKey = (await resolverPkc.createSigner()).address;
                let thrown: (Error & { details?: { communityLoadError?: unknown } }) | undefined;
                await resolverPkc
                    .getComment({ cid: unreachableCid, communityPublicKey: unpublishedCommunityKey })
                    .catch((e) => (thrown = e));
                expect(thrown, "getComment should still fail on its own terms").to.be.instanceOf(Error);
                expect(thrown!.details?.communityLoadError, "the community load failure should be attached").to.be.instanceOf(Error);
            } finally {
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment() aborts its community load when the caller aborts", async () => {
            const resolverPkc = await createColdResolverPkc();
            const recorded = recordGetCommunityCalls(resolverPkc);
            const callerAbort = new AbortController();
            try {
                const unpublishedCommunityKey = (await resolverPkc.createSigner()).address;
                setTimeout(() => callerAbort.abort(), 500);
                let thrown: { code?: string } | undefined;
                await resolverPkc
                    .getComment({ cid: unreachableCid, communityPublicKey: unpublishedCommunityKey, abortSignal: callerAbort.signal })
                    .catch((e) => (thrown = e));
                expect(thrown?.code).to.equal("ERR_GET_COMMENT_ABORTED");
                const abortSignal = recorded.calls[0]?.args.abortSignal;
                expect(abortSignal, "the community load should be given an abort signal").to.be.instanceOf(AbortSignal);
                expect(abortSignal!.aborted, "the community load should be aborted with the caller's abort").to.be.true;
            } finally {
                recorded.restore();
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("starts no community connect when the community is already updating on this pkc", async () => {
            const resolverPkc = await createColdResolverPkc();
            resolverPkc._timeouts["comment-ipfs"] = 15_000;
            const updatingCommunity = await resolverPkc.createCommunity({ publicKey: community.publicKey });
            await updatingCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: updatingCommunity,
                predicate: async () => typeof updatingCommunity.updatedAt === "number"
            });
            const recorded = recordGetCommunityCalls(resolverPkc);
            try {
                const comment = await resolverPkc.getComment({ cid: publishedPost.cid!, communityPublicKey: community.publicKey });
                expect(comment.raw.comment).to.be.an("object");
                expect(recorded.calls.length, "the updating community already keeps its peers connected").to.equal(0);
            } finally {
                recorded.restore();
                await updatingCommunity.stop();
                await resolverPkc.destroy();
            }
        }, 60_000);

        it("comment.update() does NOT throw on unreachable CID — it emits 'error' events and retries forever", async () => {
            // Documents existing behavior: retriable errors (timeouts, no providers,
            // network failures) keep retrying. Non-retriable errors (bad signature,
            // bad schema) stop the update loop and surface via the "error" event.
            // Unreachable CID is a retriable error — comment hangs forever waiting.
            const resolverPkc = await config.pkcInstancePromise({});
            try {
                const comment = await resolverPkc.createComment({ cid: unreachableCid });
                const errors: Error[] = [];
                comment.on("error", (err: Error) => errors.push(err));

                await comment.update(); // returns immediately

                // Wait long enough for at least one retriable error to surface.
                await new Promise((resolve) => setTimeout(resolve, 8_000));

                expect(comment.raw.comment, "comment IPFS should NOT have loaded").to.be.undefined;
                expect(comment.state, "comment should still be updating (retrying), not stopped").to.equal("updating");

                await comment.stop();
            } finally {
                await resolverPkc.destroy();
            }
        }, 30_000);

        it("pkc.getComment(unreachableCid) throws TimeoutError after the comment-ipfs timeout", async () => {
            // pkc.getComment wraps _attemptInfintelyToLoadCommentIpfs in a pTimeout
            // (this._timeouts["comment-ipfs"]). Lower the timeout for the test so we
            // don't sit through the full 60s default.
            const resolverPkc = await config.pkcInstancePromise({});
            try {
                resolverPkc._timeouts["comment-ipfs"] = 4_000;

                let thrown: Error | undefined;
                try {
                    await resolverPkc.getComment({ cid: unreachableCid });
                } catch (e) {
                    thrown = e as Error;
                }
                expect(thrown, "getComment should throw on unreachable CID").to.be.an.instanceOf(Error);
                expect(thrown!.message, "error message should mention timeout or fetching").to.match(/timed out|TimeoutError|fetch/i);
            } finally {
                await resolverPkc.destroy();
            }
        }, 20_000);
    });
});

// A gateway connection cannot serve bitswap, so loading the community through a gateway does nothing
// for the comment fetch and would only cost an extra gateway request (issue #562).
describe("Gateway-only pkc starts no community connect when loading a comment by CID", () => {
    it("comment.update() and pkc.getComment() do not call pkc.getCommunity", async () => {
        const gatewayPkc = await mockGatewayPKC();
        gatewayPkc._timeouts["comment-ipfs"] = 2_000;
        const getCommunitySpy = vi.spyOn(gatewayPkc, "getCommunity");
        try {
            await gatewayPkc.getComment({ cid: unreachableCid, communityPublicKey: community.publicKey }).catch(() => {});

            const comment = await gatewayPkc.createComment({ cid: unreachableCid, communityPublicKey: community.publicKey });
            comment.on("error", () => {});
            await comment.update();
            // Longer than the 5s delay the connect used to wait before this issue
            await new Promise((resolve) => setTimeout(resolve, 6_500));
            await comment.stop();

            expect(getCommunitySpy).not.toHaveBeenCalled();
        } finally {
            getCommunitySpy.mockRestore();
            await gatewayPkc.destroy();
        }
    }, 40_000);
});
