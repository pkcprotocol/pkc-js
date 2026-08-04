// Crossposts (issue #32) — a crossposting comment travelling through pages.
//
// Pages are a separate verification entry point from createComment({cid}) + update():
// verifyPageComment -> verifyCommentIpfs -> verifyCommentPubsubMessage -> _verifyCrosspost. It is
// also the path where a normalization bug in page generation would surface, which is exactly what
// the .loose() on CrosspostSchema exists to prevent: crosspost.cid hashes the embedded record whole,
// so a single stripped prop anywhere inside it stops the record reproducing its own cid and gets the
// comment rejected client-side.
//
// The reading PKC sets validatePages: true. mockPKC defaults it to false, so without this the pages
// come back unverified and the crosspost checks above never run on this path — the tests would still
// pass while covering only transport. The cid re-derivations below are the independent check: they
// prove the bytes came through untouched whether or not verification is on.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    findCommentInCommunityInstancePagesPreloadedAndPageCids,
    findReplyInParentCommentPagesInstancePreloadedAndPageCids,
    waitTillPostInCommunityInstancePages,
    waitTillReplyInParentPagesInstance
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { PageTypeJson } from "../../../dist/node/pages/types.js";

describe("crossposts through pages", () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity;
    let original: Comment; // the comment being reposted
    let crosspost: { cid: string; comment: CommentIpfsType };
    let crosspostingPost: Comment;
    let crosspostingReply: Comment;

    // Re-derives the embedded record's cid from the bytes that came back inside a page. If page
    // generation normalized anything, this stops matching.
    const embeddedCidOf = async (comment: CommentIpfsType) => calculateIpfsHash(deterministicStringify(comment.crosspost!.comment)!);

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { validatePages: true } });
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        original = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
        crosspost = { cid: original.cid!, comment: original.raw.comment! };

        crosspostingPost = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({ publication: crosspostingPost, expectedChallengeSuccess: true });

        crosspostingReply = await generateMockComment(original as CommentIpfsWithCidDefined, remotePKC, false, { crosspost });
        await publishWithExpectedResult({ publication: crosspostingReply, expectedChallengeSuccess: true });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    // Without this the rest of the file silently degrades to a transport test, so fail loudly rather
    // than quietly losing the verification coverage these exist for.
    it("the reading PKC has page validation enabled", () => {
        expect(remotePKC.validatePages).to.be.true;
    });

    describe("community.posts", () => {
        let remoteCommunity: RemoteCommunity;

        beforeAll(async () => {
            remoteCommunity = await remotePKC.createCommunity({ address: community.address });
            await remoteCommunity.update();
            await waitTillPostInCommunityInstancePages(
                crosspostingPost as Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
                remoteCommunity
            );
        });

        afterAll(async () => {
            await remoteCommunity.stop();
        });

        it("a crossposting post appears in the community's posts pages with its crosspost intact", async () => {
            const inPage = await findCommentInCommunityInstancePagesPreloadedAndPageCids({
                comment: crosspostingPost as Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
                community: remoteCommunity
            });
            expect(inPage).to.exist;
            expect(inPage!.crosspost?.cid).to.equal(crosspost.cid);
            expect(inPage!.crosspost?.comment).to.deep.equal(crosspost.comment);
        });

        it("the page-borne embedded record still reproduces crosspost.cid", async () => {
            const inPage = await findCommentInCommunityInstancePagesPreloadedAndPageCids({
                comment: crosspostingPost as Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
                community: remoteCommunity
            });
            expect(await embeddedCidOf(inPage!.raw.comment)).to.equal(crosspost.cid);
        });

        it("a non-crossposting post in the same page is unaffected", async () => {
            const inPage = await findCommentInCommunityInstancePagesPreloadedAndPageCids({
                comment: original as Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
                community: remoteCommunity
            });
            expect(inPage).to.exist;
            expect(inPage!.crosspost).to.be.undefined;
        });
    });

    describe("comment.replies", () => {
        let remoteOriginal: Comment;

        beforeAll(async () => {
            remoteOriginal = await remotePKC.createComment({ cid: original.cid! });
            await remoteOriginal.update();
            await waitTillReplyInParentPagesInstance(
                crosspostingReply as Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
                remoteOriginal
            );
        });

        afterAll(async () => {
            await remoteOriginal.stop();
        });

        it("a crossposting reply appears in its parent's replies pages with its crosspost intact", async () => {
            const inPage = await findReplyInParentCommentPagesInstancePreloadedAndPageCids({
                reply: crosspostingReply as Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
                parentComment: remoteOriginal
            });
            expect(inPage).to.exist;
            expect(inPage!.crosspost?.cid).to.equal(crosspost.cid);
            expect(await embeddedCidOf(inPage!.raw.comment)).to.equal(crosspost.cid);
        });
    });

    // The tests above are served from the preloaded page inlined in the CommentUpdate. This one
    // forces the replies to chunk so the crossposting reply is only reachable by fetching a pageCid
    // over IPFS, which is a different code path (getPage -> verifyPage) than the preloaded one.
    describe("a page fetched by pageCid rather than preloaded", () => {
        let chunkingCleanup: () => void;
        let parentPost: Comment;
        let remoteParent: Comment;
        let chunkedReply: Comment;

        beforeAll(async () => {
            parentPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
            ({ cleanup: chunkingCleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                community,
                parentComment: parentPost
            }));

            chunkedReply = await generateMockComment(parentPost as CommentIpfsWithCidDefined, remotePKC, false, { crosspost });
            await publishWithExpectedResult({ publication: chunkedReply, expectedChallengeSuccess: true });
            // A second reply so the sort actually has something to chunk across.
            const filler = await generateMockComment(parentPost as CommentIpfsWithCidDefined, remotePKC, false);
            await publishWithExpectedResult({ publication: filler, expectedChallengeSuccess: true });

            remoteParent = await remotePKC.createComment({ cid: parentPost.cid! });
            await remoteParent.update();
            await resolveWhenConditionIsTrue({
                toUpdate: remoteParent,
                predicate: async () => Object.keys(remoteParent.replies.pageCids).length > 0
            });
            await waitTillReplyInParentPagesInstance(
                chunkedReply as Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
                remoteParent
            );
        });

        afterAll(async () => {
            await remoteParent.stop();
            chunkingCleanup();
        });

        it("the reply is reachable only through a pageCid, not the preloaded page", () => {
            expect(Object.keys(remoteParent.replies.pageCids).length).to.be.greaterThan(0);
        });

        it("the crosspost survives a page fetched over IPFS by cid", async () => {
            const inPage = await findReplyInParentCommentPagesInstancePreloadedAndPageCids({
                reply: chunkedReply as Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
                parentComment: remoteParent
            });
            expect(inPage).to.exist;
            expect(inPage!.crosspost?.cid).to.equal(crosspost.cid);
            expect(inPage!.crosspost?.comment).to.deep.equal(crosspost.comment);
            expect(await embeddedCidOf(inPage!.raw.comment)).to.equal(crosspost.cid);
        });
    });

    // Everything above proves a good crosspost survives the page path. That is only half of it: the
    // reason verifyPageComment runs verifyCommentIpfs at all is to reject a bad one, and a page is
    // the load path a feed client actually uses. crosspost/client-consumption.test.ts covers the
    // rejection through getComment, update() and validateComment, none of which touch pages.
    //
    // Tampering after the fact rather than publishing a bad crosspost: the community enforces tier 1
    // at acceptance, so it will never mint a page containing one. validatePage is the manual entry
    // point for exactly this, and it requires validatePages: false, hence its own PKC.
    describe("a page carrying a bad crosspost is rejected", () => {
        let manualPKC: PKC;
        let manualCommunity: RemoteCommunity;
        let validPostsPage: PageTypeJson;
        let manualOriginal: Comment;
        let validRepliesPage: PageTypeJson;

        // A CommentIpfs whose author validly signed over the crosspost it carries, so the outer
        // signature is genuine and whatever fails is one of the three crosspost checks. Tampering
        // with an already-published comment's crosspost instead would break its own signature first
        // and the test would pass for the wrong reason.
        const recordCrossposting = async (badCrosspost: unknown): Promise<CommentIpfsType> => {
            const signed = await generateMockPost({
                communityAddress: community.address,
                pkc: remotePKC,
                postProps: { crosspost: badCrosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
            });
            // depth: what the community adds on acceptance, making this CommentIpfs-shaped
            return { ...signed.raw.pubsubMessageToPublish!, depth: 0 } as unknown as CommentIpfsType;
        };

        const mismatchedCid = () => {
            const bad = JSON.parse(JSON.stringify(crosspost));
            bad.comment.content = "the crossposter rewrote this and left cid alone";
            return bad;
        };

        const brokenEmbeddedSignature = async () => {
            const bad = JSON.parse(JSON.stringify(crosspost));
            bad.comment.content = "tampered, and cid updated to match so check 1 passes";
            bad.cid = await calculateIpfsHash(deterministicStringify(bad.comment)!);
            return bad;
        };

        const reservedFieldOnEmbedded = async () => {
            const bad = JSON.parse(JSON.stringify(crosspost));
            bad.comment.cid = crosspost.cid; // cid is runtime-only on a CommentIpfs
            bad.cid = await calculateIpfsHash(deterministicStringify(bad.comment)!);
            return bad;
        };

        // Swaps the crossposting comment's record inside a copy of a real page.
        const pageWithRecordSwappedIn = (page: PageTypeJson, targetCid: string, record: CommentIpfsType): PageTypeJson => {
            const copy = JSON.parse(JSON.stringify(page)) as PageTypeJson;
            const target = copy.comments.find((c) => c.cid === targetCid);
            if (!target) throw Error("the crossposting comment is not in this page, the test setup is wrong");
            target.raw.comment = record;
            return copy;
        };

        const expectRejected = async (
            validate: () => Promise<void>,
            expectedCode: "ERR_POSTS_PAGE_IS_INVALID" | "ERR_REPLIES_PAGE_IS_INVALID",
            expectedReason: string
        ) => {
            // Captured rather than asserted inside a catch, so "it validated fine" reports as itself
            // instead of as an assertion error swallowed by the catch block.
            let error: PKCError | undefined;
            try {
                await validate();
            } catch (e) {
                error = e as PKCError;
            }
            expect(error, "a page carrying a bad crosspost must not validate").to.exist;
            expect(error!.code).to.equal(expectedCode);
            expect(error!.details.signatureValidity.reason).to.equal(expectedReason);
        };

        beforeAll(async () => {
            manualPKC = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { validatePages: false } });

            manualCommunity = await manualPKC.createCommunity({ address: community.address });
            await manualCommunity.update();
            await waitTillPostInCommunityInstancePages(
                crosspostingPost as Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
                manualCommunity
            );
            validPostsPage = manualCommunity.posts.pages.hot!;

            manualOriginal = await manualPKC.createComment({ cid: original.cid! });
            await manualOriginal.update();
            await waitTillReplyInParentPagesInstance(
                crosspostingReply as Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
                manualOriginal
            );
            validRepliesPage = manualOriginal.replies.pages.best!;
        });

        afterAll(async () => {
            await manualOriginal.stop();
            await manualCommunity.stop();
            await manualPKC.destroy();
        });

        // Without this the rejection tests below could be passing on the tampering rather than on the
        // crosspost, so pin that the untouched page is accepted.
        it("the untampered posts page validates", async () => {
            await manualCommunity.posts.validatePage(validPostsPage);
        });

        it("rejects a posts page whose comment has a mismatched crosspost.cid", async () => {
            const record = await recordCrossposting(mismatchedCid());
            await expectRejected(
                () => manualCommunity.posts.validatePage(pageWithRecordSwappedIn(validPostsPage, crosspostingPost.cid!, record)),
                "ERR_POSTS_PAGE_IS_INVALID",
                messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
            );
        });

        it("rejects a posts page whose embedded record has a broken author signature", async () => {
            const record = await recordCrossposting(await brokenEmbeddedSignature());
            await expectRejected(
                () => manualCommunity.posts.validatePage(pageWithRecordSwappedIn(validPostsPage, crosspostingPost.cid!, record)),
                "ERR_POSTS_PAGE_IS_INVALID",
                messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
            );
        });

        it("rejects a posts page whose embedded record carries a reserved field", async () => {
            const record = await recordCrossposting(await reservedFieldOnEmbedded());
            await expectRejected(
                () => manualCommunity.posts.validatePage(pageWithRecordSwappedIn(validPostsPage, crosspostingPost.cid!, record)),
                "ERR_POSTS_PAGE_IS_INVALID",
                messages.ERR_CROSSPOST_COMMENT_INCLUDES_RESERVED_FIELD
            );
        });

        // Replies pages are verified through a different entry point than posts pages, with a parent
        // comment in hand, so the delegation to verifyCommentIpfs is worth pinning separately.
        it("the untampered replies page validates", async () => {
            await manualOriginal.replies.validatePage(validRepliesPage);
        });

        it("rejects a replies page whose comment has a mismatched crosspost.cid", async () => {
            const asReply = await generateMockComment(original as CommentIpfsWithCidDefined, remotePKC, false, {
                crosspost: mismatchedCid()
            });
            const record = { ...asReply.raw.pubsubMessageToPublish!, depth: 1 } as unknown as CommentIpfsType;
            await expectRejected(
                () => manualOriginal.replies.validatePage(pageWithRecordSwappedIn(validRepliesPage, crosspostingReply.cid!, record)),
                "ERR_REPLIES_PAGE_IS_INVALID",
                messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
            );
        });
    });
});
