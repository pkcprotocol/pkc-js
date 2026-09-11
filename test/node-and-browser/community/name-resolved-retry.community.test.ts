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
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// How long a `false` verdict is trusted in these tests. Short enough that a test can outlive it without
// sitting on the real 60 seconds, long enough that the retry is still demonstrably rate limited rather than
// firing on every update cycle.
const FALSE_TTL_MS = 2000;

// Polls, because what the in-flight case waits for is a resolver being entered, which emits no event.
const waitUntil = async (predicate: () => boolean, timeoutMs = 10000) => {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) throw Error("Timed out waiting for the condition to become true");
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

// describeSkipIfRpc: every case here turns a resolver on and off to drive the verdict, and the resolver is
// configured on this client. Under RPC the community is resolved on the server with its own mock resolvers,
// which answer normally, so the outage never happens on the side that computes `community.nameResolved`.
describeSkipIfRpc("community.nameResolved re-earns a false verdict (#353)", () => {
    let pkc: PKC;
    // Flipped by each test to change what the single shared resolver answers.
    const resolverAnswer: { publicKey?: string } = {};
    // Every name the resolver was asked for, so the rate limit is observable rather than assumed. Counted on
    // entry, so it is the number of resolves STARTED, which is what the in-flight case below measures.
    let resolveCount = 0;
    // Set by the in-flight case to hold every resolve open, standing in for a resolver that is reachable but
    // answering very slowly. Left undefined by every other case.
    let heldResolves: { promise: Promise<void>; release: () => void } | undefined;
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
                            if (heldResolves) await heldResolves.promise;
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

    // Issue #353. The retry is bounded by a floor measured from when the last verdict was RECORDED, and a
    // verdict is recorded when the resolve settles. While one is still in flight there is no verdict and no
    // stamp, so nothing but an in-flight guard stops the ungated pinned-name path from starting another
    // attempt on every fetch cycle. A resolve has no timeout of its own, only the community's stop signal, so
    // a reachable-but-slow resolver would otherwise accumulate attempts for as long as it takes to answer.
    it("does not start a second resolve while one is still in flight", async () => {
        const name = `retry-in-flight-${Date.now()}.eth`;
        const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name });

        resolverAnswer.publicKey = undefined;
        let releaseHeldResolves = () => {};
        heldResolves = { promise: new Promise<void>((resolve) => (releaseHeldResolves = resolve)), release: () => releaseHeldResolves() };
        try {
            const community = await pkc.createCommunity({ name, publicKey: communityPublicKey });
            communities.push(community);
            const countBeforeUpdate = resolveCount;
            await community.update();

            // The first attempt starts and then hangs inside the resolver. A second one is expected here and
            // is not what this case is about: the guard is per instance, and a community the caller holds
            // mirrors an internal updating instance, so each of the two classifies the name once.
            await waitUntil(() => resolveCount > countBeforeUpdate, 10000);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const countWhileHeld = resolveCount;

            // Several more fetch cycles at the 500ms updateInterval these test instances use. Every one of
            // them reaches the pinned-name branch, and not one may start another attempt while the attempt
            // before it is still unanswered.
            await new Promise((resolve) => setTimeout(resolve, 2000));
            expect(resolveCount).to.equal(countWhileHeld);
        } finally {
            heldResolves?.release();
            heldResolves = undefined;
        }
    });
});

// Issue #353. `undefined` is both "we could not find out" and the marker that allows a retry, so a name no
// configured resolver can handle would be attempted on every fetch cycle forever: the attempt throws
// ERR_NO_RESOLVER_FOR_NAME before reaching any resolver, records nothing, and leaves the verdict exactly where
// it was. The check that skips it is synchronous and lives in `_resolveNameInBackground` itself, because the
// pinned-name path that runs every cycle has no gate of its own.
describeSkipIfRpc("community.nameResolved never attempts a name no resolver can handle (#353)", () => {
    let pkc: PKC;
    let community: RemoteCommunity;

    afterAll(async () => {
        if (community) await community.stop();
        if (pkc) await pkc.destroy();
    });

    it("does not enter the background resolve at all for an unsupported TLD", async () => {
        const name = `retry-unsupported-tld-${Date.now()}.scam`;
        const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name });

        pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        key: `retry-unsupported-tld-${Date.now()}`,
                        canResolve: ({ name }) => name.endsWith(".eth"),
                        resolveFunction: async () => undefined
                    })
                ]
            }
        });

        community = await pkc.createCommunity({ name, publicKey: communityPublicKey });
        await community.update();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        // For an unsupported TLD the attempt and the skip look identical from the outside: no resolver is
        // ever reached, because the loop throws ERR_NO_RESOLVER_FOR_NAME before touching one. So the
        // observable is one level up, on the instance that actually runs the fetch cycles, which is the
        // tracked updating instance rather than the one the caller holds.
        const updatingCommunity = <RemoteCommunity | undefined>findUpdatingCommunity(pkc, { name, publicKey: communityPublicKey });
        if (!updatingCommunity) throw Error("The community should have a tracked updating instance while it is updating");
        const clientsManager = updatingCommunity._clientsManager;
        const resolveCommunityName = clientsManager.resolveCommunityNameIfNeeded.bind(clientsManager);
        let attempts = 0;
        clientsManager.resolveCommunityNameIfNeeded = async (args) => {
            attempts++;
            return resolveCommunityName(args);
        };

        // Several fetch cycles, every one of them taking the pinned-name branch.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        expect(attempts).to.equal(0);
        // The verdict for a name we can never ask about is "we do not know", not "not theirs".
        expect(community.nameResolved).to.be.undefined;
    });
});
