// Issue #353. A `nameResolved: false` verdict is an accusation resting on evidence nothing persists: the
// persistent name cache stores successes only. The states that produce one are also the volatile ones, since
// a domain with no TXT record yet is exactly what a correctly owned domain looks like while its owner is
// still configuring it. Before this, `_resolveNameInBackground` was gated on "not yet a boolean" and its own
// comment said "(once)", so the first viewer to look during that window kept the verdict for the life of the
// instance. It is now re-earned, floored at `pkc._nameResolvedFalseTtlMs` so the retry cannot run once per
// update cycle (one second on the kubo-RPC path) for a name that genuinely has no record.
//
// The four call sites of `_resolveNameInBackground` are covered here: the two gated ones for a key-addressed
// community carrying a name claim, the gated one for a domain-addressed community, and the ungated
// pinned-IPNS-name one, which already retried and must keep doing so.
import {
    createMockedCommunityIpns,
    createMockNameResolver,
    mockRemotePKC,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// How long a `false` verdict is trusted in these tests. Short enough that a test can outlive it without
// sitting on the real 60 seconds, long enough that the retry is still demonstrably rate limited rather than
// firing on every update cycle.
const FALSE_TTL_MS = 2000;

// describeSkipIfRpc: every case here turns a resolver on and off to drive the verdict, and the resolver is
// configured on this client. Under RPC the community is resolved on the server with its own mock resolvers,
// which answer normally, so the outage never happens on the side that computes `community.nameResolved`.
describeSkipIfRpc("community.nameResolved re-earns a false verdict (#353)", () => {
    let pkc: PKC;
    // Flipped by each test to change what the single shared resolver answers.
    const resolverAnswer: { publicKey?: string } = {};
    // Every name the resolver was asked for, so the rate limit is observable rather than assumed.
    let resolveCount = 0;
    const communities: RemoteCommunity[] = [];

    beforeAll(async () => {
        pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        key: `name-resolved-retry-${Date.now()}`,
                        resolveFunction: async () => {
                            resolveCount++;
                            return resolverAnswer.publicKey ? { publicKey: resolverAnswer.publicKey } : undefined;
                        }
                    })
                ]
            }
        });
        // Per instance, so shortening it here cannot leak into another suite sharing this worker.
        pkc._nameResolvedFalseTtlMs = FALSE_TTL_MS;
    });

    afterAll(async () => {
        for (const community of communities) await community.stop();
        await pkc.destroy();
    });

    // Call sites: the post-update classification and the fetch-time one, both for a community addressed by
    // its raw IPNS key whose record claims a name.
    it("flips false to true for a key-addressed community once the record appears", async () => {
        const name = `retry-key-addressed-${Date.now()}.eth`;
        const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name });

        resolverAnswer.publicKey = undefined; // the name has no record yet
        const community = await pkc.createCommunity({ publicKey: communityPublicKey });
        communities.push(community);
        await community.update();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.nameResolved === false
        });
        expect(community.nameResolved).to.equal(false);

        // The owner finishes configuring the domain.
        resolverAnswer.publicKey = communityPublicKey;
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.nameResolved === true
        });
        expect(community.nameResolved).to.equal(true);
    });

    // Call site: the ungated pinned-IPNS-name branch, which is the one a domain-addressed community takes.
    // It retried before this change and must keep retrying, since that is what lets a domain community notice
    // its record appearing at all. A domain-addressed community still loads while its name does not resolve,
    // because it fetches through the publicKey it was created with.
    //
    // Only the false-to-true direction is driven here. Going the other way is not reachable in a short test
    // and has nothing to do with this change: the community drift resolve rides the persistent cache with
    // `maxAge: 3600`, so a name that resolved once keeps answering from disk for an hour. Failures are never
    // persisted, which is exactly why the direction that matters here is the one that works.
    it("flips false to true for a domain-addressed community once the record appears", async () => {
        const name = `retry-domain-addressed-${Date.now()}.eth`;
        const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name });

        resolverAnswer.publicKey = undefined; // the domain is not configured yet
        const community = await pkc.createCommunity({ name, publicKey: communityPublicKey });
        communities.push(community);
        await community.update();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.nameResolved === false
        });
        expect(community.nameResolved).to.equal(false);

        resolverAnswer.publicKey = communityPublicKey;
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.nameResolved === true
        });
        expect(community.nameResolved).to.equal(true);
    });

    // The retry has to be bounded or it becomes the very churn the `canResolveName` short-circuit was added
    // to remove: the update loop turns over far faster than the floor, and a negative resolve persists
    // nothing, so every cycle would reach the network.
    it("does not re-resolve a false verdict more than once per floor", async () => {
        const name = `retry-rate-limited-${Date.now()}.eth`;
        const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name });

        resolverAnswer.publicKey = undefined;
        const community = await pkc.createCommunity({ publicKey: communityPublicKey });
        communities.push(community);
        await community.update();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.nameResolved === false
        });

        const countAfterFirstVerdict = resolveCount;
        // Well under the floor, and long enough for several update cycles at the 500ms updateInterval these
        // test instances use.
        await new Promise((resolve) => setTimeout(resolve, FALSE_TTL_MS / 2));
        // Other suites in this describe share the resolver, but they run sequentially, so any growth here is
        // this community's own retries.
        expect(resolveCount - countAfterFirstVerdict).to.be.lessThan(2);

        // Past the floor it is allowed to ask again, which is what makes the flip in the cases above possible.
        await new Promise((resolve) => setTimeout(resolve, FALSE_TTL_MS));
        expect(resolveCount).to.be.greaterThan(countAfterFirstVerdict);
    });
});
