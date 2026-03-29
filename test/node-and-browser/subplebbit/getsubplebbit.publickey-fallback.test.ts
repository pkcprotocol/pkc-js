import {
    createMockedSubplebbitIpns,
    createMockNameResolver,
    getAvailablePlebbitConfigsToTestAgainst,
    mockPlebbitV2
} from "../../../dist/node/test/test-util.js";
import { describe, expect, it } from "vitest";

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`plebbit.getSubplebbit publicKey fallback - ${config.name}`, () => {
        const itNonRpc = config.testConfigCode === "remote-plebbit-rpc" ? it.skip : it;

        itNonRpc(`loads via publicKey when no resolver handles .sol`, async () => {
            const { communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({});

            const testPlebbit = await mockPlebbitV2({
                remotePlebbit: true,
                mockResolve: false,
                plebbitOptions: {
                    plebbitRpcClientsOptions: undefined,
                    kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                    pubsubKuboRpcClientsOptions: [
                        "http://localhost:15002/api/v0",
                        "http://localhost:42234/api/v0",
                        "http://localhost:42254/api/v0"
                    ],
                    httpRoutersOptions: [],
                    nameResolvers: [
                        createMockNameResolver({
                            canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso")
                        })
                    ]
                }
            });

            try {
                const sub = await testPlebbit.getSubplebbit({ name: "test.sol", publicKey: subplebbitAddress });

                expect(sub.address).to.equal("test.sol");
                expect(sub.publicKey).to.equal(subplebbitAddress);
                expect(sub.updatedAt).to.be.a("number");
                expect(sub.state).to.equal("stopped");
            } finally {
                await testPlebbit.destroy();
            }
        });
    });
});
