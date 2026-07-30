// Unit tests for src/runtime/node/community/local-community/comment-updates.ts.
// communityChallengePubsubTopic and calculateLocalMfsPathForCommentUpdate are pure;
// the orchestrators (calculateNewCommentUpdate, syncPostUpdatesWithIpfs,
// updateCommentsThatNeedToBeUpdated, adjustPostUpdatesBucketsIfNeeded) chain DB +
// IPFS + signing + page generation and are exercised end-to-end by the
// integration suite under test/node/community/.

import { describe, it, expect, vi } from "vitest";
import {
    adjustPostUpdatesBucketsIfNeeded,
    calculateLocalMfsPathForCommentUpdate,
    calculateNewCommentUpdate,
    communityChallengePubsubTopic,
    syncPostUpdatesWithIpfs,
    updateCommentsThatNeedToBeUpdated,
    validateCommentUpdateSignature
} from "../../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

// Since issue #229 the fallback is the signer address, never community.address: a record without
// pubsubTopic means the challenge exchange is disabled, so the address must not stand in for a topic.
describe("comment-updates: communityChallengePubsubTopic", () => {
    it("prefers community.pubsubTopic when set", () => {
        const community = {
            pubsubTopic: "explicit-topic",
            address: "fallback.bso",
            signer: { address: "signer-address" }
        } as unknown as LocalCommunity;
        expect(communityChallengePubsubTopic(community)).to.equal("explicit-topic");
    });

    it("falls back to the signer address when pubsubTopic is undefined", () => {
        const community = {
            pubsubTopic: undefined,
            address: "fallback.bso",
            signer: { address: "signer-address" }
        } as unknown as LocalCommunity;
        expect(communityChallengePubsubTopic(community)).to.equal("signer-address");
    });

    it("falls back to the signer address when pubsubTopic is an empty string", () => {
        const community = {
            pubsubTopic: "",
            address: "fallback.bso",
            signer: { address: "signer-address" }
        } as unknown as LocalCommunity;
        expect(communityChallengePubsubTopic(community)).to.equal("signer-address");
    });

    it("returns undefined when there is neither a topic nor a signer", () => {
        const community = { pubsubTopic: undefined, address: "fallback.bso", signer: undefined } as unknown as LocalCommunity;
        expect(communityChallengePubsubTopic(community)).to.be.undefined;
    });
});

describe("comment-updates: calculateLocalMfsPathForCommentUpdate", () => {
    it("constructs the canonical /<address>/postUpdates/<bucket>/<cid>/update path", () => {
        const community = { address: "my.bso" } as unknown as LocalCommunity;
        const path = calculateLocalMfsPathForCommentUpdate(community, { cid: "QmPost" }, 86400);
        expect(path).to.equal("/my.bso/postUpdates/86400/QmPost/update");
    });

    it("handles numeric address-like strings without crashing", () => {
        const community = { address: "12D3.bso" } as unknown as LocalCommunity;
        const path = calculateLocalMfsPathForCommentUpdate(community, { cid: "QmFoo" }, 100);
        expect(path).to.equal("/12D3.bso/postUpdates/100/QmFoo/update");
    });
});

describe("comment-updates: adjustPostUpdatesBucketsIfNeeded", () => {
    it("returns early when community.postUpdates is not set", async () => {
        const queryPostsWithOutdatedBuckets = vi.fn();
        const community = {
            postUpdates: undefined,
            _postUpdatesBuckets: [],
            _dbHandler: { queryPostsWithOutdatedBuckets }
        } as unknown as LocalCommunity;

        await adjustPostUpdatesBucketsIfNeeded(community);
        expect(queryPostsWithOutdatedBuckets).not.toHaveBeenCalled();
    });

    it("does nothing when no posts have outdated buckets", async () => {
        const queryPostsWithOutdatedBuckets = vi.fn().mockReturnValue([]);
        const forceUpdate = vi.fn();
        const community = {
            postUpdates: { "86400": "QmBucketCid" },
            _postUpdatesBuckets: [86400],
            _dbHandler: { queryPostsWithOutdatedBuckets, forceUpdateOnAllCommentsWithCid: forceUpdate }
        } as unknown as LocalCommunity;

        await adjustPostUpdatesBucketsIfNeeded(community);
        expect(queryPostsWithOutdatedBuckets).toHaveBeenCalledWith([86400]);
        expect(forceUpdate).not.toHaveBeenCalled();
    });

    it("forces update on outdated post cids when any are returned", async () => {
        const forceUpdate = vi.fn();
        const community = {
            postUpdates: { "86400": "QmBucketCid" },
            _postUpdatesBuckets: [86400],
            _dbHandler: {
                queryPostsWithOutdatedBuckets: vi.fn().mockReturnValue([{ cid: "QmPost1" }, { cid: "QmPost2" }]),
                forceUpdateOnAllCommentsWithCid: forceUpdate
            }
        } as unknown as LocalCommunity;

        await adjustPostUpdatesBucketsIfNeeded(community);
        expect(forceUpdate).toHaveBeenCalledWith(["QmPost1", "QmPost2"]);
    });
});

describe("comment-updates: updateCommentsThatNeedToBeUpdated", () => {
    it("returns an empty array when there are no comments to update", async () => {
        const queryCommentsToBeUpdated = vi.fn().mockReturnValue([]);
        const community = {
            address: "community.bso",
            _dbHandler: { queryCommentsToBeUpdated },
            _communityUpdateTrigger: false
        } as unknown as LocalCommunity;

        const result = await updateCommentsThatNeedToBeUpdated(community);
        expect(result).to.deep.equal([]);
        expect(community._communityUpdateTrigger).to.equal(false);
    });
});

describe("comment-updates: syncPostUpdatesWithIpfs / calculateNewCommentUpdate / validateCommentUpdateSignature", () => {
    it("exports calculateNewCommentUpdate as a function (deeper coverage is integration)", () => {
        expect(typeof calculateNewCommentUpdate).to.equal("function");
    });

    it("exports syncPostUpdatesWithIpfs as a function (deeper coverage is integration)", () => {
        expect(typeof syncPostUpdatesWithIpfs).to.equal("function");
    });

    it("exports validateCommentUpdateSignature as a function (deeper coverage is integration)", () => {
        expect(typeof validateCommentUpdateSignature).to.equal("function");
    });
});
