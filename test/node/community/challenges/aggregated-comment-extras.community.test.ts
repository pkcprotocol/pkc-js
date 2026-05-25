// Repro for the bug where a challenge returning `{ success: true, comment: { someKey: ... } }`
// (aggregatedComment) lands in the IPFS-bound bytes (and the stored CID) but is then dropped
// from the comment row's extraProps. Rebuilding the comment from the DB via
// deriveCommentIpfsFromCommentTableRow yields different bytes, so its hash no longer matches
// the stored cid, and remote verifiers fail with ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT
// when validating any page that embeds the comment.
//
// Live incident this reproduces: community 12D3KooWNFgjQWX2EUEs7pixdjkWSLh21EZ9NeYnV8iMaCyYhLGJ
// installed @bitsocial/flags-challenge which writes `comment["5chan"] = {...assertion}`.

import { mockPKC, generateMockPost, publishWithExpectedResult, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { calculateIpfsCidV0 } from "../../../../dist/node/util.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../../dist/node/runtime/node/util.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type {
    ChallengeFileInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    CommunityChallengeSetting
} from "../../../../dist/node/community/types.js";

const flagAssertion = {
    type: "country",
    code: "FR",
    text: "flag:country:FR",
    issuer: "flags.5chan.app",
    issuedAt: 1779600000,
    signature: { type: "ed25519", signature: "deadbeef", publicKey: "issuerPubKey", signedPropertyNames: ["type", "code"] }
};

// Mirrors @bitsocial/flags-challenge: success returns a `comment` map keyed by a namespace.
const flagAttachChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
    const type = "text/plain";
    const getChallenge = async (_args: GetChallengeArgsInput): Promise<ChallengeResultInput> => ({
        success: true,
        comment: { "5chan": flagAssertion }
    });
    return { getChallenge, type, description: "Always succeeds and attaches a 5chan flag assertion to the comment" };
};

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges
// (RPC clients cannot install challenge code on the remote community).
describeSkipIfRpc("aggregatedComment extras must round-trip through DB into the rebuilt CommentIpfs", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let post: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "flag-attach": flagAttachChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        community.setMaxListeners(100);
        await community.edit({ settings: { challenges: [{ name: "flag-attach" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        post = await generateMockPost({ communityAddress: community.address, pkc });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("rebuilt CommentIpfs from the DB row hashes back to the stored cid (aggregatedComment keys preserved)", async () => {
        const row = community._dbHandler.queryComment(post.cid!);
        expect(row).to.exist;

        const rebuilt = deriveCommentIpfsFromCommentTableRow(row!);

        // Author must see the challenge-added namespace key on the comment they read back.
        expect((rebuilt as Record<string, unknown>)["5chan"]).to.deep.equal(flagAssertion);

        // Page generation re-derives the comment via this same path and embeds it in
        // commentUpdate.replies.pages.best.comments[].comment. Remote verifiers hash that
        // payload and compare against commentUpdate.cid. If the rebuilt bytes do not hash
        // back to the stored cid, every page that embeds this comment fails verification
        // with ERR_COMMENT_UPDATE_DIFFERENT_CID_THAN_COMMENT (surfaced as
        // ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID).
        const recomputedCid = await calculateIpfsCidV0(deterministicStringify(rebuilt)!);
        expect(recomputedCid).to.equal(row!.cid);
    });
});
