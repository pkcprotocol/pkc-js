import {
    createMockedCommunityIpns,
    createMockNameResolver,
    getAvailablePKCConfigsToTestAgainst,
    mockPKCV2,
    mockRemotePKC,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

describe(`publicKey fallback - createCommunity stores publicKey from explicit option`, () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`createCommunity({ name, publicKey }) sets publicKey on instance`, async () => {
        const community = await pkc.createCommunity({
            name: "test.sol",
            publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"
        });
        expect(community.publicKey).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
        expect(community.address).to.equal("test.sol");
    });

    it(`createCommunity({ publicKey }) without name sets publicKey as address`, async () => {
        const community = await pkc.createCommunity({ publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR" });
        expect(community.publicKey).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
        expect(community.address).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
    });

    it(`createCommunity({ name, publicKey }) keeps name as address even when publicKey differs`, async () => {
        const community = await pkc.createCommunity({
            name: "myforum.eth",
            publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"
        });
        // name takes priority for address, but publicKey is stored
        expect(community.address).to.equal("myforum.eth");
        expect(community.publicKey).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
    });
});

// Tests that require a real IPNS record to fetch against
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`publicKey fallback - community loading - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`update() populates name from IPNS record when loaded with only publicKey`, async () => {
            // communityAddress here is the B58 IPNS key (e.g. 12D3KooW...), not the domain
            // The domain "myforum.eth" is only inside the IPNS record's wire format
            const { communityAddress: communityPublicKey } = await createMockedCommunityIpns({ name: "myforum.eth" });

            const community = await pkc.createCommunity({ publicKey: communityPublicKey });
            expect(community.publicKey).to.equal(communityPublicKey);
            expect(community.address).to.equal(communityPublicKey);
            expect(community.name).to.be.undefined;

            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });

            // name gets populated from the IPNS record after update
            expect(community.name).to.equal("myforum.eth");
            // address stays immutable at the publicKey it was created with
            expect(community.address).to.equal(communityPublicKey);
            expect(community.publicKey).to.equal(communityPublicKey);
            expect(community.updatedAt).to.be.a("number");

            await community.stop();
        });

        it(`update() succeeds via publicKey when no resolver handles .sol`, async () => {
            // Create a real IPNS record
            const { communityAddress: communityAddress } = await createMockedCommunityIpns({});

            // Create pkc with resolver that only handles .eth/.bso (not .sol)
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

            // Create community with .sol name but real publicKey
            const community = await testPKC.createCommunity({ name: "test.sol", publicKey: communityAddress });
            expect(community.publicKey).to.equal(communityAddress);
            expect(community.address).to.equal("test.sol");

            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });

            expect(community.updatedAt).to.be.a("number");
            // nameResolved should be false because .sol can't be resolved
            expect(community.nameResolved).to.equal(false);

            await community.stop();
            await testPKC.destroy();
        });

        it(`update() succeeds via publicKey when resolver returns null for name`, async () => {
            const { communityAddress: communityAddress } = await createMockedCommunityIpns({});

            // Create pkc with resolver that returns null for our domain
            const testPKC = await config.pkcInstancePromise({
                mockResolve: false,
                pkcOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            records: { "unresolvable.eth": null }
                        })
                    ]
                }
            });

            const community = await testPKC.createCommunity({ name: "unresolvable.eth", publicKey: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });

            expect(community.updatedAt).to.be.a("number");
            // nameResolved should be false because resolver returned null
            expect(community.nameResolved).to.equal(false);

            await community.stop();
            await testPKC.destroy();
        });

        it(`update() succeeds via publicKey and nameResolved=true when name resolves correctly`, async () => {
            // Use "plebbit.bso" from defaultMockResolverRecords so both RPC server and client resolve it
            const communityAddress = signers[3].address; // plebbit.bso resolves to signers[3]

            const testPKC = await config.pkcInstancePromise({
                pkcOptions: {
                    nameResolvers: [createMockNameResolver({ includeDefaultRecords: true })]
                }
            });

            const community = await testPKC.createCommunity({ name: "plebbit.bso", publicKey: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });

            expect(community.updatedAt).to.be.a("number");
            // nameResolved should be true because resolver returned matching publicKey
            expect(community.nameResolved).to.equal(true);

            await community.stop();
            await testPKC.destroy();
        });
    });
});

describe(`publicKey fallback - failure cases without publicKey`, () => {
    it(`update() fails with ERR_NO_RESOLVER_FOR_NAME when .sol and no publicKey`, async () => {
        const testPKC = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso")
                    })
                ]
            }
        });

        const community = await testPKC.createCommunity({ address: "test.sol" });
        const errorPromise = new Promise<void>((resolve) => {
            community.on("error", (err: PKCError | Error) => {
                // ERR_NO_RESOLVER_FOR_NAME when client resolver doesn't handle .sol;
                // ERR_DOMAIN_TXT_RECORD_NOT_FOUND when RPC server resolver handles .sol but finds no record
                expect((err as PKCError).code).to.be.oneOf(["ERR_NO_RESOLVER_FOR_NAME", "ERR_DOMAIN_TXT_RECORD_NOT_FOUND"]);
                resolve();
            });
        });

        await community.update();
        await errorPromise;

        if (testPKC._pkcRpcClient) {
            // ERR_DOMAIN_TXT_RECORD_NOT_FOUND is retriable
            expect(community.updatingState).to.equal("waiting-retry");
        } else {
            // ERR_NO_RESOLVER_FOR_NAME is non-retriable
            expect(community.updatingState).to.equal("failed");
        }

        await community.stop();
        await testPKC.destroy();
    });

    it(`update() keeps retrying with ERR_DOMAIN_TXT_RECORD_NOT_FOUND when resolver returns null and no publicKey`, async () => {
        const testPKC = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: { "unresolvable.eth": null }
                    })
                ]
            }
        });

        const community = await testPKC.createCommunity({ address: "unresolvable.eth" });
        let errorCount = 0;
        const errorPromise = new Promise<void>((resolve) => {
            community.on("error", (err: PKCError | Error) => {
                expect((err as PKCError).code).to.equal("ERR_DOMAIN_TXT_RECORD_NOT_FOUND");
                errorCount++;
                if (errorCount >= 2) resolve();
            });
        });

        await community.update();
        await errorPromise;

        // ERR_DOMAIN_TXT_RECORD_NOT_FOUND is retriable
        expect(community.updatingState).to.equal("waiting-retry");

        await community.stop();
        await testPKC.destroy();
    });
});

describe(`publicKey fallback - .sol community loading`, () => {
    getAvailablePKCConfigsToTestAgainst().map((config) => {
        describe(`loading community with .sol - ${config.name}`, () => {
            let pkc: PKC;

            beforeAll(async () => {
                pkc = await config.pkcInstancePromise();
            });

            afterAll(async () => {
                await pkc.destroy();
            });

            it(`createCommunity({ address: "mycommunity.sol" }).update() fails (no resolver for .sol)`, async () => {
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

                const community = await testPKC.createCommunity({ address: "mycommunity.sol" });
                let emittedError: PKCError | Error | undefined;
                const errorPromise = new Promise<void>((resolve) => {
                    community.once("error", (err) => {
                        emittedError = err;
                        resolve();
                    });
                });

                await community.update();
                await errorPromise;

                // ERR_NO_RESOLVER_FOR_NAME when client resolver doesn't handle .sol;
                // ERR_DOMAIN_TXT_RECORD_NOT_FOUND when RPC server resolver handles .sol but finds no record
                expect((emittedError as PKCError).code).to.be.oneOf(["ERR_NO_RESOLVER_FOR_NAME", "ERR_DOMAIN_TXT_RECORD_NOT_FOUND"]);
                expect(community.raw.communityIpfs).to.be.undefined;

                await community.stop();
                await testPKC.destroy();
            });

            it(`createCommunity({ name: "mycommunity.sol", publicKey }) succeeds via publicKey fallback`, async () => {
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

                const community = await testPKC.createCommunity({ name: "mycommunity.sol", publicKey: communityAddress });
                await community.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => typeof community.updatedAt === "number"
                });

                expect(community.updatedAt).to.be.a("number");
                expect(community.nameResolved).to.equal(false);

                await community.stop();
                await testPKC.destroy();
            });
        });
    });
});

describe(`publicKey fallback - comment with .sol community address`, () => {
    it(`createComment({ cid, communityAddress: "x.sol" }) sets communityAddress but no communityPublicKey`, async () => {
        const testPKC = await mockRemotePKC();
        const comment = await testPKC.createComment({
            cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f",
            communityAddress: "mycommunity.sol"
        });
        expect(comment.communityAddress).to.equal("mycommunity.sol");
        expect(comment.communityPublicKey).to.be.undefined;
        await testPKC.destroy();
    });

    it(`createComment({ cid, communityAddress: "x.sol", communityPublicKey }) stores communityPublicKey`, async () => {
        const testPKC = await mockRemotePKC();
        const pubKey = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const comment = await testPKC.createComment({
            cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f",
            communityAddress: "mycommunity.sol",
            communityPublicKey: pubKey
        });
        expect(comment.communityAddress).to.equal("mycommunity.sol");
        expect(comment.communityPublicKey).to.equal(pubKey);
        await testPKC.destroy();
    });
});
