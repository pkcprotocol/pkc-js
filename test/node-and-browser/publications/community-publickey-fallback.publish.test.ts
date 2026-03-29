import signers from "../../fixtures/signers.js";
import {
    createMockNameResolver,
    describeSkipIfRpc,
    mockPlebbitV2,
    mockRemotePlebbit,
    publishWithExpectedResult
} from "../../../dist/node/test/test-util.js";
import { afterAll, beforeAll, it, vi } from "vitest";

import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
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

async function createRestrictedPlebbit(): Promise<Plebbit> {
    return mockPlebbitV2({
        remotePlebbit: true,
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
}

function expectCreateSubplebbitFallbackArgs(plebbitSpy: SpyWithCalls) {
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

async function publishAndAssertCommunityFallback<T extends Publication>({
    createPublication
}: {
    createPublication: (plebbit: Plebbit) => Promise<T>;
}) {
    const plebbit = await createRestrictedPlebbit();
    let publication: T | undefined;

    try {
        publication = await createPublication(plebbit);
        const createSubplebbitSpy = vi.spyOn(plebbit, "createSubplebbit");

        try {
            await publishWithExpectedResult({ publication, expectedChallengeSuccess: true });
            expectCreateSubplebbitFallbackArgs(createSubplebbitSpy);
            expectWireCommunityFields(publication);
        } finally {
            createSubplebbitSpy.mockRestore();
        }
    } finally {
        if (publication) await publication.stop();
        await plebbit.destroy();
    }
}

describeSkipIfRpc.sequential("Publication publish community publicKey fallback", async () => {
    let fixturePlebbit: Plebbit;
    let fixturePost: Comment;
    let fixturePostSigner: SignerType;

    beforeAll(async () => {
        fixturePlebbit = await mockRemotePlebbit();
        fixturePostSigner = await fixturePlebbit.createSigner();
        fixturePost = await fixturePlebbit.createComment({
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
        await fixturePlebbit.destroy();
    });

    it("Comment publish passes name and publicKey to createSubplebbit and succeeds without a .bso resolver", async () => {
        await publishAndAssertCommunityFallback({
            createPublication: async (plebbit) =>
                plebbit.createComment({
                    communityAddress: communityName,
                    communityPublicKey,
                    signer: await plebbit.createSigner(),
                    title: `Comment fallback publish ${Date.now()}`,
                    content: `Comment fallback content ${Date.now()}`
                })
        });
    });

    it("Vote publish passes name and publicKey to createSubplebbit and succeeds without a .bso resolver", async () => {
        await publishAndAssertCommunityFallback({
            createPublication: async (plebbit) =>
                plebbit.createVote({
                    communityAddress: communityName,
                    communityPublicKey,
                    commentCid: fixturePost.cid!,
                    vote: 1,
                    signer: await plebbit.createSigner()
                })
        });
    });

    it("CommentEdit publish passes name and publicKey to createSubplebbit and succeeds without a .bso resolver", async () => {
        await publishAndAssertCommunityFallback({
            createPublication: async (plebbit) =>
                plebbit.createCommentEdit({
                    communityAddress: communityName,
                    communityPublicKey,
                    commentCid: fixturePost.cid!,
                    content: `Comment edit fallback ${Date.now()}`,
                    signer: fixturePost.signer!
                })
        });
    });

    it("CommentModeration publish passes name and publicKey to createSubplebbit and succeeds without a .bso resolver", async () => {
        await publishAndAssertCommunityFallback({
            createPublication: async (plebbit) =>
                plebbit.createCommentModeration({
                    communityAddress: communityName,
                    communityPublicKey,
                    commentCid: fixturePost.cid!,
                    commentModeration: {
                        spoiler: true,
                        reason: `Comment moderation fallback ${Date.now()}`
                    },
                    signer: await plebbit.createSigner(signers[3])
                })
        });
    });

    it("SubplebbitEdit publish passes name and publicKey to createSubplebbit and succeeds without a .bso resolver", async () => {
        await publishAndAssertCommunityFallback({
            createPublication: async (plebbit) =>
                plebbit.createSubplebbitEdit({
                    communityAddress: communityName,
                    communityPublicKey,
                    subplebbitEdit: {
                        description: `Subplebbit edit fallback ${Date.now()}`
                    },
                    signer: await plebbit.createSigner(signers[1])
                })
        });
    });
});
