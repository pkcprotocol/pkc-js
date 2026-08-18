import { describe, it, expect } from "vitest";
import { TrackedInstanceRegistry } from "../../../dist/node/pkc/tracked-instance-registry.js";
import {
    findCommunityInRegistry,
    getCommunityRegistryAliases,
    syncCommunityRegistryEntry
} from "../../../dist/node/pkc/tracked-instance-registry-util.js";

// Issue #238: processStartedCommunities is a module-level registry shared by every PKC instance in
// the process, and its aliases carried no dataPath. Two LocalCommunity instances backed by
// different dataPaths but sharing an address therefore resolved to each other, and
// updateInstancePropsWithStartedCommunityOrDb copied one instance's state into a community whose
// signer is a different key — every later publish then failed signature validation.
//
// The registry itself is address-blind, so these tests exercise the alias layer directly: that is
// where the scoping lives, and it is what every processStartedCommunities call site now feeds.

type TestCommunity = { name?: string; publicKey?: string; signer?: { address?: string } };

const PUBLIC_KEY = "12D3KooWFfvHKtestpublickeyfor238scope";
const OTHER_PUBLIC_KEY = "12D3KooWN5rLmtestpublickeyfor238scope";
const DATA_PATH_A = "/tmp/pkc-238-scope-a";
const DATA_PATH_B = "/tmp/pkc-238-scope-b";

describe("community registry aliases are scoped by dataPath (issue #238)", () => {
    it("a same-address community in another dataPath is not found", () => {
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const communityInA: TestCommunity = { publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, communityInA, DATA_PATH_A);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_B)).to.be.undefined;
    });

    it("the same community is still found within its own dataPath", () => {
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const communityInA: TestCommunity = { publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, communityInA, DATA_PATH_A);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_A)).to.equal(communityInA);
    });

    it("two different communities sharing one dataPath never resolve to each other", () => {
        // Guards the naive fix of adding dataPath as one more plain alias: the registry matches on
        // ANY alias, so a bare dataPath alias would make every community in a dataPath collide.
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const first: TestCommunity = { publicKey: PUBLIC_KEY };
        const second: TestCommunity = { publicKey: OTHER_PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, first, DATA_PATH_A);
        syncCommunityRegistryEntry(registry, second, DATA_PATH_A);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_A)).to.equal(first);
        expect(findCommunityInRegistry(registry, { publicKey: OTHER_PUBLIC_KEY }, DATA_PATH_A)).to.equal(second);
    });

    it("two same-address communities in different dataPaths coexist, each found under its own", () => {
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const inA: TestCommunity = { publicKey: PUBLIC_KEY };
        const inB: TestCommunity = { publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, inA, DATA_PATH_A);
        syncCommunityRegistryEntry(registry, inB, DATA_PATH_B);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_A)).to.equal(inA);
        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_B)).to.equal(inB);
    });

    it("domain lookups stay scoped, including the .eth/.bso equivalence", () => {
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const inA: TestCommunity = { name: "scope-238.bso", publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, inA, DATA_PATH_A);

        expect(findCommunityInRegistry(registry, { name: "scope-238.bso" }, DATA_PATH_A)).to.equal(inA);
        expect(findCommunityInRegistry(registry, { name: "scope-238.eth" }, DATA_PATH_A)).to.equal(inA);
        expect(findCommunityInRegistry(registry, { name: "scope-238.bso" }, DATA_PATH_B)).to.be.undefined;
        expect(findCommunityInRegistry(registry, { name: "scope-238.eth" }, DATA_PATH_B)).to.be.undefined;
    });

    it("an unscoped registry (no dataPath) keeps matching as before", () => {
        // pkc._updatingCommunities / pkc._startedCommunities are per-PKC and already scoped by
        // construction, so they pass no dataPath and must be unaffected.
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const community: TestCommunity = { publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, community);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY })).to.equal(community);
    });

    it("address is not carried as its own alias, since it is always name or publicKey", () => {
        const domainCommunity: TestCommunity = { name: "scope-238.bso", publicKey: PUBLIC_KEY };
        const keyCommunity: TestCommunity = { publicKey: PUBLIC_KEY };

        // Every alias a community publishes is reachable from name/publicKey/signer.address alone.
        expect(getCommunityRegistryAliases(domainCommunity)).to.include("scope-238.bso");
        expect(getCommunityRegistryAliases(domainCommunity)).to.include(PUBLIC_KEY);
        expect(getCommunityRegistryAliases(keyCommunity)).to.deep.equal([PUBLIC_KEY]);
    });

    it("signer.address stays an alias, because a delegated community's identity is its anchor", () => {
        // communityIdentityPublicKey() is `anchor?.publicKey ?? signer.address`, so on a delegated
        // community publicKey is the anchor while signer.address is the minter that signs records.
        // They are different keys and both have to resolve to the instance.
        const delegated: TestCommunity = { publicKey: PUBLIC_KEY, signer: { address: OTHER_PUBLIC_KEY } };
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        syncCommunityRegistryEntry(registry, delegated, DATA_PATH_A);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_A)).to.equal(delegated);
        expect(findCommunityInRegistry(registry, { publicKey: OTHER_PUBLIC_KEY }, DATA_PATH_A)).to.equal(delegated);
        expect(findCommunityInRegistry(registry, { publicKey: OTHER_PUBLIC_KEY }, DATA_PATH_B)).to.be.undefined;
    });
});
