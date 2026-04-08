//@ts-expect-error
import TinyCache from "tinycache";
import QuickLRU from "quick-lru";
import { testScore, testFirstCommentTimestamp, testRole, testPublicationType } from "./utils.js";
import { testRateLimit } from "./rate-limiter.js";
import { derivePublicationFromChallengeRequest } from "../../../../../util.js";
import { getPKCAddressFromPublicKeySync } from "../../../../../signer/util.js";
const shouldExcludePublication = (communityChallenge, request, community) => {
    if (!communityChallenge) {
        throw Error(`shouldExcludePublication invalid communityChallenge argument '${communityChallenge}'`);
    }
    const publication = derivePublicationFromChallengeRequest(request);
    if (!publication?.author) {
        throw Error(`shouldExcludePublication invalid publication argument '${publication}'`);
    }
    const author = publication.author;
    if (!communityChallenge.exclude) {
        return false;
    }
    if (!Array.isArray(communityChallenge.exclude)) {
        throw Error(`shouldExcludePublication invalid communityChallenge argument '${communityChallenge}' communityChallenge.exclude not an array`);
    }
    // lazy-loaded author publication counts (only when postCount/replyCount exclude is set)
    let authorPublicationCounts;
    // if match any of the exclude array, should exclude
    for (const exclude of communityChallenge.exclude) {
        // if doesn't have any author excludes, shouldn't exclude
        if (typeof exclude.postScore !== "number" &&
            typeof exclude.replyScore !== "number" &&
            typeof exclude.postCount !== "number" &&
            typeof exclude.replyCount !== "number" &&
            typeof exclude.firstCommentTimestamp !== "number" &&
            !exclude.address?.length &&
            exclude.publicationType === undefined &&
            exclude.rateLimit === undefined &&
            !exclude.role?.length) {
            continue;
        }
        // if match all of the exclude item properties, should exclude
        // keep separated for easier debugging
        let shouldExclude = true;
        if (!testScore(exclude.postScore, author.community?.postScore)) {
            shouldExclude = false;
        }
        if (!testScore(exclude.replyScore, author.community?.replyScore)) {
            shouldExclude = false;
        }
        if (!testFirstCommentTimestamp(exclude.firstCommentTimestamp, author.community?.firstCommentTimestamp)) {
            shouldExclude = false;
        }
        if (!testPublicationType(exclude.publicationType, request)) {
            shouldExclude = false;
        }
        if (!testRateLimit(exclude, request)) {
            shouldExclude = false;
        }
        if (exclude.address && !exclude.address.includes(author.address)) {
            shouldExclude = false;
        }
        if (Array.isArray(exclude.role) && !testRole(exclude.role, publication.author.address, community?.roles)) {
            shouldExclude = false;
        }
        if (typeof exclude.postCount === "number" || typeof exclude.replyCount === "number") {
            if (!authorPublicationCounts && community?._dbHandler) {
                const signerAddress = getPKCAddressFromPublicKeySync(publication.signature.publicKey);
                authorPublicationCounts = community._dbHandler.queryAuthorPublicationCounts(signerAddress);
            }
            if (!testScore(exclude.postCount, authorPublicationCounts?.postCount)) {
                shouldExclude = false;
            }
            if (!testScore(exclude.replyCount, authorPublicationCounts?.replyCount)) {
                shouldExclude = false;
            }
        }
        // if one of the exclude item is successful, should exclude author
        if (shouldExclude) {
            return true;
        }
    }
    return false;
};
const shouldExcludeChallengeSuccess = (communityChallenge, communityChallengeIndex, challengeResults) => {
    if (!communityChallenge) {
        throw Error(`shouldExcludeChallengeSuccess invalid communityChallenge argument '${communityChallenge}'`);
    }
    if (challengeResults && !Array.isArray(challengeResults)) {
        throw Error(`shouldExcludeChallengeSuccess invalid challengeResults argument '${challengeResults}'`);
    }
    // no challenge results or no exclude rules
    if (!challengeResults?.length || !communityChallenge.exclude?.length) {
        return false;
    }
    const challengeToExclude = challengeResults[communityChallengeIndex];
    if (!challengeToExclude) {
        throw Error(`shouldExcludeChallengeSuccess invalid communityChallengeIndex '${communityChallengeIndex}'`);
    }
    const challengeToExcludeIsPending = "challenge" in challengeToExclude;
    // if match any of the exclude array, should exclude
    for (const excludeItem of communityChallenge.exclude) {
        // has no challenge success exclude rules
        if (!excludeItem.challenges?.length) {
            continue;
        }
        // if any of exclude.challenges failed, don't exclude
        let shouldExclude = true;
        for (const challengeIndex of excludeItem.challenges) {
            const challengeResult = challengeResults[challengeIndex];
            // config mistake, excluded challenge index doesn't exist
            if (!challengeResult) {
                shouldExclude = false;
                break;
            }
            const challengeSuccess = "success" in challengeResult && challengeResult.success === true;
            // if a challenge is pending, it can exclude another non-pending challenge
            const challengePending = "challenge" in challengeResult && !challengeToExcludeIsPending;
            if (!challengeSuccess && !challengePending) {
                // found a false, should not exclude based on this exclude item,
                // but try again in the next exclude item
                shouldExclude = false;
                break;
            }
        }
        // if all exclude.challenges succeeded, should exclude
        if (shouldExclude) {
            return true;
        }
    }
    return false;
};
const commentCache = new QuickLRU({
    maxSize: 10000
});
// cache for fetching comment updates, expire after 1 day
const commentUpdateCache = new TinyCache();
const commentUpdateCacheTime = 1000 * 60 * 60;
const getCommentPending = {}; // cid -> boolean if it's loading or not
const shouldExcludeChallengeCommentCids = async (communityChallenge, challengeRequestMessage, pkc) => {
    if (!communityChallenge) {
        throw Error(`shouldExcludeChallengeCommentCids invalid communityChallenge argument '${communityChallenge}'`);
    }
    if (!challengeRequestMessage) {
        throw Error(`shouldExcludeChallengeCommentCids invalid challengeRequestMessage argument '${challengeRequestMessage}'`);
    }
    if (typeof pkc?.getComment !== "function") {
        throw Error(`shouldExcludeChallengeCommentCids invalid pkc argument '${pkc}'`);
    }
    const publication = derivePublicationFromChallengeRequest(challengeRequestMessage);
    const commentCids = challengeRequestMessage.challengeCommentCids;
    const author = publication?.author;
    if (commentCids && !Array.isArray(commentCids)) {
        throw Error(`shouldExcludeChallengeCommentCids invalid commentCids argument '${commentCids}'`);
    }
    if (!author?.address || typeof author?.address !== "string") {
        throw Error(`shouldExcludeChallengeCommentCids invalid challengeRequestMessage.publication.author.address argument '${author?.address}'`);
    }
    const _getComment = async (commentCid, addressesSet) => {
        // comment is cached
        let cachedComment = commentCache.get(commentCid);
        // comment is not cached, add to cache
        let comment;
        if (!cachedComment) {
            comment = await pkc.getComment({ cid: commentCid });
            // only cache useful values
            cachedComment = { communityAddress: comment.communityAddress, author: { address: comment.author.address } };
            commentCache.set(commentCid, cachedComment);
        }
        // community address doesn't match filter
        if (!addressesSet.has(cachedComment.communityAddress)) {
            throw Error(`comment doesn't have matching community address`);
        }
        // author address doesn't match author
        if (cachedComment?.author?.address !== author.address) {
            throw Error(`comment author address doesn't match publication author address`);
        }
        // comment hasn't been updated yet
        let cachedCommentUpdate = commentUpdateCache.get(commentCid);
        if (!cachedCommentUpdate) {
            const commentUpdate = comment || (await pkc.createComment({ cid: commentCid }));
            const onUpdate = () => typeof commentUpdate.updatedAt === "number" && resolveUpdate(1);
            let resolveUpdate;
            const commentUpdatePromise = new Promise((resolve) => {
                resolveUpdate = resolve;
                commentUpdate.on("update", onUpdate);
            });
            await commentUpdate.update();
            await commentUpdatePromise;
            await commentUpdate.stop();
            commentUpdate.removeListener("update", onUpdate);
            // only cache useful values
            if (commentUpdate?.author?.community) {
                cachedCommentUpdate = { author: { community: commentUpdate?.author?.community } };
                commentUpdateCache.put(commentCid, cachedCommentUpdate, commentUpdateCacheTime);
            }
            commentUpdateCache._timeouts[commentCid].unref?.();
        }
        return { ...cachedComment, author: { ...cachedComment.author, ...cachedCommentUpdate?.author } };
    };
    const getComment = async (commentCid, addressesSet) => {
        // don't fetch the same comment twice
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const pendingKey = commentCid + pkc.parsedPKCOptions?.ipfsGatewayUrls?.[0] + pkc.parsedPKCOptions?.kuboRpcClientsOptions?.[0].url;
        while (getCommentPending[pendingKey] === true) {
            await sleep(20);
        }
        getCommentPending[pendingKey] = true;
        try {
            const res = await _getComment(commentCid, addressesSet);
            return res;
        }
        catch (e) {
            throw e;
        }
        finally {
            getCommentPending[pendingKey] = false;
        }
    };
    const validateComment = async (commentCid, addressesSet, exclude) => {
        const comment = await getComment(commentCid, addressesSet);
        const { postScore, replyScore, firstCommentTimestamp } = exclude?.community || {};
        if (testScore(postScore, comment.author?.community?.postScore) &&
            testScore(replyScore, comment.author?.community?.replyScore) &&
            testFirstCommentTimestamp(firstCommentTimestamp, comment.author?.community?.firstCommentTimestamp)) {
            // do nothing, comment is valid
            return;
        }
        throw Error(`should not exclude comment cid`);
    };
    const validateExclude = async (exclude) => {
        let { addresses, maxCommentCids } = exclude?.community || {};
        if (!maxCommentCids) {
            maxCommentCids = 3;
        }
        // no friendly community addresses
        if (!addresses?.length) {
            throw Error("no friendly community addresses");
        }
        const addressesSet = new Set(addresses);
        // author didn't provide comment cids
        if (!commentCids?.length) {
            throw Error(`author didn't provide comment cids`);
        }
        // fetch and test all comments of the author async
        const validateCommentPromises = [];
        let i = 0;
        while (i < maxCommentCids) {
            const commentCid = commentCids[i++];
            if (commentCid) {
                validateCommentPromises.push(validateComment(commentCid, addressesSet, exclude));
            }
        }
        // if doesn't throw, at least 1 comment was valid
        try {
            await Promise.any(validateCommentPromises);
        }
        catch (e) {
            // console.log(validateCommentPromises) // debug all validate comments
            if (e instanceof Error)
                e.message = `should not exclude: ${e.message}`;
            throw e;
        }
        // if at least 1 comment was valid, do nothing, exclude is valid
    };
    // iterate over all excludes, and validate them async
    const validateExcludePromises = [];
    for (const exclude of communityChallenge.exclude || []) {
        validateExcludePromises.push(validateExclude(exclude));
    }
    // if at least 1 valid exclude, should exclude
    try {
        await Promise.any(validateExcludePromises);
        return true;
    }
    catch (e) {
        // console.log(validateExcludePromises) // debug all validate excludes
    }
    // if no exclude are valid, should not exclude
    return false;
};
export { shouldExcludeChallengeCommentCids, shouldExcludePublication, shouldExcludeChallengeSuccess };
//# sourceMappingURL=exclude.js.map