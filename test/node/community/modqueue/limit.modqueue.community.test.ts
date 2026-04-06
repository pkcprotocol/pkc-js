import { beforeAll, afterAll, describe, it } from "vitest";
import {
    mockPlebbit,
    resolveWhenConditionIsTrue,
    publishToModQueueWithDepth,
    itSkipIfRpc,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import type { Plebbit as PlebbitType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";

const pendingApprovalChallengeCommentProps = {
    challengeRequest: { challengeAnswers: ["pending"] }
};

describe(`Modqueue limits`, () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    const pendingComments: Comment[] = [];

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Boolean(subplebbit.updatedAt) });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it("Should default maxPendingApprovalCount to 500", async function () {
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => typeof subplebbit.settings?.maxPendingApprovalCount === "number"
        });
        expect(subplebbit.settings?.maxPendingApprovalCount).to.equal(500);
    });

    it("Should allow comments to be published to pending approvals over maxPendingApprovalCount ", async function () {
        const limit = 2;
        const updatePromise = new Promise((resolve) => subplebbit.once("update", resolve));
        await subplebbit.edit({
            settings: {
                challenges: [createPendingApprovalChallenge()],
                maxPendingApprovalCount: limit
            }
        });
        await updatePromise;

        expect(subplebbit.settings!.maxPendingApprovalCount).to.equal(limit);

        const totalToPublish = limit + 2;
        const remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();

        for (let index = 0; index < totalToPublish; index++) {
            const { comment, challengeVerification } = await publishToModQueueWithDepth({
                subplebbit,
                depth: 0,
                plebbit: remotePlebbit,
                commentProps: pendingApprovalChallengeCommentProps
            });
            expect(comment.pendingApproval).to.be.true;
            pendingComments.push(comment);
        }
        await remotePlebbit.destroy();

        // none of the comments got rejected, instead 2 of them got removed from pending queue
    });

    itSkipIfRpc("Should remove old pending comments from DB when hitting maxPendingApprovalCount limit", async function () {
        const limit = subplebbit.settings!.maxPendingApprovalCount!;
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                // @ts-expect-error - accessing private _dbHandler
                (subplebbit._dbHandler as LocalSubplebbit["_dbHandler"]).queryCommentsPendingApproval().length === limit
        });

        // @ts-expect-error - accessing private _dbHandler
        const pendingRows = (subplebbit._dbHandler as LocalSubplebbit["_dbHandler"]).queryCommentsPendingApproval();
        expect(pendingRows).to.have.length(limit);

        const expectedPendingCids = pendingComments
            .slice(-limit)
            .map((comment) => comment.cid)
            .reverse();
        expect(pendingRows.map((row) => row.cid)).to.deep.equal(expectedPendingCids);

        for (let i = 0; i < limit; i++) {
            const cidOfCommentThatGotRemovedFromPending = pendingComments[i].cid;
            // @ts-expect-error - accessing private _dbHandler
            expect((subplebbit._dbHandler as LocalSubplebbit["_dbHandler"]).queryComment(cidOfCommentThatGotRemovedFromPending)).to.be
                .undefined;
        }
    });

    it("Should drop oldest pending comment from modqueue pages", async function () {
        const limit = subplebbit.settings!.maxPendingApprovalCount!;

        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => Boolean(subplebbit.modQueue.pageCids?.pendingApproval)
        });

        await new Promise((resolve) => setTimeout(resolve, 3000));

        const currentPageCid = subplebbit.modQueue.pageCids.pendingApproval!;
        const page = await subplebbit.modQueue.getPage({ cid: currentPageCid });
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
