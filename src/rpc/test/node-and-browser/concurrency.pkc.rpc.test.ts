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

const subplebbitAddress = signers[0].address;
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
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-plebbit-rpc"] }).map((config) => {
    describe.concurrent(`RPC comment moderation regression - removing post (${config.name})`, () => {
        let plebbit: PKC;
        let postToRemove: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            postToRemove = await publishRandomPost({ communityAddress: moderationCommunityAddress, plebbit: plebbit });
            await postToRemove.update();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it.sequential("publishes CommentUpdate removed=true", async () => {
            const removeEdit = await plebbit.createCommentModeration({
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
            const unremoveEdit = await plebbit.createCommentModeration({
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
        let plebbit: PKC;
        let post: Comment;
        let replyToBeRemoved: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            post = await publishRandomPost({ communityAddress: moderationCommunityAddress, plebbit: plebbit });
            replyToBeRemoved = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            await replyToBeRemoved.update();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it.sequential("publishes CommentUpdate removed=true for reply", async () => {
            const removeEdit = await plebbit.createCommentModeration({
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
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const post = await publishRandomPost({ communityAddress: moderationCommunityAddress, plebbit: plebbitB });
                const commentA = await plebbitA.createComment({
                    cid: post.cid,
                    communityAddress: post.communityAddress
                });
                const commentB = await plebbitB.createComment({
                    cid: post.cid,
                    communityAddress: post.communityAddress
                });

                await commentA.update(); // starts shared updater
                await commentB.update(); // attach B to the same updater

                // Force A to disconnect its RPC subscriptions before B has confirmed any update
                await plebbitA.destroy();

                await pTimeout(
                    resolveWhenConditionIsTrue({
                        toUpdate: commentB,
                        predicate: async () => typeof commentB.updatedAt === "number"
                    }),
                    { milliseconds: 45000, message: "Comment B never reached initial updatedAt after sibling disconnect (regression)" }
                );

                const removeEdit = await plebbitB.createCommentModeration({
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
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 80000);
    });

    describe.concurrent(`plebbit RPC concurrency - ${config.name}`, () => {
        it("handles two RPC clients publishing in parallel without dropping either connection", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const [subA, subB] = await Promise.all([
                    plebbitA.getCommunity({ address: subplebbitAddress }),
                    plebbitB.getCommunity({ address: subplebbitAddress })
                ]);
                await Promise.all([subA.update(), subB.update()]);

                const [postFromA, postFromB] = await pTimeout(
                    Promise.all([
                        publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitA }),
                        publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitB })
                    ]),
                    { milliseconds: 60000, message: "Timed out publishing in parallel via RPC" }
                );

                const [fetchedByB, fetchedByA] = await Promise.all([
                    plebbitB.getComment({ cid: postFromA.cid }),
                    plebbitA.getComment({ cid: postFromB.cid })
                ]);

                expect(fetchedByB.cid).to.equal(postFromA.cid);
                expect(fetchedByA.cid).to.equal(postFromB.cid);
                expect(plebbitA._plebbitRpcClient?.state).to.equal("connected");
                expect(plebbitB._plebbitRpcClient?.state).to.equal("connected");
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 70000);

        it("keeps an active RPC client's subscription alive when a sibling client is destroyed mid-flight", async () => {
            const plebbitToDestroy = await config.plebbitInstancePromise();
            const plebbitToKeep = await config.plebbitInstancePromise();

            try {
                const subToKeep = await plebbitToKeep.getCommunity({ address: subplebbitAddress });
                await subToKeep.update();

                const publishPromise = publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitToKeep });

                await plebbitToDestroy.destroy();

                const publishedPost = await publishPromise;
                await subToKeep.update();
                await waitTillPostInCommunityInstancePages(
                    publishedPost as Parameters<typeof waitTillPostInCommunityInstancePages>[0],
                    subToKeep
                );
                const remotePost = await plebbitToKeep.getComment({ cid: publishedPost.cid });

                expect(remotePost.cid).to.equal(publishedPost.cid);
                expect(plebbitToKeep._plebbitRpcClient?.state).to.equal("connected");
            } finally {
                if (!plebbitToDestroy.destroyed) await plebbitToDestroy.destroy();
                if (!plebbitToKeep.destroyed) await plebbitToKeep.destroy();
            }
        }, 60000);

        it("keeps updates flowing to one subscriber after another subscriber to the same sub stops", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const [subA, subB] = await Promise.all([
                    plebbitA.getCommunity({ address: subplebbitAddress }),
                    plebbitB.getCommunity({ address: subplebbitAddress })
                ]);
                await Promise.all([subA.update(), subB.update()]);

                await subB.stop(); // unsubscribes B from server-side listeners
                await plebbitB.destroy();

                const newPost = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitA });
                await subA.update(); // trigger a fresh update on the surviving subscriber
                await waitTillPostInCommunityInstancePages(newPost as Parameters<typeof waitTillPostInCommunityInstancePages>[0], subA);

                const fetched = await plebbitA.getComment({ cid: newPost.cid });
                expect(fetched.cid).to.equal(newPost.cid);
                expect(plebbitA._plebbitRpcClient?.state).to.equal("connected");
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 65000);

        it("client B remains usable when client A calls setSettings, and receives settingschange", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 1,
                    userAgent: "hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                await plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg);
                await settingsChangeOnB;

                const subB = await plebbitB.getCommunity({ address: subplebbitAddress });
                await subB.update();
                const post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitB });
                const fetched = await plebbitB.getComment({ cid: post.cid });
                expect(fetched.cid).to.equal(post.cid);
                expect(plebbitB._plebbitRpcClient?.state).to.equal("connected");
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 70000);

        it.sequential(
            "createCommunity survives setSettings overlap (no ERR_PKC_IS_DESTROYED)",
            async () => {
                const plebbitA = await config.plebbitInstancePromise();
                const plebbitB = await config.plebbitInstancePromise();

                try {
                    const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                    const updatedOptions = {
                        ...currentSettings.plebbitOptions,
                        updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 7,
                        userAgent: "overlap-create" + Math.random()
                    };

                    // Run several overlapping createCommunity + setSettings pairs to maximize the window where the old plebbit can be destroyed mid-call
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
                                    plebbitB
                                );

                                const settingsPromise = plebbitA._plebbitRpcClient.setSettings({
                                    plebbitOptions: optionsWithJitter
                                } as unknown as SetSettingsArg);

                                const createdSub = await createPromise;
                                await settingsPromise;
                                await createdSub.start();
                                const post = await publishRandomPost({ communityAddress: createdSub.address, plebbit: plebbitB });
                                const fetched = await plebbitB.getComment({ cid: post.cid });
                                expect(fetched.cid).to.equal(post.cid);
                            })(),
                            { milliseconds: 55000, message: "Timed out during createCommunity/setSettings overlap" }
                        );
                    });

                    await Promise.all(tasks);
                } finally {
                    if (!plebbitA.destroyed) await plebbitA.destroy();
                    if (!plebbitB.destroyed) await plebbitB.destroy();
                }
            },
            80000
        );

        it("does not drop an in-flight publish on client B when client A calls setSettings (server restart)", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 3
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitB }), {
                    milliseconds: 45000,
                    message: "Timed out publishing while setSettings ran"
                });

                // Kick off setSettings almost immediately to overlap with publish
                await delay(50);
                await plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg);

                const publishedPost = await publishPromise;
                await settingsChangeOnB;

                const fetched = await plebbitB.getComment({ cid: publishedPost.cid });
                expect(fetched.cid).to.equal(publishedPost.cid);
                expect(plebbitB._plebbitRpcClient?.state).to.equal("connected");
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 70000);

        it("in-flight publish survives back-to-back setSettings from different clients", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();
            const plebbitC = await config.plebbitInstancePromise();

            try {
                const initialSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const firstUpdatedOptions = {
                    ...initialSettings.plebbitOptions,
                    updateInterval: (initialSettings.plebbitOptions.updateInterval || 60000) + 37,
                    userAgent: "first" + Math.random()
                };

                const firstSettingsChangeOnB = pTimeout(
                    new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)),
                    { milliseconds: 45000, message: "Timed out waiting for first settingschange on client B" }
                );
                const firstSettingsChangeOnC = pTimeout(
                    new Promise((resolve) => plebbitC._plebbitRpcClient.once("settingschange", resolve)),
                    { milliseconds: 45000, message: "Timed out waiting for first settingschange on client C" }
                );

                await plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: firstUpdatedOptions } as unknown as SetSettingsArg);
                await Promise.all([firstSettingsChangeOnB, firstSettingsChangeOnC]);

                const postFirstSettings = await waitForSettings(plebbitC._plebbitRpcClient);
                const secondUpdatedOptions = {
                    ...postFirstSettings.plebbitOptions,
                    updateInterval: (postFirstSettings.plebbitOptions.updateInterval || 60000) + 41,
                    userAgent: "second" + Math.random()
                };

                const secondSettingsChangeOnB = pTimeout(
                    new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)),
                    { milliseconds: 45000, message: "Timed out waiting for second settingschange on client B" }
                );

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitB }), {
                    milliseconds: 45000,
                    message: "Timed out publishing across consecutive setSettings"
                });

                await delay(20); // overlap publish with the second setSettings
                await plebbitC._plebbitRpcClient.setSettings({ plebbitOptions: secondUpdatedOptions } as unknown as SetSettingsArg);
                await secondSettingsChangeOnB;

                const publishedPost = await publishPromise;
                const fetched = await plebbitB.getComment({ cid: publishedPost.cid });

                expect(fetched.cid).to.equal(publishedPost.cid);
                expect(plebbitB._plebbitRpcClient?.state).to.equal("connected");
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
                if (!plebbitC.destroyed) await plebbitC.destroy();
            }
        }, 90000);

        it("subplebbit.update does not hang when client A calls setSettings mid-update", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const subB = await plebbitB.getCommunity({ address: subplebbitAddress });
                await subB.update();

                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 11,
                    userAgent: "hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const updatePromise = pTimeout(subB.update(), {
                    milliseconds: 45000,
                    message: "subplebbit.update timed out while setSettings ran"
                });

                await delay(20);
                await plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg);

                await Promise.all([settingsChangeOnB, updatePromise]);

                const post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbitB });
                await waitTillPostInCommunityInstancePages(post as Parameters<typeof waitTillPostInCommunityInstancePages>[0], subB); // hangs here
                const fetched = await plebbitB.getComment({ cid: post.cid });
                expect(fetched.cid).to.equal(post.cid);
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 75000);

        it("startCommunity subscription still receives updates after client A calls setSettings", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const freshSub = await createSubWithNoChallenge({ title: "temp sub " + Date.now(), description: "tmp" }, plebbitB);
                const freshAddress = freshSub.address;
                const startSubId = await (plebbitB._plebbitRpcClient as unknown as RpcClientWithInternals)._webSocketClient.call(
                    "startCommunity",
                    [{ address: freshAddress }]
                );

                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 17
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                await plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg);
                await settingsChangeOnB;

                const updateNotification = await pTimeout(
                    new Promise((resolve, reject) => {
                        const sub = plebbitB._plebbitRpcClient.getSubscription(startSubId);
                        if (!sub) return reject(new Error("No startCommunity subscription found after setSettings"));
                        sub.once("update", (res: { params?: { result?: unknown } }) => resolve(res.params?.result));
                        // trigger sub update to provoke an event
                        (plebbitB._plebbitRpcClient as unknown as RpcClientWithInternals)._webSocketClient
                            .call("subplebbitUpdateSubscribe", [{ address: freshAddress }])
                            .catch((err) => reject(err));
                    }),
                    { milliseconds: 45000, message: "Timed out waiting for started sub update after setSettings" }
                );

                expect(updateNotification).to.be.ok;
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 75000);

        it("in-flight publish on a started sub survives setSettings from another client", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const freshSub = await createSubWithNoChallenge({ title: "temp publish sub " + Date.now(), description: "tmp" }, plebbitB);
                const freshAddress = freshSub.address;
                await freshSub.start();

                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 19,
                    userAgent: "hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: freshAddress, plebbit: plebbitB }), {
                    milliseconds: 45000,
                    message: "Timed out publishing while setSettings ran"
                });

                await delay(20);
                await plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg);
                await settingsChangeOnB;

                const publishedPost = await publishPromise;
                const fetched = await plebbitB.getComment({ cid: publishedPost.cid });
                expect(fetched.cid).to.equal(publishedPost.cid);
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 80000);

        it("does not throw ERR_PKC_IS_DESTROYED when setSettings overlaps with startCommunity/getComment", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 23,
                    userAgent: "Hello" + Math.random()
                };

                const settingsChangeOnB = pTimeout(new Promise((resolve) => plebbitB._plebbitRpcClient.once("settingschange", resolve)), {
                    milliseconds: 45000,
                    message: "Timed out waiting for settingschange on client B"
                });

                const createStartSubPromise = pTimeout(
                    (async () => {
                        const sub = await createSubWithNoChallenge({ title: "temp overlap " + Date.now(), description: "tmp" }, plebbitB);
                        await sub.start();
                        return sub;
                    })(),
                    { milliseconds: 45000, message: "Timed out creating sub during overlapping setSettings" }
                );

                await delay(10);
                await pTimeout(plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg), {
                    milliseconds: 45000,
                    message: "Timed out running setSettings"
                });
                await settingsChangeOnB;

                const sub = await createStartSubPromise;
                const post = await publishRandomPost({ communityAddress: sub.address, plebbit: plebbitB });
                const fetched = await plebbitB.getComment({ cid: post.cid });
                expect(fetched.cid).to.equal(post.cid);
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 80000);

        it("setSettings completes while a subplebbitUpdate subscription is mid-update", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const subB = await plebbitB.getCommunity({ address: subplebbitAddress });
                await subB.update();

                const subplebbitUpdateSubscriptionId = await plebbitB._plebbitRpcClient.subplebbitUpdateSubscribe({
                    address: subplebbitAddress
                });

                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 29
                };

                const overlappingUpdate = pTimeout(subB.update(), {
                    milliseconds: 45000,
                    message: "subplebbit.update timed out while setSettings ran"
                });

                const setSettingsPromise = pTimeout(
                    plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg),
                    {
                        milliseconds: 45000,
                        message: "setSettings hung with active subplebbitUpdate subscription"
                    }
                );

                await Promise.all([setSettingsPromise, overlappingUpdate]);

                const updateAfterSettings = await pTimeout(
                    waitForSubscriptionEvent(plebbitB._plebbitRpcClient, subplebbitUpdateSubscriptionId, "update", () => subB.update()),
                    { milliseconds: 45000, message: "subplebbitUpdate subscription stopped emitting after setSettings" }
                );

                expect(updateAfterSettings).to.be.ok;
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 90000);

        it("startCommunity subscription stays responsive through setSettings even with subplebbitUpdate running", async () => {
            const plebbitA = await config.plebbitInstancePromise();
            const plebbitB = await config.plebbitInstancePromise();

            try {
                const freshSub = await createSubWithNoChallenge(
                    { title: "sub setSettings overlap " + Date.now(), description: "tmp" },
                    plebbitB
                );
                const freshAddress = freshSub.address;

                const startCommunitySubscriptionId = await plebbitB._plebbitRpcClient.startCommunity({ address: freshAddress });
                await pTimeout(waitForSubscriptionEvent(plebbitB._plebbitRpcClient, startCommunitySubscriptionId, "update"), {
                    milliseconds: 45000,
                    message: "startCommunity failed to emit initial update"
                });

                const subplebbitUpdateSubscriptionId = await plebbitB._plebbitRpcClient.subplebbitUpdateSubscribe({
                    address: freshAddress
                });

                const currentSettings = await waitForSettings(plebbitA._plebbitRpcClient);
                const updatedOptions = {
                    ...currentSettings.plebbitOptions,
                    updateInterval: (currentSettings.plebbitOptions.updateInterval || 60000) + 31
                };

                const nextStartUpdate = pTimeout(
                    waitForSubscriptionEvent(plebbitB._plebbitRpcClient, startCommunitySubscriptionId, "update"),
                    { milliseconds: 50000, message: "startCommunity stopped emitting updates after setSettings" }
                );

                const subUpdateAfterSettings = pTimeout(
                    waitForSubscriptionEvent(plebbitB._plebbitRpcClient, subplebbitUpdateSubscriptionId, "update", async () =>
                        (await plebbitB.getCommunity({ address: freshAddress })).update()
                    ),
                    { milliseconds: 50000, message: "subplebbitUpdate subscription died during setSettings+startCommunity" }
                );

                const publishPromise = pTimeout(publishRandomPost({ communityAddress: freshAddress, plebbit: plebbitB }), {
                    milliseconds: 50000,
                    message: "publish stalled while setSettings ran alongside startCommunity"
                });

                const setSettingsPromise = pTimeout(
                    plebbitA._plebbitRpcClient.setSettings({ plebbitOptions: updatedOptions } as unknown as SetSettingsArg),
                    {
                        milliseconds: 50000,
                        message: "setSettings hung while startCommunity/subplebbitUpdate listeners were active"
                    }
                );

                const [publishedPost] = await Promise.all([publishPromise, nextStartUpdate, subUpdateAfterSettings, setSettingsPromise]);
                const fetched = await plebbitB.getComment({ cid: publishedPost.cid });

                expect(fetched.cid).to.equal(publishedPost.cid);
            } finally {
                if (!plebbitA.destroyed) await plebbitA.destroy();
                if (!plebbitB.destroyed) await plebbitB.destroy();
            }
        }, 100000);
    });
});
