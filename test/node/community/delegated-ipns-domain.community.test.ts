import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
    createDelegatedCommunityIpns,
    createMockNameResolver,
    createNewIpns,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CreateRemoteCommunityOptions } from "../../../dist/node/community/types.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// The delegated-domain behavior matrix (issue #257). A delegated community has an anchor keypair An
// (the identity readers address) and a minter keypair Mn (signs the record); since #257 the record
// carries a signed anchor claim (record.anchor.publicKey = An). The principle under test:
//
//   The record's signed anchor claim defines identity; the domain TXT record is only a routing hint
//   we always follow; nameResolved reports whether the hint points at the identity.
//
// Every test pins the full end state: publicKey, ipnsHops, nameResolved, and error events.
//
// Covered across every available non-RPC config (kubo, helia libp2p-js, gateway). RPC is excluded:
// the name resolver is mocked on the client, which is impossible over an RPC client (resolution
// happens server-side). The mechanism is otherwise config-independent.
const nonRpcConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true }).filter(
    (config) => config.testConfigCode !== "remote-pkc-rpc"
);

// The records below are published to the same local kubo node and are config-independent, so they are
// generated ONCE and shared across every config. Each domain maps to the IPNS key its TXT record
// should resolve to. The shared records object is populated in the top-level beforeAll before any
// per-config pkc is constructed.
type DelegatedFixture = Awaited<ReturnType<typeof createDelegatedCommunityIpns>>;
const fixtures = {} as Record<
    "addressDomain" | "nameOnly" | "pubkeyAnchor" | "pubkeyMinter" | "minterTxt" | "domainOnlyMinter" | "anchorTxtMinterHint" | "migration",
    { domain: string } & DelegatedFixture
>;
// A delegated record whose name never resolves (the domain is absent from the resolver records).
let unresolvableFixture: { domain: string } & DelegatedFixture;
const resolverRecords: Record<string, string> = {};
// row 3/6: a valid b58 IPNS key that nobody ever publishes to
let deadKey: string;
const deadKeyDomain = "delegated-domain-dead-key.bso";

beforeAll(async () => {
    // The record must declare the domain in its `name` field: a domain load matches the record's name
    // (not merely its signature key, which is the minter). See community-client-manager.ts
    // _findErrorInCommunityRecord and docs/protocol/delegated-ipns.md.
    const specs = [
        // row 1: TXT -> anchor, addressed by the domain
        { key: "addressDomain", domain: "delegated-domain-address.bso", resolveTo: "anchor" },
        // row 1 variant: TXT -> anchor, addressed by { name } only
        { key: "nameOnly", domain: "delegated-domain-name-only.bso", resolveTo: "anchor" },
        // row 4: TXT -> anchor, anchor hint
        { key: "pubkeyAnchor", domain: "delegated-domain-pubkey-anchor.bso", resolveTo: "anchor" },
        // row 8: TXT -> minter, minter hint
        { key: "pubkeyMinter", domain: "delegated-domain-pubkey-minter.bso", resolveTo: "minter" },
        // rows 5 and 10: TXT -> minter, anchor hint (row 5) / raw anchor address (row 10)
        { key: "minterTxt", domain: "delegated-domain-txt-to-minter.bso", resolveTo: "minter" },
        // row 2: TXT -> minter, no hint at all
        { key: "domainOnlyMinter", domain: "delegated-domain-only-minter.bso", resolveTo: "minter" },
        // row 9: TXT -> anchor, minter hint
        { key: "anchorTxtMinterHint", domain: "delegated-domain-anchor-txt-minter-hint.bso", resolveTo: "anchor" },
        // row 6: TXT -> a dead unrelated key (genuine migration target that never loads)
        { key: "migration", domain: deadKeyDomain, resolveTo: "dead" }
    ] as const;
    const deadIpns = await createNewIpns();
    deadKey = deadIpns.signer.address;
    await deadIpns.pkc.destroy(); // key never publishes anything
    for (const spec of specs) {
        const record = await createDelegatedCommunityIpns({ name: spec.domain });
        fixtures[spec.key] = { domain: spec.domain, ...record };
        resolverRecords[spec.domain] =
            spec.resolveTo === "anchor" ? record.anchorName : spec.resolveTo === "minter" ? record.terminalName : deadKey;
    }
    // row 7: the domain is deliberately NOT added to resolverRecords
    const unresolvableDomain = "delegated-domain-unresolvable.bso";
    unresolvableFixture = { domain: unresolvableDomain, ...(await createDelegatedCommunityIpns({ name: unresolvableDomain })) };
});

