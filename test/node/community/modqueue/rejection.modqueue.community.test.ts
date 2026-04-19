import {
    mockPKC,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    generateMockComment,
    getCommentWithCommentUpdateProps,
    publishToModQueueWithDepth,
    generateMockVote,
    getAvailablePKCConfigsToTestAgainst,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, vi, beforeAll, afterAll } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { CommentWithinRepliesPostsPageJson, CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { CreateCommentModerationOptions } from "../../../../dist/node/publications/comment-moderation/types.js";

const remotePKCConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true }).filter(
    (config) => config.testConfigCode !== "remote-pkc-rpc" // we're filtering RPC out because we can't reduce its timeout so tests take forever
);

const depthsToTest = [0, 1, 2, 15];
const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } };

const commentModProps: CreateCommentModerationOptions["commentModeration"][] = [
    { approved: false },

    { approved: false, reason: "Test reason 1234" },
    {
        approved: false,
        reason: "New reason to be picked up and used",
        spoiler: true,
        nsfw: true,
        pinned: true,
        removed: true
    },
    { approved: false, reason: "Test removed and approved", removed: true }
];

interface CapturedChunkItem {
    commentUpdate?: { cid?: string; replies?: { pages?: { best?: { comments?: CapturedChunkItem[] } } } };
    cid?: string;
    comment?: { cid?: string };
    replies?: { pages?: { best?: { comments?: CapturedChunkItem[] } } };
}

