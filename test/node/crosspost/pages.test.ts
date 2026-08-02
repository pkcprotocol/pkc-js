// Crossposts (issue #32) — a crossposting comment travelling through pages.
//
// Pages are a separate verification entry point from createComment({cid}) + update():
// verifyPageComment -> verifyCommentIpfs -> verifyCommentPubsubMessage -> _verifyCrosspost. It is
// also the path where a normalization bug in page generation would surface, which is exactly what
// the .loose() on CrosspostSchema exists to prevent: crosspost.cid hashes the embedded record whole,
// so a single stripped prop anywhere inside it stops the record reproducing its own cid and gets the
// comment rejected client-side. Loading these pages at all only proves verification passed; the cid
// assertions below are what prove the bytes came through untouched.
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
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

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
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
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
});
