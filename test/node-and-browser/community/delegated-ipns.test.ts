import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
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
import { ipnsNameToIpnsOverPubsubTopic } from "../../../dist/node/util.js";

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

// Failure-load counterpart of loadCommunityViaUpdate: creates the community and resolves with the
// first error its update loop emits, then stops it (the loop keeps retrying on failure). Preferred
// over getCommunity for expected-failure load tests — it exercises the same stable load path as the
// success cases and won't flake on one-shot transport timing.
async function loadCommunityExpectingError(pkc: PKCType, address: string): Promise<PKCError> {
    const community = await pkc.createCommunity({ address });
    const errorPromise = new Promise<PKCError>((resolve) => community.once("error", resolve as (err: Error) => void));
    await community.update();
    const err = await errorPromise;
    await community.stop();
    return err;
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

        it("rejects a chain longer than one hop over both P2P and gateways (only anchor -> minter is followed for now)", async () => {
            // A legitimate 2-hop chain anchor -> intermediate -> minter. pkc-js follows only a single
            // anchor -> minter delegation, so the chain is rejected with ERR_IPNS_MAX_HOPS_EXCEEDED.
            // Over a gateway we now independently walk and validate the chain (?format=ipns-record), so
            // the same hop cap is enforced there too — it surfaces as the inner error of
            // ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS. See docs/protocol/delegated-ipns.md.
            const { anchorName, ipnsHops: expectedHops } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
            expect(expectedHops).to.have.length(3);

            const err = await loadCommunityExpectingError(pkc, anchorName);
            if (isPKCFetchingUsingGateways(pkc)) {
                expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
                expect(innerErrors.some((inner) => inner?.code === "ERR_IPNS_MAX_HOPS_EXCEEDED")).to.be.true;
            } else {
                expect(err.code).to.equal("ERR_IPNS_MAX_HOPS_EXCEEDED");
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

        it("rejects a delegated record signed by a non-terminal key over both P2P and gateways", async () => {
            // The anchor legitimately points to the minter, but the community record at the terminal is
            // signed by an unrelated third key — the anchor->terminal->content binding is broken. Over
            // P2P we verify each hop; over a gateway we now independently walk and validate the chain
            // (?format=ipns-record) and require the content signer to equal the terminal, so both reject.
            // See docs/protocol/delegated-ipns.md.
            const stranger = await createNewIpns();
            const { anchorName } = await createDelegatedCommunityIpns({}, { contentSigner: stranger.signer });
            await stranger.pkc.destroy();

            const err = await loadCommunityExpectingError(pkc, anchorName);
            if (isPKCFetchingUsingGateways(pkc)) {
                expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
                expect(innerErrors.some((inner) => inner?.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID")).to.be.true;
            } else {
                expect(err.code).to.equal("ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED");
            }
        });

        // The ipns-over-pubsub topic (where publications to this community are sent / where its IPNS
        // updates are gossiped) must be derived from the ANCHOR (ipnsHops[0]), not the minter — so a
        // comment published to a delegated community reaches the anchor-keyed topic. We assert the
        // derived topic rather than a full publish round-trip: a delegated community has no live
        // process subscribing to it here (delegate-side publishing is out of scope for pkc-js, see
        // docs/protocol/delegated-ipns.md), so an end-to-end publish cannot be exercised.
        it("derives the ipns-over-pubsub identity from the anchor, not the minter (delegated)", async () => {
            const { anchorName, terminalName } = await createDelegatedCommunityIpns({});
            const community = await loadCommunityViaUpdate(pkc, anchorName);
            try {
                expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
                expect(community.ipnsPubsubTopic).to.equal(ipnsNameToIpnsOverPubsubTopic(anchorName));
                expect(community.ipnsPubsubTopic).to.not.equal(ipnsNameToIpnsOverPubsubTopic(terminalName));
            } finally {
                await community.stop();
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

    // The P2P paths reject a >1-hop chain (ERR_IPNS_MAX_HOPS_EXCEEDED). Now that we walk and validate
    // the chain ourselves over gateways (?format=ipns-record), the same hop cap is enforced here too —
    // it surfaces as the inner error of ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS.
    it("rejects a >1-hop delegated community over a gateway (hop cap enforced via the validated chain)", async () => {
        const { anchorName, ipnsHops: expectedHops } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
        expect(expectedHops).to.have.length(3);

        const err = await loadCommunityExpectingError(gatewayPKC, anchorName);
        expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
        const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
        expect(innerErrors.some((inner) => inner?.code === "ERR_IPNS_MAX_HOPS_EXCEEDED")).to.be.true;
    });

    // The gateway is untrusted, so a delegated load independently walks and validates the IPNS record
    // chain via per-hop ?format=ipns-record fetches rather than trusting the gateway's own recursion.
    // This asserts those per-hop record fetches actually happen. See docs/protocol/delegated-ipns.md.
    it("validates the delegated chain over a gateway via per-hop ?format=ipns-record fetches", async () => {
        const { anchorName, terminalName } = await createDelegatedCommunityIpns({});
        const anchorCid = convertBase58IpnsNameToBase36Cid(anchorName);

        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            const community = await loadCommunityViaUpdate(gatewayPKC, anchorName);
            await community.stop();

            const urlOf = (input: unknown) => (typeof input === "string" ? input : (input as { url?: string })?.url) ?? "";
            const recordFetches = fetchSpy.mock.calls.filter(([input]) => urlOf(input).includes("format=ipns-record"));
            const anchorRecordFetches = recordFetches.filter(([input]) => {
                const url = urlOf(input);
                return url.includes("/ipns/" + anchorCid) || url.includes("/ipns/" + anchorName);
            });

            // identity is still correctly resolved to anchor + terminal
            expect(community.address).to.equal(anchorName);
            expect(community.ipnsHops).to.deep.equal([anchorName, terminalName]);
            // the anchor's record was independently fetched & validated, plus at least the minter's
            // record: a 1-hop delegation means >= 2 per-hop ?format=ipns-record fetches.
            expect(anchorRecordFetches.length).to.be.greaterThanOrEqual(1, "anchor ipns-record must be fetched & validated");
            expect(recordFetches.length).to.be.greaterThanOrEqual(2, "per-hop ipns-record fetches must occur (anchor + minter)");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    // A malicious gateway (test-server.js, port 14007) returns a forged IPNS record for the chain
    // walk: a well-formed record that is validly signed but by the WRONG key. `ipnsValidator` checks
    // each record's signature against the routing key derived from the IPNS name, so the forged record
    // fails validation and the gateway cannot substitute a different community for the requested
    // anchor. See docs/protocol/delegated-ipns.md.
    it("rejects a delegated community when a malicious gateway forges the anchor's IPNS record", async () => {
        const maliciousGatewayPKC = await mockGatewayPKC({
            pkcOptions: { ipfsGatewayUrls: ["http://localhost:14007"] },
            forceMockPubsub: true
        });
        // A fresh anchor name the gateway has no valid record for. The gateway serves a body signed by
        // a different key (so the load is treated as delegated) and a forged anchor record for the walk.
        const anchorSigner = await maliciousGatewayPKC.createSigner();
        try {
            const err = await loadCommunityExpectingError(maliciousGatewayPKC, anchorSigner.address);
            expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
            const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
            expect(innerErrors.some((inner) => inner?.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID")).to.be.true;
        } finally {
            await maliciousGatewayPKC.destroy();
        }
    });

    // A gateway can serve a perfectly valid, correctly-signed IPNS record chain (anchor -> minter ->
    // /ipfs/cidA) yet return a DIFFERENT community body on the plain GET. We independently validate the
    // chain, so the terminal CID it resolves to (cidA) must equal the CID of the body the gateway
    // actually served. Here we let the real ?format=ipns-record chain through (resolves to cidA) but
    // swap the plain-GET body for an unrelated community (cidB != cidA): the load must be rejected with
    // ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID before the body is ever trusted. Distinct from the forged-
    // signature case above, which fails at signature validation and never reaches this check.
    it("rejects a gateway body whose CID does not match the validated chain terminal", async () => {
        const a = await createDelegatedCommunityIpns({});
        // An unrelated community body (signed by a different minter key, so its signer != anchorA ->
        // the load is treated as delegated and the chain is walked). Its CID differs from cidA.
        const b = await createDelegatedCommunityIpns({});
        const swappedBody = JSON.stringify(b.communityRecord);
        const anchorCid = convertBase58IpnsNameToBase36Cid(a.anchorName);

        const realFetch = globalThis.fetch;
        const urlOf = (input: unknown) => (typeof input === "string" ? input : (input as { url?: string })?.url) ?? "";
        const isAnchorPlainGet = (url: string) =>
            !url.includes("format=ipns-record") && (url.includes("/ipns/" + anchorCid) || url.includes("/ipns/" + a.anchorName));
        const stubBodyResponse = (body: string) =>
            ({
                status: 200,
                statusText: "OK",
                headers: new Headers({ "content-type": "application/json" }),
                body: undefined,
                text: async () => body
            }) as unknown as Response;

        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation((input, init) =>
                isAnchorPlainGet(urlOf(input)) ? Promise.resolve(stubBodyResponse(swappedBody)) : realFetch(input, init)
            );
        try {
            const err = await loadCommunityExpectingError(gatewayPKC, a.anchorName);
            expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
            const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
            const chainInvalid = innerErrors.find((inner) => inner?.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID");
            expect(chainInvalid, "expected an ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID inner error").to.exist;
            expect(String((chainInvalid!.details as { reason?: string })?.reason)).to.include("Terminal IPNS record CID does not match");
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