for (const commentMod of commentModProps) {
    for (const pendingCommentDepth of depthsToTest) {
        const shouldCommentBePurged = Object.keys(commentMod).length === 1; // only approved=false, no other props

        // if a post is rejected, then it never appears in community.post, and if you wanna get its commentUpdate you can do so from postUpdates
        // but if a reply is rejected, then it will be included in pages only if shouldCommentBePurged = false
        const shouldCommentBeInPostsOrRepliesPages = pendingCommentDepth === 0 ? false : !shouldCommentBePurged; // if it's a reply then it will be nested within another commment and will appear in community.post

        describe.sequential(
            `Comment moderation rejection of pending comment with depth ` +
                pendingCommentDepth +
                " and commentModeration=" +
                JSON.stringify(commentMod),
            () => {
                let pkc: PKCType;
                let commentToBeRejected: Comment;
                let modSigner: SignerType;
                let community: LocalCommunity | RpcLocalCommunity;

                beforeAll(async () => {
                    pkc = await mockPKC();
                    community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
                    community.setMaxListeners(100);
                    modSigner = await pkc.createSigner();
                    await community.edit({
                        roles: {
                            [modSigner.address]: { role: "moderator" }
                        },
                        settings: { challenges: [createPendingApprovalChallenge()] }
                    });

                    await community.start();
                    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });

                    const pending = await publishToModQueueWithDepth({
                        community,
                        pkc: pkc, // needs to be remote or otherwise it will add comment to local node which will ruin our test
                        depth: pendingCommentDepth,
                        modCommentProps: { signer: modSigner, content: " 12" + Math.random() },
                        commentProps: pendingApprovalCommentProps
                    });
                    commentToBeRejected = pending.comment;

                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => Boolean(community.modQueue.pageCids.pendingApproval)
                    }); // wait until we publish a new mod queue with this new comment
                    await commentToBeRejected.update();
                });

                afterAll(async () => {
                    await community.delete();
                    await pkc.destroy();
                });

                it.sequential(`Can reject comment with commentModeration=${JSON.stringify(commentMod)}`, async () => {
                    const commentModeration = await pkc.createCommentModeration({
                        communityAddress: community.address,
                        signer: modSigner,
                        commentModeration: commentMod as unknown as Record<string, unknown>,
                        commentCid: commentToBeRejected.cid!
                    });

                    await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });
                });

                it.sequential(`Rejecting a pending comment will purge it from modQueue`, async () => {
                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => !community.modQueue.pageCids.pendingApproval
                    }); // wait until we publish a new mod queue with this new comment
                    expect(community.modQueue.pageCids.pendingApproval).to.be.undefined;
                });

                if (!shouldCommentBePurged)
                    itSkipIfRpc(
                        `Rejecting a pending comment with ${JSON.stringify(commentMod)} will not remove it from database of community because it has more than {approved: false}`,
                        async () => {
                            // @ts-expect-error - accessing private _dbHandler
                            const queryRes = (community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentToBeRejected.cid!);
                            expect(queryRes).to.be.exist;
                        }
                    );
                if (shouldCommentBePurged) {
                    itSkipIfRpc(`Rejecting a pending comment with only ${JSON.stringify(commentMod)} will purge it out of DB`, async () => {
                        // @ts-expect-error - accessing private _dbHandler
                        const queryRes = (community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentToBeRejected.cid!);
                        expect(queryRes).to.be.not.exist;
                    });
                }

                if (pendingCommentDepth > 0) {
                    it(`Rejected reply does not show up in parentComment.replyCount`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: commentToBeRejected.parentCid!, pkc })).replyCount).to.equal(
                            0
                        );
                    });

                    it(`Rejected reply does not show up in parentComment.childCount`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: commentToBeRejected.parentCid!, pkc })).childCount).to.equal(
                            0
                        );
                    });

                    it(`Rejected reply does not show up in parentComment.lastChildCid`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: commentToBeRejected.parentCid!, pkc })).lastChildCid).to.be
                            .undefined;
                    });
                    it(`Rejected reply does not show up in parentComment.lastReplyTimestamp`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: commentToBeRejected.parentCid!, pkc })).lastReplyTimestamp).to
                            .be.undefined;
                    });
                }

                if (pendingCommentDepth === 0)
                    it(`Rejected post does not show up in community.lastPostCid`, async () => {
                        expect(community.lastPostCid).to.not.equal(commentToBeRejected.cid);
                    });

                it(`Rejected comment does not show up in community.lastCommentCid`, async () => {
                    expect(community.lastCommentCid).to.not.equal(commentToBeRejected.cid);
                });

                itSkipIfRpc(
                    `A rejected comment with only ${JSON.stringify(commentMod)} will ${shouldCommentBeInPostsOrRepliesPages ? "" : "never"} show up in community.posts`,
                    async () => {
                        const preloadedSortName = "hot";
                        const { generated, capturedChunks } = await capturePostsGeneration(
                            community as LocalCommunity,
                            preloadedSortName,
                            1024 * 1024
                        );

                        const foundInGeneratedPages = cidExistsInChunks(capturedChunks, commentToBeRejected.cid!);
                        if (shouldCommentBeInPostsOrRepliesPages) {
                            expect(generated, "expected posts generation when rejected comment should be visible").to.exist;
                            expect(foundInGeneratedPages, "rejected comment should be present in generated posts").to.be.true;
                        } else {
                            expect(foundInGeneratedPages, "rejected comment should be excluded from generated posts").to.be.false;
                        }
                    }
                );

                if (pendingCommentDepth > 0)
                    itSkipIfRpc(
                        `A rejected reply will ${shouldCommentBePurged ? "not" : ""} show up in parentComment.replies`,
                        async () => {
                            const expectedResult = !shouldCommentBePurged;
                            const parentRow = (community as LocalCommunity)._dbHandler.queryComment(commentToBeRejected.parentCid!);
                            expect(parentRow).to.exist;

                            const { generated, capturedChunks } = await captureRepliesGeneration({
                                community: community as LocalCommunity,
                                parentCid: parentRow!.cid,
                                parentDepth: parentRow!.depth,
                                preloadedSortName: "best",
                                preloadedPageSizeBytes: 1024 * 1024
                            });

                            const foundInReplies = cidExistsInChunks(capturedChunks, commentToBeRejected.cid!);
                            expect(foundInReplies).to.equal(expectedResult);
                            if (expectedResult) expect(generated, "expected replies generation to contain the rejected comment").to.exist;
                        }
                    );
                if (pendingCommentDepth > 0)
                    itSkipIfRpc(`A rejected reply will ${shouldCommentBePurged ? "not" : ""} show up in flat pages of post`, async () => {
                        const shouldCommentBeInFlatPages = !shouldCommentBePurged;
                        // @ts-expect-error - accessing private _dbHandler
                        const postRow = (community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentToBeRejected.postCid!);
                        expect(postRow).to.exist;

                        for (const sortName of ["newFlat", "oldFlat"]) {
                            const { generated, capturedChunks } = await captureRepliesGeneration({
                                community: community as LocalCommunity,
                                parentCid: postRow!.cid,
                                parentDepth: postRow!.depth,
                                preloadedSortName: sortName,
                                preloadedPageSizeBytes: 1024 * 1024
                            });

                            const foundInFlatPages = cidExistsInChunks(capturedChunks, commentToBeRejected.cid!);
                            expect(foundInFlatPages).to.equal(shouldCommentBeInFlatPages);
                            if (shouldCommentBeInFlatPages)
                                expect(generated, "expected flat pages generation to include the rejected comment").to.exist;
                        }
                    });

                it(`comments with approved: false should not be in pageCids.pendingApproval`, async () => {
                    expect(community.modQueue.pageCids.pendingApproval).to.be.undefined;
                });
                if (pendingCommentDepth === 0)
                    itSkipIfRpc(
                        `Rejecting a pending post with ${JSON.stringify(commentMod)} will ${shouldCommentBePurged ? "not" : ""} keep it in community.postUpdates`,
                        async () => {
                            const localMfsPath = `/${community.address}/postUpdates/86400/${commentToBeRejected.cid}/update`;
                            const kuboRpc = Object.values(pkc.clients.kuboRpcClients)[0]._client;

                            try {
                                const res = await kuboRpc.files.stat(localMfsPath); // this call needs to pass because file should exist

                                if (!shouldCommentBePurged) expect(res.size).to.be.greaterThan(0);
                                else expect.fail("call should not succeed");
                            } catch (e) {
                                if (shouldCommentBePurged) expect((e as Error).message).to.equal("file does not exist");
                                else expect.fail("should not fail");
                            }
                        }
                    );

                remotePKCConfigs.forEach((remotePKCConfig) => {
                    const itSequentialIfRpc =
                        remotePKCConfig.testConfigCode === "remote-pkc-rpc" ||
                        remotePKCConfig.testConfigCode === "local-kubo-rpc" ||
                        remotePKCConfig.testConfigCode === "remote-kubo-rpc"
                            ? it.sequential
                            : it;

                    if (shouldCommentBePurged) {
                        itSequentialIfRpc(
                            `Should not be able to update a rejected comment with ${JSON.stringify(commentMod)} and retrieve its CommentIpfs - PKC Config ${remotePKCConfig.name}`,
                            async () => {
                                const remotePKC = await remotePKCConfig.pkcInstancePromise();
                                remotePKC._timeouts["comment-ipfs"] = 500; // speed up the test
                                try {
                                    const newComment = await remotePKC.createComment({
                                        cid: commentToBeRejected.cid,
                                        communityAddress: commentToBeRejected.communityAddress
                                    });

                                    const errors: Error[] = [];
                                    const failIfUpdated = () =>
                                        newComment.raw.comment &&
                                        expect.fail("Rejected comment unexpectedly emitted an update event with CommentIpfs");
                                    newComment.on("update", failIfUpdated);
                                    newComment.on("error", (err: Error) => errors.push(err));
                                    await newComment.update();

                                    await new Promise<void>((resolve) => {
                                        let settled = false;
                                        let timeoutId: NodeJS.Timeout;
                                        const onError = () => {
                                            if (settled) return;
                                            settled = true;
                                            clearTimeout(timeoutId);
                                            newComment.removeListener("error", onError);
                                            resolve();
                                        };
                                        timeoutId = setTimeout(() => {
                                            if (settled) return;
                                            settled = true;
                                            newComment.removeListener("error", onError);
                                            resolve();
                                        }, 10_000);
                                        newComment.on("error", onError);
                                    });

                                    newComment.removeListener("update", failIfUpdated);

                                    expect(newComment.raw.commentUpdate).to.be.undefined;
                                    expect(newComment.raw.comment).to.be.undefined;
                                    expect(newComment.signature).to.be.undefined;
                                    expect(newComment.updatedAt).to.be.undefined;
                                    errors.forEach((err) =>
                                        expect((err as Error & { code: string }).code).to.be.oneOf([
                                            "ERR_FETCH_CID_P2P_TIMEOUT",
                                            "ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS"
                                        ])
                                    );
                                    await newComment.stop();
                                } finally {
                                    await remotePKC.destroy();
                                }
                            }
                        );

                        itSequentialIfRpc(
                            `Should not be able to update a rejected comment with ${JSON.stringify(commentMod)} and retrieve its CommentUpdate - PKC Config ${remotePKCConfig.name}`,
                            async () => {
                                const remotePKC = await remotePKCConfig.pkcInstancePromise();
                                remotePKC._timeouts["comment-update-ipfs"] = 1000;
                                try {
                                    const newComment = await remotePKC.createComment(commentToBeRejected);
                                    expect(newComment.raw.comment).to.be.ok;

                                    const errors: Error[] = [];
                                    const failIfUpdated = () =>
                                        newComment.raw.commentUpdate &&
                                        expect.fail("Rejected comment unexpectedly emitted an update event with CommentUpdate");
                                    newComment.on("update", failIfUpdated);
                                    newComment.on("error", (err: Error) => errors.push(err));
                                    await newComment.update();

                                    await new Promise<void>((resolve) => {
                                        let settled = false;
                                        let timeoutId: NodeJS.Timeout;
                                        const onError = () => {
                                            if (settled) return;
                                            settled = true;
                                            clearTimeout(timeoutId);
                                            newComment.removeListener("error", onError);
                                            resolve();
                                        };
                                        timeoutId = setTimeout(() => {
                                            if (settled) return;
                                            settled = true;
                                            newComment.removeListener("error", onError);
                                            resolve();
                                        }, 10_000);
                                        newComment.on("error", onError);
                                    });

                                    newComment.removeListener("update", failIfUpdated);

                                    expect(newComment.raw.commentUpdate).to.be.undefined;
                                    expect(newComment.updatedAt).to.be.undefined;
                                    if (errors.length > 0)
                                        expect((errors[0] as Error & { code: string }).code).to.be.oneOf([
                                            "ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES",
                                            "ERR_FAILED_TO_FIND_REPLY_COMMENT_UPDATE_WITHIN_PARENT_COMMENT_PAGE_CIDS",
                                            "ERR_COMMUNITY_HAS_NO_POST_UPDATES"
                                        ]);
                                    await newComment.stop();
                                } finally {
                                    await remotePKC.destroy();
                                }
                            }
                        );
                    }

                    if (!shouldCommentBePurged) {
                        // test scenearios:
                        // have CommentIpfs but want to load commentUpdate
                        // have neither CommentUpdate or CommentIpfs

                        itSequentialIfRpc(
                            `Can update a rejected comment with ${JSON.stringify(commentMod)} and retrieve its update as long as we have its CommentIpfs - PKC Config ${remotePKCConfig.name}`,
                            async () => {
                                const remotePKC = await remotePKCConfig.pkcInstancePromise();

                                try {
                                    const newComment = await remotePKC.createComment(commentToBeRejected);
                                    expect(newComment.raw.comment).to.be.ok;

                                    await newComment.update();
                                    await resolveWhenConditionIsTrue({
                                        toUpdate: newComment,
                                        predicate: async () => Boolean(newComment.updatedAt)
                                    });

                                    for (const commentModKey of Object.keys(
                                        commentMod
                                    ) as (keyof CreateCommentModerationOptions["commentModeration"])[]) {
                                        expect((newComment as unknown as Record<string, unknown>)[commentModKey]).to.equal(
                                            commentMod[commentModKey]
                                        );
                                        expect(
                                            (newComment.raw.commentUpdate! as unknown as Record<string, unknown>)[commentModKey]
                                        ).to.equal(commentMod[commentModKey]);
                                    }

                                    expect(newComment.updatedAt).to.be.a("number");
                                    expect(newComment.upvoteCount).to.equal(0);
                                    expect(newComment.replyCount).to.equal(0);
                                    expect(newComment.childCount).to.equal(0);
                                    expect(newComment.removed).to.be.true;

                                    expect(newComment.raw.commentUpdate!.updatedAt).to.be.a("number");
                                    expect(newComment.raw.commentUpdate!.upvoteCount).to.equal(0);
                                    expect(newComment.raw.commentUpdate!.replyCount).to.equal(0);
                                    expect(newComment.raw.commentUpdate!.childCount).to.equal(0);
                                    expect(newComment.raw.commentUpdate!.removed).to.be.true;

                                    await newComment.stop();
                                } finally {
                                    await remotePKC.destroy();
                                }
                            }
                        );

                        if (shouldCommentBeInPostsOrRepliesPages) {
                            itSequentialIfRpc(
                                `Can update a rejected comment with ${JSON.stringify(commentMod)} and retrieve both CommentIpfs and CommentUpdate - PKC Config ${remotePKCConfig.name}`,
                                async () => {
                                    // times out in RPC
                                    const remotePKC = await remotePKCConfig.pkcInstancePromise();
                                    remotePKC._timeouts["comment-ipfs"] = 500; // speed up the test
                                    try {
                                        const newComment = await remotePKC.createComment({
                                            cid: commentToBeRejected.cid,
                                            communityAddress: commentToBeRejected.communityAddress
                                        });

                                        await newComment.update();
                                        await resolveWhenConditionIsTrue({
                                            toUpdate: newComment,
                                            predicate: async () => Boolean(newComment.updatedAt)
                                        });

                                        for (const commentModKey of Object.keys(
                                            commentMod
                                        ) as (keyof CreateCommentModerationOptions["commentModeration"])[]) {
                                            expect((newComment as unknown as Record<string, unknown>)[commentModKey]).to.equal(
                                                commentMod[commentModKey]
                                            );
                                            expect(
                                                (newComment.raw.commentUpdate! as unknown as Record<string, unknown>)[commentModKey]
                                            ).to.equal(commentMod[commentModKey]);
                                        }

                                        expect(newComment.updatedAt).to.be.a("number");
                                        expect(newComment.upvoteCount).to.equal(0);
                                        expect(newComment.replyCount).to.equal(0);
                                        expect(newComment.childCount).to.equal(0);
                                        expect(newComment.removed).to.be.true;

                                        expect(newComment.raw.commentUpdate!.updatedAt).to.be.a("number");
                                        expect(newComment.raw.commentUpdate!.upvoteCount).to.equal(0);
                                        expect(newComment.raw.commentUpdate!.replyCount).to.equal(0);
                                        expect(newComment.raw.commentUpdate!.childCount).to.equal(0);
                                        expect(newComment.raw.commentUpdate!.removed).to.be.true;
                                        expect(newComment.pendingApproval).to.be.false;

                                        expect(newComment.raw.comment).to.be.ok;
                                        expect(newComment.signature).to.be.ok;

                                        await newComment.stop();
                                    } finally {
                                        await remotePKC.destroy();
                                    }
                                }
                            );
                        }

                        // if only {approved:false} then we're not getting an update
                        itSequentialIfRpc(
                            `A rejected comment will have pendingApproval=false after receiving an update with ${JSON.stringify(commentMod)} if it already had its CommentIpfs - PKC Config ${remotePKCConfig.name}`,
                            async () => {
                                const remotePKC = await remotePKCConfig.pkcInstancePromise();
                                remotePKC._timeouts["comment-ipfs"] = 500; // it's gonna fail to load CID so this will make test run faster

                                try {
                                    const remoteCommentToBeRejected = await remotePKC.createComment({
                                        cid: commentToBeRejected.cid,
                                        raw: { comment: commentToBeRejected.raw.comment }
                                    });
                                    expect(remoteCommentToBeRejected.raw.comment).to.be.ok;
                                    await remoteCommentToBeRejected.update();
                                    await resolveWhenConditionIsTrue({
                                        toUpdate: remoteCommentToBeRejected,
                                        predicate: async () => remoteCommentToBeRejected.pendingApproval === false
                                    });
                                    expect(remoteCommentToBeRejected.pendingApproval).to.be.false;
                                } finally {
                                    await remotePKC.destroy();
                                }
                            }
                        );

                        if (shouldCommentBeInPostsOrRepliesPages)
                            itSequentialIfRpc(
                                `A rejected comment will have pendingApproval=false after receiving an update with ${JSON.stringify(commentMod)} without CommentIpfs - PKC Config ${remotePKCConfig.name}`,
                                async () => {
                                    const remotePKC = await remotePKCConfig.pkcInstancePromise();
                                    try {
                                        remotePKC._timeouts["comment-ipfs"] = 500; // it's gonna fail to load CID so this will make test run faster
                                        const remoteCommentToBeRejected = await remotePKC.createComment({
                                            cid: commentToBeRejected.cid,
                                            communityAddress: commentToBeRejected.communityAddress
                                        });
                                        await remoteCommentToBeRejected.update();
                                        await resolveWhenConditionIsTrue({
                                            toUpdate: remoteCommentToBeRejected,
                                            predicate: async () => remoteCommentToBeRejected.pendingApproval === false
                                        });
                                        expect(remoteCommentToBeRejected.pendingApproval).to.be.false;
                                    } finally {
                                        await remotePKC.destroy();
                                    }
                                }
                            );
                    }
                });

                it(`Can't vote on rejected comment`, async () => {
                    const expectedMessage = commentMod.removed
                        ? messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED
                        : shouldCommentBePurged
                          ? messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY
                          : messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT;
                    const vote = await generateMockVote(commentToBeRejected as CommentIpfsWithCidDefined, 1, pkc, modSigner); // need to publish under mod otherwise we're gonna get captcha challenge
                    await publishWithExpectedResult({
                        publication: vote,
                        expectedChallengeSuccess: false,
                        expectedReason: expectedMessage
                    });
                });

                it(`Can't publish a reply under a rejected comment`, async () => {
                    const expectedMessage = commentMod.removed
                        ? messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED
                        : shouldCommentBePurged
                          ? messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY
                          : messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT;
                    const reply = await generateMockComment(commentToBeRejected as CommentIpfsWithCidDefined, pkc, false);
                    await publishWithExpectedResult({
                        publication: reply,
                        expectedChallengeSuccess: false,
                        expectedReason: expectedMessage
                    });
                });

                it(`Can't publish an edit under a rejected comment`, async () => {
                    const expectedMessage = commentMod.removed
                        ? messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED
                        : shouldCommentBePurged
                          ? messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY
                          : messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT;
                    const edit = await pkc.createCommentEdit({
                        communityAddress: commentToBeRejected.communityAddress,
                        commentCid: commentToBeRejected.cid!,
                        reason: "random reason should fail",
                        content: "text to edit on pending comment",
                        signer: commentToBeRejected.signer
                    });
                    await publishWithExpectedResult({
                        publication: edit,
                        expectedChallengeSuccess: false,
                        expectedReason: expectedMessage
                    });
                });

                itSkipIfRpc(`A rejected comment is not pinned to IPFS node`, async () => {
                    const kuboRpc = Object.values(pkc.clients.kuboRpcClients)[0]._client;

                    // Collect all pinned CIDs
                    for await (const pin of kuboRpc.pin.ls()) {
                        expect(pin.cid.toString()).to.not.equal(commentToBeRejected.cid); // pending comment should not be pinned in kubo
                    }
                });

                itSkipIfRpc(`Should not be able to fetch rejected comment with only its CID since it's not provided anymore`, async () => {
                    const originalTimeout = JSON.parse(JSON.stringify(pkc._timeouts["generic-ipfs"]));
                    pkc._timeouts["generic-ipfs"] = 1000;
                    try {
                        await pkc.fetchCid({ cid: commentToBeRejected.cid! });
                        expect.fail("should fail");
                    } catch (e) {
                        expect((e as Error & { code: string }).code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
                    } finally {
                        pkc._timeouts["generic-ipfs"] = originalTimeout;
                    }
                });

                it(`Sub should reject CommentModeration if a mod published disapproval for a comment that already got disapproved`, async () => {
                    const expectedMessage = shouldCommentBePurged
                        ? messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY
                        : messages.ERR_MOD_ATTEMPTING_TO_APPROVE_OR_DISAPPROVE_COMMENT_THAT_IS_NOT_PENDING;
                    const commentModerationDisapproval = await pkc.createCommentModeration({
                        communityAddress: community.address,
                        signer: modSigner,
                        commentModeration: { approved: false },
                        commentCid: commentToBeRejected.cid!
                    });

                    await publishWithExpectedResult({
                        publication: commentModerationDisapproval,
                        expectedChallengeSuccess: false,
                        expectedReason: expectedMessage
                    });
                });

                itSkipIfRpc.sequential(`A rejected comment is not pinned to IPFS node after restarting the sub`, async () => {
                    await community.stop();

                    const updatePromise = new Promise((resolve) => community.once("update", resolve));
                    await community.start();
                    await updatePromise;

                    const kuboRpc = Object.values(pkc.clients.kuboRpcClients)[0]._client;

                    // Collect all pinned CIDs
                    for await (const pin of kuboRpc.pin.ls()) {
                        expect(pin.cid.toString()).to.not.equal(commentToBeRejected.cid); // pending comment should not be pinned in kubo
                    }
                });
            }
        );
    }
}

