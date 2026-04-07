import signers from "../../../fixtures/signers.js";
import {
    createMockNameResolver,
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    mockPKCV2,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";

// Tests for domain-based author bans
// When banning an author who uses a domain address (e.g., spammer.eth),
// we store both targetAuthorSignerAddress AND targetAuthorDomain
// so that bans can be enforced by either public key OR domain

async function createPKCWithMockResolver(records: Map<string, string | undefined>) {
    return mockPKCV2({
        stubStorage: false,
        mockResolve: false,
        pkcOptions: {
            nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records })]
        }
    });
}

describeSkipIfRpc("Domain-based author bans", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerType;
    let resolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        resolverRecords = new Map();
        pkc = await createPKCWithMockResolver(resolverRecords);
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        moderatorSigner = await pkc.createSigner();

        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    describe("Banning an author who uses a domain address", () => {
        const testDomain = "testbanneduser.bso";
        let domainAuthorSigner: SignerType;
        let commentWithDomain: Comment;
        let authorBanExpiresAt: number;

        beforeAll(async () => {
            // Use signers[6] which is pre-configured for domain resolution tests
            domainAuthorSigner = signers[6];

            // Mock the domain resolution: testbanneduser.eth -> signers[6].address
            resolverRecords.set(testDomain, domainAuthorSigner.address);
        });

        it.sequential("should store targetAuthorDomain when banning an author who used a domain address", async () => {
            // Publish a comment with domain address
            commentWithDomain = await generateMockPost({
                communityAddress: community.address,
                pkc: pkc,
                postProps: {
                    author: { address: testDomain },
                    signer: domainAuthorSigner
                }
            });
            await publishWithExpectedResult({ publication: commentWithDomain, expectedChallengeSuccess: true });

            // Verify comment has domain address
            expect(commentWithDomain.author.address).to.equal(testDomain);

            // Ban the author
            authorBanExpiresAt = timestamp() + 300;
            const banMod = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: commentWithDomain.cid,
                commentModeration: {
                    author: { banExpiresAt: authorBanExpiresAt },
                    reason: "Domain ban test " + Date.now()
                },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

            // Verify targetAuthorDomain is stored in the database
            const moderation = community._dbHandler._db
                .prepare(
                    `SELECT targetAuthorSignerAddress, targetAuthorDomain FROM commentModerations
                     WHERE commentCid = ? AND json_extract(commentModeration, '$.author.banExpiresAt') IS NOT NULL`
                )
                .get(commentWithDomain.cid) as { targetAuthorSignerAddress: string; targetAuthorDomain: string } | undefined;

            expect(moderation).to.exist;
            expect(moderation!.targetAuthorSignerAddress).to.equal(domainAuthorSigner.address);
            expect(moderation!.targetAuthorDomain).to.equal(testDomain);
        });

        it.sequential("banned author can't publish with same signer", async () => {
            // Try to publish with the same signer - should fail due to public key ban
            const newComment = await generateMockPost({
                communityAddress: community.address,
                pkc: pkc,
                postProps: {
                    signer: domainAuthorSigner
                }
            });
            await publishWithExpectedResult({
                publication: newComment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_AUTHOR_IS_BANNED
            });
        });

        it.sequential("banned author can't publish with same domain but different signer", async () => {
            // Create a new signer
            const newSigner = await pkc.createSigner();

            // Mock the domain to now resolve to the new signer's address
            resolverRecords.set(testDomain, newSigner.address);

            // Try to publish with the new signer but same domain - should fail due to domain ban
            const newComment = await generateMockPost({
                communityAddress: community.address,
                pkc: pkc,
                postProps: {
                    author: { address: testDomain },
                    signer: newSigner
                }
            });
            await publishWithExpectedResult({
                publication: newComment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_AUTHOR_IS_BANNED
            });
        });
    });

    describe("Banning an author with derived address - domain shouldn't be stored", () => {
        let regularAuthorSigner: SignerType;
        let commentWithDerivedAddress: Comment;

        it.sequential("should not store targetAuthorDomain when author uses derived address", async () => {
            regularAuthorSigner = await pkc.createSigner();

            // Publish a comment with derived address (no domain)
            commentWithDerivedAddress = await generateMockPost({
                communityAddress: community.address,
                pkc: pkc,
                postProps: {
                    signer: regularAuthorSigner
                }
            });
            await publishWithExpectedResult({ publication: commentWithDerivedAddress, expectedChallengeSuccess: true });

            // Verify comment has derived address (not a domain)
            expect(commentWithDerivedAddress.author.address).to.equal(regularAuthorSigner.address);
            expect(commentWithDerivedAddress.author.address).to.not.include(".");

            // Ban the author
            const authorBanExpiresAt = timestamp() + 300;
            const banMod = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: commentWithDerivedAddress.cid,
                commentModeration: {
                    author: { banExpiresAt: authorBanExpiresAt },
                    reason: "Non-domain ban test " + Date.now()
                },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

            // Verify targetAuthorDomain is NULL in the database
            const moderation = community._dbHandler._db
                .prepare(
                    `SELECT targetAuthorSignerAddress, targetAuthorDomain FROM commentModerations
                     WHERE commentCid = ? AND json_extract(commentModeration, '$.author.banExpiresAt') IS NOT NULL`
                )
                .get(commentWithDerivedAddress.cid) as { targetAuthorSignerAddress: string; targetAuthorDomain: string | null } | undefined;

            expect(moderation).to.exist;
            expect(moderation!.targetAuthorSignerAddress).to.equal(regularAuthorSigner.address);
            expect(moderation!.targetAuthorDomain).to.be.null;
        });

        it.sequential("author banned by public key can still be blocked if they later acquire a domain", async () => {
            // The author was banned by public key (no domain stored)
            // Now they get a domain pointing to their public key
            const newDomain = "newlybanned.bso";
            resolverRecords.set(newDomain, regularAuthorSigner.address);

            // Try to publish with domain - should fail because public key is banned
            const newComment = await generateMockPost({
                communityAddress: community.address,
                pkc: pkc,
                postProps: {
                    author: { address: newDomain },
                    signer: regularAuthorSigner
                }
            });
            await publishWithExpectedResult({
                publication: newComment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_AUTHOR_IS_BANNED
            });
        });
    });
});

