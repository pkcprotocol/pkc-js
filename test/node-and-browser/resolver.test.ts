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
            textRecord: "plebbit-author-address",
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
        comment = await publishRandomPost(subplebbit.address, plebbit, {});
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
            textRecord: "plebbit-author-address",
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
                return expectedIpns;
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
                if (name === "testauthor.bso") return expectedAuthorAddress;
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
                    return expectedIpns; // second resolver returns value
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
                resolve: async () => expectedIpns,
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
            textRecord: "plebbit-author-address",
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
