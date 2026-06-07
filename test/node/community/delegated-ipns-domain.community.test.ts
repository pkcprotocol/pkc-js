import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
    createDelegatedCommunityIpns,
    createMockNameResolver,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CreateRemoteCommunityOptions } from "../../../dist/node/community/types.js";

// A delegated community whose user-facing address is a DOMAIN (e.g. .bso) that resolves to an IPNS
// name, then (for the delegated cases) anchor -> minter -> /ipfs/cid. Exercises the domain + delegation
// interaction: _findErrorInCommunityRecord skips the "content signer == terminal" check for domain
// addresses, so verification of a delegated record must still succeed end-to-end. See
// docs/protocol/delegated-ipns.md.
//
// The same interaction is covered across every available non-RPC config (kubo, helia libp2p-js,
// gateway). RPC is excluded: the name resolver is mocked on the client, which is impossible over an RPC
// client (resolution happens server-side). The mechanism is otherwise config-independent.
const nonRpcConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true }).filter(
    (config) => config.testConfigCode !== "remote-pkc-rpc"
);

// The records below are published to the same local kubo node and are config-independent, so they are
// generated ONCE and shared across every config. Each domain maps to the IPNS key it should resolve to:
// the anchor for the delegated cases, the minter for the direct-minter case. The shared records object
// is populated in the top-level beforeAll before any per-config pkc is constructed.
type DelegatedFixture = Awaited<ReturnType<typeof createDelegatedCommunityIpns>>;
const fixtures = {} as Record<"addressDomain" | "nameOnly" | "pubkeyAnchor" | "pubkeyMinter", { domain: string } & DelegatedFixture>;
const resolverRecords: Record<string, string> = {};

beforeAll(async () => {
    // The record must declare the domain in its `name` field: a domain load matches the record's name
    // (not merely its signature key, which is the minter). See community-client-manager.ts
    // _findErrorInCommunityRecord and docs/protocol/delegated-ipns.md.
    const specs = [
        { key: "addressDomain", domain: "delegated-domain-address.bso", resolveTo: "anchor" },
        { key: "nameOnly", domain: "delegated-domain-name-only.bso", resolveTo: "anchor" },
        { key: "pubkeyAnchor", domain: "delegated-domain-pubkey-anchor.bso", resolveTo: "anchor" },
        // the domain resolves to the minter so addressing the terminal key directly stays consistent
        { key: "pubkeyMinter", domain: "delegated-domain-pubkey-minter.bso", resolveTo: "minter" }
    ] as const;
    for (const spec of specs) {
        const record = await createDelegatedCommunityIpns({ name: spec.domain });
        fixtures[spec.key] = { domain: spec.domain, ...record };
        resolverRecords[spec.domain] = spec.resolveTo === "anchor" ? record.anchorName : record.terminalName;
    }
});

async function loadCommunityViaUpdate(pkc: PKC, createOpts: CreateRemoteCommunityOptions): Promise<RemoteCommunity> {
    const community = (await pkc.createCommunity(createOpts)) as RemoteCommunity;
    const updatePromise = new Promise<void>((resolve) => community.once("update", () => resolve()));
    await community.update();
    await updatePromise;
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    return community;
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
                    // resolverRecords is populated by the top-level beforeAll above, which runs first
                    nameResolvers: [createMockNameResolver({ records: resolverRecords })]
                }
            });
        });
        afterAll(async () => {
            if (pkc) await pkc.destroy();
        });

        it("loads a delegated community whose address is a domain resolving to the anchor", async () => {
            const { domain, anchorName, terminalName } = fixtures.addressDomain;
            const community = await loadCommunityViaUpdate(pkc, { address: domain });
            try {
                expect(community.updatedAt).to.be.a("number");
                // identity stays the DOMAIN (immutable address); the domain resolves to the anchor and the
                // content is signed by the minter (terminal) key.
                expect(community.address).to.equal(domain);
                expect(community.name).to.equal(domain);
                // the domain resolved to the anchor public key, and the chain is anchor -> minter
                expect(community.publicKey).to.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
                expect(recordSignatureAddress).to.not.equal(anchorName);
            } finally {
                await community.stop();
            }
        });

        it("loads a delegated community identified by { name } only (name resolves to the anchor)", async () => {
            // No publicKey hint: the domain is the sole identifier and must resolve to the anchor, which
            // then delegates anchor -> minter -> /ipfs/cid.
            const { domain, anchorName, terminalName } = fixtures.nameOnly;
            const community = await loadCommunityViaUpdate(pkc, { name: domain });
            try {
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.name).to.equal(domain);
                expect(community.publicKey).to.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
                expect(recordSignatureAddress).to.not.equal(anchorName);
            } finally {
                await community.stop();
            }
        });

        it("loads a delegated community identified by { publicKey, name } where publicKey is the anchor", async () => {
            // publicKey hint == the anchor: the load goes straight through the anchor key (the domain is
            // verified against it in the background) and follows the anchor -> minter delegation.
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
                expect(recordSignatureAddress).to.not.equal(anchorName);
            } finally {
                await community.stop();
            }
        });

        it("loads a delegated community identified by { publicKey, name } where publicKey is the minter", async () => {
            // publicKey hint == the minter (terminal): the load addresses the minter key directly, so it
            // is a normal single-hop load (Mn -> /ipfs/cid) even though the address is a domain. The
            // domain resolves to the minter, so identity == the minter and the chain is just [minter].
            const { domain, anchorName, terminalName } = fixtures.pubkeyMinter;
            const community = await loadCommunityViaUpdate(pkc, { publicKey: terminalName, name: domain });
            try {
                expect(community.updatedAt).to.be.a("number");
                expect(community.address).to.equal(domain);
                expect(community.name).to.equal(domain);
                // addressing the terminal key directly makes the minter the identity (single hop)
                expect(community.publicKey).to.equal(terminalName);
                expect(community.publicKey).to.not.equal(anchorName);
                expect(community.ipnsHops).to.deep.equal([terminalName]);
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
            } finally {
                await community.stop();
            }
        });
    });
});
