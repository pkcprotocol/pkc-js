import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pTimeout from "p-timeout";
import signers from "../../../../test/fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    createSubWithNoChallenge,
    publishRandomPost,
    publishRandomReply,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityInstancePages
} from "../../../../dist/node/test/test-util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type PKCRpcClient from "../../../../dist/node/clients/rpc-client/pkc-rpc-client.js";

const communityAddress = signers[0].address;
const moderationCommunityAddress = signers[7].address;
const modSigner = signers[3];

type RpcClientWithInternals = { _webSocketClient: { call: (method: string, params: unknown[]) => Promise<number> } };
type SetSettingsArg = Parameters<PKCRpcClient["setSettings"]>[0];

const waitForSettings = async (rpcClient: PKCRpcClient) =>
    rpcClient.settings ??
    (await new Promise((resolve) => {
        rpcClient.once("settingschange", resolve);
    }));

// seems like running this test in parallel with other test files gets the other tests to timeout
// try running this test in parallel with test/node-and-browser/publications/comment/update/update.test.js
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForSubscriptionEvent = (
    rpcClient: PKCRpcClient,
    subscriptionId: number,
    eventName: string,
    trigger?: () => Promise<void> | void
) =>
    new Promise((resolve, reject) => {
        const subscription = rpcClient.getSubscription(subscriptionId);
        if (!subscription) return reject(new Error(`No subscription ${subscriptionId} found for ${eventName}`));

        const onEvent = (res: { params?: { result?: unknown } }) => {
            (subscription.removeListener as (event: string, listener: unknown) => void)("error", onError);
            resolve(res.params?.result);
        };
        const onError = (err: Error) => {
            (subscription.removeListener as (event: string, listener: unknown) => void)(eventName, onEvent);
            reject(err);
        };

        subscription.once(eventName, onEvent);
        subscription.once("error", onError);

        if (trigger) {
            Promise.resolve()
                .then(trigger)
                .catch((err) => {
                    (subscription.removeListener as (event: string, listener: unknown) => void)(eventName, onEvent);
                    (subscription.removeListener as (event: string, listener: unknown) => void)("error", onError);
                    reject(err);
                });
        }
    });

