import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
    findProcessStartedCommunity,
    processStartedCommunities,
    syncProcessStartedCommunity
} from "../../../dist/node/runtime/node/community/local-community/registry.js";
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

describe("alias history is kept per registry and re-scoped on every sync", () => {
    it("syncing into an unscoped registry first does not leak bare aliases into a scoped one", () => {
        // lifecycle.ts start() tracks the per-PKC registry (unscoped) right before the process registry
        // (scoped). With a single history Set per object the process registry also received the bare
        // aliases, so an unscoped lookup (or a caller forgetting dataPath) matched across dataPaths.
        const perPkcRegistry = new TrackedInstanceRegistry<TestCommunity>();
        const processRegistry = new TrackedInstanceRegistry<TestCommunity>();
        const community: TestCommunity = { publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(perPkcRegistry, community);
        syncCommunityRegistryEntry(processRegistry, community, DATA_PATH_A);

        expect(processRegistry.aliases()).to.not.include(PUBLIC_KEY);
        expect(findCommunityInRegistry(processRegistry, { publicKey: PUBLIC_KEY })).to.be.undefined;
        expect(findCommunityInRegistry(processRegistry, { publicKey: PUBLIC_KEY }, DATA_PATH_A)).to.equal(community);
        // and the scoped aliases do not flow back into the unscoped registry either
        expect(perPkcRegistry.aliases()).to.deep.equal([PUBLIC_KEY]);
    });

    it("a community re-tracked under a new dataPath is no longer found under the old one", () => {
        // RPC setSettings swaps community._pkc (possibly with a new dataPath), then stop()/start()s the
        // same object. The old scope must not survive that restart.
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const community: TestCommunity = { publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, community, DATA_PATH_A);
        registry.untrack(community);
        syncCommunityRegistryEntry(registry, community, DATA_PATH_B);

        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_A)).to.be.undefined;
        expect(findCommunityInRegistry(registry, { publicKey: PUBLIC_KEY }, DATA_PATH_B)).to.equal(community);
    });

    it("renamed communities stay reachable by their old name within the same dataPath (sticky aliases)", () => {
        const registry = new TrackedInstanceRegistry<TestCommunity>();
        const community: TestCommunity = { name: "before-238.eth", publicKey: PUBLIC_KEY };
        syncCommunityRegistryEntry(registry, community, DATA_PATH_A);
        community.name = "after-238.eth";
        syncCommunityRegistryEntry(registry, community, DATA_PATH_A);

        expect(findCommunityInRegistry(registry, { name: "before-238.eth" }, DATA_PATH_A)).to.equal(community);
        expect(findCommunityInRegistry(registry, { name: "after-238.eth" }, DATA_PATH_A)).to.equal(community);
        expect(findCommunityInRegistry(registry, { name: "before-238.eth" }, DATA_PATH_B)).to.be.undefined;
    });
});

describe("processStartedCommunities scope normalizes the dataPath", () => {
    it("different spellings of the same directory land in the same scope", () => {
        const dir = path.join(process.cwd(), ".tmp", "pkc-238-scope-spellings");
        fs.mkdirSync(dir, { recursive: true });
        const inA = { publicKey: PUBLIC_KEY, _pkc: { dataPath: dir } };
        syncProcessStartedCommunity(inA);
        try {
            expect(findProcessStartedCommunity({ publicKey: PUBLIC_KEY, _pkc: { dataPath: `${dir}/` } })).to.equal(inA);
            expect(findProcessStartedCommunity({ publicKey: PUBLIC_KEY, _pkc: { dataPath: path.relative(process.cwd(), dir) } })).to.equal(
                inA
            );
            expect(
                findProcessStartedCommunity({ publicKey: PUBLIC_KEY, _pkc: { dataPath: path.join(dir, "..", path.basename(dir)) } })
            ).to.equal(inA);
        } finally {
            processStartedCommunities.untrack(inA);
        }
    });

    it("a symlink to the dataPath resolves to the same scope", () => {
        const real = path.join(process.cwd(), ".tmp", "pkc-238-scope-real");
        const link = path.join(process.cwd(), ".tmp", "pkc-238-scope-link");
        fs.mkdirSync(real, { recursive: true });
        fs.rmSync(link, { force: true });
        fs.symlinkSync(real, link);
        const inReal = { publicKey: PUBLIC_KEY, _pkc: { dataPath: real } };
        syncProcessStartedCommunity(inReal);
        try {
            expect(findProcessStartedCommunity({ publicKey: PUBLIC_KEY, _pkc: { dataPath: link } })).to.equal(inReal);
        } finally {
            processStartedCommunities.untrack(inReal);
            fs.rmSync(link, { force: true });
        }
    });

    it("a dataPath that does not exist yet still scopes consistently with its later spelling", () => {
        // start() creates the directory; the registry may be consulted before that.
        const missing = path.join(process.cwd(), ".tmp", "pkc-238-scope-missing", "nested");
        fs.rmSync(path.dirname(missing), { recursive: true, force: true });
        const inMissing = { publicKey: PUBLIC_KEY, _pkc: { dataPath: missing } };
        syncProcessStartedCommunity(inMissing);
        try {
            expect(findProcessStartedCommunity({ publicKey: PUBLIC_KEY, _pkc: { dataPath: `${missing}/` } })).to.equal(inMissing);
        } finally {
            processStartedCommunities.untrack(inMissing);
        }
    });

    it("different directories stay in different scopes", () => {
        const a = path.join(process.cwd(), ".tmp", "pkc-238-scope-dir-a");
        const b = path.join(process.cwd(), ".tmp", "pkc-238-scope-dir-b");
        const inA = { publicKey: PUBLIC_KEY, _pkc: { dataPath: a } };
        syncProcessStartedCommunity(inA);
        try {
            expect(findProcessStartedCommunity({ publicKey: PUBLIC_KEY, _pkc: { dataPath: b } })).to.be.undefined;
        } finally {
            processStartedCommunities.untrack(inA);
        }
    });
});
