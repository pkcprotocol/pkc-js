import {
    mockPKC,
    resolveWhenConditionIsTrue,
    publishToModQueueWithDepth,
    mockPKCNoDataPathWithOnlyKuboClient,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import { testCommentFieldsInModQueuePageJson } from "../../../node-and-browser/pages/pages-test-util.js";
import { describe, it } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { ModQueuePageTypeJson } from "../../../../dist/node/pages/types.js";

const depthsToTest = [0, 1, 2, 3, 10, 15, 25, 35];
const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } };

interface SetupResult {
    plebbit: PKCType;
    subplebbit: LocalCommunity | RpcLocalCommunity;
    modSigner: SignerType;
}

const setupCommunityWithModerator = async (): Promise<SetupResult> => {
    const plebbit = await mockPKC();
    const subplebbit = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
    const modSigner = await plebbit.createSigner();
    await subplebbit.edit({
        roles: {
            [modSigner.address]: { role: "moderator" }
        },
        settings: {
            challenges: [createPendingApprovalChallenge()]
        }
    });

    await subplebbit.start();
    await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Boolean(subplebbit.updatedAt) });
    return { plebbit, subplebbit, modSigner };
};

describe("Modqueue depths", () => {
    const batchSize = 3;
    const depthBatches: number[][] = [];
    for (let i = 0; i < depthsToTest.length; i += batchSize) {
        depthBatches.push(depthsToTest.slice(i, i + batchSize));
    }

    for (const batch of depthBatches) {
        describe(`Modqueue depths batch [${batch.join(",")}]`, () => {
            for (const depth of batch) {
                it.concurrent(`should support mod queue pages with comments of the same depth, depth = ${depth}`, async () => {
                    const { plebbit, subplebbit, modSigner } = await setupCommunityWithModerator();
                    expect(subplebbit.lastPostCid).to.be.undefined;
                    const numOfComments = 3;
                    const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();

                    try {
                        const pendingComments = await Promise.all(
                            new Array(numOfComments).fill(null).map(() =>
                                publishToModQueueWithDepth({
                                    subplebbit,
                                    depth,
                                    modCommentProps: { signer: modSigner },
                                    plebbit: remotePKC,
                                    commentProps: pendingApprovalCommentProps
                                })
                            )
                        );

                        let modQueuePage: ModQueuePageTypeJson | undefined;

                        await resolveWhenConditionIsTrue({
                            toUpdate: subplebbit,
                            predicate: async () => {
                                if (!subplebbit.modQueue.pageCids.pendingApproval) return false;
                                modQueuePage = await subplebbit.modQueue.getPage({ cid: subplebbit.modQueue.pageCids.pendingApproval });
                                return modQueuePage.comments.length === numOfComments;
                            }
                        });

                        expect(modQueuePage).to.be.ok;

                        expect(modQueuePage!.comments.length).to.equal(numOfComments);

                        for (let i = 0; i < pendingComments.length; i++) {
                            // this will test both order and that all depths do exist in the page
                            // order of mod queue is newest first, so it's the reverse of pendingComments
                            expect(pendingComments[i].comment.depth).to.equal(depth);
                            expect(modQueuePage!.comments[i].depth).to.equal(depth);

                            testCommentFieldsInModQueuePageJson(modQueuePage!.comments[i], subplebbit.address);
                        }
                    } finally {
                        await remotePKC.destroy();
                        await subplebbit.delete();
                        await plebbit.destroy();
                    }
                });
            }
        });
    }

    it.sequential("Should support modqueue pages with comments of different depths", async () => {
        const { plebbit, subplebbit, modSigner } = await setupCommunityWithModerator();
        // TODO: Create a mix of top-level posts and nested replies in pending approval
        // and verify modqueue page rendering/order handles varying depths correctly

        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();

        try {
            const pendingComments: Awaited<ReturnType<typeof publishToModQueueWithDepth>>[] = [];
            const publishBatchSize = 3;
            for (let i = 0; i < depthsToTest.length; i += publishBatchSize) {
                const batchDepths = depthsToTest.slice(i, i + publishBatchSize);
                const batchResults = await Promise.all(
                    batchDepths.map((depth) =>
                        publishToModQueueWithDepth({
                            subplebbit,
                            depth,
                            modCommentProps: { signer: modSigner },
                            plebbit: remotePKC,
                            commentProps: pendingApprovalCommentProps
                        })
                    )
                );
                pendingComments.push(...batchResults);
            }

            // different depths should show up in mod queue

            let modQueuePage: ModQueuePageTypeJson | undefined;

            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => {
                    if (!subplebbit.modQueue.pageCids.pendingApproval) return false;
                    modQueuePage = await subplebbit.modQueue.getPage({ cid: subplebbit.modQueue.pageCids.pendingApproval });
                    return modQueuePage.comments.length === pendingComments.length;
                }
            });

            expect(modQueuePage!.comments.length).to.equal(pendingComments.length);
            for (let i = 0; i < pendingComments.length; i++) {
                // this will test both order and that all depths do exist in the page
                const pendingInPage = modQueuePage!.comments.find((c) => c.cid === pendingComments[i].comment.cid);

                expect(pendingComments[i].comment.depth).to.equal(pendingInPage!.depth);

                testCommentFieldsInModQueuePageJson(pendingInPage!, subplebbit.address);
            }
        } finally {
            await remotePKC.destroy();
            await subplebbit.delete();
            await plebbit.destroy();
        }
    });
});
