import { PKCError } from "../pkc-error.js";
import { PageSortFileFactorySchema } from "../community/schema.js";
import { getEquivalentCommunityAddresses } from "../util.js";
import { parseReservedPageSortOptions, type ParsedReservedPageSortOptions } from "./page-sort-options.js";
import type { CommunityPageSortSetting, PageSortFile, PageSortFileFactoryInput } from "../community/types.js";
import type { PageIpfs, PageSortExclusionOptionName, PageSortReplyEntry } from "./types.js";

// Client-side page sorting (issue #73, docs/protocol/page-sorts.md "Client-side re-sorting"). Browser-safe: no
// database, only what a page entry carries. The community publishes every option a sort runs with in
// community.pageSorts[sortName].publicOptions, so a client holding a page and the package registered under
// community.pageSorts[sortName].name can reproduce the community's own order, or apply any other sort it has.

type PageComment = PageIpfs["comments"][number];

// Build the PageSortFile of a package: what a client does with PKC.pageSorts[name], and what the community does with
// a resolved settings.pages entry. A factory takes only the entry; there is no community database in either place.
export function instantiatePageSortFile({
    factory,
    pageSortSettings
}: {
    factory: PageSortFileFactoryInput;
    pageSortSettings: CommunityPageSortSetting;
}): PageSortFile {
    return PageSortFileFactorySchema.parse(factory)({ pageSortSettings });
}

// The reserved exclusions as a client applies them to page entries. Mirrors the SQL clauses in DbHandler
// (exclusionClauses): a comment is removed when commentUpdate.removed is true, deleted when its author's edit says so,
// disapproved when commentUpdate.approved is false, pending when commentUpdate.pendingApproval is true.
export function applyPageSortExclusions<T extends PageSortReplyEntry>({
    comments,
    exclusions,
    communityAddress
}: {
    comments: T[];
    exclusions: Record<PageSortExclusionOptionName, boolean>;
    communityAddress?: string; // the community the page belongs to; needed only for excludeCommentsWithDifferentCommunityAddress
}): T[] {
    const equivalentAddresses = communityAddress ? new Set(getEquivalentCommunityAddresses(communityAddress)) : undefined;
    return comments.filter(({ comment, commentUpdate }) => {
        if (exclusions.excludeRemovedComments && commentUpdate.removed === true) return false;
        if (exclusions.excludeDeletedComments && commentUpdate.edit?.deleted === true) return false;
        if (exclusions.excludeCommentWithApprovedFalse && commentUpdate.approved === false) return false;
        if (exclusions.excludeCommentPendingApproval && commentUpdate.pendingApproval === true) return false;
        if (exclusions.excludeCommentsWithDifferentCommunityAddress && equivalentAddresses) {
            const belongs =
                (comment.communityPublicKey ? equivalentAddresses.has(comment.communityPublicKey) : false) ||
                (comment.communityName ? equivalentAddresses.has(comment.communityName) : false);
            if (!belongs) return false;
        }
        return true;
    });
}

// Pinned placement and the maxAge window, the two reserved options that shape every sort's set and order. Pinned
// comments sort first and bypass the window when pinnedFirst is on (the default), so a sticky never ages out of a
// windowed index; with pinnedFirst off they are ordinary comments. Shared with the community's page generator.
export function partitionPageCommentsForSort({
    comments,
    reserved,
    baseTimestamp
}: {
    comments: PageComment[];
    reserved: Pick<ParsedReservedPageSortOptions, "pinnedFirst" | "maxAgeSeconds">;
    baseTimestamp: number;
}): { pinned: PageComment[]; unpinned: PageComment[] } {
    const pinned = reserved.pinnedFirst ? comments.filter((entry) => entry.commentUpdate.pinned === true) : [];
    let unpinned = reserved.pinnedFirst ? comments.filter((entry) => entry.commentUpdate.pinned !== true) : comments;
    if (typeof reserved.maxAgeSeconds === "number") {
        const timestampLower = baseTimestamp - reserved.maxAgeSeconds;
        unpinned = unpinned.filter((entry) => entry.comment.timestamp >= timestampLower);
    }
    return { pinned, unpinned };
}

// Order pinned then unpinned by descending score. `null` declines the comment from this sort, pinned or not. A
// missing or non-numeric score is a bug in the sort file. Equal scores keep the input order (a stable sort), which is
// the community's insertion order at generation and the page's order on a client.
export function orderPageCommentsByScore({
    pinned,
    unpinned,
    scoreOf,
    sortName
}: {
    pinned: PageComment[];
    unpinned: PageComment[];
    scoreOf: (entry: PageComment) => number | null | undefined;
    sortName: string;
}): PageComment[] {
    const scores = new Map<string, number>();
    const kept = (entries: PageComment[]) =>
        entries.filter((entry) => {
            const score = scoreOf(entry);
            if (score === null) return false;
            if (typeof score !== "number" || Number.isNaN(score))
                throw Error(`Page sort ${sortName} returned no numeric score for comment ${entry.commentUpdate.cid}`);
            scores.set(entry.commentUpdate.cid, score);
            return true;
        });
    const byScoreDesc = (a: PageComment, b: PageComment) => scores.get(b.commentUpdate.cid)! - scores.get(a.commentUpdate.cid)!;
    return kept(pinned).sort(byScoreDesc).concat(kept(unpinned).sort(byScoreDesc));
}

