import { expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import {
    shouldExcludeChallengeCommentCids,
    _getCommentPendingKeyCountForTesting
} from "../../../dist/node/runtime/node/community/challenges/exclude/exclude.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { CommunityChallenge } from "../../../dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../../dist/node/pubsub-messages/types.js";

// Reproduction for https://github.com/pkcprotocol/pkc-js/issues/148
//
// The `exclude` challenge's module-level `getCommentPending` map is used as a
// per-comment concurrency guard. When a comment finishes loading the entry is
// set to `false` instead of being deleted, so the map gains one permanently
// retained key per unique comment-CID/provider combination for the whole
// process lifetime — an unbounded growth leak.
//
// We drive the real shouldExcludeChallengeCommentCids path with a pkc whose
// getComment rejects (the pending-key cleanup happens in a `finally`, so it runs
// regardless), then assert the pending-key count does not grow across the call.

it("issue #148: exclude getCommentPending map does not retain finished entries", async () => {
    const commentCids = [uuidv4(), uuidv4(), uuidv4()]; // distinct → distinct pending keys

    const communityChallenge = {
        exclude: [{ community: { addresses: ["friendly-community-addr"], maxCommentCids: 3 } }]
    } as unknown as CommunityChallenge;

    const challengeRequestMessage = {
        comment: { author: { address: "author-addr" } },
        challengeCommentCids: commentCids
    } as unknown as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

    const pkc = {
        getComment: async () => {
            throw new Error("mock getComment rejects so the loader fails fast (cleanup still runs in finally)");
        },
        parsedPKCOptions: { ipfsGatewayUrls: ["http://gw"], kuboRpcClientsOptions: [{ url: "http://kubo" }] }
    } as unknown as PKC;

    const before = _getCommentPendingKeyCountForTesting();
    await shouldExcludeChallengeCommentCids(communityChallenge, challengeRequestMessage, pkc);
    const after = _getCommentPendingKeyCountForTesting();

    // With the bug, each of the 3 comments leaves a key behind (after === before + 3).
    // After the fix the keys are deleted in the finally (after === before).
    expect(after).to.equal(before);
});
