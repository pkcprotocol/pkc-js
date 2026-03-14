import signers from "../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import {
    describeSkipIfRpc,
    mockRemotePlebbit,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst,
    isRpcFlagOn
} from "../../../../dist/node/test/test-util.js";
import { sha256 } from "js-sha256";

import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";

const subplebbitAddress = signers[0].address;

function createAbortError(message: string) {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

function createBlockedNameResolver(key: string) {
    const receivedCalls: { name: string; signal: AbortSignal | undefined }[] = [];
    const resolverCallWaiters: { targetCallCount: number; resolve: () => void }[] = [];

    const resolveWaitersIfNeeded = () => {
        while (resolverCallWaiters.length > 0 && receivedCalls.length >= resolverCallWaiters[0].targetCallCount) {
            resolverCallWaiters.shift()!.resolve();
        }
    };

    const waitUntilCallCount = (targetCallCount: number) => {
        if (receivedCalls.length >= targetCallCount) return Promise.resolve();
        return new Promise<void>((resolve) => {
            resolverCallWaiters.push({ targetCallCount, resolve });
        });
    };

    return {
        waitUntilCalled: waitUntilCallCount(1),
        waitUntilCallCount,
        getCallCount: () => receivedCalls.length,
        getReceivedName: (callIndex = receivedCalls.length - 1) => receivedCalls[callIndex]?.name,
        getReceivedSignal: (callIndex = receivedCalls.length - 1) => receivedCalls[callIndex]?.signal,
        resolver: {
            key,
            canResolve: () => true,
            provider: `${key}-provider`,
            resolve: async ({ name, abortSignal }: { name: string; provider: string; abortSignal?: AbortSignal }) => {
                receivedCalls.push({ name, signal: abortSignal });
                resolveWaitersIfNeeded();
                if (!abortSignal) throw new Error("Expected abortSignal to be passed to the resolver");
                await new Promise<never>((_, reject) => {
                    const rejectWithAbort = () =>
                        reject(abortSignal.reason instanceof Error ? abortSignal.reason : createAbortError("The operation was aborted"));

                    if (abortSignal.aborted) {
                        rejectWithAbort();
                        return;
                    }

                    abortSignal.addEventListener("abort", rejectWithAbort, { once: true });
                });
                throw new Error("Blocked resolver should only finish by aborting");
            }
        }
    };
}

getAvailablePlebbitConfigsToTestAgainst().map((config) =>
    describe(`comment.stop() timing - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`comment.stop() after update() should complete within 10s`, async () => {
            const post = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });

            const recreatedPost = await plebbit.createComment({ cid: post.cid });
            await recreatedPost.update();
            await resolveWhenConditionIsTrue({
                toUpdate: recreatedPost,
                predicate: async () => typeof recreatedPost.updatedAt === "number"
            });
            const startMs = Date.now();
            await recreatedPost.stop();
            const elapsed = Date.now() - startMs;
            expect(elapsed).to.be.lessThan(10000);
        });
    })
);

describeSkipIfRpc(`comment.stop() aborts verification`, async () => {
    it(`comment.stop() aborts publish-time author resolution before challenge flow starts`, async () => {
        const blockedResolver = createBlockedNameResolver("publish-blocked-resolver");
        const plebbit = await mockRemotePlebbit({
            mockResolve: false,
            plebbitOptions: { nameResolvers: [blockedResolver.resolver] }
        });

        try {
            const comment = await plebbit.createComment({
                author: { name: "plebbit.bso" },
                signer: signers[3],
                title: `Abort publish verification ${Date.now()}`,
                content: `Abort publish verification ${Date.now()}`,
                subplebbitAddress
            });
            const errors: Error[] = [];
            const challengeRequests: unknown[] = [];
            comment.on("error", (error) => errors.push(error as Error));
            comment.on("challengerequest", (challengeRequest) => challengeRequests.push(challengeRequest));

            const publishPromise = comment.publish();
            await blockedResolver.waitUntilCalled;

            expect(blockedResolver.getReceivedName()).to.equal("plebbit.bso");
            expect(blockedResolver.getReceivedSignal()).to.be.instanceOf(AbortSignal);
            expect(comment.clients.nameResolvers["publish-blocked-resolver"].state).to.equal("resolving-author-name");

            await comment.stop();

            await expect(publishPromise).rejects.toMatchObject({ name: "AbortError" });
            expect(comment.state).to.equal("stopped");
            expect(comment.publishingState).to.equal("stopped");
            expect(comment.clients.nameResolvers["publish-blocked-resolver"].state).to.equal("stopped");
            expect(blockedResolver.getReceivedSignal()!.aborted).to.equal(true);
            expect(plebbit._memCaches.nameResolvedCache.get(sha256("plebbit.bso" + signers[3].publicKey))).to.be.undefined;
            expect(errors).to.have.length(0);
            expect(challengeRequests).to.have.length(0);
        } finally {
            await plebbit.destroy();
        }
    });

    it(`comment.stop() aborts update-time author resolution without emitting a failure`, async () => {
        const blockedResolver = createBlockedNameResolver("update-blocked-resolver");
        const publisher = await mockRemotePlebbit();
        const reader = await mockRemotePlebbit({
            mockResolve: false,
            stubStorage: false,
            plebbitOptions: { nameResolvers: [blockedResolver.resolver] }
        });

        try {
            const publishedComment = await publishRandomPost({
                subplebbitAddress,
                plebbit: publisher,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });

            const updatingComment = await reader.createComment({ cid: publishedComment.cid });
            const errors: Error[] = [];
            updatingComment.on("error", (error) => errors.push(error as Error));

            await updatingComment.update();
            await blockedResolver.waitUntilCalled;

            expect(blockedResolver.getReceivedName()).to.equal("plebbit.bso");
            expect(updatingComment.clients.nameResolvers["update-blocked-resolver"].state).to.equal("resolving-author-name");

            await updatingComment.stop();

            expect(updatingComment.state).to.equal("stopped");
            expect(updatingComment.updatingState).to.equal("stopped");
            expect(updatingComment.clients.nameResolvers["update-blocked-resolver"].state).to.equal("stopped");
            expect(blockedResolver.getReceivedSignal()!.aborted).to.equal(true);
            expect(reader._memCaches.nameResolvedCache.get(sha256("plebbit.bso" + publishedComment.signature.publicKey))).to.be.undefined;
            expect(errors).to.have.length(0);
        } finally {
            await Promise.allSettled([reader.destroy(), publisher.destroy()]);
        }
    });

    it(`comment.stop() recreates the stop abort signal for a later update cycle`, async () => {
        const blockedResolver = createBlockedNameResolver("restarted-update-blocked-resolver");
        const publisher = await mockRemotePlebbit();
        const reader = await mockRemotePlebbit({
            mockResolve: false,
            stubStorage: false,
            plebbitOptions: { nameResolvers: [blockedResolver.resolver] }
        });

        try {
            const publishedComment = await publishRandomPost({
                subplebbitAddress,
                plebbit: publisher,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });

            const updatingComment = await reader.createComment({ cid: publishedComment.cid });
            const errors: Error[] = [];
            updatingComment.on("error", (error) => errors.push(error as Error));

            updatingComment["_setStateWithEmission"]("updating");
            reader._updatingComments[publishedComment.cid] = updatingComment;
            const firstUpdateCyclePromise = updatingComment.loadCommentIpfsAndStartCommentUpdateSubscription();
            await blockedResolver.waitUntilCalled;

            const firstSignal = blockedResolver.getReceivedSignal(0);
            expect(blockedResolver.getReceivedName(0)).to.equal("plebbit.bso");
            expect(firstSignal).to.be.instanceOf(AbortSignal);
            expect(firstSignal!.aborted).to.equal(false);

            await updatingComment.stop();
            await firstUpdateCyclePromise;

            expect(updatingComment.state).to.equal("stopped");
            expect(updatingComment.updatingState).to.equal("stopped");
            expect(firstSignal!.aborted).to.equal(true);
            expect(reader._updatingComments[publishedComment.cid]).to.be.undefined;

            updatingComment["_setStateWithEmission"]("updating");
            reader._updatingComments[publishedComment.cid] = updatingComment;
            const secondUpdateCyclePromise = updatingComment.loadCommentIpfsAndStartCommentUpdateSubscription();
            await blockedResolver.waitUntilCallCount(2);

            const secondSignal = blockedResolver.getReceivedSignal(1);
            expect(blockedResolver.getCallCount()).to.equal(2);
            expect(blockedResolver.getReceivedName(1)).to.equal("plebbit.bso");
            expect(secondSignal).to.be.instanceOf(AbortSignal);
            expect(secondSignal).to.not.equal(firstSignal);
            expect(secondSignal!.aborted).to.equal(false);
            expect(updatingComment.clients.nameResolvers["restarted-update-blocked-resolver"].state).to.equal("resolving-author-name");

            await updatingComment.stop();
            await secondUpdateCyclePromise;

            expect(updatingComment.state).to.equal("stopped");
            expect(updatingComment.updatingState).to.equal("stopped");
            expect(updatingComment.clients.nameResolvers["restarted-update-blocked-resolver"].state).to.equal("stopped");
            expect(secondSignal!.aborted).to.equal(true);
            expect(reader._updatingComments[publishedComment.cid]).to.be.undefined;
            expect(reader._memCaches.nameResolvedCache.get(sha256("plebbit.bso" + publishedComment.signature.publicKey))).to.be.undefined;
            expect(errors).to.have.length(0);
        } finally {
            await Promise.allSettled([reader.destroy(), publisher.destroy()]);
        }
    });
});
