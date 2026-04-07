import {
    createSubWithNoChallenge,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPageCidToFindComment,
    loadAllPagesBySortName,
    mockPKC,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityPages
} from "../../../../dist/node/test/test-util.js";
import { POSTS_SORT_TYPES } from "../../../../dist/node/pages/util.js";
import { testPageCommentsIfSortedCorrectly } from "../../../node-and-browser/pages/pages-test-util.js";
import * as remeda from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";
import type { PageIpfs } from "../../../../dist/node/pages/types.js";

const remotePKCLoadingConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface LocalCommunityWithPageCidsContext {
    pkc: PKC;
    publisherCommunity: LocalCommunity;
    newPost: Comment;
    cleanup: () => Promise<void>;
}

describe("local community.posts pagination coverage", () => {
    let pkc: PKC;
    let publisherCommunity: LocalCommunity;
    let newPost: Comment;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        ({ pkc, publisherCommunity, newPost, cleanup } = await createLocalCommunityWithPageCids());
    });

    afterAll(async () => {
        await cleanup?.();
    });

    remotePKCLoadingConfigs.forEach((remotePKCConfig) => {
        describe(`local community.posts pagination coverage with pkc config ${remotePKCConfig.name}`, async () => {
            let remotePKC: PKC;
            let remoteCommunity: RemoteCommunity;
            beforeAll(async () => {
                remotePKC = await remotePKCConfig.pkcInstancePromise();
                remoteCommunity = await remotePKC.getCommunity({ address: publisherCommunity.address });
                await remoteCommunity.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: remoteCommunity,
                    predicate: async () =>
                        Object.keys(remoteCommunity.posts.pageCids || {}).length > 0 &&
                        Boolean(remoteCommunity.posts.pages.hot?.comments?.length)
                });
            });
            afterAll(async () => {
                await remotePKC.destroy();
            });
            it(`Newly published post appears on all pages`, async () => {
                expect(Object.keys(remoteCommunity.posts.pageCids || {})).to.not.be.empty;

                for (const preloadedPageSortName of Object.keys(remoteCommunity.posts.pages)) {
                    const allPostsUnderPreloadedSortName = await loadAllPagesBySortName(preloadedPageSortName, remoteCommunity.posts);
                    const postInPreloadedPage = (allPostsUnderPreloadedSortName as CommentWithinRepliesPostsPageJson[]).find(
                        (postInPage) => postInPage.cid === newPost.cid
                    );
                    expect(postInPreloadedPage).to.exist;
                }

                for (const pageCid of Object.values(remoteCommunity.posts.pageCids || {})) {
                    const postInPage = await iterateThroughPageCidToFindComment(newPost.cid!, pageCid, remoteCommunity.posts);
                    expect(postInPage).to.exist;
                }
            });

            it(`All pageCids exists except preloaded`, () => {
                expect(Object.keys(remoteCommunity.posts.pageCids || {})).to.not.be.empty;
                const preloadedSorts = Object.keys(remoteCommunity.posts.pages);

                const pageCidsWithoutPreloaded = Object.keys(remoteCommunity.posts.pageCids || {}).filter(
                    (pageCid) => !preloadedSorts.includes(pageCid)
                );
                expect(pageCidsWithoutPreloaded.length).to.be.greaterThan(0);
                expect(pageCidsWithoutPreloaded.sort()).to.deep.equal(Object.keys(remoteCommunity.posts.pageCids || {}).sort());

                const allSortsWithoutPreloaded = Object.keys(POSTS_SORT_TYPES).filter((sortName) => !preloadedSorts.includes(sortName));
                expect(allSortsWithoutPreloaded.length).to.be.greaterThan(0);
                expect(allSortsWithoutPreloaded.sort()).to.deep.equal(Object.keys(remoteCommunity.posts.pageCids || {}).sort());
            });

            Object.keys(POSTS_SORT_TYPES).map(async (sortName) =>
                it(`${sortName} pages are sorted correctly if there's more than a single page`, async () => {
                    const subPostsBySortName: Record<string, CommentWithinRepliesPostsPageJson[]> = {};

                    for (const sortName of Object.keys(POSTS_SORT_TYPES)) {
                        subPostsBySortName[sortName] = (await loadAllPagesBySortName(
                            sortName,
                            remoteCommunity.posts
                        )) as CommentWithinRepliesPostsPageJson[];
                    }
                    const posts = subPostsBySortName[sortName];

                    await testPageCommentsIfSortedCorrectly(posts, sortName, remoteCommunity);
                })
            );

            it(`posts are the same within all pages`, async () => {
                const subPostsBySortName: Record<string, CommentWithinRepliesPostsPageJson[]> = {};

                for (const sortName of Object.keys(POSTS_SORT_TYPES)) {
                    subPostsBySortName[sortName] = (await loadAllPagesBySortName(
                        sortName,
                        remoteCommunity.posts
                    )) as CommentWithinRepliesPostsPageJson[];
                }
                expect(Object.keys(subPostsBySortName)).to.not.be.empty;
                const pagesByTimeframe = remeda.groupBy(
                    Object.entries(POSTS_SORT_TYPES),
                    ([_, sort]) => (sort as { timeframe?: string }).timeframe ?? "none"
                );

                for (const pagesGrouped of Object.values(pagesByTimeframe)) {
                    const pages = pagesGrouped.map(([sortName, _]) => subPostsBySortName[sortName]);
                    if (pages.some((page) => !page)) continue;
                    if (pages.length === 1) continue; // there's only a single page under this timeframe, not needed to verify against other pages
                    expect(pages.length).to.be.greaterThanOrEqual(2);
                    expect(pages.map((page) => page.length).every((val, i, arr) => val === arr[0])).to.be.true; // All pages are expected to have the same length

                    for (const comment of pages[0]) {
                        const otherPageComments = pages.map((page) => page.find((c) => c.cid === comment.cid));
                        expect(otherPageComments.length).to.equal(pages.length);
                        for (const otherPageComment of otherPageComments) expect(comment).to.deep.equal(otherPageComment);
                    }
                }
            });

            it(`The PageIpfs.comments.comment always correspond to PageIpfs.comment.commentUpdate.cid`, async () => {
                const pageCids = Object.values(remoteCommunity.posts.pageCids || {});
                expect(pageCids.length).to.be.greaterThan(0);

                for (const pageCid of pageCids) {
                    const pageIpfs = JSON.parse(await pkc.fetchCid({ cid: pageCid })) as PageIpfs; // will have PageIpfs type

                    for (const commentInPageIpfs of pageIpfs.comments) {
                        const calculatedCid = await calculateIpfsHash(JSON.stringify(commentInPageIpfs.comment));
                        expect(calculatedCid).to.equal(commentInPageIpfs.commentUpdate.cid);
                    }
                }
            });
        });
    });
});

