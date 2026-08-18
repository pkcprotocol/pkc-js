import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, isRpcFlagOn, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import { calculateIpfsCidV0 } from "../../../../dist/node/util.js";
import { CommentIpfsReservedFields, CommentPubsubMessageReservedFields } from "../../../../dist/node/publications/comment/schema.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";

// pkc.getComment() on a cid that nothing on the network has blocks for the whole
// _timeouts["comment-ifps"]. These tests pin that an abortSignal unwinds it immediately, reports it
// distinctly from a timeout, and leaves no comment instance running behind (issue #278).
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`pkc.getComment abortSignal - ${config.name}`, () => {
        let pkc: PKC;
        let unloadableCid: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            // A cid derived from content that was never added to any node, so the retry loop inside
            // getComment keeps going until the comment-ipfs timeout.
            unloadableCid = await calculateIpfsCidV0("getcomment-abort-" + Math.random());
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it("rejects with ERR_GET_COMMENT_ABORTED when the signal fires mid-fetch", async () => {
            const abortController = new AbortController();
            // The two paths park in different places, so each needs its own proof that the fetch is
            // genuinely in flight before aborting — otherwise this silently degrades into the
            // pre-aborted case covered below. Directly, getComment retries inside a Comment instance
            // it does not expose, so spy on createComment for a handle on it (spyOn with no
            // implementation calls through). Under RPC there is no local instance at all: getComment
            // is parked on the RPC call itself, so wait for that call to have been issued.
            const rpcGetCommentSpy = isRpcFlagOn() ? vi.spyOn(pkc._pkcRpcClient!, "getComment") : undefined;
            const createCommentSpy = isRpcFlagOn() ? undefined : vi.spyOn(pkc, "createComment");
            try {
                const getCommentPromise = pkc.getComment({ cid: unloadableCid, abortSignal: abortController.signal });
                const inFlightSpy = rpcGetCommentSpy ?? createCommentSpy!;
                await vi.waitFor(() => expect(inFlightSpy.mock.calls.length).to.equal(1), { timeout: 30000, interval: 20 });

                let comment: Comment | undefined;
                if (createCommentSpy) {
                    comment = <Comment>await createCommentSpy.mock.results[0].value;
                    await vi.waitFor(() => expect(comment!.updatingState).to.equal("fetching-ipfs"), { timeout: 30000, interval: 20 });
                }

                const abortedAt = Date.now();
                abortController.abort();
                const error = await getCommentPromise.then(
                    (): PKCError | undefined => undefined,
                    (e): PKCError | undefined => e as PKCError
                );

                expect(error).to.be.an("Error");
                expect(error?.code).to.equal("ERR_GET_COMMENT_ABORTED");
                // The point of the signal: we come back on abort, not on the comment-ipfs timeout.
                expect(Date.now() - abortedAt).to.be.lessThan(30000);
                // getComment owns the instance it created, so abort has to stop it the same way a
                // successful or timed-out fetch would.
                if (comment) expect(comment.state).to.equal("stopped");
            } finally {
                createCommentSpy?.mockRestore();
                rpcGetCommentSpy?.mockRestore();
            }
        });

        it("rejects immediately when the signal is already aborted", async () => {
            const startedAt = Date.now();
            const error = await pkc.getComment({ cid: unloadableCid, abortSignal: AbortSignal.abort() }).then(
                (): PKCError | undefined => undefined,
                (e): PKCError | undefined => e as PKCError
            );

            expect(error?.code).to.equal("ERR_GET_COMMENT_ABORTED");
            expect(Date.now() - startedAt).to.be.lessThan(30000);
            expect(pkc._updatingComments.size()).to.equal(0);
        });

        it("still loads a comment normally when a signal is given but never fires", async () => {
            // The signal is inert unless it fires, so an unaborted one must not change the outcome.
            const community = <RemoteCommunity>await pkc.createCommunity({ address: signers[0].address });
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const existingCid = community.lastPostCid!;
            await community.stop();
            expect(existingCid).to.be.a("string");

            const abortController = new AbortController();
            const comment = await pkc.getComment({ cid: existingCid, abortSignal: abortController.signal });
            expect(comment.cid).to.equal(existingCid);
            expect(comment.signature).to.be.a("object");
        });
    });
});

// abortSignal lives on getComment()'s argument object, which is the same shape a caller can hand
// createComment(), so a record arriving on the wire with that key has to be rejected rather than
// carried onto the instance.
describe("abortSignal is a reserved comment field", () => {
    it("is included in CommentIpfsReservedFields", () => {
        expect(CommentIpfsReservedFields).to.include("abortSignal");
    });

    it("is included in CommentPubsubMessageReservedFields", () => {
        expect(CommentPubsubMessageReservedFields).to.include("abortSignal");
    });
});
