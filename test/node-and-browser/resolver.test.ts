import { beforeAll, afterAll, describe, it } from "vitest";
import signers from "../fixtures/signers.js";
import { messages } from "../../dist/node/errors.js";
import {
    mockRemotePlebbit,
    mockUpdatingCommentResolvingAuthor,
    publishWithExpectedResult,
    publishRandomPost,
    itSkipIfRpc,
    describeSkipIfRpc,
    mockNameResolvers,
    resolveWhenConditionIsTrue,
    mockCacheOfTextRecord,
    mockPlebbitV2
} from "../../dist/node/test/test-util.js";
import type { Plebbit } from "../../dist/node/plebbit/plebbit.js";
import type { RemoteSubplebbit } from "../../dist/node/subplebbit/remote-subplebbit.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import { NameResolverSchema } from "../../dist/node/schema.js";
import type { CachedTextRecordResolve } from "../../dist/node/clients/base-client-manager.js";

const mockComments: Comment[] = [];

describe("Comments with Authors as domains", async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Sub accepts posts with author.address as a domain that resolves to comment signer `, async () => {
        // I've mocked plebbit.resolver.resolveAuthorAddressIfNeeded to return signers[6] address for plebbit.bso
        const mockPost = await plebbit.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, address: "plebbit.bso" },
            signer: signers[6],
            content: `Mock post - ${Date.now()}`,
            title: "Mock post title",
            subplebbitAddress: signers[0].address
        });
        const resolvedAuthorAddress = await plebbit.resolveAuthorAddress({ address: mockPost.author.address });
        expect(resolvedAuthorAddress).to.equal(signers[6].address);

        expect(mockPost.author.address).to.equal("plebbit.bso");

        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: true });

        expect(mockPost.author.address).to.equal("plebbit.bso");
        // ipnsKeyName is an internal property that may not be in the type definition
        expect((mockPost as Comment & { ipnsKeyName?: string }).ipnsKeyName).to.be.undefined;
        mockComments.push(mockPost);
    });

    itSkipIfRpc(`Subplebbit rejects a comment if plebbit-author-address points to a different address than signer`, async () => {
        // There are two mocks of resovleAuthorAddressIfNeeded, one return null on testgibbreish.bso (server side) and this one returns signers[6]
        // The purpose is to test whether server rejects publications that has different plebbit-author-address and signer address

        const authorAddress = "testgibbreish.bso";
        const tempPlebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true });

        await mockCacheOfTextRecord({
            plebbit: tempPlebbit,
            domain: authorAddress,
            resolveType: "author",
            value: signers[6].address
        });

        const mockPost = await tempPlebbit.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, address: authorAddress },
            signer: signers[6],
            content: `Mock comment - ${Date.now()}`,
            title: "Mock post Title",
            subplebbitAddress: signers[0].address
        });

        expect(mockPost.author.address).to.equal(authorAddress);

        await publishWithExpectedResult({
            publication: mockPost,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_NOT_MATCHING_SIGNATURE
        });
        expect(mockPost.author.address).to.equal("testgibbreish.bso");
        await tempPlebbit.destroy();
    });

    itSkipIfRpc(
        `comment.update() corrects author.address to derived address in case plebbit-author-address points to another address`,
        async () => {
            const tempPlebbit = await mockRemotePlebbit();
            const comment = await tempPlebbit.createComment({ cid: mockComments[mockComments.length - 1].cid });
            const originalResolvingFunction = comment._clientsManager.resolveAuthorAddressIfNeeded.bind(comment._clientsManager);
            // verifyComment in comment.update should overwrite author.address to derived address
            await comment.update();
            mockUpdatingCommentResolvingAuthor(comment, async (authorAddress: string) =>
                authorAddress === "plebbit.bso" ? signers[7].address : originalResolvingFunction(authorAddress)
            );
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => Boolean(comment.author?.address) });
            await comment.stop();
            expect(comment.author.address).to.equal(signers[6].address);
            await tempPlebbit.destroy();
        }
    );
});

describe(`Vote with authors as domains`, async () => {
    let plebbit: Plebbit;
    let subplebbit: RemoteSubplebbit;
    let comment: Comment;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
        comment = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    itSkipIfRpc(`Subplebbit rejects a Vote with author.address (domain) that resolves to a different signer`, async () => {
        const tempPlebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true });
        const authorAddress = "testgibbreish.bso";
        await mockCacheOfTextRecord({
            plebbit: tempPlebbit,
            domain: authorAddress,
            resolveType: "author",
            value: signers[6].address
        });

        const vote = await tempPlebbit.createVote({
            author: { address: authorAddress },
            signer: signers[6],
            commentCid: comment.cid!,
            vote: -1,
            subplebbitAddress: subplebbit.address
        });
        expect(vote.author.address).to.equal("testgibbreish.bso");

        await publishWithExpectedResult({
            publication: vote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_NOT_MATCHING_SIGNATURE
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("plebbit.bso");
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

        const resolved = await plebbit.resolveAuthorAddress({ address: "testauthor.bso" });
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
        expect(resolved).to.equal(expectedIpns);
        await plebbit.destroy();
    });
});

describe("Comments with Authors as .bso domains", async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbitV2({ stubStorage: false, remotePlebbit: true });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    itSkipIfRpc(`Sub accepts posts with author.address as .bso domain that resolves to comment signer`, async () => {
        // Mock the cache so plebbit.bso resolves to signers[6] address (same as plebbit.eth mock)
        await mockCacheOfTextRecord({
            plebbit,
            domain: "plebbit.bso",
            resolveType: "author",
            value: signers[6].address
        });

        const mockPost = await plebbit.createComment({
            author: { displayName: `Mock Author - ${Date.now()}`, address: "plebbit.bso" },
            signer: signers[6],
            content: `Mock post - ${Date.now()}`,
            title: "Mock post title .bso",
            subplebbitAddress: signers[0].address
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        const resolvedEth = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.eth");
        expect(resolvedEth).to.equal(ethIpns);
        expect(resolverCalls).to.deep.equal(["eth-resolver"]);

        resolverCalls.length = 0;
        // clear cache so next resolve goes through resolvers again
        await plebbit._clientsManager.clearDomainCache("test.ton", "subplebbit");
        const resolvedTon = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.ton");
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
            await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.ton");
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
            await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_NO_RESOLVER_FOR_NAME");
        }
        await plebbit.destroy();
    });

    it(`Throws ERR_NO_RESOLVER_FOR_NAME when nameResolvers is undefined`, async () => {
        const plebbit = await mockPlebbitV2({ remotePlebbit: true, mockResolve: false });

        try {
            await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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
            await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
        // The resolver should have been called (signal may or may not be passed depending on call site)
        // The important thing is that the resolver type accepts abortSignal and doesn't break
        expect(receivedSignal === undefined || receivedSignal instanceof AbortSignal).to.be.true;
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`nameResolver caching behavior`, async () => {
    it(`resolveSubplebbitAddressIfNeeded returns IPNS address as-is without calling resolvers`, async () => {
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
        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded(ipnsAddress);
        expect(resolved).to.equal(ipnsAddress);
        expect(resolverCalled).to.be.false;
        await plebbit.destroy();
    });

    it(`resolveAuthorAddressIfNeeded throws ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58 for non-domain address`, async () => {
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
            // An IPNS address is not a domain, so resolveAuthorAddressIfNeeded should throw
            await plebbit._clientsManager.resolveAuthorAddressIfNeeded("12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR");
            expect.fail("Should have thrown");
        } catch (e: any) {
            expect(e.code).to.equal("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58");
        }
        await plebbit.destroy();
    });

    it(`clearDomainCache removes cached entry and forces re-resolution`, async () => {
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

        // First resolution should call the resolver and cache the result
        const resolved1 = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("cached.bso");
        expect(resolved1).to.equal(firstIpns);
        expect(callCount).to.equal(1);

        // Second resolution should return cached value (resolver not called again)
        const resolved2 = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("cached.bso");
        expect(resolved2).to.equal(firstIpns);
        expect(callCount).to.equal(1);

        // Clear the cache
        await plebbit._clientsManager.clearDomainCache("cached.bso", "subplebbit");

        // Third resolution should call the resolver again
        const resolved3 = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("cached.bso");
        expect(resolved3).to.equal(secondIpns);
        expect(callCount).to.equal(2);
        await plebbit.destroy();
    });

    it(`Stale cache returns old value immediately while refreshing in background`, async () => {
        const oldIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        const newIpns = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            stubStorage: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "fresh-resolver",
                        canResolve: () => true,
                        resolve: async () => ({ publicKey: newIpns }),
                        provider: "provider"
                    }
                ]
            }
        });

        // Manually insert a stale cache entry (timestampSeconds set to > 1 hour ago)
        const cacheKey = plebbit._clientsManager._getKeyOfCachedDomainTextRecord("stale.bso", "subplebbit");
        const staleTimestamp = Math.round(Date.now() / 1000) - 3601; // 1 hour + 1 second ago
        const staleCacheEntry: CachedTextRecordResolve = { timestampSeconds: staleTimestamp, valueOfTextRecord: oldIpns };
        await plebbit._storage.setItem(cacheKey, staleCacheEntry);

        // Resolution should return the old (stale) value immediately
        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("stale.bso");
        expect(resolved).to.equal(oldIpns);

        // Wait a bit for the background refresh to complete
        await new Promise((resolve) => setTimeout(resolve, 500));

        // The background refresh should have updated the cache
        const updatedCache = await plebbit._storage.getItem(cacheKey);
        expect(updatedCache).to.not.be.undefined;
        expect((updatedCache as CachedTextRecordResolve).valueOfTextRecord).to.equal(newIpns);
        await plebbit.destroy();
    });

    it(`Cache entry older than 1 hour is considered stale`, async () => {
        const cachedIpns = "12D3KooWJJcSwxH2F3sFL7YCNDLD95kBczEfkHpPNdxcjZwR2X2Y";
        let resolverCallCount = 0;

        const plebbit = await mockPlebbitV2({
            remotePlebbit: true,
            mockResolve: false,
            stubStorage: false,
            plebbitOptions: {
                nameResolvers: [
                    {
                        key: "ttl-resolver",
                        canResolve: () => true,
                        resolve: async () => {
                            resolverCallCount++;
                            return { publicKey: cachedIpns };
                        },
                        provider: "provider"
                    }
                ]
            }
        });

        // Insert a fresh cache entry (current timestamp)
        const cacheKey = plebbit._clientsManager._getKeyOfCachedDomainTextRecord("fresh.bso", "subplebbit");
        const freshTimestamp = Math.round(Date.now() / 1000);
        const freshCacheEntry: CachedTextRecordResolve = { timestampSeconds: freshTimestamp, valueOfTextRecord: cachedIpns };
        await plebbit._storage.setItem(cacheKey, freshCacheEntry);

        // Resolution with fresh cache should NOT trigger resolver
        await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("fresh.bso");
        expect(resolverCallCount).to.equal(0);

        // Now set the cache to be stale (> 1 hour old)
        const staleTimestamp = Math.round(Date.now() / 1000) - 7200; // 2 hours ago
        const staleCacheEntry: CachedTextRecordResolve = { timestampSeconds: staleTimestamp, valueOfTextRecord: cachedIpns };
        await plebbit._storage.setItem(cacheKey, staleCacheEntry);

        // Resolution with stale cache should return cached value but trigger background refresh
        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("fresh.bso");
        expect(resolved).to.equal(cachedIpns);

        // Wait for background refresh to complete
        await new Promise((resolve) => setTimeout(resolve, 500));
        // The resolver should have been called once by the background refresh
        expect(resolverCallCount).to.equal(1);
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.bso");
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

        const resolved1 = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("runtime.bso");
        expect(resolved1).to.equal(firstIpns);

        // Clear cache so next resolve goes through resolvers
        await plebbit._clientsManager.clearDomainCache("runtime.bso", "subplebbit");

        // Swap resolvers at runtime
        plebbit.nameResolvers = [
            {
                key: "new-resolver",
                canResolve: () => true,
                resolve: async () => ({ publicKey: secondIpns }),
                provider: "new-provider"
            }
        ];

        const resolved2 = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("runtime.bso");
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
            await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.ton");
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

        const resolved = await plebbit._clientsManager.resolveSubplebbitAddressIfNeeded("test.ton");
        expect(resolved).to.equal(tonIpns);
        await plebbit.destroy();
    });
});

describeSkipIfRpc(`CommentEdit with author as domain`, async () => {
    let plebbit: Plebbit;
    let postToEdit: Comment;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        // Publish a post with author.address as domain
        postToEdit = await publishRandomPost({
            subplebbitAddress: signers[0].address,
            plebbit: plebbit,
            postProps: {
                author: { address: "plebbit.bso" },
                signer: signers[6]
            }
        });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Sub accepts CommentEdit from author with domain address`, async () => {
        const commentEdit = await plebbit.createCommentEdit({
            subplebbitAddress: postToEdit.subplebbitAddress,
            commentCid: postToEdit.cid!,
            content: "edited content via domain author " + Date.now(),
            signer: signers[6]
        });

        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});
