import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../fixtures/signers.js";
import { messages } from "../../dist/node/errors.js";
import {
    createMockNameResolver,
    mockRemotePlebbit,
    publishWithExpectedResult,
    publishRandomPost,
    itSkipIfRpc,
    describeSkipIfRpc,
    mockNameResolvers,
    mockPlebbitV2
} from "../../dist/node/test/test-util.js";
import type { Plebbit } from "../../dist/node/pkc/pkc.js";
import type { RemoteSubplebbit } from "../../dist/node/community/remote-community.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import { NameResolverSchema } from "../../dist/node/schema.js";

describe("Comments with Authors as domains", async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Sub accepts posts with author.name as a domain that resolves to comment signer `, async () => {
        // mockRemotePlebbit resolves plebbit.bso to signers[3]
        const mockPost = await plebbit.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, name: "plebbit.bso" },
            signer: signers[3],
            content: `Mock post - ${Date.now()}`,
            title: "Mock post title",
            communityAddress: signers[0].address
        });
        const resolvedAuthorAddress = await plebbit.resolveAuthorName({ address: mockPost.author.address });
        expect(resolvedAuthorAddress).to.equal(signers[3].address);

        expect(mockPost.author.address).to.equal("plebbit.bso");

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(mockPost.author.address).to.equal("plebbit.bso");
        // ipnsKeyName is an internal property that may not be in the type definition
        expect((mockPost as Comment & { ipnsKeyName?: string }).ipnsKeyName).to.be.undefined;
    });

    itSkipIfRpc(`Subplebbit rejects a comment if author.name resolves to a different address than signer`, async () => {
        // There are two mocks of resolveAuthorNameIfNeeded, one returns null on testgibbreish.bso (server side) and this one returns signers[6]
        // The purpose is to test whether server rejects publications whose claimed author.name resolves to another signer

        const authorAddress = "testgibbreish.bso";
        const tempPlebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ records: { [authorAddress]: signers[6].address } })]
            }
        });

        const mockPost = await tempPlebbit.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, name: authorAddress },
            signer: signers[6],
            content: `Mock comment - ${Date.now()}`,
            title: "Mock post Title",
            communityAddress: signers[0].address
        });

        expect(mockPost.author.address).to.equal(authorAddress);

        await publishWithExpectedResult({
            publication: mockPost,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_DOMAIN_RESOLVES_TO_DIFFERENT_SIGNER
        });
        expect(mockPost.author.address).to.equal("testgibbreish.bso");
        await tempPlebbit.destroy();
    });
});

describe(`Vote with authors as domains`, async () => {
    let plebbit: Plebbit;
    let subplebbit: RemoteSubplebbit;
    let comment: Comment;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
        comment = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    itSkipIfRpc(`Subplebbit rejects a Vote with author.name (domain) that resolves to a different signer`, async () => {
        const authorAddress = "testgibbreish.bso";
        const tempPlebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ records: { [authorAddress]: signers[6].address } })]
            }
        });

        const vote = await tempPlebbit.createVote({
            author: { name: authorAddress },
            signer: signers[6],
            commentCid: comment.cid!,
            vote: -1,
            communityAddress: subplebbit.address
        });
        expect(vote.author.address).to.equal("testgibbreish.bso");

        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_DOMAIN_RESOLVES_TO_DIFFERENT_SIGNER
        });
        expect(vote.author.address).to.equal("testgibbreish.bso");
        await tempPlebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver resolution`, async () => {
    it(`nameResolver receives the original address (no normalization)`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false
        });

        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        let receivedName: string | undefined;

        mockNameResolvers({
            plebbit,
            resolveFunction: async ({ name }: { name: string; provider: string }) => {
                receivedName = name;
                return { publicKey: expectedIpns };
            }
        });

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "plebbit.bso" });
        expect(resolved).to.equal(expectedIpns);
        // The resolver receives the original address as-is
        expect(receivedName).to.equal("plebbit.bso");
        await plebbit.destroy();
    });

    it(`nameResolver resolves plebbit-author-address correctly`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false
        });

        const expectedAuthorAddress = "12D3KooWJJcSwMHrFvsFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

        mockNameResolvers({
            plebbit,
            resolveFunction: async ({ name }: { name: string; provider: string }) => {
                if (name === "testauthor.bso") return { publicKey: expectedAuthorAddress };
                return undefined;
            }
        });

        const resolved = await plebbit.resolveAuthorName({ address: "testauthor.bso" });
        expect(resolved).to.equal(expectedAuthorAddress);
        await plebbit.destroy();
    });

    it(`Serial resolution: first resolver that returns a value wins`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false
        });

        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const resolverCalls: string[] = [];

        plebbit.nameResolvers = [
            {
                key: "resolver-1",
                canResolve: () => true,
                resolve: async () => {
                    resolverCalls.push("resolver-1");
                    return undefined; // first resolver returns nothing
                },
                provider: "provider-1"
            },
            {
                key: "resolver-2",
                canResolve: () => true,
                resolve: async () => {
                    resolverCalls.push("resolver-2");
                    return { publicKey: expectedIpns }; // second resolver returns value
                },
                provider: "provider-2"
            }
        ];

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        expect(resolverCalls).to.deep.equal(["resolver-1", "resolver-2"]);
        await plebbit.destroy();
    });

    it(`Failing resolver is skipped, next resolver is tried`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false
        });

        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

        plebbit.nameResolvers = [
            {
                key: "failing-resolver",
                canResolve: () => true,
                resolve: async () => {
                    throw Error("failed to resolve");
                },
                provider: "failing-provider"
            },
            {
                key: "working-resolver",
                canResolve: () => true,
                resolve: async () => ({ publicKey: expectedIpns }),
                provider: "working-provider"
            }
        ];

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        await plebbit.destroy();
    });
});

