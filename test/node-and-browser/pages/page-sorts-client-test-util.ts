import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PageIpfs, PageTypeJson } from "../../../dist/node/pages/types.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../dist/node/publications/comment/types.js";

// The worked example of what a UI library does before applying a reply-dependent page sort on a client
// (docs/protocol/page-sorts.md, "Client side"): walk a post's reply pages into the flat `replies` list that
// `sortPageComments` hands to a file declaring `requireReplies`. pkc-js exports no walker on purpose; UI libraries
// own the fetching policy (how many threads, when to stop). The rules the walk follows:
//
// - A flat reply sort (`newFlat` / `oldFlat`), when the CommentUpdate carries one, lists the whole subtree in one
//   chain of pages, so it is walked and nothing else is.
// - Otherwise the nested sort's pages are walked, and every reply's own reply pages recursively, because a nested
//   reply carries its own `replies.pages` and `nextCid`.
// - A preloaded page with no `pageCids` and no `nextCid` for its key is the whole set (the single-chunk shortcut), which
//   is why the embedded `best` page of a small thread is enough.
//
// Each entry keeps the wire shape a page carries (`{ comment, commentUpdate }`); nested `replies` are stripped by
// sortPageComments itself, a caller does not have to.

type WireEntry = PageIpfs["comments"][number];
type ReplyPagesJson = NonNullable<CommentWithinRepliesPostsPageJson["replies"]>;

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

// Every descendant of every comment on a page, as the one flat list sortPageComments takes for `replies`.
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