async function capturePostsGeneration(
    community: LocalCommunity,
    preloadedSortName: string,
    preloadedPageSizeBytes: number
): Promise<{ generated: CommentWithinRepliesPostsPageJson | undefined; capturedChunks: CapturedChunkItem[][] }> {
    return captureSortChunks({
        community,
        matchParentCid: null,
        matchSortName: preloadedSortName,
        // @ts-expect-error - accessing private _pageGenerator
        generate: () => community._pageGenerator.generateCommunityPosts(preloadedSortName, preloadedPageSizeBytes)
    });
}

async function captureRepliesGeneration({
    community,
    parentCid,
    parentDepth,
    preloadedSortName,
    preloadedPageSizeBytes
}: {
    community: LocalCommunity;
    parentCid: string;
    parentDepth: number;
    preloadedSortName: string;
    preloadedPageSizeBytes: number;
}): Promise<{ generated: CommentWithinRepliesPostsPageJson | undefined; capturedChunks: CapturedChunkItem[][] }> {
    const generator =
        parentDepth === 0
            ? // @ts-expect-error - accessing private _pageGenerator
              () => community._pageGenerator.generatePostPages({ cid: parentCid }, preloadedSortName, preloadedPageSizeBytes)
            : () =>
                  // @ts-expect-error - accessing private _pageGenerator
                  community._pageGenerator.generateReplyPages(
                      { cid: parentCid, depth: parentDepth },
                      preloadedSortName,
                      preloadedPageSizeBytes
                  );

    return captureSortChunks({
        community,
        matchParentCid: parentCid,
        matchSortName: preloadedSortName,
        generate: generator
    });
}