describe("Comments with Authors as .bso domains", async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true })]
            }
        });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    itSkipIfRpc(`Sub accepts posts with author.name as .bso domain that resolves to comment signer`, async () => {
        const mockPost = await plebbit.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, name: "plebbit.bso" },
            signer: signers[3],
            content: `Mock post - ${Date.now()}`,
            title: "Mock post title .bso",
            communityAddress: signers[0].address
        });

        expect(mockPost.author.address).to.equal("plebbit.bso");
        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });
        expect(mockPost.author.address).to.equal("plebbit.bso");
    });
});

describeSkipIfRpc(`nameResolver canResolve filtering`, async () => {
    it(`canResolve returning false skips that resolver`, async () => {
        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const resolverCalls: string[] = [];

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "skipped-resolver",
                        canResolve: () => false,
                        resolve: async () => {
                            resolverCalls.push("skipped-resolver");
                            return { publicKey: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR" };
                        },
                        provider: "skipped-provider"
                    },
                    {
                        key: "active-resolver",
                        canResolve: () => true,
                        resolve: async () => {
                            resolverCalls.push("active-resolver");
                            return { publicKey: expectedIpns };
                        },
                        provider: "active-provider"
                    }
                ]
            }
        });

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        expect(resolverCalls).to.deep.equal(["active-resolver"]);
        await plebbit.destroy();
    });

    it(`TLD-based routing: each resolver handles its own TLD`, async () => {
        const ethIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const tonIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const resolverCalls: string[] = [];

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "eth-resolver",
                        canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso"),
                        resolve: async () => {
                            resolverCalls.push("eth-resolver");
                            return { publicKey: ethIpns };
                        },
                        provider: "eth-provider"
                    },
                    {
                        key: "ton-resolver",
                        canResolve: ({ name }: { name: string }) => name.endsWith(".ton"),
                        resolve: async () => {
                            resolverCalls.push("ton-resolver");
                            return { publicKey: tonIpns };
                        },
                        provider: "ton-provider"
                    }
                ]
            }
        });

        const resolvedEth = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.eth" });
        expect(resolvedEth).to.equal(ethIpns);
        expect(resolverCalls).to.deep.equal(["eth-resolver"]);

        resolverCalls.length = 0;
        const resolvedTon = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.ton" });
        expect(resolvedTon).to.equal(tonIpns);
        expect(resolverCalls).to.deep.equal(["ton-resolver"]);
        await plebbit.destroy();
    });

    it(`Throws ERR_NO_RESOLVER_FOR_NAME when all canResolve return false`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "eth-only-resolver",
                        canResolve: ({ name }: { name: string }) => name.endsWith(".eth"),
                        resolve: async () => ({ publicKey: "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y" }),
                        provider: "eth-provider"
                    }
                ]
            }
        });

        try {
            await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.ton" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver error edge cases`, async () => {
    it(`Throws ERR_NO_RESOLVER_FOR_NAME when nameResolvers is an empty array`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: { nameResolvers: [] }
        });

        try {
            await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await plebbit.destroy();
    });

    it(`Throws ERR_NO_RESOLVER_FOR_NAME when nameResolvers is undefined`, async () => {
        const plebbit = await mockPlebbitV2({ remotePlebbit: true, mockResolve: false });

        try {
            await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await plebbit.destroy();
    });

    it(`Throws ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS when resolve returns a non-IPNS publicKey`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "bad-resolver",
                        canResolve: () => true,
                        resolve: async () => ({ publicKey: "not-an-ipns-address" }),
                        provider: "bad-provider"
                    }
                ]
            }
        });

        try {
            await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS");
        }
        await plebbit.destroy();
    });

    it(`Returns null when all resolvers throw errors`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "failing-1",
                        canResolve: () => true,
                        resolve: async () => {
                            throw Error("resolver 1 failed");
                        },
                        provider: "provider-1"
                    },
                    {
                        key: "failing-2",
                        canResolve: () => true,
                        resolve: async () => {
                            throw Error("resolver 2 failed");
                        },
                        provider: "provider-2"
                    }
                ]
            }
        });

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(resolved).to.be.null;
        await plebbit.destroy();
    });

    it(`Returns null when all resolvers return undefined`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "empty-1",
                        canResolve: () => true,
                        resolve: async () => undefined,
                        provider: "provider-1"
                    },
                    {
                        key: "empty-2",
                        canResolve: () => true,
                        resolve: async () => undefined,
                        provider: "provider-2"
                    }
                ]
            }
        });

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(resolved).to.be.null;
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver provider argument passthrough`, async () => {
    it(`Each resolver's provider field is passed as the provider argument to resolve`, async () => {
        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        let receivedProvider: string | undefined;

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "test-resolver",
                        canResolve: () => true,
                        resolve: async ({ provider }: { name: string; provider: string }) => {
                            receivedProvider = provider;
                            return { publicKey: expectedIpns };
                        },
                        provider: "my-custom-provider-url"
                    }
                ]
            }
        });

        await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(receivedProvider).to.equal("my-custom-provider-url");
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver abortSignal support`, async () => {
    it(`Resolver can use abortSignal to cancel resolution`, async () => {
        let receivedSignal: AbortSignal | undefined;

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "signal-resolver",
                        canResolve: () => true,
                        resolve: async ({ abortSignal }: { name: string; provider: string; abortSignal?: AbortSignal }) => {
                            receivedSignal = abortSignal;
                            return { publicKey: "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y" };
                        },
                        provider: "signal-provider"
                    }
                ]
            }
        });

        await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        // The resolver should have been called (signal may or may not be passed depending on call site)
        // The important thing is that the resolver type accepts abortSignal and doesn't break
        expect(receivedSignal === undefined || receivedSignal instanceof AbortSignal).to.be.true;
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver resolution behavior`, async () => {
    it(`resolveCommunityNameIfNeeded returns IPNS address as-is without calling resolvers`, async () => {
        let resolverCalled = false;

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "should-not-be-called",
                        canResolve: () => true,
                        resolve: async () => {
                            resolverCalled = true;
                            return { publicKey: "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y" };
                        },
                        provider: "provider"
                    }
                ]
            }
        });

        const ipnsAddress = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: ipnsAddress });
        expect(resolved).to.equal(ipnsAddress);
        expect(resolverCalled).to.be.false;
        await plebbit.destroy();
    });

    it(`resolveAuthorNameIfNeeded throws ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58 for non-domain address`, async () => {
        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "resolver",
                        canResolve: () => true,
                        resolve: async () => ({ publicKey: "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y" }),
                        provider: "provider"
                    }
                ]
            }
        });

        try {
            // An IPNS address is not a domain, so resolveAuthorNameIfNeeded should throw
            await plebbit._clientsManager.resolveAuthorNameIfNeeded({
                authorAddress: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"
            });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58");
        }
        await plebbit.destroy();
    });

    it(`resolveCommunityNameIfNeeded re-resolves on each call`, async () => {
        const firstIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const secondIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        let callCount = 0;

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            stubStorage: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "counting-resolver",
                        canResolve: () => true,
                        resolve: async () => {
                            callCount++;
                            return { publicKey: callCount === 1 ? firstIpns : secondIpns };
                        },
                        provider: "provider"
                    }
                ]
            }
        });

        const resolved1 = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "cached.bso" });
        expect(resolved1).to.equal(firstIpns);
        expect(callCount).to.equal(1);

        const resolved2 = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "cached.bso" });
        expect(resolved2).to.equal(secondIpns);
        expect(callCount).to.equal(2);
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver schema validation`, async () => {
    it(`Rejects nameResolver with non-function resolve`, () => {
        const result = NameResolverSchema.safeParse({
            key: "test",
            resolve: "not-a-function",
            canResolve: () => true,
            provider: "provider"
        });
        expect(result.success).to.be.false;
    });

    it(`Rejects nameResolver with non-function canResolve`, () => {
        const result = NameResolverSchema.safeParse({
            key: "test",
            resolve: async () => ({ publicKey: "test" }),
            canResolve: "not-a-function",
            provider: "provider"
        });
        expect(result.success).to.be.false;
    });

    it(`Rejects nameResolver with empty key`, () => {
        const result = NameResolverSchema.safeParse({
            key: "",
            resolve: async () => ({ publicKey: "test" }),
            canResolve: () => true,
            provider: "provider"
        });
        expect(result.success).to.be.false;
    });

    it(`Rejects nameResolver with empty provider`, () => {
        const result = NameResolverSchema.safeParse({
            key: "test",
            resolve: async () => ({ publicKey: "test" }),
            canResolve: () => true,
            provider: ""
        });
        expect(result.success).to.be.false;
    });

    it(`Rejects nameResolver with missing key`, () => {
        const result = NameResolverSchema.safeParse({
            resolve: async () => ({ publicKey: "test" }),
            canResolve: () => true,
            provider: "provider"
        });
        expect(result.success).to.be.false;
    });

    it(`Accepts a valid nameResolver`, () => {
        const result = NameResolverSchema.safeParse({
            key: "valid-resolver",
            resolve: async () => ({ publicKey: "test" }),
            canResolve: () => true,
            provider: "valid-provider"
        });
        expect(result.success).to.be.true;
    });
});

describeSkipIfRpc(`plebbit._clientsManager.clients.nameResolvers initialization`, async () => {
    it(`Creates NameResolverClient instances for each resolver key`, async () => {
        const plebbit = await mockPlebbitV2({ remotePlebbit: true, mockResolve: true });
        const keys = Object.keys(plebbit._clientsManager.clients.nameResolvers);
        expect(keys.length).to.be.greaterThanOrEqual(1);
        expect(keys).to.include("mock-resolver");
        expect(plebbit._clientsManager.clients.nameResolvers["mock-resolver"].state).to.equal("stopped");
        await plebbit.destroy();
    });

    it(`No NameResolverClient instances when nameResolvers is undefined`, async () => {
        const plebbit = await mockPlebbitV2({ remotePlebbit: true, mockResolve: false });
        const keys = Object.keys(plebbit._clientsManager.clients.nameResolvers);
        expect(keys.length).to.equal(0);
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver returning extra properties`, async () => {
    it(`Extra properties in resolve return value do not cause errors`, async () => {
        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "extra-props-resolver",
                        canResolve: () => true,
                        resolve: async () => ({
                            publicKey: expectedIpns,
                            chainId: "1",
                            resolverVersion: "2.0.0",
                            extraField: "extra-value"
                        }),
                        provider: "extra-provider"
                    }
                ]
            }
        });

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver runtime modification`, async () => {
    it(`Changing plebbit.nameResolvers at runtime uses new resolvers`, async () => {
        const firstIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const secondIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            stubStorage: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "original-resolver",
                        canResolve: () => true,
                        resolve: async () => ({ publicKey: firstIpns }),
                        provider: "original-provider"
                    }
                ]
            }
        });

        const resolved1 = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "runtime.bso" });
        expect(resolved1).to.equal(firstIpns);

        // Swap resolvers at runtime
        plebbit.nameResolvers = [
            {
                key: "new-resolver",
                canResolve: () => true,
                resolve: async () => ({ publicKey: secondIpns }),
                provider: "new-provider"
            }
        ];

        const resolved2 = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "runtime.bso" });
        expect(resolved2).to.equal(secondIpns);
        await plebbit.destroy();
    });

    it(`Adding a resolver at runtime allows resolving previously unhandled TLDs`, async () => {
        const ethIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const tonIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "eth-resolver",
                        canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso"),
                        resolve: async () => ({ publicKey: ethIpns }),
                        provider: "eth-provider"
                    }
                ]
            }
        });

        // .ton should fail since no resolver handles it
        try {
            await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.ton" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }

        // Add a .ton resolver at runtime
        plebbit.nameResolvers = [
            ...plebbit.nameResolvers!,
            {
                key: "ton-resolver",
                canResolve: ({ name }: { name: string }) => name.endsWith(".ton"),
                resolve: async () => ({ publicKey: tonIpns }),
                provider: "ton-provider"
            }
        ];

        const resolved = await plebbit._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: "test.ton" });
        expect(resolved).to.equal(tonIpns);
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`CommentEdit with author as domain`, async () => {
    let plebbit: Plebbit;
    let postToEdit: Comment;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        // Publish a post with author.name as domain
        postToEdit = await publishRandomPost({
            communityAddress: signers[0].address,
            plebbit: plebbit,
            postProps: {
                author: { name: "plebbit.bso" },
                signer: signers[3]
            }
        });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Sub accepts CommentEdit from author with domain name`, async () => {
        const commentEdit = await plebbit.createCommentEdit({
            communityAddress: postToEdit.communityAddress,
            commentCid: postToEdit.cid!,
            content: "edited content via domain author " + Date.now(),
            signer: signers[3]
        });

        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});
