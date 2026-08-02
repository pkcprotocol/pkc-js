// Crossposts (issue #32) — behavior under pseudonymityMode, and moderating a crossposting comment.
//
// Under pseudonymityMode the community clones the incoming comment and re-signs it with an alias
// signer. crosspost is one of the signed property names, so it is covered by the new alias
// signature, but the embedded record is carried through the clone untouched and keeps the ORIGINAL
// author's signature. That is what lets a crosspost survive anonymization: the outer author is an
// alias, the embedded author is not.
//
// The moderation half is the other half of the point of embedding: the crossposting community's
// mods act on the crossposting comment as if it were any other comment, without touching the
// referenced one.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    publishRandomReply
} from "../../../dist/node/test/test-util.js";
import { verifyCommentPubsubMessage } from "../../../dist/node/signer/signatures.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import signers from "../../fixtures/signers.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

// Both suites read the community's local DB / start their own LocalCommunity, so neither runs under RPC.
describeSkipIfRpc("crossposts under pseudonymityMode", () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity;
    let crosspost: { cid: string; comment: CommentIpfsType };
    let anonymized: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();

        // The record to embed is published to a plain community, so the embedded author is a real
        // author rather than an alias.
        const plainCommunity = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await plainCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: plainCommunity,
            predicate: async () => typeof plainCommunity.updatedAt === "number"
        });
        const original = await publishRandomPost({ communityAddress: plainCommunity.address, pkc: remotePKC });
        crosspost = { cid: original.cid!, comment: original.raw.comment! };
        await plainCommunity.delete();

        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.edit({ features: { ...community.features, pseudonymityMode: "per-post" } });

        anonymized = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { crosspost, author: { displayName: "Real Author" } }
        });
        await publishWithExpectedResult({ publication: anonymized, expectedChallengeSuccess: true });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it("a crosspost published to a pseudonymous community is accepted", () => {
        expect(anonymized.cid).to.be.a("string");
    });

    it("the outer comment was re-signed by the alias, not the original author", () => {
        const row = community._dbHandler.queryComment(anonymized.cid!);
        expect(row!.signature.publicKey).to.not.equal(anonymized.raw.pubsubMessageToPublish!.signature.publicKey);
        expect(row!.pseudonymityMode).to.equal("per-post");
        expect(row!.originalCommentSignatureEncoded).to.be.a("string");
    });

    it("the embedded record keeps the ORIGINAL author's signature", () => {
        const row = community._dbHandler.queryComment(anonymized.cid!);
        expect(row!.crosspost!.comment.signature).to.deep.equal(crosspost.comment.signature);
        expect(row!.crosspost!.comment).to.deep.equal(crosspost.comment);
    });

    it("the embedded record still reproduces its own cid after anonymization", async () => {
        const row = community._dbHandler.queryComment(anonymized.cid!);
        expect(await calculateIpfsHash(deterministicStringify(row!.crosspost!.comment)!)).to.equal(crosspost.cid);
    });

    it("the anonymized comment still passes tier-1 verification", async () => {
        const stored = await remotePKC.createComment({ cid: anonymized.cid! });
        await stored.update();
        await resolveWhenConditionIsTrue({ toUpdate: stored, predicate: async () => typeof stored.updatedAt === "number" });

        const keys = stored.raw.comment!.signature.signedPropertyNames as string[];
        const asPubsub = Object.fromEntries(Object.entries(stored.raw.comment!).filter(([k]) => k === "signature" || keys.includes(k)));
        expect(
            await verifyCommentPubsubMessage({
                comment: asPubsub as never,
                resolveAuthorNames: false,
                clientsManager: stored._clientsManager
            })
        ).to.deep.equal({ valid: true });
        await stored.stop();
    });

    it("crosspost is covered by the alias signature", () => {
        const row = community._dbHandler.queryComment(anonymized.cid!);
        expect(row!.signature.signedPropertyNames).to.include("crosspost");
    });
});

describeSkipIfRpc("moderating a crossposting comment", () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity;
    let crosspost: { cid: string; comment: CommentIpfsType };
    let crossposting: Comment;

    const modSigner = signers[7];

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.edit({ roles: { [modSigner.address]: { role: "moderator" } } });

        const original = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
        crosspost = { cid: original.cid!, comment: original.raw.comment! };

        crossposting = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({ publication: crossposting, expectedChallengeSuccess: true });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it("a mod can remove a crossposting comment", async () => {
        const moderation = await remotePKC.createCommentModeration({
            commentCid: crossposting.cid!,
            communityAddress: community.address,
            commentModeration: { removed: true, reason: "moderated as an ordinary comment" },
            signer: modSigner
        });
        await publishWithExpectedResult({ publication: moderation, expectedChallengeSuccess: true });

        const loaded = await remotePKC.createComment({ cid: crossposting.cid! });
        await loaded.update();
        await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => loaded.removed === true });
        expect(loaded.removed).to.be.true;
        await loaded.stop();
    });

    it("removing the crosspost leaves the embedded record and the referenced comment untouched", async () => {
        const row = community._dbHandler.queryComment(crossposting.cid!);
        expect(row!.crosspost!.comment).to.deep.equal(crosspost.comment);

        const referenced = await remotePKC.createComment({ cid: crosspost.cid });
        await referenced.update();
        await resolveWhenConditionIsTrue({ toUpdate: referenced, predicate: async () => typeof referenced.updatedAt === "number" });
        expect(referenced.removed).to.not.be.true;
        await referenced.stop();
    });

    it("a mod can lock and pin a crossposting comment", async () => {
        const moderation = await remotePKC.createCommentModeration({
            commentCid: crossposting.cid!,
            communityAddress: community.address,
            commentModeration: { locked: true, pinned: true },
            signer: modSigner
        });
        await publishWithExpectedResult({ publication: moderation, expectedChallengeSuccess: true });

        const loaded = await remotePKC.createComment({ cid: crossposting.cid! });
        await loaded.update();
        await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => loaded.locked === true });
        expect(loaded.pinned).to.be.true;
        await loaded.stop();
    });
});