async function captureSortChunks<T>({
    community,
    matchParentCid,
    matchSortName,
    generate
}: {
    community: LocalCommunity;
    matchParentCid: string | null;
    matchSortName: string;
    generate: () => Promise<T>;
}): Promise<{ generated: T; capturedChunks: CapturedChunkItem[][] }> {
    const capturedChunks: CapturedChunkItem[][] = [];
    // @ts-expect-error - accessing private _pageGenerator
    const originalSortAndChunk = community._pageGenerator.sortAndChunkComments.bind(community._pageGenerator);
    // @ts-expect-error - accessing private _pageGenerator
    const sortSpy = vi.spyOn(community._pageGenerator, "sortAndChunkComments").mockImplementation(async (...args) => {
        const result = await originalSortAndChunk(...args);
        const [, sortName, options] = args as [unknown, string, { parentCid?: string | null }?];
        if (sortName === matchSortName && (options?.parentCid ?? null) === (matchParentCid ?? null)) {
            capturedChunks.push(...result);
        }
        return result;
    });

    try {
        const generated = await generate();
        return { generated, capturedChunks };
    } finally {
        sortSpy.mockRestore();
    }
}

function cidExistsInChunks(chunks: CapturedChunkItem[][], targetCid: string): boolean {
    for (const chunk of chunks) {
        for (const comment of chunk) {
            if (commentContainsCid(comment, targetCid)) return true;
        }
    }
    return false;
}

function commentContainsCid(comment: CapturedChunkItem, targetCid: string): boolean {
    if (extractCidFromChunkItem(comment) === targetCid) return true;
    const replies = comment?.commentUpdate?.replies ?? comment?.replies;
    const bestReplies = replies?.pages?.best?.comments;
    if (Array.isArray(bestReplies)) {
        for (const reply of bestReplies) {
            if (commentContainsCid(reply, targetCid)) return true;
        }
    }
    return false;
}

function extractCidFromChunkItem(comment: CapturedChunkItem): string | undefined {
    return comment?.commentUpdate?.cid ?? comment?.cid ?? comment?.comment?.cid;
}
