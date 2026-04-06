import signers from "../../fixtures/signers.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";
import {
    createNewIpns,
    getAvailablePKCConfigsToTestAgainst,
    createMockedCommunityIpns,
    itSkipIfRpc,
    isPKCFetchingUsingGateways
} from "../../../dist/node/test/test-util.js";
import { convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";
import { describe, it, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
const ensCommunityAddress = "plebbit.bso";
const subplebbitSigner = signers[0];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`plebbit.getCommunity (Remote) - ${config.name}`, async () => {
        let plebbit: PKCType;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        itSkipIfRpc("calling plebbit.getCommunity({address}) in parallel of the same subplebbit resolves IPNS only once", async () => {
            const localPKC = await config.plebbitInstancePromise();
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
                expect(localPKC._updatingCommunitys.size()).to.equal(0);

                const subInstances = await Promise.all(
                    new Array(stressCount).fill(null).map(async () => {
                        return localPKC.getCommunity({ address: randomSub.communityAddress });
                    })
                );

                expect(localPKC._updatingCommunitys.size()).to.equal(0);

                const resolveCallsCount = fetchSpy
                    ? fetchSpy.mock.calls.filter(([input]: [unknown]) => {
                          const url = typeof input === "string" ? input : (input as { url?: string })?.url;
                          return typeof url === "string" && url.includes("/ipns/" + targetAddress);
                      }).length
                    : nameResolveSpy?.mock.calls.length;

                expect(resolveCallsCount).to.equal(
                    1,
                    "calling getCommunity() on many subplebbit instances with the same address should only resolve IPNS once"
                );
            } finally {
                if (nameResolveSpy) nameResolveSpy.mockRestore();
                if (fetchSpy) fetchSpy.mockRestore();
                await localPKC.destroy();
            }
        });

        it("Can load subplebbit via IPNS address", async () => {
            const loadedCommunity = await plebbit.getCommunity({ address: subplebbitSigner.address });
            const _subplebbitIpns = loadedCommunity.raw.subplebbitIpfs!;
            expect(_subplebbitIpns.lastPostCid).to.be.a.string;
            expect(_subplebbitIpns.pubsubTopic).to.be.a.string;
            expect(loadedCommunity.address).to.be.a.string;
            expect(_subplebbitIpns.statsCid).to.be.a.string;
            expect(_subplebbitIpns.createdAt).to.be.a("number");
            expect(_subplebbitIpns.updatedAt).to.be.a("number");
            expect(_subplebbitIpns.encryption).to.be.a("object");
            expect(_subplebbitIpns.roles).to.be.a("object");
            expect(_subplebbitIpns.signature).to.be.a("object");
            expect(_subplebbitIpns.posts).to.be.a("object");
            // Remove undefined keys from json
            expect(deterministicStringify(loadedCommunity.raw.subplebbitIpfs!)).to.equals(deterministicStringify(_subplebbitIpns));
        });

        it("can load subplebbit with ENS domain via plebbit.getCommunity", async () => {
            const subplebbit = await plebbit.getCommunity({ address: ensCommunityAddress });
            expect(subplebbit.address).to.equal(ensCommunityAddress);
            expect(subplebbit.updatedAt).to.be.a("number");
        });

        it("can load subplebbit with .eth/.bso ENS aliases interchangeably via plebbit.getCommunity", { retry: 3 }, async () => {
            const subplebbit = await plebbit.getCommunity({ address: "plebbit.eth" });
            expect(["plebbit.eth", "plebbit.bso"]).to.include(subplebbit.address);
            expect(subplebbit.updatedAt).to.be.a("number");
        });

        it(`plebbit.getCommunity fails to fetch a sub with ENS address if it has capital letter`, async () => {
            try {
                await plebbit.getCommunity({ address: "testSub.bso" });
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER");
            }
        });

        it(`plebbit.getCommunity is not fetching subplebbit updates in background after fulfilling its promise`, async () => {
            const loadedCommunity = await plebbit.getCommunity({ address: subplebbitSigner.address });
            let updatedHasBeenCalled = false;
            (loadedCommunity as unknown as Record<string, Function>)["_setUpdatingState"] = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, plebbit.updateInterval * 3));
            expect(updatedHasBeenCalled).to.be.false;
        });

        it.sequential(`plebbit.getCommunity should throw if it loads a record with invalid json`, async () => {
            // this test fails sometimes
            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns("<html>hello this is not a valid json</html>");

            try {
                await plebbit.getCommunity({ address: ipnsObj.signer.address });
                expect.fail("should not succeed");
            } catch (e) {
                const plebbitErr = e as PKCError;
                if (isPKCFetchingUsingGateways(plebbit)) {
                    expect(plebbitErr.code).to.equal("ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS");
                    const gatewayError = plebbitErr.details.gatewayToError[Object.keys(plebbitErr.details.gatewayToError)[0]] as PKCError;
                    expect(gatewayError.code).to.equal("ERR_INVALID_JSON");
                } else expect(plebbitErr.code).to.equal("ERR_INVALID_JSON");
            } finally {
                await ipnsObj.plebbit.destroy();
            }
        });

        it(`plebbit.getCommunity should throw immedietly if it loads a record with invalid signature`, async () => {
            const loadedCommunity = await plebbit.getCommunity({ address: subplebbitSigner.address });
            const ipnsObj = await createNewIpns();
            await ipnsObj.publishToIpns(JSON.stringify({ ...loadedCommunity.raw.subplebbitIpfs, updatedAt: 12345 })); // publish invalid signature

            try {
                await plebbit.getCommunity({ address: ipnsObj.signer.address });
                expect.fail("should not succeed");
            } catch (e) {
                expect([
                    "ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS",
                    "ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED"
                ]).to.include((e as { code: string }).code);
            } finally {
                await ipnsObj.plebbit.destroy();
            }
        });

        it(`plebbit.getCommunity times out if subplebbit does not load`, async () => {
            const doesNotExistCommunityAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zx"; // random sub address, should not be able to resolve this
            const customPKC = await config.plebbitInstancePromise();
            customPKC._timeouts["subplebbit-ipns"] = 1 * 1000; // change timeout from 5min to 1s

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
