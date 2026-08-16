// Crosspost chain depth. See docs/protocol/crossposts.md and issue #250.
//
// A chain is attacker-controlled in both depth and content. The 40kb publication limit bounds what
// can enter through a community's challenge exchange (roughly 50 levels), but every client path that
// ingests a CommentIpfs allows 1MB, and a deep chain is cheap to mint: _signJson derives
// signedPropertyNames from the fields present, so one genuinely signed record nested into itself
// needs no signature per level. Left uncapped that reaches zod's recursive parse, which overflows
// the stack at roughly 1000 levels and throws a RangeError rather than a PKCError, at a depth that
// varies by engine — so the same record parses on one client and throws on another.
//
// MAX_CROSSPOST_DEPTH is the hard cap every client enforces, which is what makes the rejection
// deterministic rather than stack-dependent. features.maxCrosspostDepth lets a community tighten
// below it, never above: a community accepting deeper chains than clients will load would publish
// comments nobody can render.
export const MAX_CROSSPOST_DEPTH = 10;

// Depth is the number of embedded records in the chain: a comment carrying no crosspost is 0, a
// plain crosspost is 1, a crosspost of a crosspost is 2.
//
// Iterative on purpose. The whole point is to reach a verdict without adding a stack frame per
// level, so this can run *before* the recursive zod parse rather than after it. It therefore walks
// raw unvalidated JSON and assumes nothing about the shape beyond the crosspost.comment.crosspost
// path. Counting stops at `stopAt`, so a 100k-level chain costs no more than a capped one.
export function crosspostChainDepthUpTo(record: unknown, stopAt: number = MAX_CROSSPOST_DEPTH + 1): number {
    let depth = 0;
    let level = _prop(record, "crosspost");
    while (_isObject(level) && depth < stopAt) {
        depth++;
        level = _prop(_prop(level, "comment"), "crosspost");
    }
    return depth;
}

// The deepest chain carried by any comment in a page, including the reply pages nested inside each
// comment's CommentUpdate. Also iterative: nesting of pages is attacker-controlled the same way
// nesting of crossposts is, so neither dimension gets a stack frame per level.
export function deepestCrosspostChainInPageUpTo(pageJson: unknown, stopAt: number = MAX_CROSSPOST_DEPTH + 1): number {
    return _deepestCrosspostChainInPagesUpTo([pageJson], stopAt);
}

// A CommentUpdate carries reply pages, and is fetched under the same 1MB cap as anything else, so a
// chain can arrive nested inside one rather than on the comment itself.
export function deepestCrosspostChainInCommentUpdateUpTo(commentUpdateJson: unknown, stopAt: number = MAX_CROSSPOST_DEPTH + 1): number {
    const replyPages = _prop(_prop(commentUpdateJson, "replies"), "pages");
    return _isObject(replyPages) ? _deepestCrosspostChainInPagesUpTo(Object.values(replyPages), stopAt) : 0;
}

function _deepestCrosspostChainInPagesUpTo(pages: unknown[], stopAt: number): number {
    let deepest = 0;
    const pagesToWalk = [...pages];
    while (pagesToWalk.length > 0) {
        const comments = _prop(pagesToWalk.pop(), "comments");
        if (!Array.isArray(comments)) continue;
        for (const pageComment of comments) {
            deepest = Math.max(deepest, crosspostChainDepthUpTo(_prop(pageComment, "comment"), stopAt));
            if (deepest >= stopAt) return deepest;
            const replyPages = _prop(_prop(_prop(pageComment, "commentUpdate"), "replies"), "pages");
            if (_isObject(replyPages)) pagesToWalk.push(...Object.values(replyPages));
        }
    }
    return deepest;
}

// A community may tighten the cap but never loosen it, and an out-of-range or non-integer value from
// a future protocol version degrades to the hard cap rather than failing the whole community record.
export function effectiveMaxCrosspostDepth(maxCrosspostDepthFeature: number | undefined): number {
    if (typeof maxCrosspostDepthFeature !== "number" || !Number.isInteger(maxCrosspostDepthFeature) || maxCrosspostDepthFeature < 0)
        return MAX_CROSSPOST_DEPTH;
    return Math.min(maxCrosspostDepthFeature, MAX_CROSSPOST_DEPTH);
}

function _isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function _prop(value: unknown, key: string): unknown {
    return _isObject(value) ? value[key] : undefined;
}
