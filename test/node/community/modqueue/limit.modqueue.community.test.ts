import { beforeAll, afterAll, describe, it } from "vitest";
import {
    mockPKC,
    resolveWhenConditionIsTrue,
    publishToModQueueWithDepth,
    mockPKCNoDataPathWithOnlyKuboClient,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";

const pendingApprovalChallengeCommentProps = {
    challengeRequest: { challengeAnswers: ["pending"] }
};

describe(`Modqueue limits`, () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    const pendingComments: Comment[] = [];

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("Should default maxPendingApprovalCount to 500", async function () {
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.settings?.maxPendingApprovalCount === "number"
        });
        expect(community.settings?.maxPendingApprovalCount).to.equal(500);
    });

    it("Should allow comments to be published to pending approvals over maxPendingApprovalCount ", async function () {
        const limit = 2;
        const updatePromise = new Promise((resolve) => community.once("update", resolve));
        await community.edit({
            settings: {
                challenges: [createPendingApprovalChallenge()],
                maxPendingApprovalCount: limit
            }
        });
        await updatePromise;

        expect(community.settings!.maxPendingApprovalCount).to.equal(limit);

        const totalToPublish = limit + 2;
        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();

        for (let index = 0; index < totalToPublish; index++) {
            const { comment, challengeVerification } = await publishToModQueueWithDepth({
                community,
                depth: 0,
                pkc: remotePKC,
                commentProps: pendingApprovalChallengeCommentProps
            });
            expect(comment.pendingApproval).to.be.true;
            pendingComments.push(comment);
        }
        await remotePKC.destroy();

        // none of the comments got rejected, instead 2 of them got removed from pending queue
    });

    itSkipIfRpc("Should remove old pending comments from DB when hitting maxPendingApprovalCount limit", async function () {
        const limit = community.settings!.maxPendingApprovalCount!;
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                // @ts-expect-error - accessing private _dbHandler
                (community._dbHandler as LocalCommunity["_dbHandler"]).queryCommentsPendingApproval().length === limit
        });

        // @ts-expect-error - accessing private _dbHandler
        const pendingRows = (community._dbHandler as LocalCommunity["_dbHandler"]).queryCommentsPendingApproval();
        expect(pendingRows).to.have.length(limit);

        const expectedPendingCids = pendingComments
            .slice(-limit)
            .map((comment) => comment.cid)
            .reverse();
        expect(pendingRows.map((row) => row.cid)).to.deep.equal(expectedPendingCids);

        for (let i = 0; i < limit; i++) {
            const cidOfCommentThatGotRemovedFromPending = pendingComments[i].cid;
            // @ts-expect-error - accessing private _dbHandler
            expect((community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(cidOfCommentThatGotRemovedFromPending)).to.be
                .undefined;
        }
    });

    it("Should drop oldest pending comment from modqueue pages", async function () {
        const limit = community.settings!.maxPendingApprovalCount!;

        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => Boolean(community.modQueue.pageCids?.pendingApproval)
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        const currentPageCid = community.modQueue.pageCids.pendingApproval!;
        const page = await community.modQueue.getPage({ cid: currentPageCid });
        const pageCommentCids = page.comments.map((comment) => comment.cid);

        const expectedPendingCids = pendingComments
            .slice(-limit)
            .map((comment) => comment.cid)
            .reverse();
        expect(pageCommentCids).to.deep.equal(expectedPendingCids);

        for (let i = 0; i < limit; i++) {
            const cidOfCommentThatGotRemovedFromPending = pendingComments[i].cid;
            expect(pageCommentCids).to.not.include(cidOfCommentThatGotRemovedFromPending);
        }
    });
});
