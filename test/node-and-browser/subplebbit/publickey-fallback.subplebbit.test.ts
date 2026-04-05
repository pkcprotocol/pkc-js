import {
    createMockedSubplebbitIpns,
    createMockNameResolver,
    getAvailablePlebbitConfigsToTestAgainst,
    mockPlebbitV2,
    mockRemotePlebbit,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import signers from "../../fixtures/signers.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { PlebbitError } from "../../../dist/node/plebbit-error.js";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";

describe(`publicKey fallback - createSubplebbit stores publicKey from explicit option`, () => {
    let plebbit: Plebbit;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`createSubplebbit({ name, publicKey }) sets publicKey on instance`, async () => {
        const sub = await plebbit.createSubplebbit({ name: "test.sol", publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR" });
        expect(sub.publicKey).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
        expect(sub.address).to.equal("test.sol");
    });

    it(`createSubplebbit({ publicKey }) without name sets publicKey as address`, async () => {
        const sub = await plebbit.createSubplebbit({ publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR" });
        expect(sub.publicKey).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
        expect(sub.address).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
    });

    it(`createSubplebbit({ name, publicKey }) keeps name as address even when publicKey differs`, async () => {
        const sub = await plebbit.createSubplebbit({
            name: "myforum.eth",
            publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"
        });
        // name takes priority for address, but publicKey is stored
        expect(sub.address).to.equal("myforum.eth");
        expect(sub.publicKey).to.equal("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
    });
});

// Tests that require a real IPNS record to fetch against
getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`publicKey fallback - community loading - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`update() populates name from IPNS record when loaded with only publicKey`, async () => {
            // communityAddress here is the B58 IPNS key (e.g. 12D3KooW...), not the domain
            // The domain "myforum.eth" is only inside the IPNS record's wire format
            const { communityAddress: communityPublicKey } = await createMockedSubplebbitIpns({ name: "myforum.eth" });

            const sub = await plebbit.createSubplebbit({ publicKey: communityPublicKey });
            expect(sub.publicKey).to.equal(communityPublicKey);
            expect(sub.address).to.equal(communityPublicKey);
            expect(sub.name).to.be.undefined;

            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });

            // name gets populated from the IPNS record after update
            expect(sub.name).to.equal("myforum.eth");
            // address stays immutable at the publicKey it was created with
            expect(sub.address).to.equal(communityPublicKey);
            expect(sub.publicKey).to.equal(communityPublicKey);
            expect(sub.updatedAt).to.be.a("number");

            await sub.stop();
        });

        it(`update() succeeds via publicKey when no resolver handles .sol`, async () => {
            // Create a real IPNS record
            const { communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({});

            // Create plebbit with resolver that only handles .eth/.bso (not .sol)
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

            // Create sub with .sol name but real publicKey
            const sub = await testPlebbit.createSubplebbit({ name: "test.sol", publicKey: subplebbitAddress });
            expect(sub.publicKey).to.equal(subplebbitAddress);
            expect(sub.address).to.equal("test.sol");

            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });

            expect(sub.updatedAt).to.be.a("number");
            // nameResolved should be false because .sol can't be resolved
            expect(sub.nameResolved).to.equal(false);

            await sub.stop();
            await testPlebbit.destroy();
        });

        it(`update() succeeds via publicKey when resolver returns null for name`, async () => {
            const { communityAddress: subplebbitAddress } = await createMockedSubplebbitIpns({});

            // Create plebbit with resolver that returns null for our domain
            const testPlebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            records: { "unresolvable.eth": null }
                        })
                    ]
                }
            });

            const sub = await testPlebbit.createSubplebbit({ name: "unresolvable.eth", publicKey: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });

            expect(sub.updatedAt).to.be.a("number");
            // nameResolved should be false because resolver returned null
            expect(sub.nameResolved).to.equal(false);

            await sub.stop();
            await testPlebbit.destroy();
        });

        it(`update() succeeds via publicKey and nameResolved=true when name resolves correctly`, async () => {
            // Use "plebbit.bso" from defaultMockResolverRecords so both RPC server and client resolve it
            const subplebbitAddress = signers[3].address; // plebbit.bso resolves to signers[3]

            const testPlebbit = await config.plebbitInstancePromise({
                plebbitOptions: {
                    nameResolvers: [createMockNameResolver({ includeDefaultRecords: true })]
                }
            });

            const sub = await testPlebbit.createSubplebbit({ name: "plebbit.bso", publicKey: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });

            expect(sub.updatedAt).to.be.a("number");
            // nameResolved should be true because resolver returned matching publicKey
            expect(sub.nameResolved).to.equal(true);

            await sub.stop();
            await testPlebbit.destroy();
        });
    });
});

describe(`publicKey fallback - failure cases without publicKey`, () => {
    it(`update() fails with ERR_NO_RESOLVER_FOR_NAME when .sol and no publicKey`, async () => {
        const testPlebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso")
                    })
                ]
            }
        });

        const sub = await testPlebbit.createSubplebbit({ address: "test.sol" });
        const errorPromise = new Promise<void>((resolve) => {
            sub.on("error", (err: PlebbitError | Error) => {
                // ERR_NO_RESOLVER_FOR_NAME when client resolver doesn't handle .sol;
                // ERR_DOMAIN_TXT_RECORD_NOT_FOUND when RPC server resolver handles .sol but finds no record
                expect((err as PlebbitError).code).to.be.oneOf(["ERR_NO_RESOLVER_FOR_NAME", "ERR_DOMAIN_TXT_RECORD_NOT_FOUND"]);
                resolve();
            });
        });

        await sub.update();
        await errorPromise;

        if (testPlebbit._plebbitRpcClient) {
            // ERR_DOMAIN_TXT_RECORD_NOT_FOUND is retriable
            expect(sub.updatingState).to.equal("waiting-retry");
        } else {
            // ERR_NO_RESOLVER_FOR_NAME is non-retriable
            expect(sub.updatingState).to.equal("failed");
        }

        await sub.stop();
        await testPlebbit.destroy();
    });

    it(`update() keeps retrying with ERR_DOMAIN_TXT_RECORD_NOT_FOUND when resolver returns null and no publicKey`, async () => {
        const testPlebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: { "unresolvable.eth": null }
                    })
                ]
            }
        });

        const sub = await testPlebbit.createSubplebbit({ address: "unresolvable.eth" });
        let errorCount = 0;
        const errorPromise = new Promise<void>((resolve) => {
            sub.on("error", (err: PlebbitError | Error) => {
                expect((err as PlebbitError).code).to.equal("ERR_DOMAIN_TXT_RECORD_NOT_FOUND");
                errorCount++;
                if (errorCount >= 2) resolve();
            });
        });

        await sub.update();
        await errorPromise;

        // ERR_DOMAIN_TXT_RECORD_NOT_FOUND is retriable
        expect(sub.updatingState).to.equal("waiting-retry");

        await sub.stop();
        await testPlebbit.destroy();
    });
});

describe(`publicKey fallback - .sol community loading`, () => {
    getAvailablePlebbitConfigsToTestAgainst().map((config) => {
        describe(`loading community with .sol - ${config.name}`, () => {
            let plebbit: Plebbit;

            beforeAll(async () => {
                plebbit = await config.plebbitInstancePromise();
            });

            afterAll(async () => {
                await plebbit.destroy();
            });

            it(`createSubplebbit({ address: "mycommunity.sol" }).update() fails (no resolver for .sol)`, async () => {
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

                const sub = await testPlebbit.createSubplebbit({ address: "mycommunity.sol" });
                let emittedError: PlebbitError | Error | undefined;
                const errorPromise = new Promise<void>((resolve) => {
                    sub.once("error", (err) => {
                        emittedError = err;
                        resolve();
                    });
                });

                await sub.update();
                await errorPromise;

                // ERR_NO_RESOLVER_FOR_NAME when client resolver doesn't handle .sol;
                // ERR_DOMAIN_TXT_RECORD_NOT_FOUND when RPC server resolver handles .sol but finds no record
                expect((emittedError as PlebbitError).code).to.be.oneOf(["ERR_NO_RESOLVER_FOR_NAME", "ERR_DOMAIN_TXT_RECORD_NOT_FOUND"]);
                expect(sub.raw.subplebbitIpfs).to.be.undefined;

                await sub.stop();
                await testPlebbit.destroy();
            });

            it(`createSubplebbit({ name: "mycommunity.sol", publicKey }) succeeds via publicKey fallback`, async () => {
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

                const sub = await testPlebbit.createSubplebbit({ name: "mycommunity.sol", publicKey: subplebbitAddress });
                await sub.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => typeof sub.updatedAt === "number"
                });

                expect(sub.updatedAt).to.be.a("number");
                expect(sub.nameResolved).to.equal(false);

                await sub.stop();
                await testPlebbit.destroy();
            });
        });
    });
});

describe(`publicKey fallback - comment with .sol community address`, () => {
    it(`createComment({ cid, communityAddress: "x.sol" }) sets communityAddress but no communityPublicKey`, async () => {
        const testPlebbit = await mockRemotePlebbit();
        const comment = await testPlebbit.createComment({
            cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f",
            communityAddress: "mycommunity.sol"
        });
        expect(comment.communityAddress).to.equal("mycommunity.sol");
        expect(comment.communityPublicKey).to.be.undefined;
        await testPlebbit.destroy();
    });

    it(`createComment({ cid, communityAddress: "x.sol", communityPublicKey }) stores communityPublicKey`, async () => {
        const testPlebbit = await mockRemotePlebbit();
        const pubKey = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const comment = await testPlebbit.createComment({
            cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f",
            communityAddress: "mycommunity.sol",
            communityPublicKey: pubKey
        });
        expect(comment.communityAddress).to.equal("mycommunity.sol");
        expect(comment.communityPublicKey).to.equal(pubKey);
        await testPlebbit.destroy();
    });
});
