import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PageIpfs, PageTypeJson } from "../../../dist/node/pages/types.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../dist/node/publications/comment/types.js";
import type { CommunityPageSortSetting, PageSortFileFactory, PageSortFileFactoryInput } from "../../../dist/node/community/types.js";

// What a UI library does to re-sort a page it holds with a page-sort package it installed (docs/protocol/page-sorts.md,
// "Client side"): pkc-js exports no sorter and no walker on purpose, the package's `score` is the whole contract and
// the UI owns the fetching policy. This file is the doc's guidance as runnable code, so the tests check that the
// guidance reproduces the community's order.

type WireEntry = PageIpfs["comments"][number];
type ReplyPagesJson = NonNullable<CommentWithinRepliesPostsPageJson["replies"]>;
type SortablePageComment = WireEntry | { raw: WireEntry };

const toWireEntry = (entry: SortablePageComment): WireEntry => ("raw" in entry ? entry.raw : entry);

// Re-sort a page the way the community did for the same package and options, from the page alone (plus the walked
// `replies` for a package declaring requireReplies). The published `publicOptions` are the option set the sort ran
// with, exclusions included, and the page holds only the comments that passed them, so a client re-applies nothing but
// the pinned placement; `score` gets the CommentUpdate without its `replies`, returning null declines the comment,
// and ties keep the page's order.
export function resortPageLikeAUi<T extends SortablePageComment>({
    comments,
    factory,
    pageSortSettings,
    baseTimestamp,
    replies
}: {
    comments: T[];
    factory: PageSortFileFactoryInput;
    pageSortSettings: CommunityPageSortSetting; // { name, options: community.pageSorts[scope][sortName].publicOptions }
    baseTimestamp: number;
    replies?: WireEntry[];
}): T[] {
    const file = (factory as PageSortFileFactory)({ pageSortSettings });
    const options = pageSortSettings.options ?? {};
    if (file.requireReplies && !replies) throw new Error(`${file.sortName} declares requireReplies: walk the reply pages first`);
    const childrenOf = new Map<string, WireEntry[]>();
    for (const reply of replies ?? []) {
        const parentCid = reply.comment.parentCid!;
        if (!childrenOf.has(parentCid)) childrenOf.set(parentCid, []);
        childrenOf.get(parentCid)!.push(reply);
    }
    const descendantsOf = (cid: string): WireEntry[] => {
        const collected: WireEntry[] = [];
        const queue = [...(childrenOf.get(cid) ?? [])];
        while (queue.length) {
            const entry = queue.shift()!;
            collected.push(entry);
            queue.push(...(childrenOf.get(entry.commentUpdate.cid) ?? []));
        }
        return collected;
    };
    const scored = comments.map((entry, index) => {
        const { comment, commentUpdate } = toWireEntry(entry);
        const { replies: _stripped, ...commentUpdateWithoutReplies } = commentUpdate;
        const score = file.score({
            comment,
            commentUpdate: commentUpdateWithoutReplies,
            options,
            baseTimestamp,
            ...(file.requireReplies ? { replies: descendantsOf(commentUpdate.cid) } : {})
        });
        return { entry, index, score, pinned: commentUpdate.pinned === true };
    });
    const byScore = (a: (typeof scored)[number], b: (typeof scored)[number]) => b.score! - a.score! || a.index - b.index;
    const kept = scored.filter((item) => item.score !== null);
    const pinnedFirst = options.pinnedFirst !== "false";
    const ordered = pinnedFirst
        ? [...kept.filter((item) => item.pinned).sort(byScore), ...kept.filter((item) => !item.pinned).sort(byScore)]
        : kept.sort(byScore);
    return ordered.map((item) => item.entry);
}

// The walk before applying a reply-dependent package: a post's reply pages into the flat `replies` list a file
// declaring `requireReplies` scores over. The rules the walk follows:
//
// - A flat reply sort (`newFlat` / `oldFlat`), when the CommentUpdate carries one, lists the whole subtree in one
//   chain of pages, so it is walked and nothing else is.
// - Otherwise the nested sort's pages are walked, and every reply's own reply pages recursively, because a nested
//   reply carries its own `replies.pages` and `nextCid`.
// - A preloaded page with no `pageCids` and no `nextCid` for its key is the whole set (the single-chunk shortcut), which
//   is why the embedded `best` page of a small thread is enough.
//
// Each entry keeps the wire shape a page carries (`{ comment, commentUpdate }`); resortPageLikeAUi strips the nested
// `replies` before handing an entry to `score`.

const FLAT_SORTS = ["newFlat", "oldFlat"];

async function loadWholeChain({
    replies,
    sortName,
    getPage
}: {
    replies: ReplyPagesJson;
    sortName: string;
    getPage: (cid: string) => Promise<PageTypeJson>;
}): Promise<PageTypeJson["comments"]> {
    let page: PageTypeJson | undefined = replies.pages[sortName];
    if (!page) {
        const firstCid = replies.pageCids[sortName];
        if (!firstCid) return [];
        page = await getPage(firstCid);
    }
    const comments = [...page.comments];
    while (page.nextCid) {
        page = await getPage(page.nextCid);
        comments.push(...page.comments);
    }
    return comments;
}

export async function walkRepliesOfPageComment({
    pageComment,
    pkc
}: {
    pageComment: CommentWithinRepliesPostsPageJson;
    pkc: PKC;
}): Promise<WireEntry[]> {
    const replies = pageComment.replies;
    if (!replies) return [];
    const getPage = async (cid: string): Promise<PageTypeJson> => {
        const instance = await pkc.createComment(pageComment);
        return instance.replies.getPage({ cid });
    };

    const flatSort = FLAT_SORTS.find((sortName) => replies.pages[sortName] || replies.pageCids[sortName]);
    if (flatSort) return (await loadWholeChain({ replies, sortName: flatSort, getPage })).map((entry) => entry.raw);

    const nestedSort = Object.keys(replies.pages)[0] ?? Object.keys(replies.pageCids)[0];
    if (!nestedSort) return [];
    const direct = await loadWholeChain({ replies, sortName: nestedSort, getPage });
    const collected: WireEntry[] = [];
    for (const child of direct) {
        collected.push(child.raw);
        collected.push(...(await walkRepliesOfPageComment({ pageComment: child, pkc })));
    }
    return collected;
}

// Every descendant of every comment on a page, as the one flat list resortPageLikeAUi takes for `replies`.
export async function walkRepliesOfPage({
    comments,
    pkc
}: {
    comments: CommentWithinRepliesPostsPageJson[];
    pkc: PKC;
}): Promise<WireEntry[]> {
    const lists = await Promise.all(comments.map((pageComment) => walkRepliesOfPageComment({ pageComment, pkc })));
    return lists.flat();
}
