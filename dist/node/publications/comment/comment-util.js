import Logger from "../../logger.js";
export async function loadAllPagesUnderCommunityToFindComment(opts) {
    const { commentCidToFind, community, signal, postCid, parentCid } = opts;
    if (!commentCidToFind)
        throw Error("commentCidToFind should be defined");
    const log = Logger("pkc-js:comment:loadAllPagesUnderCommunityToFindComment");
    const queue = [];
    const queued = new Map();
    const visited = new Set();
    const parentCommentCache = new Map();
    const resetTraversalState = () => {
        queue.length = 0;
        queued.clear();
        visited.clear();
    };
    const getParentCommentInstance = (parentCid) => {
        let existing = parentCommentCache.get(parentCid);
        if (!existing) {
            existing = community._pkc.getComment({ cid: parentCid });
            parentCommentCache.set(parentCid, existing);
        }
        return existing;
    };
    const throwIfAborted = () => {
        if (!signal?.aborted)
            return;
        const abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        throw abortErr;
    };
    const normalizePage = (page) => {
        if ("comments" in page && page.comments.length > 0 && "raw" in page.comments[0])
            return { comments: page.comments.map((comment) => comment.raw), nextCid: page.nextCid };
        return page;
    };
    const getPageKey = (cid, source, parentCommentCid) => `${source}:${parentCommentCid || ""}:${cid}`;
    const enqueue = (cid, source, parentCommentCid) => {
        if (typeof cid !== "string" || cid.length === 0)
            return;
        const key = getPageKey(cid, source, parentCommentCid);
        if (visited.has(key))
            return;
        const existingEntry = queued.get(key);
        if (existingEntry)
            return;
        const entry = { cid, source, parentCommentCid };
        queued.set(key, entry);
        queue.push(entry);
    };
    const fetchPage = async (cid, source, parentCommentCid) => {
        throwIfAborted();
        if (source === "posts") {
            try {
                return await community.posts.getPage({ cid: cid });
            }
            catch (err) {
                log.trace("posts.getPage failed", { cid, err });
                return undefined;
            }
        }
        else {
            if (!parentCommentCid)
                return undefined;
            try {
                const parentCommentInstance = await getParentCommentInstance(parentCommentCid);
                return await parentCommentInstance.replies.getPage({ cid: cid });
            }
            catch (err) {
                log.trace("replies.getPage failed", { cid, parentCommentCid, err });
                return undefined;
            }
        }
    };
    const processReplies = async (replies, parentCommentCid) => {
        throwIfAborted();
        if (!replies)
            return undefined;
        if (replies.pages)
            for (const page of Object.values(replies.pages)) {
                if (!page)
                    continue;
                const comment = await processPage(page, "replies", parentCommentCid);
                if (comment)
                    return comment;
            }
        if (replies.pageCids) {
            const initialPageCid = replies.pageCids.new || Object.values(replies.pageCids)[0];
            enqueue(initialPageCid, "replies", parentCommentCid);
        }
        return undefined;
    };
    const processPage = async (page, source, parentCommentCid) => {
        throwIfAborted();
        const pageIpfs = normalizePage(page);
        for (const pageComment of pageIpfs.comments) {
            if (pageComment.commentUpdate.cid === commentCidToFind)
                return pageComment;
            const childComment = await processReplies(pageComment.commentUpdate.replies, pageComment.commentUpdate.cid);
            if (childComment)
                return childComment;
        }
        if (pageIpfs.nextCid)
            enqueue(pageIpfs.nextCid, source, parentCommentCid);
        return undefined;
    };
    const drainQueue = async (processPageFunc) => {
        while (queue.length) {
            throwIfAborted();
            const { cid, source, parentCommentCid } = queue.shift();
            const pageKey = getPageKey(cid, source, parentCommentCid);
            queued.delete(pageKey);
            if (visited.has(pageKey))
                continue;
            visited.add(pageKey);
            const page = await fetchPage(cid, source, parentCommentCid);
            if (!page)
                continue;
            const foundComment = await processPageFunc(page, source, parentCommentCid);
            if (foundComment)
                return foundComment;
        }
        return undefined;
    };
    const processPageForCidOnly = (targetCid) => async (page, source, _parentCommentCid) => {
        throwIfAborted();
        const pageIpfs = normalizePage(page);
        for (const pageComment of pageIpfs.comments) {
            if (pageComment.commentUpdate.cid === targetCid)
                return pageComment;
        }
        if (pageIpfs.nextCid)
            enqueue(pageIpfs.nextCid, source);
        return undefined;
    };
    const findPostCommentInCommunity = async (targetPostCid) => {
        const processPostPage = processPageForCidOnly(targetPostCid);
        for (const page of Object.values(community.posts.pages || {})) {
            if (!page)
                continue;
            const comment = await processPostPage(page, "posts");
            if (comment)
                return comment;
        }
        const initialPostsPageCid = community.posts.pageCids?.new || Object.values(community.posts.pageCids || {}).find((cid) => typeof cid === "string");
        enqueue(initialPostsPageCid, "posts");
        const foundFromQueue = await drainQueue(processPostPage);
        if (foundFromQueue)
            return foundFromQueue;
        return undefined;
    };
    const searchUnderParent = async (parentCommentCid) => {
        resetTraversalState();
        try {
            const parentCommentInstance = await getParentCommentInstance(parentCommentCid);
            const foundFromReplies = await processReplies(parentCommentInstance.replies, parentCommentCid);
            if (foundFromReplies)
                return foundFromReplies;
            const foundFromQueue = await drainQueue(processPage);
            if (foundFromQueue)
                return foundFromQueue;
        }
        catch (err) {
            log.trace("searchUnderParent failed", { parentCommentCid, err });
        }
        return undefined;
    };
    const searchUnderPost = async (postCidToSearch) => {
        resetTraversalState();
        const postComment = await findPostCommentInCommunity(postCidToSearch);
        if (!postComment)
            return undefined;
        if (postComment.commentUpdate.cid === commentCidToFind)
            return postComment;
        resetTraversalState();
        const foundFromReplies = await processReplies(postComment.commentUpdate.replies, postCidToSearch);
        if (foundFromReplies)
            return foundFromReplies;
        return await drainQueue(processPage);
    };
    if (parentCid) {
        const foundFromParent = await searchUnderParent(parentCid);
        if (foundFromParent)
            return foundFromParent;
    }
    if (postCid) {
        const foundFromPost = await searchUnderPost(postCid);
        if (foundFromPost)
            return foundFromPost;
    }
    resetTraversalState();
    for (const page of Object.values(community.posts.pages || {})) {
        if (!page)
            continue;
        const comment = await processPage(page, "posts");
        if (comment)
            return comment;
    }
    const initialPageCid = community.posts.pageCids?.new || Object.values(community.posts.pageCids || {}).find((cid) => typeof cid === "string");
    enqueue(initialPageCid, "posts");
    return await drainQueue(processPage);
}
//# sourceMappingURL=comment-util.js.map