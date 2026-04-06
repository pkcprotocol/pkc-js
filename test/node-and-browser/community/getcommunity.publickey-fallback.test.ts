import {
    createMockedSubplebbitIpns,
    createMockNameResolver,
    getAvailablePlebbitConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { describe, expect, it } from "vitest";

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`plebbit.getSubplebbit publicKey fallback - ${config.name}`, () => {
        it(`getSubplebbit({ publicKey }) populates name from IPNS record`, async () => {
            // communityAddress is the B58 IPNS key, not the domain
            const { communityAddress: communityPublicKey } = await createMockedSubplebbitIpns({ name: "myforum.eth" });

            const testPlebbit = await config.plebbitInstancePromise();

            try {
                const sub = await testPlebbit.getSubplebbit({ publicKey: communityPublicKey });

                expect(sub.name).to.equal("myforum.eth");
                expect(sub.address).to.equal(communityPublicKey);
                expect(sub.publicKey).to.equal(communityPublicKey);
                expect(sub.updatedAt).to.be.a("number");
                expect(sub.state).to.equal("stopped");
            } finally {
                await testPlebbit.destroy();
            }
        });

        it(`loads via publicKey when no resolver handles .sol`, async () => {
            const { communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({});

            const testPlebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
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