async function loadCommunityViaUpdate(pkc: PKC, createOpts: CreateRemoteCommunityOptions): Promise<RemoteCommunity> {
    const community = (await pkc.createCommunity(createOpts)) as RemoteCommunity;
    const updatePromise = new Promise<void>((resolve) => community.once("update", () => resolve()));
    await community.update();
    await updatePromise;
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    return community;
}

// The refetch-through-the-anchor-chain after a re-anchor resolves the same record again, which emits
// no "update" event (the record was already consumed), so chain-shape waits listen on the loop's
// state changes instead.
async function waitForIpnsHops(community: RemoteCommunity, expectedHops: string[]) {
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        eventName: "updatingstatechange",
        predicate: async () => JSON.stringify(community.ipnsHops) === JSON.stringify(expectedHops)
    });
}

function collectMigrationErrors(community: RemoteCommunity): PKCError[] {
    const errors: PKCError[] = [];
    community.on("error", (err) => {
        if ((err as PKCError).code === "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY") errors.push(err as PKCError);
    });
    return errors;
}

nonRpcConfigs.forEach((config) => {
    describe(`Delegated IPNS loading with a domain address - ${config.name}`, () => {
        let pkc: PKC;

        beforeAll(async () => {
            // Only kubo configs need httpRoutersOptions: [] to stop the Zod default from adding production
            // routers (which restarts Kubo and breaks parallel tests). Helia REQUIRES real http routers to
            // resolve IPNS, and the gateway config resolves via gateway URLs, so leave their defaults intact.
            const isKuboConfig = config.testConfigCode === "local-kubo-rpc" || config.testConfigCode === "remote-kubo-rpc";
            pkc = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    ...(isKuboConfig ? { httpRoutersOptions: [] } : {}),
                    // The re-anchor rows assert the chain refetch, which on the gateway config happens on
                    // the next update-loop iteration (kubo/helia iterate every second regardless).
                    updateInterval: 3000,
                    // resolverRecords is populated by the top-level beforeAll above, which runs first
                    nameResolvers: [createMockNameResolver({ records: resolverRecords })]
                }
            });
        });
        afterAll(async () => {
            if (pkc) await pkc.destroy();
        });

        // row 1
        it("TXT -> anchor, addressed by the domain: loads through the chain, nameResolved true", async () => {
            const { domain, anchorName, terminalName } = fixtures.addressDomain;
            const community = await loadCommunityViaUpdate(pkc, { address: domain });
            try {
                expect(community.updatedAt).to.be.a("number");
                // identity stays the DOMAIN (immutable address); the domain resolves to the anchor and the
                // content is signed by the minter (terminal) key.
                expect(community.address).to.equal(domain);
                expect(community.name).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.anchor?.publicKey).to.equal(anchorName); // the record's signed claim (#257)
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
                expect(recordSignatureAddress).to.not.equal(anchorName);
                // the TXT record points at the identity, so the name verifies
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === true });
                expect(community.nameResolved).to.be.true;
            } finally {
                await community.stop();
            }
        });

        // row 1, { name } only
        it("TXT -> anchor, addressed by { name } only: loads through the chain, nameResolved true", async () => {
            const { domain, anchorName, terminalName } = fixtures.nameOnly;
            const community = await loadCommunityViaUpdate(pkc, { name: domain });
            try {
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.name).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === true });
                expect(community.nameResolved).to.be.true;
            } finally {
                await community.stop();
            }
        });

        // row 4
        it("TXT -> anchor, anchor hint: loads through the chain, nameResolved true", async () => {
            const { domain, anchorName, terminalName } = fixtures.pubkeyAnchor;
            const community = await loadCommunityViaUpdate(pkc, { publicKey: anchorName, name: domain });
            try {
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.name).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === true });
                expect(community.nameResolved).to.be.true;
            } finally {
                await community.stop();
            }
        });

        // row 2
        it("TXT -> minter, no hint: the record's anchor claim re-anchors the identity, nameResolved false", async () => {
            // The reader has nothing but the domain, whose TXT points at the minter. The load goes
            // through the minter (single hop), but the record's signed anchor claim recovers the true
            // identity: no migration is involved because no identity expectation existed to migrate from.
            const { domain, anchorName, terminalName } = fixtures.domainOnlyMinter;
            const community = (await pkc.createCommunity({ address: domain })) as RemoteCommunity;
            const migrationErrors = collectMigrationErrors(community);
            try {
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === false });
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName); // claim, not the TXT's minter
                expect(community.anchor?.publicKey).to.equal(anchorName);
                expect(community.nameResolved).to.be.false;
                expect(community.raw.communityIpfs).to.be.an("object");
                // subsequent fetches route through the anchor chain, never pinned to the TXT's hop
                await waitForIpnsHops(community, [anchorName, terminalName]);
                expect(migrationErrors).to.deep.equal([]);
            } finally {
                await community.stop();
            }
        });

        // row 5
        it("TXT -> minter, anchor hint: transient migration, then the claim re-anchors back, nameResolved false", async () => {
            // The TXT is followed immediately (it is a routing hint we trust for routing), which fires
            // one migration error and a refetch through the minter — then the landed record's anchor
            // claim recovers the very identity the hint named, restoring it with nameResolved false.
            const { domain, anchorName, terminalName } = fixtures.minterTxt;
            const community = (await pkc.createCommunity({ publicKey: anchorName, name: domain })) as RemoteCommunity;
            const migrationErrors = collectMigrationErrors(community);
            try {
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === false });
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.anchor?.publicKey).to.equal(anchorName);
                expect(community.nameResolved).to.be.false;
                expect(community.raw.communityIpfs).to.be.an("object");
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
                await waitForIpnsHops(community, [anchorName, terminalName]);
                // the pre-load TXT-vs-hint mismatch fired exactly one honest migration error on the way
                expect(migrationErrors.length).to.be.at.least(1);
            } finally {
                await community.stop();
            }
        });

        // row 8
        it("TXT -> minter, minter hint: the claim re-anchors the identity, nameResolved false", async () => {
            // Hint and TXT agree on the minter, so no migration fires — but the record's anchor claim
            // still moves the identity to the anchor, and the TXT pointing at a non-anchor hop makes
            // the name unverified. Direct-minter identity is no longer a mode (#257).
            const { domain, anchorName, terminalName } = fixtures.pubkeyMinter;
            const community = (await pkc.createCommunity({ publicKey: terminalName, name: domain })) as RemoteCommunity;
            const migrationErrors = collectMigrationErrors(community);
            try {
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === false });
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.publicKey).to.not.equal(terminalName);
                expect(community.nameResolved).to.be.false;
                await waitForIpnsHops(community, [anchorName, terminalName]);
                expect(migrationErrors).to.deep.equal([]);
            } finally {
                await community.stop();
            }
        });

        // row 9
        it("TXT -> anchor, minter hint: migration to the anchor, the claim confirms it, nameResolved true", async () => {
            // The hint named a hop while the TXT names the identity. The mismatch fires a migration to
            // the TXT's key — which the landed record's claim then confirms as the identity, so the
            // end state is a correctly-anchored community whose name verifies.
            const { domain, anchorName, terminalName } = fixtures.anchorTxtMinterHint;
            const community = (await pkc.createCommunity({ publicKey: terminalName, name: domain })) as RemoteCommunity;
            const migrationErrors = collectMigrationErrors(community);
            try {
                await community.update();
                // nameResolved flips to true at migration time, before the record has loaded, so the
                // wait must require the loaded record too.
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.nameResolved === true && typeof community.updatedAt === "number"
                });
                expect(community.updatedAt).to.be.a("number");
                expect(community.publicKey).to.equal(anchorName);
                expect(community.nameResolved).to.be.true;
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                expect(migrationErrors.length).to.be.at.least(1);
                expect(migrationErrors[0].details.newPublicKey).to.equal(anchorName);
            } finally {
                await community.stop();
            }
        });

        // row 6
        it("TXT -> unrelated dead key, anchor hint: genuine key migration wins", async () => {
            // The TXT names a key that is neither the anchor nor any hop of the chain: that is the real
            // key-migration scenario, and it must keep firing exactly as before #257.
            const { domain } = fixtures.migration;
            const community = (await pkc.createCommunity({ publicKey: fixtures.migration.anchorName, name: domain })) as RemoteCommunity;
            const migrationErrors = collectMigrationErrors(community);
            try {
                await community.update();
                // Migration emits "update" then "error", and the dead key never produces another
                // update event — so the wait must ride the error event itself.
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    eventName: "error",
                    predicate: async () => migrationErrors.length > 0
                });
                expect(community.publicKey).to.equal(deadKey);
                expect(community.nameResolved).to.be.true; // the domain resolved correctly to the (new) key
                expect(community.updatedAt).to.equal(undefined); // data cleared; the dead key never loads
                expect(migrationErrors[0].details.newPublicKey).to.equal(deadKey);
            } finally {
                await community.stop();
            }
        });

        // row 7
        it("TXT record missing, anchor hint: nameResolved false, identity and record kept", async () => {
            const { domain, anchorName, terminalName } = unresolvableFixture;
            const community = (await pkc.createCommunity({ publicKey: anchorName, name: domain })) as RemoteCommunity;
            const migrationErrors = collectMigrationErrors(community);
            try {
                await community.update();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === false });
                expect(community.updatedAt).to.be.a("number");
                expect(community.publicKey).to.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                expect(community.nameResolved).to.be.false;
                expect(community.raw.communityIpfs).to.be.an("object");
                expect(migrationErrors).to.deep.equal([]);
            } finally {
                await community.stop();
            }
        });

        // row 3
        it("TXT -> dead key, no hint: the load errors and nameResolved stays undefined", async () => {
            const community = (await pkc.createCommunity({ address: deadKeyDomain })) as RemoteCommunity;
            const firstError = new Promise<PKCError>((resolve) => community.once("error", (err) => resolve(err as PKCError)));
            try {
                await community.update();
                const err = await firstError;
                expect(err.code).to.be.a("string");
                expect(community.updatedAt).to.equal(undefined);
                expect(community.nameResolved).to.equal(undefined);
                expect(community.raw.communityIpfs).to.equal(undefined);
            } finally {
                await community.stop();
            }
        });

        // row 10
        it("raw anchor address, record names a TXT -> minter domain: nameResolved false, identity stays the anchor", async () => {
            // Addressed by the raw anchor key; the record advertises a name whose TXT points at the
            // minter. The name claim is verified in the background against the identity and fails,
            // without ever touching the identity or the loaded record.
            const { domain, anchorName, terminalName } = fixtures.minterTxt;
            const community = await loadCommunityViaUpdate(pkc, { address: anchorName });
            const migrationErrors = collectMigrationErrors(community);
            try {
                expect(community.name).to.equal(domain);
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.nameResolved === false });
                expect(community.address).to.equal(anchorName);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                expect(community.nameResolved).to.be.false;
                expect(community.raw.communityIpfs).to.be.an("object");
                expect(migrationErrors).to.deep.equal([]);
            } finally {
                await community.stop();
            }
        });
    });
});