describeSkipIfRpc("Domain bans with pseudonymity mode", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerType;
    const testDomain = "pseudonymuser.bso";
    let domainAuthorSigner: SignerType;
    let resolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        resolverRecords = new Map();
        pkc = await createPKCWithMockResolver(resolverRecords);
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;

        // Enable per-post pseudonymity mode
        await community.edit({ features: { pseudonymityMode: "per-post" } });
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        moderatorSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        // Use signers[6] for domain tests
        domainAuthorSigner = signers[6];

        // Mock the domain resolution
        resolverRecords.set(testDomain, domainAuthorSigner.address);
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it.sequential("should store originalAuthorDomain in pseudonymityAliases when author uses domain", async () => {
        // Publish a comment with domain address
        const commentWithDomain = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                author: { address: testDomain },
                signer: domainAuthorSigner
            }
        });
        await publishWithExpectedResult({ publication: commentWithDomain, expectedChallengeSuccess: true });

        // Verify the pseudonymity alias stores the original author's domain
        const aliasRow = community._dbHandler.queryPseudonymityAliasByCommentCid(commentWithDomain.cid);
        expect(aliasRow).to.exist;
        expect(aliasRow!.originalAuthorSignerPublicKey).to.equal(domainAuthorSigner.publicKey);
        expect(aliasRow!.originalAuthorDomain).to.equal(testDomain);
    });

    it.sequential("banning via pseudonymous comment should store original author's domain", async () => {
        // Create another comment to ban
        const commentToBan = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                author: { address: testDomain },
                signer: domainAuthorSigner
            }
        });
        await publishWithExpectedResult({ publication: commentToBan, expectedChallengeSuccess: true });

        // Verify comment was published with alias (pseudonymity mode)
        const aliasRow = community._dbHandler.queryPseudonymityAliasByCommentCid(commentToBan.cid);
        expect(aliasRow).to.exist;

        // Ban the author via the pseudonymous comment
        const authorBanExpiresAt = timestamp() + 300;
        const banMod = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: commentToBan.cid,
            commentModeration: {
                author: { banExpiresAt: authorBanExpiresAt },
                reason: "Pseudonymity domain ban test " + Date.now()
            },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

        // Verify the moderation stores the original author's domain (not the alias)
        const moderation = community._dbHandler._db
            .prepare(
                `SELECT targetAuthorSignerAddress, targetAuthorDomain FROM commentModerations
                 WHERE commentCid = ? AND json_extract(commentModeration, '$.author.banExpiresAt') IS NOT NULL`
            )
            .get(commentToBan.cid) as { targetAuthorSignerAddress: string; targetAuthorDomain: string } | undefined;

        expect(moderation).to.exist;
        expect(moderation!.targetAuthorSignerAddress).to.equal(domainAuthorSigner.address);
        expect(moderation!.targetAuthorDomain).to.equal(testDomain);

        // Verify ban works with original signer
        const newComment = await generateMockPost({
            communityAddress: community.address,
            pkc: pkc,
            postProps: {
                signer: domainAuthorSigner
            }
        });
        await publishWithExpectedResult({
            publication: newComment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_IS_BANNED
        });
    });
});

describe("Domain-based flairs", () => {
    it.todo("should store targetAuthorDomain when setting flairs for an author who used a domain address");

    it.todo("should apply flairs to an author by their domain even if they change their public key");
});
