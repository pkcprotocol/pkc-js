import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    getAvailablePKCConfigsToTestAgainst,
    publishWithExpectedResult
} from "../../../dist/node/test/test-util.js";
import { afterAll, beforeAll, it, vi } from "vitest";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

const communityName = "plebbit.bso";
const communityPublicKey = signers[3].address;

type SpyWithCalls = {
    mock: {
        calls: unknown[][];
    };
};

type WirePublication = Record<string, unknown> & {
    communityName?: string;
    communityPublicKey?: string;
    subplebbitAddress?: string;
};

function expectCreateCommunityFallbackArgs(plebbitSpy: SpyWithCalls) {
    expect(plebbitSpy.mock.calls.length).to.be.greaterThan(0);

    for (const call of plebbitSpy.mock.calls) {
        expect(call[0]).to.include({
            name: communityName,
            publicKey: communityPublicKey
        });

        if (typeof call[0] === "object" && call[0] !== null && "address" in call[0] && call[0].address !== undefined) {
            expect(call[0].address).to.equal(communityName);
        }
    }
}

function expectWireCommunityFields(publication: Publication) {
    expect(publication.raw.pubsubMessageToPublish).to.exist;
    const wirePublication = publication.raw.pubsubMessageToPublish as WirePublication;
    expect(wirePublication.communityName).to.equal(communityName);
    expect(wirePublication.communityPublicKey).to.equal(communityPublicKey);
    expect(wirePublication).to.not.have.property("subplebbitAddress");
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential(`Publication publish community publicKey fallback - ${config.name}`, async () => {
        let fixturePKC: PKC;
        let fixturePost: Comment;
        let fixturePostSigner: SignerType;

        beforeAll(async () => {
            fixturePKC = await config.plebbitInstancePromise();
            fixturePostSigner = await fixturePKC.createSigner();
            fixturePost = await fixturePKC.createComment({
                communityAddress: communityName,
                communityPublicKey,
                signer: fixturePostSigner,
                title: `Community fallback fixture post ${Date.now()}`,
                content: `Community fallback fixture content ${Date.now()}`
            });
            await publishWithExpectedResult({ publication: fixturePost, expectedChallengeSuccess: true });

            if (!fixturePost.cid) throw Error("Expected fixture post to have a CID after publishing");
            if (!fixturePost.signer) throw Error("Expected fixture post to retain its signer after publishing");
        });

        afterAll(async () => {
            await fixturePost.stop();
            await fixturePKC.destroy();
        });

        it("Comment publish succeeds with community publicKey fallback", async () => {
            // Create plebbit with resolver that only handles .eth (not .bso)
            // For RPC, resolver options are stripped but the server still resolves .bso normally
            const plebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            includeDefaultRecords: true,
                            canResolve: ({ name }: { name: string }) => /\.eth$/i.test(name)
                        })
                    ]
                }
            });
            const publication = await plebbit.createComment({
                communityAddress: communityName,
                communityPublicKey,
                signer: await plebbit.createSigner(),
                title: `Comment fallback publish ${Date.now()}`,
                content: `Comment fallback content ${Date.now()}`
            });
            const createCommunitySpy = vi.spyOn(plebbit, "createCommunity");

            try {
                await publishWithExpectedResult({ publication, expectedChallengeSuccess: true });
                // Spy and wire format assertions only work for non-RPC
                // (RPC delegates createCommunity to server, and raw.pubsubMessageToPublish may not be populated)
                if (config.testConfigCode !== "remote-plebbit-rpc") {
                    expectCreateCommunityFallbackArgs(createCommunitySpy);
                    expectWireCommunityFields(publication);
                }
            } finally {
                createCommunitySpy.mockRestore();
                await publication.stop();
                await plebbit.destroy();
            }
        });

        it("Vote publish succeeds with community publicKey fallback", async () => {
            const plebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            includeDefaultRecords: true,
                            canResolve: ({ name }: { name: string }) => /\.eth$/i.test(name)
                        })
                    ]
                }
            });
            const publication = await plebbit.createVote({
                communityAddress: communityName,
                communityPublicKey,
                commentCid: fixturePost.cid!,
                vote: 1,
                signer: await plebbit.createSigner()
            });
            const createCommunitySpy = vi.spyOn(plebbit, "createCommunity");

            try {
                await publishWithExpectedResult({ publication, expectedChallengeSuccess: true });
                if (config.testConfigCode !== "remote-plebbit-rpc") {
                    expectCreateCommunityFallbackArgs(createCommunitySpy);
                    expectWireCommunityFields(publication);
                }
            } finally {
                createCommunitySpy.mockRestore();
                await publication.stop();
                await plebbit.destroy();
            }
        });

        it("CommentEdit publish succeeds with community publicKey fallback", async () => {
            const plebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            includeDefaultRecords: true,
                            canResolve: ({ name }: { name: string }) => /\.eth$/i.test(name)
                        })
                    ]
                }
            });
            const publication = await plebbit.createCommentEdit({
                communityAddress: communityName,
                communityPublicKey,
                commentCid: fixturePost.cid!,
                content: `Comment edit fallback ${Date.now()}`,
                signer: fixturePost.signer!
            });
            const createCommunitySpy = vi.spyOn(plebbit, "createCommunity");

            try {
                await publishWithExpectedResult({ publication, expectedChallengeSuccess: true });
                if (config.testConfigCode !== "remote-plebbit-rpc") {
                    expectCreateCommunityFallbackArgs(createCommunitySpy);
                    expectWireCommunityFields(publication);
                }
            } finally {
                createCommunitySpy.mockRestore();
                await publication.stop();
                await plebbit.destroy();
            }
        });

        it("CommentModeration publish succeeds with community publicKey fallback", async () => {
            const plebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            includeDefaultRecords: true,
                            canResolve: ({ name }: { name: string }) => /\.eth$/i.test(name)
                        })
                    ]
                }
            });
            const publication = await plebbit.createCommentModeration({
                communityAddress: communityName,
                communityPublicKey,
                commentCid: fixturePost.cid!,
                commentModeration: {
                    spoiler: true,
                    reason: `Comment moderation fallback ${Date.now()}`
                },
                signer: await plebbit.createSigner(signers[3])
            });
            const createCommunitySpy = vi.spyOn(plebbit, "createCommunity");

            try {
                await publishWithExpectedResult({ publication, expectedChallengeSuccess: true });
                if (config.testConfigCode !== "remote-plebbit-rpc") {
                    expectCreateCommunityFallbackArgs(createCommunitySpy);
                    expectWireCommunityFields(publication);
                }
            } finally {
                createCommunitySpy.mockRestore();
                await publication.stop();
                await plebbit.destroy();
            }
        });

        it("CommunityEdit publish succeeds with community publicKey fallback", async () => {
            const plebbit = await config.plebbitInstancePromise({
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            includeDefaultRecords: true,
                            canResolve: ({ name }: { name: string }) => /\.eth$/i.test(name)
                        })
                    ]
                }
            });
            const publication = await plebbit.createCommunityEdit({
                communityAddress: communityName,
                communityPublicKey,
                subplebbitEdit: {
                    description: `Community edit fallback ${Date.now()}`
                },
                signer: await plebbit.createSigner(signers[1])
            });
            const createCommunitySpy = vi.spyOn(plebbit, "createCommunity");

            try {
                await publishWithExpectedResult({ publication, expectedChallengeSuccess: true });
                if (config.testConfigCode !== "remote-plebbit-rpc") {
                    expectCreateCommunityFallbackArgs(createCommunitySpy);
                    expectWireCommunityFields(publication);
                }
            } finally {
                createCommunitySpy.mockRestore();
                await publication.stop();
                await plebbit.destroy();
            }
        });
    });
});
