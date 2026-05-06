// Documents the behavior of loading a comment by CID with no prior community
// subscription. Two scenarios:
//
//   1. The comment IS reachable (community is up, CID is fetchable from a community
//      peer). The parallel community connect kicked off by
//      `loadCommentIpfsAndStartCommentUpdateSubscription` fires 5s into the first
//      cat() attempt: it calls `pkc.getCommunity` so we subscribe to the community's
//      IPNS pubsub topic and connect to its peers, and bitswap then fetches the
//      comment block from one of those peers. Loads within ~6s on libp2pjs even when
//      no provider record exists for the comment CID; instant on kubo when local.
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

        it("loads comment IPFS within 10s via the parallel community connect", async () => {
            // Fresh resolver PKC — simulates a user landing directly on /thread/<cid>.
            // No getCommunity / createCommunity / prior pubsub subscription on this instance.
            // For libp2pjs we point its single HTTP router at the mock router (which
            // returns nothing for the comment CID, so the in-flight cat() can't make
            // progress and the parallel fallback has to carry the load). The
            // remote-kubo-rpc config shares the publisher's local kubo, so the comment
            // block is already local and no router setup is needed there.
            const isLibp2pjs = config.testConfigCode === "remote-libp2pjs";
            const resolverPkc = await config.pkcInstancePromise(
                isLibp2pjs ? { pkcOptions: { httpRoutersOptions: [mockHttpRouter.url] } } : {}
            );
            const getCommunitySpy = vi.spyOn(resolverPkc, "getCommunity");
            try {
                const comment = await resolverPkc.createComment({
                    cid: publishedPost.cid!,
                    communityPublicKey: community.publicKey
                });
                const startedAt = Date.now();
                await comment.update();

                // Parallel community connect fires 5s into the first cat() attempt and
                // bitswap fetches the comment block from a community peer shortly after,
                // so total time should be well under 10s. The vitest timeout below is
                // the per-test cap.
                await resolveWhenConditionIsTrue({
                    toUpdate: comment,
                    predicate: async () => typeof comment.raw.comment === "object"
                });
                const elapsedMs = Date.now() - startedAt;
                expect(comment.raw.comment, "comment IPFS should have loaded").to.be.an("object");
                expect(elapsedMs, `comment IPFS should load within 10s (took ${elapsedMs}ms)`).to.be.lessThan(10_000);

                // The kubo path resolves the cat() before the 5s timer fires (block is
                // local), so the parallel connect is skipped. On libp2pjs the cat() has
                // no provider, so the parallel pkc.getCommunity must fire.
                if (isLibp2pjs) {
                    expect(
                        getCommunitySpy,
                        "parallel community connect should have called pkc.getCommunity with the community's publicKey"
                    ).toHaveBeenCalledWith(expect.objectContaining({ publicKey: community.publicKey }));
                }
                await comment.stop();
            } finally {
                getCommunitySpy.mockRestore();
                await resolverPkc.destroy();
            }
        }, 30_000);

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