// TODO here add an after statement to reset rpc settings
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    describe.concurrent(`RPC comment moderation regression - removing post (${config.name})`, () => {
        let pkc: PKC;
        let postToRemove: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            postToRemove = await publishRandomPost({ communityAddress: moderationCommunityAddress, pkc: pkc });
            await postToRemove.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential("publishes CommentUpdate removed=true", async () => {
            const removeEdit = await pkc.createCommentModeration({
                communityAddress: postToRemove.communityAddress,
                commentCid: postToRemove.cid,
                commentModeration: { reason: "to remove a post RPC regression", removed: true },
                signer: modSigner
            });
            await publishWithExpectedResult({ publication: removeEdit, expectedChallengeSuccess: true });

            await postToRemove.update();
            await resolveWhenConditionIsTrue({ toUpdate: postToRemove, predicate: async () => postToRemove.removed === true });
            expect(postToRemove.removed).to.be.true;
            expect(postToRemove.raw.commentUpdate.removed).to.be.true;
        });

        it.sequential("publishes CommentUpdate removed=false", async () => {
            const unremoveEdit = await pkc.createCommentModeration({
                communityAddress: postToRemove.communityAddress,
                commentCid: postToRemove.cid,
                commentModeration: { reason: "to unremove a post RPC regression", removed: false },
                signer: modSigner
            });
            await publishWithExpectedResult({ publication: unremoveEdit, expectedChallengeSuccess: true });

            await postToRemove.update();
            await resolveWhenConditionIsTrue({ toUpdate: postToRemove, predicate: async () => postToRemove.removed === false });
            expect(postToRemove.removed).to.be.false;
            expect(postToRemove.raw.commentUpdate.removed).to.be.false;
        });
    });

    describe.concurrent(`RPC comment moderation regression - removing reply (${config.name})`, () => {
        let pkc: PKC;
        let post: Comment;
        let replyToBeRemoved: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            post = await publishRandomPost({ communityAddress: moderationCommunityAddress, pkc: pkc });
            replyToBeRemoved = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
            await replyToBeRemoved.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential("publishes CommentUpdate removed=true for reply", async () => {
            const removeEdit = await pkc.createCommentModeration({
                communityAddress: replyToBeRemoved.communityAddress,
                commentCid: replyToBeRemoved.cid,
                commentModeration: { reason: "remove reply RPC regression", removed: true },
                signer: modSigner
            });
            await publishWithExpectedResult({ publication: removeEdit, expectedChallengeSuccess: true });

            await replyToBeRemoved.update();
            await resolveWhenConditionIsTrue({ toUpdate: replyToBeRemoved, predicate: async () => replyToBeRemoved.removed === true });
            expect(replyToBeRemoved.removed).to.be.true;
            expect(replyToBeRemoved.raw.commentUpdate.removed).to.be.true;
        });
    });

    describe.concurrent(`RPC comment update survives sibling unsubscribe (${config.name})`, () => {
        it("keeps updates flowing after a sibling calls comment.stop()", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const post = await publishRandomPost({ communityAddress: moderationCommunityAddress, pkc: pkcB });
                const commentA = await pkcA.createComment({
                    cid: post.cid,
                    communityAddress: post.communityAddress
                });
                const commentB = await pkcB.createComment({
                    cid: post.cid,
                    communityAddress: post.communityAddress
                });

                await commentA.update(); // starts shared updater
                await commentB.update(); // attach B to the same updater

                // Force A to disconnect its RPC subscriptions before B has confirmed any update
                await pkcA.destroy();

                await pTimeout(
                    resolveWhenConditionIsTrue({
                        toUpdate: commentB,
                        predicate: async () => typeof commentB.updatedAt === "number"
                    }),
                    { milliseconds: 45000, message: "Comment B never reached initial updatedAt after sibling disconnect (regression)" }
                );

                const removeEdit = await pkcB.createCommentModeration({
                    communityAddress: post.communityAddress,
                    commentCid: post.cid,
                    commentModeration: { reason: "keep updates after sibling teardown", removed: true },
                    signer: modSigner
                });
                await publishWithExpectedResult({ publication: removeEdit, expectedChallengeSuccess: true });

                await pTimeout(
                    resolveWhenConditionIsTrue({
                        toUpdate: commentB,
                        predicate: async () => commentB.removed === true
                    }),
                    {
                        milliseconds: 30000,
                        message: "Remaining subscriber did not receive removal update after sibling stop (regression)"
                    }
                );

                expect(commentB.removed).to.be.true;
                expect(commentB.raw.commentUpdate?.removed).to.be.true;
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 80000);
    });

    describe.concurrent(`PKC RPC concurrency - ${config.name}`, () => {
        it("handles two RPC clients publishing in parallel without dropping either connection", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const [communityA, communityB] = await Promise.all([
                    pkcA.getCommunity({ address: communityAddress }),
                    pkcB.getCommunity({ address: communityAddress })
                ]);
                await Promise.all([communityA.update(), communityB.update()]);

                const [postFromA, postFromB] = await pTimeout(
                    Promise.all([
                        publishRandomPost({ communityAddress: communityAddress, pkc: pkcA }),
                        publishRandomPost({ communityAddress: communityAddress, pkc: pkcB })
                    ]),
                    { milliseconds: 60000, message: "Timed out publishing in parallel via RPC" }
                );

                const [fetchedByB, fetchedByA] = await Promise.all([
                    pkcB.getComment({ cid: postFromA.cid }),
                    pkcA.getComment({ cid: postFromB.cid })
                ]);

                expect(fetchedByB.cid).to.equal(postFromA.cid);
                expect(fetchedByA.cid).to.equal(postFromB.cid);
                expect(pkcA._pkcRpcClient?.state).to.equal("connected");
                expect(pkcB._pkcRpcClient?.state).to.equal("connected");
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 70000);

        it("keeps an active RPC client's subscription alive when a sibling client is destroyed mid-flight", async () => {
            const pkcToDestroy = await config.pkcInstancePromise();
            const pkcToKeep = await config.pkcInstancePromise();

            try {
                const communityToKeep = await pkcToKeep.getCommunity({ address: communityAddress });
                await communityToKeep.update();

                const publishPromise = publishRandomPost({ communityAddress: communityAddress, pkc: pkcToKeep });

                await pkcToDestroy.destroy();

                const publishedPost = await publishPromise;
                await communityToKeep.update();
                await waitTillPostInCommunityInstancePages(
                    publishedPost as Parameters<typeof waitTillPostInCommunityInstancePages>[0],
                    communityToKeep
                );
                const remotePost = await pkcToKeep.getComment({ cid: publishedPost.cid });

                expect(remotePost.cid).to.equal(publishedPost.cid);
                expect(pkcToKeep._pkcRpcClient?.state).to.equal("connected");
            } finally {
                if (!pkcToDestroy.destroyed) await pkcToDestroy.destroy();
                if (!pkcToKeep.destroyed) await pkcToKeep.destroy();
            }
        }, 60000);

        it("keeps updates flowing to one subscriber after another subscriber to the same community stops", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const [communityA, communityB] = await Promise.all([
                    pkcA.getCommunity({ address: communityAddress }),
                    pkcB.getCommunity({ address: communityAddress })
                ]);
                await Promise.all([communityA.update(), communityB.update()]);

                await communityB.stop(); // unsubscribes B from server-side listeners
                await pkcB.destroy();

                const newPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkcA });
                await communityA.update(); // trigger a fresh update on the surviving subscriber
                await waitTillPostInCommunityInstancePages(
                    newPost as Parameters<typeof waitTillPostInCommunityInstancePages>[0],
                    communityA
                );

                const fetched = await pkcA.getComment({ cid: newPost.cid });
                expect(fetched.cid).to.equal(newPost.cid);
                expect(pkcA._pkcRpcClient?.state).to.equal("connected");
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 65000);

        it("client B remains usable when client A calls setSettings, and receives settingschange", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 1,
                    userAgent: "hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                await pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg);
                await settingsChangeOnB;

                const communityB = await pkcB.getCommunity({ address: communityAddress });
                await communityB.update();
                const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkcB });
                const fetched = await pkcB.getComment({ cid: post.cid });
                expect(fetched.cid).to.equal(post.cid);
                expect(pkcB._pkcRpcClient?.state).to.equal("connected");
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 70000);

        it.sequential(
            "createCommunity survives setSettings overlap (no ERR_PKC_IS_DESTROYED)",
            async () => {
                const pkcA = await config.pkcInstancePromise();
                const pkcB = await config.pkcInstancePromise();

                try {
                    const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                    const updatedOptions = {
                        ...currentSettings.pkcOptions,
                        updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 7,
                        userAgent: "overlap-create" + Math.random()
                    };

                    // Run several overlapping createCommunity + setSettings pairs to maximize the window where the old pkc can be destroyed mid-call
                    const overlapAttempts = 4;
                    const tasks = Array.from({ length: overlapAttempts }).map((_, attemptIdx) => {
                        const optionsWithJitter = {
                            ...updatedOptions,
                            updateInterval: (updatedOptions.updateInterval || 60000) + attemptIdx * 13
                        };
                        return pTimeout(
                            (async () => {
                                const createPromise = createSubWithNoChallenge(
                                    { title: "overlap setSettings create " + Date.now() + "-" + attemptIdx, description: "tmp" },
                                    pkcB
                                );

                                const settingsPromise = pkcA._pkcRpcClient.setSettings({
                                    pkcOptions: optionsWithJitter
                                } as unknown as SetSettingsArg);

                                const createdCommunity = await createPromise;
                                await settingsPromise;
                                await createdCommunity.start();
                                const post = await publishRandomPost({ communityAddress: createdCommunity.address, pkc: pkcB });
                                const fetched = await pkcB.getComment({ cid: post.cid });
                                expect(fetched.cid).to.equal(post.cid);
                            })(),
                            { milliseconds: 55000, message: "Timed out during createCommunity/setSettings overlap" }
                        );
                    });

                    await Promise.all(tasks);
                } finally {
                    if (!pkcA.destroyed) await pkcA.destroy();
                    if (!pkcB.destroyed) await pkcB.destroy();
                }
            },
            80000
        );

        it("does not drop an in-flight publish on client B when client A calls setSettings (server restart)", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 3
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: communityAddress, pkc: pkcB }), {
                    milliseconds: 45000,
                    message: "Timed out publishing while setSettings ran"
                });

                // Kick off setSettings almost immediately to overlap with publish
                await delay(50);
                await pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg);

                const publishedPost = await publishPromise;
                await settingsChangeOnB;

                const fetched = await pkcB.getComment({ cid: publishedPost.cid });
                expect(fetched.cid).to.equal(publishedPost.cid);
                expect(pkcB._pkcRpcClient?.state).to.equal("connected");
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 70000);

        it("in-flight publish survives back-to-back setSettings from different clients", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();
            const pkcC = await config.pkcInstancePromise();

            try {
                const initialSettings = await waitForSettings(pkcA._pkcRpcClient);
                const firstUpdatedOptions = {
                    ...initialSettings.pkcOptions,
                    updateInterval: (initialSettings.pkcOptions.updateInterval || 60000) + 37,
                    userAgent: "first" + Math.random()
                };

                const firstSettingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for first settingschange on client B"
                });
                const firstSettingsChangeOnC = pTimeout(new Promise((resolve) => pkcC._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for first settingschange on client C"
                });

                await pkcA._pkcRpcClient.setSettings({ pkcOptions: firstUpdatedOptions } as unknown as SetSettingsArg);
                await Promise.all([firstSettingsChangeOnB, firstSettingsChangeOnC]);

                const postFirstSettings = await waitForSettings(pkcC._pkcRpcClient);
                const secondUpdatedOptions = {
                    ...postFirstSettings.pkcOptions,
                    updateInterval: (postFirstSettings.pkcOptions.updateInterval || 60000) + 41,
                    userAgent: "second" + Math.random()
                };

                const secondSettingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for second settingschange on client B"
                });

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: communityAddress, pkc: pkcB }), {
                    milliseconds: 45000,
                    message: "Timed out publishing across consecutive setSettings"
                });

                await delay(20); // overlap publish with the second setSettings
                await pkcC._pkcRpcClient.setSettings({ pkcOptions: secondUpdatedOptions } as unknown as SetSettingsArg);
                await secondSettingsChangeOnB;

                const publishedPost = await publishPromise;
                const fetched = await pkcB.getComment({ cid: publishedPost.cid });

                expect(fetched.cid).to.equal(publishedPost.cid);
                expect(pkcB._pkcRpcClient?.state).to.equal("connected");
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
                if (!pkcC.destroyed) await pkcC.destroy();
            }
        }, 90000);

        it("community.update does not hang when client A calls setSettings mid-update", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const communityB = await pkcB.getCommunity({ address: communityAddress });
                await communityB.update();

                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 11,
                    userAgent: "hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const updatePromise = pTimeout(communityB.update(), {
                    milliseconds: 45000,
                    message: "community.update timed out while setSettings ran"
                });

                await delay(20);
                await pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg);

                await Promise.all([settingsChangeOnB, updatePromise]);

                const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkcB });
                await waitTillPostInCommunityInstancePages(post as Parameters<typeof waitTillPostInCommunityInstancePages>[0], communityB); // hangs here
                const fetched = await pkcB.getComment({ cid: post.cid });
                expect(fetched.cid).to.equal(post.cid);
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 75000);

        it("startCommunity subscription still receives updates after client A calls setSettings", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const freshCommunity = await createSubWithNoChallenge({ title: "temp community " + Date.now(), description: "tmp" }, pkcB);
                const freshAddress = freshCommunity.address;
                const startCommunityId = await (pkcB._pkcRpcClient as unknown as RpcClientWithInternals)._webSocketClient.call(
                    "startCommunity",
                    [{ publicKey: freshAddress }]
                );

                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 17
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                await pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg);
                await settingsChangeOnB;

                const updateNotification = await pTimeout(
                    new Promise((resolve, reject) => {
                        const sub = pkcB._pkcRpcClient.getSubscription(startCommunityId);
                        if (!sub) return reject(new Error("No startCommunity subscription found after setSettings"));
                        sub.once("update", (res: { params?: { result?: unknown } }) => resolve(res.params?.result));
                        // trigger community update to provoke an event
                        (pkcB._pkcRpcClient as unknown as RpcClientWithInternals)._webSocketClient
                            .call("communityUpdateSubscribe", [{ publicKey: freshAddress }])
                            .catch((err) => reject(err));
                    }),
                    { milliseconds: 45000, message: "Timed out waiting for started community update after setSettings" }
                );

                expect(updateNotification).to.be.ok;
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 75000);

        it("in-flight publish on a started community survives setSettings from another client", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const freshCommunity = await createSubWithNoChallenge(
                    { title: "temp publish community " + Date.now(), description: "tmp" },
                    pkcB
                );
                const freshAddress = freshCommunity.address;
                await freshCommunity.start();

                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 19,
                    userAgent: "hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: freshAddress, pkc: pkcB }), {
                    milliseconds: 45000,
                    message: "Timed out publishing while setSettings ran"
                });

                await delay(20);
                await pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg);
                await settingsChangeOnB;

                const publishedPost = await publishPromise;
                const fetched = await pkcB.getComment({ cid: publishedPost.cid });
                expect(fetched.cid).to.equal(publishedPost.cid);
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 80000);

        it("does not throw ERR_PKC_IS_DESTROYED when setSettings overlaps with startCommunity/getComment", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 23,
                    userAgent: "Hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => pkcB._pkcRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const createStartCommunityPromise = pTimeout(
                    (async () => {
                        const community = await createSubWithNoChallenge({ title: "temp overlap " + Date.now(), description: "tmp" }, pkcB);
                        await community.start();
                        return community;
                    })(),
                    { milliseconds: 45000, message: "Timed out creating community during overlapping setSettings" }
                );

                await delay(10);
                await pTimeout(pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg), {
                    milliseconds: 45000,
                    message: "Timed out running setSettings"
                });
                await settingsChangeOnB;

                const community = await createStartCommunityPromise;
                const post = await publishRandomPost({ communityAddress: community.address, pkc: pkcB });
                const fetched = await pkcB.getComment({ cid: post.cid });
                expect(fetched.cid).to.equal(post.cid);
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 80000);

        it("setSettings completes while a communityUpdate subscription is mid-update", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const communityB = await pkcB.getCommunity({ address: communityAddress });
                await communityB.update();

                const { subscriptionId: communityUpdateSubscriptionId } = await pkcB._pkcRpcClient.communityUpdateSubscribe({
                    publicKey: communityAddress
                });

                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 29
                };

                const overlappingUpdate = pTimeout(communityB.update(), {
                    milliseconds: 45000,
                    message: "community.update timed out while setSettings ran"
                });

                const setSettingsPromise = pTimeout(
                    pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg),
                    {
                        milliseconds: 45000,
                        message: "setSettings hung with active communityUpdate subscription"
                    }
                );

                await Promise.all([setSettingsPromise, overlappingUpdate]);

                const updateAfterSettings = await pTimeout(
                    waitForSubscriptionEvent(pkcB._pkcRpcClient, communityUpdateSubscriptionId, "update", () => communityB.update()),
                    { milliseconds: 45000, message: "communityUpdate subscription stopped emitting after setSettings" }
                );

                expect(updateAfterSettings).to.be.ok;
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 90000);

        it("startCommunity subscription stays responsive through setSettings even with communityUpdate running", async () => {
            const pkcA = await config.pkcInstancePromise();
            const pkcB = await config.pkcInstancePromise();

            try {
                const freshCommunity = await createSubWithNoChallenge(
                    { title: "community setSettings overlap " + Date.now(), description: "tmp" },
                    pkcB
                );
                const freshAddress = freshCommunity.address;

                const { subscriptionId: startCommunitySubscriptionId } = await pkcB._pkcRpcClient.startCommunity({
                    publicKey: freshAddress
                });
                await pTimeout(waitForSubscriptionEvent(pkcB._pkcRpcClient, startCommunitySubscriptionId, "update"), {
                    milliseconds: 45000,
                    message: "startCommunity failed to emit initial update"
                });

                const { subscriptionId: communityUpdateSubscriptionId } = await pkcB._pkcRpcClient.communityUpdateSubscribe({
                    publicKey: freshAddress
                });

                const currentSettings = await waitForSettings(pkcA._pkcRpcClient);
                const updatedOptions = {
                    ...currentSettings.pkcOptions,
                    updateInterval: (currentSettings.pkcOptions.updateInterval || 60000) + 31
                };

                const nextStartUpdate = pTimeout(waitForSubscriptionEvent(pkcB._pkcRpcClient, startCommunitySubscriptionId, "update"), {
                    milliseconds: 50000,
                    message: "startCommunity stopped emitting updates after setSettings"
                });

                const communityUpdateAfterSettings = pTimeout(
                    waitForSubscriptionEvent(pkcB._pkcRpcClient, communityUpdateSubscriptionId, "update", async () =>
                        (await pkcB.getCommunity({ address: freshAddress })).update()
                    ),
                    { milliseconds: 50000, message: "communityUpdate subscription died during setSettings+startCommunity" }
                );

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: freshAddress, pkc: pkcB }), {
                    milliseconds: 50000,
                    message: "publish stalled while setSettings ran alongside startCommunity"
                });

                const setSettingsPromise = pTimeout(
                    pkcA._pkcRpcClient.setSettings({ pkcOptions: updatedOptions } as unknown as SetSettingsArg),
                    {
                        milliseconds: 50000,
                        message: "setSettings hung while startCommunity/communityUpdate listeners were active"
                    }
                );

                const [publishedPost] = await Promise.all([
                    publishPromise,
                    nextStartUpdate,
                    communityUpdateAfterSettings,
                    setSettingsPromise
                ]);
                const fetched = await pkcB.getComment({ cid: publishedPost.cid });

                expect(fetched.cid).to.equal(publishedPost.cid);
            } finally {
                if (!pkcA.destroyed) await pkcA.destroy();
                if (!pkcB.destroyed) await pkcB.destroy();
            }
        }, 100000);
    });
});
