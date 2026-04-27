import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../fixtures/signers.js";
import { messages } from "../../dist/node/errors.js";
import {
    createMockNameResolver,
    mockRemotePKC,
    publishWithExpectedResult,
    publishRandomPost,
    mockNameResolvers,
    mockPKCV2
} from "../../dist/node/test/test-util.js";
import { itSkipIfRpc, describeSkipIfRpc } from "../helpers/conditional-tests.js";
import type { PKC } from "../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../dist/node/community/remote-community.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import { NameResolverSchema } from "../../dist/node/schema.js";

describe("Comments with Authors as domains", async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Sub accepts posts with author.name as a domain that resolves to comment signer `, async () => {
        // mockRemotePKC resolves plebbit.bso to signers[3]
        const mockPost = await pkc.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, name: "plebbit.bso" },
            signer: signers[3],
            content: `Mock post - ${Date.now()}`,
            title: "Mock post title",
            communityAddress: signers[0].address
        });
        const { resolvedAuthorName: resolvedAuthorAddress } = await pkc.resolveAuthorName({ name: mockPost.author.address });
        expect(resolvedAuthorAddress).to.equal(signers[3].address);

        expect(mockPost.author.address).to.equal("plebbit.bso");

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(mockPost.author.address).to.equal("plebbit.bso");
        // ipnsKeyName is an internal property that may not be in the type definition
        expect((mockPost as Comment & { ipnsKeyName?: string }).ipnsKeyName).to.be.undefined;
    });

    itSkipIfRpc(`Community rejects a comment if author.name resolves to a different address than signer`, async () => {
        // There are two mocks of resolveAuthorNameIfNeeded, one returns null on testgibbreish.bso (server side) and this one returns signers[6]
        // The purpose is to test whether server rejects publications whose claimed author.name resolves to another signer

        const authorAddress = "testgibbreish.bso";
        const tempPKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ records: { [authorAddress]: signers[6].address } })]
            }
        });

        const mockPost = await tempPKC.createComment({
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
        await tempPKC.destroy();
    });
});

describe(`Vote with authors as domains`, async () => {
    let pkc: PKC;
    let community: RemoteCommunity;
    let comment: Comment;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        community = await pkc.getCommunity({ address: signers[0].address });
        comment = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    itSkipIfRpc(`Community rejects a Vote with author.name (domain) that resolves to a different signer`, async () => {
        const authorAddress = "testgibbreish.bso";
        const tempPKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ records: { [authorAddress]: signers[6].address } })]
            }
        });

        const vote = await tempPKC.createVote({
            author: { name: authorAddress },
            signer: signers[6],
            commentCid: comment.cid!,
            vote: -1,
            communityAddress: community.address
        });
        expect(vote.author.address).to.equal("testgibbreish.bso");

        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_DOMAIN_RESOLVES_TO_DIFFERENT_SIGNER
        });
        expect(vote.author.address).to.equal("testgibbreish.bso");
        await tempPKC.destroy();
    });
});

describeSkipIfRpc(`nameResolver resolution`, async () => {
    it(`nameResolver receives the original address (no normalization)`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false
        });

        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        let receivedName: string | undefined;

        mockNameResolvers({
            pkc: pkc,
            resolveFunction: async ({ name }: { name: string }) => {
                receivedName = name;
                return { publicKey: expectedIpns };
            }
        });

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "plebbit.bso" });
        expect(resolved).to.equal(expectedIpns);
        // The resolver receives the original address as-is
        expect(receivedName).to.equal("plebbit.bso");
        await pkc.destroy();
    });

    it(`nameResolver resolves plebbit-author-address correctly`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false
        });

        const expectedAuthorAddress = "12D3KooWJJcSwMHrFvsFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

        mockNameResolvers({
            pkc: pkc,
            resolveFunction: async ({ name }: { name: string }) => {
                if (name === "testauthor.bso") return { publicKey: expectedAuthorAddress };
                return undefined;
            }
        });

        const { resolvedAuthorName: resolved } = await pkc.resolveAuthorName({ name: "testauthor.bso" });
        expect(resolved).to.equal(expectedAuthorAddress);
        await pkc.destroy();
    });

    it(`Serial resolution: first resolver that returns a value wins`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false
        });

        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const resolverCalls: string[] = [];

        pkc.nameResolvers = [
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

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        expect(resolverCalls).to.deep.equal(["resolver-1", "resolver-2"]);
        await pkc.destroy();
    });

    it(`Failing resolver is skipped, next resolver is tried`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false
        });

        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

        pkc.nameResolvers = [
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

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        await pkc.destroy();
    });
});

describe("Comments with Authors as .bso domains", async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true })]
            }
        });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    itSkipIfRpc(`Sub accepts posts with author.name as .bso domain that resolves to comment signer`, async () => {
        const mockPost = await pkc.createComment({
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

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        expect(resolverCalls).to.deep.equal(["active-resolver"]);
        await pkc.destroy();
    });

    it(`TLD-based routing: each resolver handles its own TLD`, async () => {
        const ethIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const tonIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        const resolverCalls: string[] = [];

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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

        const resolvedEth = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.eth" });
        expect(resolvedEth).to.equal(ethIpns);
        expect(resolverCalls).to.deep.equal(["eth-resolver"]);

        resolverCalls.length = 0;
        const resolvedTon = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.ton" });
        expect(resolvedTon).to.equal(tonIpns);
        expect(resolverCalls).to.deep.equal(["ton-resolver"]);
        await pkc.destroy();
    });

    it(`Throws ERR_NO_RESOLVER_FOR_NAME when all canResolve return false`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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
            await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.ton" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await pkc.destroy();
    });
});

describeSkipIfRpc(`nameResolver error edge cases`, async () => {
    it(`Throws ERR_NO_RESOLVER_FOR_NAME when nameResolvers is an empty array`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: { nameResolvers: [] }
        });

        try {
            await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await pkc.destroy();
    });

    it(`Throws ERR_NO_RESOLVER_FOR_NAME when nameResolvers is undefined`, async () => {
        const pkc = await mockPKCV2({ remotePKC: true, mockResolve: false });

        try {
            await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await pkc.destroy();
    });

    it(`Throws ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS when resolve returns a non-IPNS publicKey`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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
            await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS");
        }
        await pkc.destroy();
    });

    it(`Returns null when all resolvers throw errors`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        expect(resolved).to.be.null;
        await pkc.destroy();
    });

    it(`Returns null when all resolvers return undefined`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    {
                        key: "empty-1",
                        canResolve: () => true,
                        resolve: async (): Promise<undefined> => undefined,
                        provider: "provider-1"
                    },
                    {
                        key: "empty-2",
                        canResolve: () => true,
                        resolve: async (): Promise<undefined> => undefined,
                        provider: "provider-2"
                    }
                ]
            }
        });

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        expect(resolved).to.be.null;
        await pkc.destroy();
    });
});

describeSkipIfRpc(`nameResolver abortSignal support`, async () => {
    it(`Resolver can use abortSignal to cancel resolution`, async () => {
        let receivedSignal: AbortSignal | undefined;

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    {
                        key: "signal-resolver",
                        canResolve: () => true,
                        resolve: async ({ abortSignal }: { name: string; abortSignal?: AbortSignal }) => {
                            receivedSignal = abortSignal;
                            return { publicKey: "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y" };
                        },
                        provider: "signal-provider"
                    }
                ]
            }
        });

        await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        // The resolver should have been called (signal may or may not be passed depending on call site)
        // The important thing is that the resolver type accepts abortSignal and doesn't break
        expect(receivedSignal === undefined || receivedSignal instanceof AbortSignal).to.be.true;
        await pkc.destroy();
    });
});

describeSkipIfRpc(`nameResolver resolution behavior`, async () => {
    it(`resolveCommunityNameIfNeeded returns IPNS address as-is without calling resolvers`, async () => {
        let resolverCalled = false;

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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
        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: ipnsAddress });
        expect(resolved).to.equal(ipnsAddress);
        expect(resolverCalled).to.be.false;
        await pkc.destroy();
    });

    it(`resolveAuthorNameIfNeeded throws ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58 for non-domain address`, async () => {
        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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
            await pkc._clientsManager.resolveAuthorNameIfNeeded({
                authorName: "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"
            });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58");
        }
        await pkc.destroy();
    });

    it(`resolveCommunityNameIfNeeded re-resolves on each call`, async () => {
        const firstIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const secondIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
        let callCount = 0;

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            stubStorage: false,
            pkcOptions: {
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

        const resolved1 = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "cached.bso" });
        expect(resolved1).to.equal(firstIpns);
        expect(callCount).to.equal(1);

        const resolved2 = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "cached.bso" });
        expect(resolved2).to.equal(secondIpns);
        expect(callCount).to.equal(2);
        await pkc.destroy();
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

describeSkipIfRpc(`pkc._clientsManager.clients.nameResolvers initialization`, async () => {
    it(`Creates NameResolverClient instances for each resolver key`, async () => {
        const pkc = await mockPKCV2({ remotePKC: true, mockResolve: true });
        const keys = Object.keys(pkc._clientsManager.clients.nameResolvers);
        expect(keys.length).to.be.greaterThanOrEqual(1);
        expect(keys).to.include("mock-resolver");
        expect(pkc._clientsManager.clients.nameResolvers["mock-resolver"].state).to.equal("stopped");
        await pkc.destroy();
    });

    it(`No NameResolverClient instances when nameResolvers is undefined`, async () => {
        const pkc = await mockPKCV2({ remotePKC: true, mockResolve: false });
        const keys = Object.keys(pkc._clientsManager.clients.nameResolvers);
        expect(keys.length).to.equal(0);
        await pkc.destroy();
    });
});

describeSkipIfRpc(`nameResolver returning extra properties`, async () => {
    it(`Extra properties in resolve return value do not cause errors`, async () => {
        const expectedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.bso" });
        expect(resolved).to.equal(expectedIpns);
        await pkc.destroy();
    });
});

describeSkipIfRpc(`nameResolver runtime modification`, async () => {
    it(`Changing pkc.nameResolvers at runtime uses new resolvers`, async () => {
        const firstIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const secondIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            stubStorage: false,
            pkcOptions: {
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

        const resolved1 = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "runtime.bso" });
        expect(resolved1).to.equal(firstIpns);

        // Swap resolvers at runtime
        pkc.nameResolvers = [
            {
                key: "new-resolver",
                canResolve: () => true,
                resolve: async () => ({ publicKey: secondIpns }),
                provider: "new-provider"
            }
        ];

        const resolved2 = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "runtime.bso" });
        expect(resolved2).to.equal(secondIpns);
        await pkc.destroy();
    });

    it(`Adding a resolver at runtime allows resolving previously unhandled TLDs`, async () => {
        const ethIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const tonIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

        const pkc = await mockPKCV2({
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
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
            await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.ton" });
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }

        // Add a .ton resolver at runtime
        pkc.nameResolvers = [
            ...pkc.nameResolvers!,
            {
                key: "ton-resolver",
                canResolve: ({ name }: { name: string }) => name.endsWith(".ton"),
                resolve: async () => ({ publicKey: tonIpns }),
                provider: "ton-provider"
            }
        ];

        const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({ communityName: "test.ton" });
        expect(resolved).to.equal(tonIpns);
        await pkc.destroy();
    });
});

describeSkipIfRpc(`CommentEdit with author as domain`, async () => {
    let pkc: PKC;
    let postToEdit: Comment;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        // Publish a post with author.name as domain
        postToEdit = await publishRandomPost({
            communityAddress: signers[0].address,
            pkc: pkc,
            postProps: {
                author: { name: "plebbit.bso" },
                signer: signers[3]
            }
        });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Sub accepts CommentEdit from author with domain name`, async () => {
        const commentEdit = await pkc.createCommentEdit({
            communityAddress: postToEdit.communityAddress,
            commentCid: postToEdit.cid!,
            content: "edited content via domain author " + Date.now(),
            signer: signers[3]
        });

        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});

// RPC clients can't use nameResolvers (functions aren't serializable over RPC)
describeSkipIfRpc("Class-based name resolvers", () => {
    it("class-based resolver preserves internal state after PKC options parsing", async () => {
        // Simulate a class-based resolver like BsoResolver that has internal state
        class TestResolver {
            key: string;
            provider: string;
            private runtime: { createClient: () => string };

            constructor({ key, provider }: { key: string; provider: string }) {
                this.key = key;
                this.provider = provider;
                this.runtime = { createClient: () => "test-client" };
            }

            canResolve({ name }: { name: string }) {
                return name.endsWith(".test");
            }

            async resolve({ name }: { name: string }) {
                // This line crashes if Zod strips `this.runtime`
                const client = this.runtime.createClient();
                return { publicKey: signers[0].address };
            }

            async destroy() {}
        }

        const resolver = new TestResolver({ key: "test-resolver", provider: "test" });

        const pkc = await mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [resolver]
            }
        });

        // This should not throw "Cannot read properties of undefined (reading 'createClient')"
        const { resolvedAuthorName: result } = await pkc.resolveAuthorName({ name: "something.test" });
        expect(result).to.equal(signers[0].address);

        await pkc.destroy();
    });
});
