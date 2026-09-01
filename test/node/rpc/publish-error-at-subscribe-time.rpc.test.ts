// Regression test for issue #314: PR #313 fixed the subscribe-time notification replay for
// RpcRemoteCommunity.update() only. publication.publish() over RPC still attaches its
// notification handlers and synchronously calls emitAllPendingMessages(subscriptionId) INSIDE
// the awaited publish() call (src/publications/publication.ts _publishWithRpc), replaying every
// buffered notification before the caller of publish() gets a chance to attach an "error"
// listener. Any error the server emitted at publish-subscribe time (before the JSON-RPC publish
// response) then bubbles to pkc via the listenerCount("error") === 1 rule in the Publication
// constructor, so callers following the natural `await comment.publish(); comment.on("error",
// ...)` order never see it and pkc emits it as unhandled instead.
//
// The server sends notifications for a publish subscription before returning the subscribe
// response (src/rpc/src/index.ts publishComment attaches its listeners and awaits
// comment.publish() before resolving with { subscriptionId }), and the client buffers
// notifications for subscription ids it does not know yet
// (src/clients/rpc-client/pkc-rpc-client.ts _pendingSubscriptionMsgs), so this ordering is
// reachable in production whenever the server-side publication errors during the awaited
// publish() call (e.g. a pubsub provider failing immediately).
//
// To make that window deterministic, this test runs the PKCWsServer in-process and wraps its
// _createCommentInstanceFromPublishCommentParams so the server-side comment's publish() emits a
// non-retriable error instead of publishing. publishComment awaits that publish() AFTER binding
// all its subscription listeners and BEFORE writing the JSON-RPC response, so the error
// notification is written to the websocket ahead of the publish response, lands in the client's
// pending buffer, and is replayed synchronously inside the client's comment.publish().
import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

const RPC_AUTH_KEY = "test-publish-error-at-subscribe-time";
const INJECTED_MARKER = "injectedSubscribeTimePublishError314";

const isInjectedError = (err: unknown): boolean =>
    Boolean(err && typeof err === "object" && (err as { details?: Record<string, unknown> }).details?.[INJECTED_MARKER]);

describe("RPC: publish error emitted at subscribe time reaches a listener attached after publish() (#314)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let serverCommunity: Awaited<ReturnType<typeof createSubWithNoChallenge>>;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.tmp/.pkc-rpc-publish-subscribe-time-error-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPKC = await mockRpcServerPKC({ dataPath });

        // A real, started local community so the client's publish() can fetch it over RPC for
        // signing. The challenge exchange itself never runs: the server-side comment's publish()
        // is replaced below.
        serverCommunity = await createSubWithNoChallenge({}, serverPKC);
        await serverCommunity.start();

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as Record<string, Function>;

        // Make the server-side comment's publish() emit a non-retriable error instead of
        // publishing. publishComment awaits comment.publish() after all subscription listeners
        // (including the error forwarder) are bound and before the JSON-RPC response is written,
        // so the error notification deterministically precedes the publish response on the wire —
        // the deterministic version of the server-side publication failing during the awaited
        // publish() call.
        const originalCreate = server._createCommentInstanceFromPublishCommentParams.bind(rpcServer);
        server._createCommentInstanceFromPublishCommentParams = async (params: unknown) => {
            const comment = (await originalCreate(params)) as Comment;
            (comment as unknown as Record<string, Function>).publish = async () => {
                comment.emit("error", new PKCError("ERR_INVALID_JSON", { [INJECTED_MARKER]: true }));
            };
            return comment;
        };
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("listener attached right after await comment.publish() receives the subscribe-time error", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        let comment: Comment | undefined;
        try {
            const signer = await client.createSigner();
            comment = await client.createComment({
                signer,
                communityAddress: serverCommunity.address,
                title: `Repro post for #314 - ${Date.now()}`,
                content: "The injected error notification precedes the publish JSON-RPC response"
            });

            const publicationLevelErrors: unknown[] = [];
            // If a fix routes the buffered subscribe-time error into the publish() rejection
            // instead of a later listener, that is an acceptable catchable path too.
            let publishRejectedWithInjectedError = false;
            try {
                await comment.publish();
            } catch (e) {
                if (isInjectedError(e)) publishRejectedWithInjectedError = true;
                else throw e;
            }
            // The natural listener order from the caller's perspective: publish first, then
            // listen. Nothing has yielded to the event loop between publish() settling and this
            // attach, yet today the injected error has already been replayed inside publish().
            comment.on("error", (err) => publicationLevelErrors.push(err));

            // Give delivery ample time in case a fix defers the replay to a later tick.
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline && !publicationLevelErrors.some(isInjectedError) && !publishRejectedWithInjectedError)
                await new Promise((resolve) => setTimeout(resolve, 100));

            // Extra settle window so a duplicate delivery (e.g. a replay that runs twice or a
            // buffer that isn't cleared after draining) would have time to arrive and fail the
            // exactly-once assertion below.
            await new Promise((resolve) => setTimeout(resolve, 500));

            const injectedAtPublicationListener = publicationLevelErrors.filter(isInjectedError).length;
            expect({
                // Desired: the injected error reaches a catchable path — either the listener
                // attached right after the await (exactly once: not dropped, not duplicated) or
                // the publish() rejection — and never surfaces only as an unhandled pkc error.
                injectedErrorReachedCatchablePath: injectedAtPublicationListener === 1 || publishRejectedWithInjectedError,
                injectedErrorsAtPublicationListener: publishRejectedWithInjectedError ? 0 : injectedAtPublicationListener,
                pkcGotInjectedErrorAsUnhandled: pkcLevelErrors.some(isInjectedError)
            }).toEqual({
                injectedErrorReachedCatchablePath: true,
                injectedErrorsAtPublicationListener: publishRejectedWithInjectedError ? 0 : 1,
                pkcGotInjectedErrorAsUnhandled: false
            });
        } finally {
            if (comment) await comment.stop();
            await client.destroy();
        }
    });
});
