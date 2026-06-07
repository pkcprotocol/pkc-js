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

        it("rejects a chain longer than one hop over both P2P and gateways (only anchor -> minter is followed for now)", async () => {
            // A legitimate 2-hop chain anchor -> intermediate -> minter. pkc-js follows only a single
            // anchor -> minter delegation, so the chain is rejected with ERR_IPNS_MAX_HOPS_EXCEEDED.
            // Over a gateway we now independently walk and validate the chain (?format=ipns-record), so
            // the same hop cap is enforced there too — it surfaces as the inner error of
            // ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS. See docs/protocol/delegated-ipns.md.
            const { anchorName, ipnsHops: expectedHops } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
            expect(expectedHops).to.have.length(3);

            try {
                await pkc.getCommunity({ address: anchorName });
                expect.fail("should reject a delegated chain longer than one hop");
            } catch (e) {
                const err = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
                    expect(innerErrors.some((inner) => inner?.code === "ERR_IPNS_MAX_HOPS_EXCEEDED")).to.be.true;
                } else {
                    expect(err.code).to.equal("ERR_IPNS_MAX_HOPS_EXCEEDED");
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

        it("rejects a delegated record signed by a non-terminal key over both P2P and gateways", async () => {
            // The anchor legitimately points to the minter, but the community record at the terminal is
            // signed by an unrelated third key — the anchor->terminal->content binding is broken. Over
            // P2P we verify each hop; over a gateway we now independently walk and validate the chain
            // (?format=ipns-record) and require the content signer to equal the terminal, so both reject.
            // See docs/protocol/delegated-ipns.md.
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

    // The P2P paths reject a >1-hop chain (ERR_IPNS_MAX_HOPS_EXCEEDED). Now that we walk and validate
    // the chain ourselves over gateways (?format=ipns-record), the same hop cap is enforced here too —
    // it surfaces as the inner error of ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS.
    it("rejects a >1-hop delegated community over a gateway (hop cap enforced via the validated chain)", async () => {
        const { anchorName, ipnsHops: expectedHops } = await createDelegatedCommunityIpns({}, { intermediateHopsCount: 1 });
        expect(expectedHops).to.have.length(3);

        try {
            await gatewayPKC.getCommunity({ address: anchorName });
            expect.fail("gateway load should reject a delegated chain longer than one hop");
        } catch (e) {
            const err = e as PKCError;
            expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
            const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
            expect(innerErrors.some((inner) => inner?.code === "ERR_IPNS_MAX_HOPS_EXCEEDED")).to.be.true;
        }
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
            await maliciousGatewayPKC.getCommunity({ address: anchorSigner.address });
            expect.fail("should reject a community whose anchor IPNS record fails signature validation");
        } catch (e) {
            const err = e as PKCError;
            expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
            const innerErrors = Object.values((err.details as { gatewayToError: Record<string, PKCError> }).gatewayToError);
            expect(innerErrors.some((inner) => inner?.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID")).to.be.true;
        } finally {
            await maliciousGatewayPKC.destroy();
        }
    });
});

// Timing benchmark (issue #93): measures the wall-clock cost of the extra IPNS hop that a
// delegated community adds, across the three loading mechanisms (kubo RPC, helia/libp2p-js,
// gateway). It is a measurement tool, not a regression gate, so it is gated behind BENCH_IPNS=1
// to keep it out of normal (noisy/slow) CI runs. Run it with the test server up:
//   BENCH_IPNS=1 node test/run-test-config.js --pkc-config remote-kubo-rpc,remote-pkc-rpc \
//     test/node-and-browser/community/delegated-ipns.test.ts
// Tune iterations with BENCH_IPNS_ITERATIONS (default 7).
//
// Assumptions baked into the test harness (as requested):
//   - No DHT. Helia resolves IPNS via the local HTTP router (localhost:20001); kubo resolves the
//     records straight from its own datastore (they are published with allowOffline); the gateway
//     recurses internally. No DHT walk is involved on any path.
//   - The same peer serves every key. createDelegatedCommunityIpns publishes the anchor record and
//     the minter record to the SAME local kubo node, so both hops are provided by the same peer.
//
// For each mechanism we load the SAME community record two ways:
//   - direct    : load the minter name (Mn -> /ipfs/cid). A normal single-hop load.
//   - delegated : load the anchor name (An -> Mn -> /ipfs/cid). One extra IPNS hop over P2P; over a
//                 gateway it is still a single plain GET (the gateway recurses internally).
// Same CID and content either way, so the wall-clock delta isolates the extra hop's cost. The P2P
// paths re-resolve IPNS on every load (recursive:false + nocache:true), so the hop cost is paid
// each iteration rather than served from a name cache.
const benchEnabled = Boolean(process.env.BENCH_IPNS);
const benchDescribe = benchEnabled ? describe : describe.skip;
const BENCH_ITERATIONS = Number(process.env.BENCH_IPNS_ITERATIONS ?? 7);

// The three loading mechanisms, regardless of which --pkc-config the runner was started with.
const benchConfigs = getAvailablePKCConfigsToTestAgainst({
    includeAllPossibleConfigOnEnv: true,
    includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs", "remote-ipfs-gateway"]
});

const median = (xs: number[]): number => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

type BenchRow = { mechanism: string; directMs: number; delegatedMs: number; deltaMs: number; ratio: number };
const benchRows: BenchRow[] = [];

benchDescribe("Delegated IPNS loading - timing benchmark (issue #93)", () => {
    afterAll(() => {
        if (!benchRows.length) return;
        // Combined table: direct (1-hop) vs delegated (2-hop over P2P) load times per mechanism.
        // deltaMs is the cleanest signal (constant per-load overhead cancels); ratio is diluted by it.
        console.log(`\nDelegated IPNS load timing (median of ${BENCH_ITERATIONS} runs, ms):`);
        console.table(
            benchRows.map((r) => ({
                mechanism: r.mechanism,
                "direct(1-hop)": Number(r.directMs.toFixed(1)),
                "delegated(2-hop)": Number(r.delegatedMs.toFixed(1)),
                "delta(ms)": Number(r.deltaMs.toFixed(1)),
                ratio: Number(r.ratio.toFixed(2))
            }))
        );
    });

    benchConfigs.forEach((config) => {
        it(`measures direct vs delegated load over ${config.name} (${config.testConfigCode})`, async () => {
            // forceMockPubsub keeps live-update subscriptions out of the measured path so we time
            // resolution + content fetch, not pubsub warmup churn.
            const pkc = await config.pkcInstancePromise({ forceMockPubsub: true });
            const { anchorName, terminalName } = await createDelegatedCommunityIpns({});

            const timeLoad = async (address: string): Promise<number> => {
                const start = performance.now();
                const community = await loadCommunityViaUpdate(pkc, address);
                const elapsed = performance.now() - start;
                await community.stop();
                return elapsed;
            };

            try {
                // Warm up both paths so the shared CID content is cached and we measure the
                // steady-state hop cost rather than a first-touch content fetch.
                await timeLoad(terminalName);
                await timeLoad(anchorName);

                const direct: number[] = [];
                const delegated: number[] = [];
                for (let i = 0; i < BENCH_ITERATIONS; i++) {
                    // Alternate order so any residual cache warmth does not systematically favor one path.
                    if (i % 2 === 0) {
                        direct.push(await timeLoad(terminalName));
                        delegated.push(await timeLoad(anchorName));
                    } else {
                        delegated.push(await timeLoad(anchorName));
                        direct.push(await timeLoad(terminalName));
                    }
                }

                const directMs = median(direct);
                const delegatedMs = median(delegated);
                benchRows.push({
                    mechanism: config.testConfigCode,
                    directMs,
                    delegatedMs,
                    deltaMs: delegatedMs - directMs,
                    ratio: delegatedMs / directMs
                });

                console.log(
                    `[bench ${config.testConfigCode}] direct(1-hop)=${directMs.toFixed(1)}ms ` +
                        `delegated(2-hop)=${delegatedMs.toFixed(1)}ms delta=${(delegatedMs - directMs).toFixed(1)}ms ` +
                        `ratio=${(delegatedMs / directMs).toFixed(2)}x ` +
                        `(n=${BENCH_ITERATIONS}, direct=[${direct.map((x) => x.toFixed(0)).join(",")}] ` +
                        `delegated=[${delegated.map((x) => x.toFixed(0)).join(",")}])`
                );

                // Sanity only. Timing is informational, so we do not assert on the delta (it is noisy).
                expect(directMs).to.be.greaterThan(0);
                expect(delegatedMs).to.be.greaterThan(0);
            } finally {
                await pkc.destroy();
            }
        }, 300_000);
    });
});
