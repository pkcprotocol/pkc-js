import {
    createSubWithNoChallenge,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    getAvailablePlebbitConfigsToTestAgainst,
    iterateThroughPageCidToFindComment,
    loadAllPagesBySortName,
    mockPlebbit,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    waitTillPostInSubplebbitPages
} from "../../../../dist/node/test/test-util.js";
import { POSTS_SORT_TYPES } from "../../../../dist/node/pages/util.js";
import { testPageCommentsIfSortedCorrectly } from "../../../node-and-browser/pages/pages-test-util.js";
import * as remeda from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { RemoteSubplebbit } from "../../../../dist/node/community/remote-community.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";
import type { PageIpfs } from "../../../../dist/node/pages/types.js";

const remotePlebbitLoadingConfigs = getAvailablePlebbitConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface LocalSubplebbitWithPageCidsContext {
    plebbit: Plebbit;
    publisherSubplebbit: LocalSubplebbit;
    newPost: Comment;
    cleanup: () => Promise<void>;
}

describe("local subplebbit.posts pagination coverage", () => {
    let plebbit: Plebbit;
    let publisherSubplebbit: LocalSubplebbit;
    let newPost: Comment;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        ({ plebbit, publisherSubplebbit, newPost, cleanup } = await createLocalSubplebbitWithPageCids());
    });

    afterAll(async () => {
        await cleanup?.();
    });

    remotePlebbitLoadingConfigs.forEach((remotePlebbitConfig) => {
        describe(`local subplebbit.posts pagination coverage with plebbit config ${remotePlebbitConfig.name}`, async () => {
            let remotePlebbit: Plebbit;
            let remoteSubplebbit: RemoteSubplebbit;
            beforeAll(async () => {
                remotePlebbit = await remotePlebbitConfig.plebbitInstancePromise();
                remoteSubplebbit = await remotePlebbit.getSubplebbit({ address: publisherSubplebbit.address });
                await remoteSubplebbit.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: remoteSubplebbit,
                    predicate: async () =>
                        Object.keys(remoteSubplebbit.posts.pageCids || {}).length > 0 &&
                        Boolean(remoteSubplebbit.posts.pages.hot?.comments?.length)
                });
            });
            afterAll(async () => {
                await remotePlebbit.destroy();
            });
            it(`Newly published post appears on all pages`, async () => {
                expect(Object.keys(remoteSubplebbit.posts.pageCids || {})).to.not.be.empty;

                for (const preloadedPageSortName of Object.keys(remoteSubplebbit.posts.pages)) {
                    const allPostsUnderPreloadedSortName = await loadAllPagesBySortName(preloadedPageSortName, remoteSubplebbit.posts);
                    const postInPreloadedPage = (allPostsUnderPreloadedSortName as CommentWithinRepliesPostsPageJson[]).find(
                        (postInPage) => postInPage.cid === newPost.cid
                    );
                    expect(postInPreloadedPage).to.exist;
                }

                for (const pageCid of Object.values(remoteSubplebbit.posts.pageCids || {})) {
                    const postInPage = await iterateThroughPageCidToFindComment(newPost.cid!, pageCid, remoteSubplebbit.posts);
                    expect(postInPage).to.exist;
                }
            });

            it(`All pageCids exists except preloaded`, () => {
                expect(Object.keys(remoteSubplebbit.posts.pageCids || {})).to.not.be.empty;
                const preloadedSorts = Object.keys(remoteSubplebbit.posts.pages);

                const pageCidsWithoutPreloaded = Object.keys(remoteSubplebbit.posts.pageCids || {}).filter(
                    (pageCid) => !preloadedSorts.includes(pageCid)
                );
                expect(pageCidsWithoutPreloaded.length).to.be.greaterThan(0);
                expect(pageCidsWithoutPreloaded.sort()).to.deep.equal(Object.keys(remoteSubplebbit.posts.pageCids || {}).sort());

                const allSortsWithoutPreloaded = Object.keys(POSTS_SORT_TYPES).filter((sortName) => !preloadedSorts.includes(sortName));
                expect(allSortsWithoutPreloaded.length).to.be.greaterThan(0);
                expect(allSortsWithoutPreloaded.sort()).to.deep.equal(Object.keys(remoteSubplebbit.posts.pageCids || {}).sort());
            });

            Object.keys(POSTS_SORT_TYPES).map(async (sortName) =>
                it(`${sortName} pages are sorted correctly if there's more than a single page`, async () => {
                    const subPostsBySortName: Record<string, CommentWithinRepliesPostsPageJson[]> = {};

                    for (const sortName of Object.keys(POSTS_SORT_TYPES)) {
                        subPostsBySortName[sortName] = (await loadAllPagesBySortName(
                            sortName,
                            remoteSubplebbit.posts
                        )) as CommentWithinRepliesPostsPageJson[];
                    }
                    const posts = subPostsBySortName[sortName];

                    await testPageCommentsIfSortedCorrectly(posts, sortName, remoteSubplebbit);
                })
            );

            it(`posts are the same within all pages`, async () => {
                const subPostsBySortName: Record<string, CommentWithinRepliesPostsPageJson[]> = {};

                for (const sortName of Object.keys(POSTS_SORT_TYPES)) {
                    subPostsBySortName[sortName] = (await loadAllPagesBySortName(
                        sortName,
                        remoteSubplebbit.posts
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
                const pageCids = Object.values(remoteSubplebbit.posts.pageCids || {});
                expect(pageCids.length).to.be.greaterThan(0);

                for (const pageCid of pageCids) {
                    const pageIpfs = JSON.parse(await plebbit.fetchCid({ cid: pageCid })) as PageIpfs; // will have PageIpfs type

                    for (const commentInPageIpfs of pageIpfs.comments) {
                        const calculatedCid = await calculateIpfsHash(JSON.stringify(commentInPageIpfs.comment));
                        expect(calculatedCid).to.equal(commentInPageIpfs.commentUpdate.cid);
                    }
                }
            });
        });
    });
});

async function createLocalSubplebbitWithPageCids(): Promise<LocalSubplebbitWithPageCidsContext> {
    const publisherPlebbit = await mockPlebbit();
    const publisherSubplebbit = await createSubWithNoChallenge({}, publisherPlebbit);
    await publisherSubplebbit.start();

    await resolveWhenConditionIsTrue({
        toUpdate: publisherSubplebbit,
        predicate: async () => typeof publisherSubplebbit.updatedAt === "number"
    });
    const latestPost = await publishRandomPost({ communityAddress: publisherSubplebbit.address, plebbit: publisherPlebbit });
    await waitTillPostInSubplebbitPages(latestPost as never, publisherPlebbit);

    await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
        subplebbit: publisherSubplebbit as LocalSubplebbit,
        forcedPreloadedPageSizeBytes: 1,
        subplebbitPostsCommentProps: { content: `local pagination coverage` } as never
    });

    await resolveWhenConditionIsTrue({
        toUpdate: publisherSubplebbit,
        predicate: async () =>
            Object.keys(publisherSubplebbit.posts.pageCids || {}).length > 0 &&
            Boolean(publisherSubplebbit.posts.pages.hot?.comments?.length)
    });

    const cleanup = async (): Promise<void> => {
        await publisherSubplebbit.delete();

        await publisherPlebbit.destroy();
    };

    return { plebbit: publisherPlebbit, publisherSubplebbit: publisherSubplebbit as LocalSubplebbit, newPost: latestPost, cleanup };
}
