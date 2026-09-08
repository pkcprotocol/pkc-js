import { PageSortFileSchema } from "../community/schema.js";
import { getEquivalentCommunityAddresses } from "../util.js";
import type { ParsedReservedPageSortOptions } from "./page-sort-options.js";
import type { PageSortFile } from "../community/types.js";
import type { PageIpfs, PageSortExclusionOptionName, PageSortReplyEntry } from "./types.js";

// Scoring a comment set with a page sort file (issue #73): the reserved exclusions, pinned placement and the maxAge
// window pkc-js applies around a file's `score`, and the file validation the registry runs. Used by the page generator;
// nothing here touches the database, only what a page entry carries.

type PageComment = PageIpfs["comments"][number];

// Validate what a factory returned, once, and hand back the file with its own functions rather than the schema's
// per-call wrappers: `score` runs once per comment per sort, and the wrapper re-validated its argument object (the
// whole `replies` list included, for a requireReplies file) on every call (issue #351). The generator checks the
// score's type itself.
export function validatePageSortFile(rawFile: unknown): PageSortFile {
    const validated = PageSortFileSchema.parse(rawFile);
    const raw = rawFile as PageSortFile;
    return {
        ...validated,
        score: raw.score,
        ...(raw.validatePageSortSettings ? { validatePageSortSettings: raw.validatePageSortSettings } : {})
    };
}

// The reserved exclusions applied to page entries in JS (the `replies` a requireReplies file receives). Mirrors the SQL clauses in DbHandler
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
    const kept = (entries: PageComment[]) => {
        const scored: { entry: PageComment; score: number }[] = [];
        for (const entry of entries) {
            const score = scoreOf(entry);
            if (score === null) continue;
            if (typeof score !== "number" || Number.isNaN(score))
                throw Error(`Page sort ${sortName} returned no numeric score for comment ${entry.commentUpdate.cid}`);
            scored.push({ entry, score });
        }
        return scored.sort((a, b) => b.score - a.score).map(({ entry }) => entry); // Array.prototype.sort is stable
    };
    return kept(pinned).concat(kept(unpinned));
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
    replies,
    stripEntry = stripRepliesFromPageComment,
    descendantsOf: descendantsOfOverride
}: {
    file: PageSortFile;
    options: Record<string, string>;
    baseTimestamp: number;
    replies?: PageSortReplyEntry[];
    stripEntry?: (entry: PageComment) => PageComment; // the community strips each entry once and reuses it across sorts
    descendantsOf?: (cid: string) => PageSortReplyEntry[]; // the community streams subtrees instead of passing `replies`
}): (entry: PageComment) => number | null {
    const descendantsOf = file.requireReplies ? descendantsOfOverride ?? createDescendantsLookup(replies ?? []) : undefined;
    return (entry) => {
        const { comment, commentUpdate } = stripEntry(entry);
        return file.score({
            comment,
            commentUpdate,
            options,
            baseTimestamp,
            ...(descendantsOf ? { replies: descendantsOf(commentUpdate.cid) } : {})
        });
    };
}
