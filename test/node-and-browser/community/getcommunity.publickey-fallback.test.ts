import {
    createMockedCommunityIpns,
    createMockNameResolver,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { describe, expect, it } from "vitest";

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`pkc.getCommunity publicKey fallback - ${config.name}`, () => {
        it(`getCommunity({ publicKey }) populates name from IPNS record`, async () => {
            // communityAddress is the B58 IPNS key, not the domain
            const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name: "myforum.eth" });

            const testPKC = await config.pkcInstancePromise();

            try {
                const sub = await testPKC.getCommunity({ publicKey: communityPublicKey });

                expect(sub.name).to.equal("myforum.eth");
                expect(sub.address).to.equal(communityPublicKey);
                expect(sub.publicKey).to.equal(communityPublicKey);
                expect(sub.updatedAt).to.be.a("number");
                expect(sub.state).to.equal("stopped");
            } finally {
                await testPKC.destroy();
            }
        });

        it(`loads via publicKey when no resolver handles .sol`, async () => {
            const { communityAddress: communityAddress } = await createMockedCommunityIpns({});

            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso")
                        })
                    ]
                }
            });

            try {
                const sub = await testPKC.getCommunity({ name: "test.sol", publicKey: communityAddress });

                expect(sub.address).to.equal("test.sol");
                expect(sub.publicKey).to.equal(communityAddress);
                expect(sub.updatedAt).to.be.a("number");
                expect(sub.state).to.equal("stopped");
            } finally {
                await testPKC.destroy();
            }
        });
    });
});
