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
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";

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

        it("loads a 3-hop delegated community (anchor -> intermediate -> minter)", async () => {
            const {
                anchorName,
                terminalName,
                ipnsHops: expectedHops
            } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
            expect(expectedHops).to.have.length(3);

            const community = await loadCommunityViaUpdate(pkc, anchorName);
            try {
                expect(community.updatedAt).to.be.a("number");
                // identity stays the anchor across multiple hops (including over RPC, where the
                // server transmits the resolved ipnsHops to the client)
                expect(community.address).to.equal(anchorName);
                expect(community.publicKey).to.equal(anchorName);
                // the full chain is walked and exposed in order [anchor, intermediate, terminal]
                expect(community.ipnsHops).to.deep.equal(expectedHops);
                // content is signed by the terminal (minter) key at the end of the chain
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
                expect(recordSignatureAddress).to.equal(terminalName);
            } finally {
                await community.stop();
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

        it("rejects a delegated record whose content is signed by a key other than the terminal", async () => {
            // The anchor legitimately points to the minter, but the community record at the
            // terminal is signed by an unrelated third key — the anchor->terminal->content
            // binding is broken and must be rejected.
            const stranger = await createNewIpns();
            const { anchorName } = await createDelegatedCommunityIpns({}, { contentSigner: stranger.signer });
            await stranger.pkc.destroy();

            try {
                await pkc.getCommunity({ address: anchorName });
                expect.fail("should not load a record whose signer is not the terminal of the chain");
            } catch (e) {
                const err = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
                    expect(innerErrors.some((inner) => inner?.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID")).to.be.true;
                } else {
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

    it("loads a 3-hop delegated community by validating the full gateway-served ipns-record chain", async () => {
        const { anchorName, terminalName, ipnsHops: expectedHops } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
        expect(expectedHops).to.have.length(3);

        const community = await loadCommunityViaUpdate(gatewayPKC, anchorName);
        try {
            expect(community.updatedAt).to.be.a("number");
            expect(community.address).to.equal(anchorName);
            // the independent ?format=ipns-record walk validates every hop and exposes the full chain
            expect(community.ipnsHops).to.deep.equal(expectedHops);
            const recordSignatureAddress = getPKCAddressFromPublicKeySync(community.raw.communityIpfs!.signature.publicKey);
            expect(recordSignatureAddress).to.equal(terminalName);
        } finally {
            await community.stop();
        }
    });

    it("rejects when the gateway-served record's signer is not the terminal of the validated chain", async () => {
        const stranger = await createNewIpns();
        const { anchorName } = await createDelegatedCommunityIpns({}, { contentSigner: stranger.signer });
        await stranger.pkc.destroy();

        try {
            await gatewayPKC.getCommunity({ address: anchorName });
            expect.fail("gateway load should reject a record not bound to the anchor by the ipns-record chain");
        } catch (e) {
            const err = e as PKCError;
            expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
            const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
            expect(innerErrors.some((inner) => inner?.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID")).to.be.true;
        }
    });
});
