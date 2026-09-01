// Regression test for issue #314: over PKC RPC, Comment._updateViaRpc() (src/publications/comment/comment.ts)
// attaches the notification handlers and synchronously calls emitAllPendingMessages(subscriptionId)
// INSIDE update(), replaying every buffered notification before the caller of update() got a
// chance to attach an "error" listener. Any error the server emitted at subscribe time (before
// the JSON-RPC subscribe response) then bubbled to pkc via the listenerCount("error") === 1 rule
// in publication.ts, so callers following the natural `await comment.update();
// comment.on("error", ...)` order never saw it and pkc emitted it as unhandled instead.
// PR #313 fixed this race for RpcRemoteCommunity.update() only; comment.update() still has it.
//
// The server sends notifications for a subscription before returning the subscribe response
// (src/rpc/src/index.ts commentUpdateSubscribe calls sendUpdate() and awaits the server-side
// comment.update() before resolving), and the client buffers notifications for subscription ids
// it does not know yet (src/clients/rpc-client/pkc-rpc-client.ts _pendingSubscriptionMsgs), so
// this ordering is reachable in production whenever the server-side updating instance fails at
// subscribe time (e.g. a stale, already-failed shared instance being reused).
//
// To make that window deterministic, this test runs the PKCWsServer in-process and wraps the
// server pkc's createComment so the server-side comment instance created by
// commentUpdateSubscribe emits a non-retriable error right after its update() resolves — i.e.
// after the subscription listeners are bound and before the subscribe call returns. That is
// exactly "an error the server emitted at subscribe time": the error notification is written to
// the websocket ahead of the subscribe response, lands in the client's pending buffer, and is
// replayed synchronously inside comment.update().
import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC, createSubWithNoChallenge, publishRandomPost } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const RPC_AUTH_KEY = "test-comment-error-at-subscribe-time";
const INJECTED_MARKER = "injectedSubscribeTimeError314";

const isInjectedError = (err: unknown): boolean =>
    Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[INJECTED_MARKER]);

describe("RPC: comment error emitted at subscribe time reaches a listener attached after update() (#314)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;
    let postCid: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.tmp/.pkc-rpc-comment-subscribe-time-error-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPKC = await mockRpcServerPKC({ dataPath });

        // A real comment CID is needed for commentUpdateSubscribe: create+start a local community
        // on the server pkc and publish a post to it.
        const community = await createSubWithNoChallenge({}, serverPKC);
        await community.start();
        await new Promise<void>((resolve) => community.once("update", () => resolve()));
        const publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: serverPKC });
        if (typeof publishedPost.cid !== "string") throw new Error("Test setup failed: published post has no cid");
        postCid = publishedPost.cid;

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as Record<string, Function>;

        // Emit a non-retriable error on the server-side comment instance after the subscription's
        // listeners are bound but before commentUpdateSubscribe returns its response. There is no
        // separate binder method to wrap for comments (commentUpdateSubscribe is registered as a
        // bound function at construction), but the handler fetches its comment instance through
        // pkc.createComment() and then awaits comment.update() as its last step before returning,
        // so wrapping createComment to patch that instance's update() gives the exact window: the
        // error notification is written to the websocket ahead of the subscribe response, which is
        // the deterministic version of a stale, already-failed server-side instance being reused.
        const originalCreateComment = serverPKC.createComment.bind(serverPKC);
        const serverPkcInternals = serverPKC as unknown as Record<string, Function>;
        serverPkcInternals.createComment = async (options: Parameters<PKCType["createComment"]>[0]) => {
            const comment = await originalCreateComment(options);
            if (options && typeof options === "object" && "cid" in options && options.cid === postCid) {
                const originalUpdate = comment.update.bind(comment);
                const commentInternals = comment as unknown as Record<string, Function>;
                commentInternals.update = async () => {
                    await originalUpdate();
                    comment.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
                };
            }
            return comment;
        };
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("listener attached right after await comment.update() receives the subscribe-time error", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        try {
            const comment = await client.createComment({ cid: postCid });

            const commentLevelErrors: unknown[] = [];
            await comment.update();
            // The natural listener order from the caller's perspective: subscribe first, then
            // listen. Nothing has yielded to the event loop between update() resolving and this
            // attach, yet the injected error has already been replayed inside update().
            comment.on("error", (err) => commentLevelErrors.push(err));

            // Give delivery ample time in case a fix defers the replay to a later tick.
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !commentLevelErrors.some(isInjectedError))
                await new Promise((resolve) => setTimeout(resolve, 100));

            // Extra settle window so a duplicate delivery (e.g. a replay that runs twice or a
            // buffer that isn't cleared after draining) would have time to arrive and fail the
            // exactly-once assertion below.
            await new Promise((resolve) => setTimeout(resolve, 500));

            await comment.stop();

            expect({
                injectedErrorsAtCommentListener: commentLevelErrors.filter(isInjectedError).length,
                pkcGotInjectedErrorAsUnhandled: pkcLevelErrors.some(isInjectedError)
            }).toEqual({
                injectedErrorsAtCommentListener: 1, // exactly once: not dropped, not duplicated
                pkcGotInjectedErrorAsUnhandled: false
            });
        } finally {
            await client.destroy();
        }
    });
});
