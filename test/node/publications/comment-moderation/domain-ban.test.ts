import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    mockPlebbitV2,
    mockCacheOfTextRecord,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";

// Tests for domain-based author bans
// When banning an author who uses a domain address (e.g., spammer.eth),
// we store both targetAuthorSignerAddress AND targetAuthorDomain
// so that bans can be enforced by either public key OR domain

describeSkipIfRpc("Domain-based author bans", () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit;
    let moderatorSigner: SignerType;

    beforeAll(async () => {
        plebbit = await mockPlebbitV2({ stubStorage: false, mockResolve: true });
        subplebbit = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit;
        await subplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => typeof subplebbit.updatedAt === "number"
        });

        moderatorSigner = await plebbit.createSigner();

        await subplebbit.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => subplebbit.roles?.[moderatorSigner.address]?.role === "moderator"
        });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
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
            await mockCacheOfTextRecord({
                plebbit,
                domain: testDomain,
                resolveType: "author",
                value: domainAuthorSigner.address
            });
        });

        it.sequential("should store targetAuthorDomain when banning an author who used a domain address", async () => {
            // Publish a comment with domain address
            commentWithDomain = await generateMockPost({
                subplebbitAddress: subplebbit.address,
                plebbit: plebbit,
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
            const banMod = await plebbit.createCommentModeration({
                subplebbitAddress: subplebbit.address,
                commentCid: commentWithDomain.cid,
                commentModeration: {
                    author: { banExpiresAt: authorBanExpiresAt },
                    reason: "Domain ban test " + Date.now()
                },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

            // Verify targetAuthorDomain is stored in the database
            const moderation = subplebbit._dbHandler._db
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
                subplebbitAddress: subplebbit.address,
                plebbit: plebbit,
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
            const newSigner = await plebbit.createSigner();

            // Mock the domain to now resolve to the new signer's address
            await mockCacheOfTextRecord({
                plebbit,
                domain: testDomain,
                resolveType: "author",
                value: newSigner.address
            });

            // Try to publish with the new signer but same domain - should fail due to domain ban
            const newComment = await generateMockPost({
                subplebbitAddress: subplebbit.address,
                plebbit: plebbit,
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
            regularAuthorSigner = await plebbit.createSigner();

            // Publish a comment with derived address (no domain)
            commentWithDerivedAddress = await generateMockPost({
                subplebbitAddress: subplebbit.address,
                plebbit: plebbit,
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
            const banMod = await plebbit.createCommentModeration({
                subplebbitAddress: subplebbit.address,
                commentCid: commentWithDerivedAddress.cid,
                commentModeration: {
                    author: { banExpiresAt: authorBanExpiresAt },
                    reason: "Non-domain ban test " + Date.now()
                },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

            // Verify targetAuthorDomain is NULL in the database
            const moderation = subplebbit._dbHandler._db
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
            await mockCacheOfTextRecord({
                plebbit,
                domain: newDomain,
                resolveType: "author",
                value: regularAuthorSigner.address
            });

            // Try to publish with domain - should fail because public key is banned
            const newComment = await generateMockPost({
                subplebbitAddress: subplebbit.address,
                plebbit: plebbit,
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
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit;
    let moderatorSigner: SignerType;
    const testDomain = "pseudonymuser.bso";
    let domainAuthorSigner: SignerType;

    beforeAll(async () => {
        plebbit = await mockPlebbitV2({ stubStorage: false, mockResolve: true });
        subplebbit = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit;

        // Enable per-post pseudonymity mode
        await subplebbit.edit({ features: { pseudonymityMode: "per-post" } });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => typeof subplebbit.updatedAt === "number"
        });

        moderatorSigner = await plebbit.createSigner();
        await subplebbit.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => subplebbit.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        // Use signers[6] for domain tests
        domainAuthorSigner = signers[6];

        // Mock the domain resolution
        await mockCacheOfTextRecord({
            plebbit,
            domain: testDomain,
            resolveType: "author",
            value: domainAuthorSigner.address
        });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it.sequential("should store originalAuthorDomain in pseudonymityAliases when author uses domain", async () => {
        // Publish a comment with domain address
        const commentWithDomain = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: {
                author: { address: testDomain },
                signer: domainAuthorSigner
            }
        });
        await publishWithExpectedResult({ publication: commentWithDomain, expectedChallengeSuccess: true });

        // Verify the pseudonymity alias stores the original author's domain
        const aliasRow = subplebbit._dbHandler.queryPseudonymityAliasByCommentCid(commentWithDomain.cid);
        expect(aliasRow).to.exist;
        expect(aliasRow!.originalAuthorSignerPublicKey).to.equal(domainAuthorSigner.publicKey);
        expect(aliasRow!.originalAuthorDomain).to.equal(testDomain);
    });

    it.sequential("banning via pseudonymous comment should store original author's domain", async () => {
        // Create another comment to ban
        const commentToBan = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: {
                author: { address: testDomain },
                signer: domainAuthorSigner
            }
        });
        await publishWithExpectedResult({ publication: commentToBan, expectedChallengeSuccess: true });

        // Verify comment was published with alias (pseudonymity mode)
        const aliasRow = subplebbit._dbHandler.queryPseudonymityAliasByCommentCid(commentToBan.cid);
        expect(aliasRow).to.exist;

        // Ban the author via the pseudonymous comment
        const authorBanExpiresAt = timestamp() + 300;
        const banMod = await plebbit.createCommentModeration({
            subplebbitAddress: subplebbit.address,
            commentCid: commentToBan.cid,
            commentModeration: {
                author: { banExpiresAt: authorBanExpiresAt },
                reason: "Pseudonymity domain ban test " + Date.now()
            },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: banMod, expectedChallengeSuccess: true });

        // Verify the moderation stores the original author's domain (not the alias)
        const moderation = subplebbit._dbHandler._db
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
            subplebbitAddress: subplebbit.address,
            plebbit: plebbit,
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
