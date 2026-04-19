import signers from "../../fixtures/signers.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";
import {
    createNewIpns,
    getAvailablePKCConfigsToTestAgainst,
    createMockedCommunityIpns,
    isPKCFetchingUsingGateways
} from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
const ensCommunityAddress = "plebbit.bso";
const communitySigner = signers[0];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`pkc.getCommunity (Remote) - ${config.name}`, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        itSkipIfRpc("calling pkc.getCommunity({address}) in parallel of the same community resolves IPNS only once", async () => {
            const localPKC = await config.pkcInstancePromise();
            const randomSub = await createMockedCommunityIpns({});
            let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
            let nameResolveSpy: ReturnType<typeof vi.spyOn> | undefined;
            try {
                const usesGateways = isPKCFetchingUsingGateways(localPKC);
                const isRemoteIpfsGatewayConfig = isPKCFetchingUsingGateways(localPKC);
                const shouldMockFetchForIpns = isRemoteIpfsGatewayConfig && typeof globalThis.fetch === "function";

                const targetAddress = convertBase58IpnsNameToBase36Cid(randomSub.communityAddress);
                const stressCount = 100;

                if (!usesGateways) {
                    const p2pClient =
                        Object.keys(localPKC.clients.kuboRpcClients).length > 0
                            ? Object.values(localPKC.clients.kuboRpcClients)[0]._client
                            : Object.keys(localPKC.clients.libp2pJsClients).length > 0
                              ? Object.values(localPKC.clients.libp2pJsClients)[0].heliaWithKuboRpcClientFunctions
                              : undefined;
                    if (!p2pClient?.name?.resolve) {
                        throw new Error("Expected p2p client like kubo or helia RPC client with name.resolve for this test");
                    }
                    nameResolveSpy = vi.spyOn(p2pClient.name, "resolve");
                } else if (shouldMockFetchForIpns) {
                    fetchSpy = vi.spyOn(globalThis, "fetch");
                }
                expect(localPKC._updatingCommunities.size()).to.equal(0);

                const subInstances = await Promise.all(
                    new Array(stressCount).fill(null).map(async () => {
                        return localPKC.getCommunity({ address: randomSub.communityAddress });
                    })
                );

                expect(localPKC._updatingCommunities.size()).to.equal(0);

                const resolveCallsCount = fetchSpy
                    ? fetchSpy.mock.calls.filter(([input]: [unknown]) => {
                          const url = typeof input === "string" ? input : (input as { url?: string })?.url;
                          return typeof url === "string" && url.includes("/ipns/" + targetAddress);
                      }).length
                    : nameResolveSpy?.mock.calls.length;

                expect(resolveCallsCount).to.equal(
                    1,
                    "calling getCommunity() on many community instances with the same address should only resolve IPNS once"
                );
            } finally {
                if (nameResolveSpy) nameResolveSpy.mockRestore();
                if (fetchSpy) fetchSpy.mockRestore();
                await localPKC.destroy();
            }
        });

        it("Can load community via IPNS address", async () => {
            const loadedCommunity = await pkc.getCommunity({ address: communitySigner.address });
            const _communityIpns = loadedCommunity.raw.communityIpfs!;
            expect(_communityIpns.lastPostCid).to.be.a.string;
            expect(_communityIpns.pubsubTopic).to.be.a.string;
            expect(loadedCommunity.address).to.be.a.string;
            expect(_communityIpns.statsCid).to.be.a.string;
            expect(_communityIpns.createdAt).to.be.a("number");
            expect(_communityIpns.updatedAt).to.be.a("number");
            expect(_communityIpns.encryption).to.be.a("object");
            expect(_communityIpns.roles).to.be.a("object");
            expect(_communityIpns.signature).to.be.a("object");
            expect(_communityIpns.posts).to.be.a("object");
            // Remove undefined keys from json
            expect(deterministicStringify(loadedCommunity.raw.communityIpfs!)).to.equals(deterministicStringify(_communityIpns));
        });

        it("can load community with ENS domain via pkc.getCommunity", async () => {
            const community = await pkc.getCommunity({ address: ensCommunityAddress });
            expect(community.address).to.equal(ensCommunityAddress);
            expect(community.updatedAt).to.be.a("number");
        });

        it("can load community with .eth/.bso ENS aliases interchangeably via pkc.getCommunity", { retry: 3 }, async () => {
            const community = await pkc.getCommunity({ address: "plebbit.eth" });
            expect(["plebbit.eth", "plebbit.bso"]).to.include(community.address);
            expect(community.updatedAt).to.be.a("number");
        });

        it(`pkc.getCommunity fails to fetch a community with ENS address if it has capital letter`, async () => {
            try {
                await pkc.getCommunity({ address: "testSub.bso" });
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER");
            }
        });

        it(`pkc.getCommunity is not fetching community updates in background after fulfilling its promise`, async () => {
            const loadedCommunity = await pkc.getCommunity({ address: communitySigner.address });
            let updatedHasBeenCalled = false;
            (loadedCommunity as unknown as Record<string, Function>)["_setUpdatingState"] = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 3));
            expect(updatedHasBeenCalled).to.be.false;
        });

        it.sequential(`pkc.getCommunity should throw if it loads a record with invalid json`, async () => {
            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns("<html>hello this is not a valid json</html>");

            try {
                await pkc.getCommunity({ address: ipnsObj.signer.address });
                expect.fail("should not succeed");
            } catch (e) {
                const plebbitErr = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(plebbitErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    const gatewayError = plebbitErr.details.gatewayToError[Object.keys(plebbitErr.details.gatewayToError)[0]] as PKCError;
                    expect(gatewayError.code).to.equal("ERR_INVALID_JSON");
                } else expect(plebbitErr.code).to.equal("ERR_INVALID_JSON");
            } finally {
                await ipnsObj.pkc.destroy();
            }
        });

        it(`pkc.getCommunity should throw immedietly if it loads a record with invalid signature`, async () => {
            const loadedCommunity = await pkc.getCommunity({ address: communitySigner.address });
            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns(JSON.stringify({ ...loadedCommunity.raw.communityIpfs, updatedAt: 12345 })); // publish invalid signature

            try {
                await pkc.getCommunity({ address: ipnsObj.signer.address });
                expect.fail("should not succeed");
            } catch (e) {
                expect([
                    "ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS",
                    "ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED"
                ]).to.include((e as { code: string }).code);
            } finally {
                await ipnsObj.pkc.destroy();
            }
        });

        it(`pkc.getCommunity should throw a retriable error (not generic timeout) when only retriable errors occur`, async () => {
            const doesNotExistCommunityAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zx";
            const customPKC = await config.pkcInstancePromise();
            customPKC._timeouts["community-ipns"] = 5 * 1000;

            try {
                await customPKC.getCommunity({ address: doesNotExistCommunityAddress });
                expect.fail("should not succeed");
            } catch (e) {
                const pkcErr = e as PKCError;
                if (isPKCFetchingUsingGateways(customPKC)) {
                    // Gateways respond quickly, so retriable errors are captured before timeout.
                    // The last retriable error is surfaced instead of a generic ERR_GET_COMMUNITY_TIMED_OUT.
                    expect(pkcErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    expect(pkcErr.details.retriableError).to.equal(true);
                    expect(pkcErr.details.countOfLoadAttempts).to.be.a("number");
                } else {
                    // P2P/RPC: IPNS resolution takes the full timeout so no intermediate errors
                    // are captured before the outer timeout fires
                    expect([
                        "ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P",
                        "ERR_IPNS_RESOLUTION_P2P_TIMEOUT",
                        "ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED",
                        "ERR_GET_COMMUNITY_TIMED_OUT"
                    ]).to.include(pkcErr.code);
                    if (pkcErr.code !== "ERR_GET_COMMUNITY_TIMED_OUT") {
                        expect(pkcErr.details.retriableError).to.equal(true);
                    }
                }
            } finally {
                await customPKC.destroy();
            }
        });

        it(`pkc.getCommunity times out if community does not load`, async () => {
            const doesNotExistCommunityAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zx"; // random community address, should not be able to resolve this
            const customPKC = await config.pkcInstancePromise();
            customPKC._timeouts["community-ipns"] = 1 * 1000; // change timeout from 5min to 1s

            try {
                await customPKC.getCommunity({ address: doesNotExistCommunityAddress });
                expect.fail("should not succeed");
            } catch (e) {
                expect([
                    "ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS",
                    "ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED",
                    "ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P",
                    "ERR_IPNS_RESOLUTION_P2P_TIMEOUT",
                    "ERR_GET_COMMUNITY_TIMED_OUT"
                ]).to.include((e as { code: string }).code, "Error is not as expected:" + JSON.stringify(e));
            } finally {
                await customPKC.destroy();
            }
        });
    });
});