// What `score` receives: the entry with the CommentUpdate's nested `replies` stripped, so a file cannot mistake the
// preloaded slice for the reply set (docs/protocol/page-sorts.md, "Writing a page sort file").
export function stripRepliesFromPageComment<T extends PageSortReplyEntry>(entry: T): T {
    if (!("replies" in entry.commentUpdate)) return entry;
    const { replies: _replies, ...commentUpdate } = entry.commentUpdate as T["commentUpdate"] & { replies?: unknown };
    return { comment: entry.comment, commentUpdate } as T;
}

// The `replies` a file with requireReplies gets per scored comment: its descendants, out of one flat list of every
// descendant of the page's comments (the community loads the scope's descendants once; a client passes what it
// walked). Indexed by parentCid, so a reply on a reply page gets its own subtree and a post gets everything under it;
// a node whose parent was excluded is unreachable, the same cut the community's exclusions make.
export function createDescendantsLookup(replies: PageSortReplyEntry[]): (cid: string) => PageSortReplyEntry[] {
    const childrenByParent = new Map<string, PageSortReplyEntry[]>();
    for (const entry of replies) {
        const stripped = stripRepliesFromPageComment(entry);
        const parentCid = stripped.comment.parentCid;
        if (!parentCid) continue;
        const siblings = childrenByParent.get(parentCid);
        if (siblings) siblings.push(stripped);
        else childrenByParent.set(parentCid, [stripped]);
    }
    return (cid) => {
        const collected: PageSortReplyEntry[] = [];
        const stack = [cid];
        while (stack.length) {
            const children = childrenByParent.get(stack.pop()!);
            if (!children) continue;
            for (const child of children) {
                collected.push(child);
                stack.push(child.commentUpdate.cid);
            }
        }
        return collected;
    };
}

// Score every entry the way both the community and a client do: the stripped entry, plus its descendants when the
// file asks for them. `replies` is required here only when the file requires it.
export function scorePageCommentsWithFile({
    file,
    options,
    baseTimestamp,
    replies
}: {
    file: PageSortFile;
    options: Record<string, string>;
    baseTimestamp: number;
    replies?: PageSortReplyEntry[];
}): (entry: PageComment) => number | null {
    const descendantsOf = file.requireReplies ? createDescendantsLookup(replies ?? []) : undefined;
    return (entry) => {
        const { comment, commentUpdate } = stripRepliesFromPageComment(entry);
        return file.score({
            comment,
            commentUpdate,
            options,
            baseTimestamp,
            ...(descendantsOf ? { replies: descendantsOf(commentUpdate.cid) } : {})
        });
    };
}

// What a UI holds: either the wire entries of a PageIpfs, or the parsed page comments of community.posts.pages /
// comment.replies.pages, which keep the wire entry under `raw`. Sorting returns the same shape it was given.
type SortablePageComment = PageComment | { raw: PageComment };

const toWireEntry = (entry: SortablePageComment): PageComment => ("raw" in entry ? entry.raw : entry);

// Sort a page's comments the way the community would for `file` under `options`: the full option set the sort runs
// with (community.pageSorts[sortName].publicOptions, or the same merge a community does). Applies the reserved
// exclusions, pinned placement and the window, then the file's `score`, dropping the comments it declines. A file with
// requireReplies needs `replies`: every descendant of the page's comments the caller walked from the reply pages, as
// one flat list; the exclusions are applied to it here, so the file sees the same survivors the community's SQL gives.
export function sortPageComments<T extends SortablePageComment>({
    comments,
    file,
    options,
    baseTimestamp,
    communityAddress,
    replies
}: {
    comments: T[];
    file: PageSortFile;
    options: Record<string, string>;
    baseTimestamp: number;
    communityAddress?: string;
    replies?: PageSortReplyEntry[]; // page entries are a superset of the lean entry, pass them as walked
}): T[] {
    if (file.requireReplies && !replies) throw new PKCError("ERR_PAGE_SORT_REPLIES_REQUIRED", { sortName: file.sortName });
    const reserved = parseReservedPageSortOptions(options);
    const byCid = new Map(comments.map((entry) => [toWireEntry(entry).commentUpdate.cid, entry]));
    const included = applyPageSortExclusions({ comments: comments.map(toWireEntry), exclusions: reserved.exclusions, communityAddress });
    const { pinned, unpinned } = partitionPageCommentsForSort({ comments: included, reserved, baseTimestamp });
    const survivingReplies = replies
        ? applyPageSortExclusions({ comments: replies, exclusions: reserved.exclusions, communityAddress })
        : undefined;
    const ordered = orderPageCommentsByScore({
        pinned,
        unpinned,
        sortName: file.sortName,
        scoreOf: scorePageCommentsWithFile({ file, options, baseTimestamp, replies: survivingReplies })
    });
    return ordered.map((entry) => byCid.get(entry.commentUpdate.cid)!);
}
