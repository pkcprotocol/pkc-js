// Crossposts (issue #32) — persistence on the community side.
//
// crosspost is stored as a single JSON column on the comments table so the embedded record
// round-trips verbatim. Reads need no special handling: parseDbResponses parses JSON columns
// generically and deriveCommentIpfsFromCommentTableRow picks by keys(CommentIpfsSchema.shape).
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
    setExtraPropOnCommentAndSign
} from "../../../dist/node/test/test-util.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../dist/node/runtime/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType } from "../../../dist/node/publications/comment/types.js";

// Reads the community's local DB directly, so it cannot run under RPC.
describeSkipIfRpc("crosspost persistence", () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity;
    let original: Comment;
    let crosspost: { cid: string; comment: CommentIpfsType };
    let crossposting: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        original = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
        crosspost = { cid: original.cid!, comment: original.raw.comment! };

        crossposting = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({ publication: crossposting, expectedChallengeSuccess: true });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    describe("the crosspost column", () => {
        it("a comment without a crosspost stores NULL", () => {
            const row = community._dbHandler.queryComment(original.cid!);
            expect(row).to.exist;
            expect(row!.crosspost).to.be.undefined;
        });

        it("queryComment returns crosspost as an object, not a string", () => {
            const row = community._dbHandler.queryComment(crossposting.cid!);
            expect(row!.crosspost).to.be.an("object");
            expect(row!.crosspost!.cid).to.equal(crosspost.cid);
            expect(row!.crosspost!.comment).to.be.an("object");
        });

        it("the stored embedded record is deep-equal to what was published", () => {
            const row = community._dbHandler.queryComment(crossposting.cid!);
            expect(row!.crosspost!.comment).to.deep.equal(crosspost.comment);
        });
    });

    // The regression guard for the nested-strip footgun. storePublication runs
    // CommentIpfsSchema.strip().parse() before building the row; zod's strip behavior is per-schema,
    // so leaving crosspost.comment at the default would silently delete author-signed extra props
    // from the embedded record. The row is what deriveCommentIpfsFromCommentTableRow reconstructs
    // the CID from during page generation, so any loss there changes the CID.
    describe("CID stability through the db round trip", () => {
        it("deriveCommentIpfsFromCommentTableRow reproduces the original CID", async () => {
            const row = community._dbHandler.queryComment(crossposting.cid!);
            const derived = deriveCommentIpfsFromCommentTableRow(row!);
            expect(await calculateIpfsHash(deterministicStringify(derived)!)).to.equal(crossposting.cid);
        });

        it("the reconstructed CommentIpfs is byte-identical to the published one", () => {
            const row = community._dbHandler.queryComment(crossposting.cid!);
            const derived = deriveCommentIpfsFromCommentTableRow(row!);
            expect(deterministicStringify(derived)).to.equal(deterministicStringify(crossposting.raw.comment!));
        });

        it("the embedded record still reproduces its own CID from the stored copy", async () => {
            const row = community._dbHandler.queryComment(crossposting.cid!);
            expect(await calculateIpfsHash(deterministicStringify(row!.crosspost!.comment)!)).to.equal(crosspost.cid);
        });

        it("an embedded record carrying author-signed extra props survives the round trip", async () => {
            // The realistic shape of the footgun: the original author signed extra props into their
            // comment, so those props are part of the bytes the embedded cid commits to.
            const withExtras = await generateMockPost({ communityAddress: community.address, pkc: remotePKC });
            await setExtraPropOnCommentAndSign(withExtras, { extraPropOnOriginal: "must survive" }, true);
            await publishWithExpectedResult({ publication: withExtras, expectedChallengeSuccess: true });

            const embedded = { cid: withExtras.cid!, comment: withExtras.raw.comment! };
            expect((embedded.comment as Record<string, unknown>).extraPropOnOriginal).to.equal("must survive");

            const repost = await generateMockPost({
                communityAddress: community.address,
                pkc: remotePKC,
                postProps: { crosspost: embedded }
            });
            await publishWithExpectedResult({ publication: repost, expectedChallengeSuccess: true });

            const row = community._dbHandler.queryComment(repost.cid!);
            expect((row!.crosspost!.comment as Record<string, unknown>).extraPropOnOriginal).to.equal("must survive");
            expect(await calculateIpfsHash(deterministicStringify(row!.crosspost!.comment)!)).to.equal(embedded.cid);

            const derived = deriveCommentIpfsFromCommentTableRow(row!);
            expect(await calculateIpfsHash(deterministicStringify(derived)!)).to.equal(repost.cid);
        });

        it("a chained crosspost reproduces its CID from the stored row", async () => {
            const chained = { cid: crossposting.cid!, comment: crossposting.raw.comment! };
            const repost = await generateMockPost({
                communityAddress: community.address,
                pkc: remotePKC,
                postProps: { crosspost: chained }
            });
            await publishWithExpectedResult({ publication: repost, expectedChallengeSuccess: true });

            const row = community._dbHandler.queryComment(repost.cid!);
            expect(row!.crosspost!.comment.crosspost!.cid).to.equal(crosspost.cid);
            const derived = deriveCommentIpfsFromCommentTableRow(row!);
            expect(await calculateIpfsHash(deterministicStringify(derived)!)).to.equal(repost.cid);
        });

        it("the crossposting comment survives the post-migration signature sweep", async () => {
            // _purgeCommentsWithInvalidSchemaOrSignature re-derives each row and verifies it. A row
            // that lost bytes would fail verification here and be purged. It is private on DbHandler,
            // so reach it the same way the migration tests do.
            const priv = community._dbHandler as unknown as { _purgeCommentsWithInvalidSchemaOrSignature: () => Promise<void> };
            await priv._purgeCommentsWithInvalidSchemaOrSignature();
            expect(community._dbHandler.queryComment(crossposting.cid!)).to.exist;
        });
    });
});