async function createLocalCommunityWithPageCids(): Promise<LocalCommunityWithPageCidsContext> {
    const publisherPKC = await mockPKC();
    const publisherCommunity = await createSubWithNoChallenge({}, publisherPKC);
    await publisherCommunity.start();

    await resolveWhenConditionIsTrue({
        toUpdate: publisherCommunity,
        predicate: async () => typeof publisherCommunity.updatedAt === "number"
    });
    const latestPost = await publishRandomPost({ communityAddress: publisherCommunity.address, pkc: publisherPKC });
    await waitTillPostInCommunityPages(latestPost as never, publisherPKC);

    await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
        community: publisherCommunity as LocalCommunity,
        forcedPreloadedPageSizeBytes: 1,
        communityPostsCommentProps: { content: `local pagination coverage` } as never
    });

    await resolveWhenConditionIsTrue({
        toUpdate: publisherCommunity,
        predicate: async () =>
            Object.keys(publisherCommunity.posts.pageCids || {}).length > 0 && Boolean(publisherCommunity.posts.pages.hot?.comments?.length)
    });

    const cleanup = async (): Promise<void> => {
        await publisherCommunity.delete();

        await publisherPKC.destroy();
    };

    return { pkc: publisherPKC, publisherCommunity: publisherCommunity as LocalCommunity, newPost: latestPost, cleanup };
}
