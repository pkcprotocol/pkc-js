import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    createDelegatedCommunityIpns,
    createMockedCommunityIpns,
    createNewIpns,
    getAvailablePKCConfigsToTestAgainst,
    isPKCFetchingUsingGateways,
    mockGatewayPKC,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { getPKCAddressFromPublicKeySync, convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// Loads a community via createCommunity()+update() (more reliable than getCommunity which
// does a one-shot fetch that can fail randomly in CI) and resolves once it has an update.
async function loadCommunityViaUpdate(pkc: PKCType, address: string): Promise<RemoteCommunity> {
    const community = await pkc.createCommunity({ address });
    const updatePromise = new Promise<void>((resolve) => community.once("update", () => resolve()));
    await community.update();
    await updatePromise;
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    return community;
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`Delegated IPNS loading (issue #93) - ${config.name}`, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("loads a delegated community (anchor -> minter -> /ipfs/cid) and anchors identity to the anchor", async () => {
            const { anchorName, terminalName } = await createDelegatedCommunityIpns({});

            const community = await loadCommunityViaUpdate(pkc, anchorName);
            try {
                expect(community.updatedAt).to.be.a("number");
                // identity stays the anchor even though the content is signed by the minter.
                // Over RPC the server resolves the chain and transmits ipnsHops in runtimeFields,
                // so the client derives the same anchor identity. See docs/protocol/delegated-ipns.md.
                expect(community.address).to.equal(anchorName);
                expect(community.publicKey).to.equal(anchorName);
                // the resolved chain is exposed and ordered [anchor, ..., terminal]
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                // the content record was actually signed by the terminal (minter) key, not the anchor
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
                expect(recordSignatureAddress).to.not.equal(anchorName);
            } finally {
                await community.stop();
            }
        });

        it("rejects a chain longer than one hop over P2P (only anchor -> minter is followed for now)", async () => {
            // A legitimate 2-hop chain anchor -> intermediate -> minter. For now pkc-js follows only a
            // single anchor -> minter delegation over the P2P paths, so the chain is rejected with
            // ERR_IPNS_MAX_HOPS_EXCEEDED. Over a gateway the hop count is not observable (the gateway
            // recurses internally and serves only the final content), so it still loads and is reported
            // as [anchor, terminal]. See docs/protocol/delegated-ipns.md.
            const {
                anchorName,
                terminalName,
                ipnsHops: expectedHops
            } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
            expect(expectedHops).to.have.length(3);

            if (isPKCFetchingUsingGateways(pkc)) {
                const community = await loadCommunityViaUpdate(pkc, anchorName);
                try {
                    expect(community.updatedAt).to.be.a("number");
                    expect(community.address).to.equal(anchorName);
                    // gateway recursion collapses the intermediate hop; only [anchor, terminal] is observable
                    expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                    const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                    expect(recordSignatureAddress).to.equal(terminalName);
                } finally {
                    await community.stop();
                }
            } else {
                try {
                    await pkc.getCommunity({ address: anchorName });
                    expect.fail("should reject a delegated chain longer than one hop over P2P");
                } catch (e) {
                    expect((e as PKCError).code).to.equal("ERR_IPNS_MAX_HOPS_EXCEEDED");
                }
            }
        });

        it("loads a community addressed directly by the minter key as a normal single-hop community", async () => {
            const { terminalName } = await createDelegatedCommunityIpns({});

            // The minter record is single-hop (Mn -> /ipfs/cid) and the content is signed by Mn,
            // so loading it directly is a normal (non-delegated) load: terminal === anchor.
            const community = await loadCommunityViaUpdate(pkc, terminalName);
            try {
                expect(community.updatedAt).to.be.a("number");
                expect(community.ipnsHops).to.deep.equal([terminalName]);
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
            } finally {
                await community.stop();
            }
        });

        it("still loads a normal (non-delegated) community (regression)", async () => {
            // createMockedCommunityIpns destroys its own helper pkc internally.
            const { communityAddress } = await createMockedCommunityIpns({});
            const community = await loadCommunityViaUpdate(pkc, communityAddress);
            try {
                expect(community.updatedAt).to.be.a("number");
                expect(community.ipnsHops).to.deep.equal([communityAddress]);
            } finally {
                await community.stop();
            }
        });

        it("rejects a delegated record signed by a non-terminal key over P2P (gateway trusts its own recursion)", async () => {
            // The anchor legitimately points to the minter, but the community record at the
            // terminal is signed by an unrelated third key. Over P2P we verify each hop, so the
            // broken anchor->terminal->content binding is rejected. Over a gateway we trust the
            // gateway's internal recursion (a single plain GET), so the content signed by the
            // stranger is accepted and reported as terminal. See docs/protocol/delegated-ipns.md.
            const stranger = await createNewIpns();
            const { anchorName } = await createDelegatedCommunityIpns({}, { contentSigner: stranger.signer });
            const strangerName = stranger.signer.address;
            await stranger.pkc.destroy();

            if (isPKCFetchingUsingGateways(pkc)) {
                const community = await loadCommunityViaUpdate(pkc, anchorName);
                try {
                    expect(community.updatedAt).to.be.a("number");
                    expect(community.address).to.equal(anchorName);
                    // gateway can only observe the final content signer as the terminal
                    expect(community.ipnsHops).to.deep.equal([anchorName, strangerName]);
                    const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                    expect(recordSignatureAddress).to.equal(strangerName);
                } finally {
                    await community.stop();
                }
            } else {
                try {
                    await pkc.getCommunity({ address: anchorName });
                    expect.fail("should not load a record whose signer is not the terminal of the chain");
                } catch (e) {
                    const err = e as PKCError;
                    expect(err.code).to.equal("ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED");
                }
            }
        });
    });
});

// Dedicated gateway coverage: the gateway is untrusted, so the IPNS record chain
// (anchor -> ... -> terminal) is validated independently via ?format=ipns-record.
describe("Delegated IPNS loading over an untrusted gateway", async () => {
    let gatewayPKC: PKCType;
    beforeAll(async () => {
        gatewayPKC = await mockGatewayPKC({ forceMockPubsub: true });
    });
    afterAll(async () => {
        await gatewayPKC.destroy();
    });

    it("loads a delegated community by validating the gateway-served ipns-record chain", async () => {
        const { anchorName, terminalName } = await createDelegatedCommunityIpns({});

        const community = await loadCommunityViaUpdate(gatewayPKC, anchorName);
        try {
            expect(community.updatedAt).to.be.a("number");
            expect(community.address).to.equal(anchorName);
            expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
            const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
            expect(recordSignatureAddress).to.equal(terminalName);
        } finally {
            await community.stop();
        }
    });

    // Note: the P2P paths reject a >1-hop chain (ERR_IPNS_MAX_HOPS_EXCEEDED), but a gateway recurses
    // the chain internally and exposes only the final content, so the hop cap is unenforceable here.
    it("loads a 3-hop delegated community via the gateway's internal recursion (intermediate hop not observable)", async () => {
        const { anchorName, terminalName, ipnsHops: expectedHops } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
        expect(expectedHops).to.have.length(3);

        const community = await loadCommunityViaUpdate(gatewayPKC, anchorName);
        try {
            expect(community.updatedAt).to.be.a("number");
            expect(community.address).to.equal(anchorName);
            // The plain GET lets the gateway recurse internally and returns only the final content,
            // so the intermediate hop is invisible — ipnsHops is [anchor, terminal]. The terminal is
            // derived from the content signer. See docs/protocol/delegated-ipns.md.
            expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
            const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
            expect(recordSignatureAddress).to.equal(terminalName);
        } finally {
            await community.stop();
        }
    });

    // Loading an IPNS over a gateway must stay a single call. A delegated community used to add one
    // ?format=ipns-record fetch per hop; we now let the gateway recurse internally via a single plain
    // GET. This guards against regressing back to per-hop fetching. See docs/protocol/delegated-ipns.md
    // and https://github.com/ipfs/kubo/issues/11351.
    it("loads a delegated community with a single plain GET and zero per-hop ipns-record fetches", async () => {
        const { anchorName, terminalName } = await createDelegatedCommunityIpns({});
        const anchorCid = convertBase58IpnsNameToBase36Cid(anchorName);

        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            const community = await loadCommunityViaUpdate(gatewayPKC, anchorName);
            await community.stop();

            const urlOf = (input: unknown) => (typeof input === "string" ? input : (input as { url?: string })?.url) ?? "";
            const anchorIpnsCalls = fetchSpy.mock.calls.filter(([input]) => {
                const url = urlOf(input);
                return url.includes("/ipns/" + anchorCid) || url.includes("/ipns/" + anchorName);
            });
            const plainGets = anchorIpnsCalls.filter(([input]) => !urlOf(input).includes("format=ipns-record"));
            const recordFetches = fetchSpy.mock.calls.filter(([input]) => urlOf(input).includes("format=ipns-record"));

            // identity is still correctly resolved to anchor + terminal
            expect(community.address).to.equal(anchorName);
            expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
            // exactly one plain GET for the anchor IPNS, and never a per-hop ipns-record fetch
            expect(plainGets.length).to.equal(1, "delegated gateway load should issue exactly one plain GET /ipns/<anchor>");
            expect(recordFetches.length).to.equal(0, "delegated gateway load must not make any ?format=ipns-record fetches");
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
