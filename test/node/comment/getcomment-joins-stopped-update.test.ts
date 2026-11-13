import http, { Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { sha256 } from "js-sha256";
import { afterEach, expect, it, vi } from "vitest";
import { createMockNameResolver, mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import { calculateIpfsCidV0 } from "../../../dist/node/util.js";
import { getPKCAddressFromPublicKey } from "../../../dist/node/signer/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import validPageFixture from "../../fixtures/valid_page.json" with { type: "json" };
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// pkc.getComment({cid}) while an updating Comment is still loading the same CommentIpfs joins that
// comment's in-flight fetch (InflightFetchManager). The fetch runs under the updating comment's stop
// signal, so stopping that comment used to reject getComment with "Failed to load CommentIpfs": its
// comment saw an AbortError, took it for its own stop, and gave up silently. getComment never
// cancelled anything, so it has to load the comment. A getComment that was itself cancelled, or whose
// pkc is being destroyed, must not fetch again though.
//
// Gateway-only PKC against a local HTTP server, so no kubo and no test server. Under USE_RPC=1 the
// fetch happens on the RPC server, so this runs non-RPC only.
describeSkipIfRpc("pkc.getComment joining the CommentIpfs fetch of a comment that is then stopped", () => {
    let pkc: PKC | undefined;
    let server: Server | undefined;
    let requestsReceived = 0;

    afterEach(async () => {
        vi.restoreAllMocks();
        await pkc?.destroy();
        pkc = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            server = undefined;
        }
    });

    const settled = <T>(promise: Promise<T>): Promise<{ value?: T; error?: PKCError }> =>
        promise.then(
            (value) => ({ value }),
            (error: PKCError) => ({ error })
        );

    // A local gateway that holds the first request (the updating comment's fetch) open and serves the
    // later ones, and a comment updating from it whose fetch is in flight
    const startUpdatingCommentWithHeldFetch = async () => {
        const commentIpfs = validPageFixture.comments[0].comment;
        const body = JSON.stringify(commentIpfs);
        const cid = await calculateIpfsCidV0(body);

        const heldResponses: ServerResponse[] = [];
        requestsReceived = 0;
        server = http.createServer((_req, res) => {
            requestsReceived++;
            if (requestsReceived === 1) return void heldResponses.push(res);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        pkc = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: [gatewayUrl] } });

        const updatingComment = await pkc.createComment({ cid });
        await updatingComment.update();
        await vi.waitFor(() => expect(requestsReceived).to.equal(1), { timeout: 10_000 });
        const answerHeldFetch = () => {
            for (const res of heldResponses) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(body);
            }
        };
        return { cid, commentIpfs, updatingComment, answerHeldFetch };
    };

    it("loads the comment instead of rejecting with the other comment's cancellation", async () => {
        const { cid, commentIpfs, updatingComment } = await startUpdatingCommentWithHeldFetch();

        const withResourceSpy = vi.spyOn(pkc!._inflightFetchManager, "withResource");
        const loading = settled(pkc!.getComment({ cid }));
        await vi.waitFor(() => expect(withResourceSpy).toHaveBeenCalled(), { timeout: 10_000 });
        expect(requestsReceived, "getComment joined the in-flight fetch instead of starting its own").to.equal(1);

        await updatingComment.stop();

        const { value: comment, error } = await loading;
        expect(error?.message, "getComment rejected with the stopped comment's cancellation").to.equal(undefined);
        expect(comment?.cid).to.equal(cid);
        expect(comment?.content).to.equal(commentIpfs.content);
        expect(requestsReceived).to.equal(2);
    });

    it("an aborted getComment does not fetch again when the comment whose fetch it joined is stopped", async () => {
        const { cid, updatingComment } = await startUpdatingCommentWithHeldFetch();

        // getComment does not expose the comment it loads into; spyOn with no implementation calls through
        const createCommentSpy = vi.spyOn(pkc!, "createComment");
        const withResourceSpy = vi.spyOn(pkc!._inflightFetchManager, "withResource");
        const getCommentAbort = new AbortController();
        const loading = settled(pkc!.getComment({ cid, abortSignal: getCommentAbort.signal }));
        await vi.waitFor(() => expect(withResourceSpy).toHaveBeenCalled(), { timeout: 10_000 });
        expect(requestsReceived, "getComment joined the in-flight fetch instead of starting its own").to.equal(1);
        const getCommentInstance = <Comment>await createCommentSpy.mock.results[0].value;
        const joinedFetch = settled(<Promise<unknown>>withResourceSpy.mock.results[0].value);
        let updatesAfterAbort = 0;
        getCommentInstance.on("update", () => updatesAfterAbort++);

        getCommentAbort.abort();
        expect((await loading).error?.code).to.equal("ERR_GET_COMMENT_ABORTED");

        await updatingComment.stop();

        const joined = await joinedFetch;
        expect(joined.error?.name, "the aborted getComment fetched the comment again").to.equal("AbortError");
        // Anything the settled fetch could still set off (a request, an update) starts right away
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(requestsReceived, "the aborted getComment sent its own request").to.equal(1);
        expect(updatesAfterAbort, "the aborted getComment's comment emitted update").to.equal(0);
    });

    // The other way round: the fetch the aborted getComment joined is not cancelled, it succeeds. getComment has
    // stopped its comment by then, and that comment must not be handed the record and emit "update".
    it("an aborted getComment's comment is not loaded when the fetch it joined succeeds afterwards", async () => {
        const { cid, updatingComment, answerHeldFetch } = await startUpdatingCommentWithHeldFetch();

        // getComment does not expose the comment it loads into; spyOn with no implementation calls through
        const createCommentSpy = vi.spyOn(pkc!, "createComment");
        const withResourceSpy = vi.spyOn(pkc!._inflightFetchManager, "withResource");
        const getCommentAbort = new AbortController();
        const loading = settled(pkc!.getComment({ cid, abortSignal: getCommentAbort.signal }));
        await vi.waitFor(() => expect(withResourceSpy).toHaveBeenCalled(), { timeout: 10_000 });
        expect(requestsReceived, "getComment joined the in-flight fetch instead of starting its own").to.equal(1);
        const getCommentInstance = <Comment>await createCommentSpy.mock.results[0].value;
        const joinedFetch = settled(<Promise<unknown>>withResourceSpy.mock.results[0].value);
        let updatesAfterAbort = 0;
        getCommentInstance.on("update", () => updatesAfterAbort++);

        getCommentAbort.abort();
        expect((await loading).error?.code).to.equal("ERR_GET_COMMENT_ABORTED");

        answerHeldFetch();
        await vi.waitFor(() => expect(updatingComment.raw.comment, "the updating comment never loaded").to.not.equal(undefined), {
            timeout: 10_000
        });
        try {
            expect((await joinedFetch).error?.name, "the aborted getComment was handed the record").to.equal("AbortError");
            // Anything the settled fetch could still set off (an update) starts right away
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(updatesAfterAbort, "the aborted getComment's comment emitted update").to.equal(0);
            expect(getCommentInstance.raw.comment, "the aborted getComment's comment was loaded").to.equal(undefined);
        } finally {
            await updatingComment.stop();
        }
    });

    it("a getComment does not fetch again when pkc.destroy() stops the comment whose fetch it joined", async () => {
        const { cid } = await startUpdatingCommentWithHeldFetch();

        const withResourceSpy = vi.spyOn(pkc!._inflightFetchManager, "withResource");
        const loading = settled(pkc!.getComment({ cid }));
        await vi.waitFor(() => expect(withResourceSpy).toHaveBeenCalled(), { timeout: 10_000 });
        expect(requestsReceived, "getComment joined the in-flight fetch instead of starting its own").to.equal(1);
        const joinedFetch = settled(<Promise<unknown>>withResourceSpy.mock.results[0].value);

        // Destroyed here, so afterEach does not destroy it again
        const destroyedPKC = pkc!;
        pkc = undefined;
        await destroyedPKC.destroy();

        const joined = await joinedFetch;
        expect(joined.error?.name, "getComment fetched the comment again during destroy").to.equal("AbortError");
        const { value: comment, error } = await loading;
        expect(comment, "getComment resolved with a comment fetched during destroy").to.equal(undefined);
        expect(error?.message).to.equal("Failed to load CommentIpfs");
        expect(requestsReceived, "getComment sent its own request during destroy").to.equal(1);
    });
});

// getComment loads under its comment's stop signal and stops the comment before it returns. The loaded
// comment resolves its author's name in the background, and that resolve has to outlive getComment:
// its verdict lands on the returned comment and in the pkc-wide cache (docs/protocol/community-lists.md,
// "same as getComment").
//
// Gateway-only PKC against a local HTTP server, with a name resolver on this pkc. Under USE_RPC=1 the fetch and
// the author name resolve happen on the RPC server, which neither the gateway nor the resolver here reach, so this
// runs non-RPC only.
describeSkipIfRpc("pkc.getComment and its comment's background author name resolve", () => {
    let pkc: PKC | undefined;
    let server: Server | undefined;

    afterEach(async () => {
        await pkc?.destroy();
        pkc = undefined;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            server = undefined;
        }
    });

    // A local gateway that serves the comment, and a pkc whose name resolver holds every resolve until released
    const servePKCWithHeldResolver = async () => {
        const commentIpfs = validPageFixture.comments.find(({ comment }) => "name" in comment.author)!.comment;
        const authorName = (<{ name: string }>commentIpfs.author).name;
        const body = JSON.stringify(commentIpfs);
        const cid = await calculateIpfsCidV0(body);
        server = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        // Holds every resolve until released, then answers with the comment signer's address
        const resolverCalls: string[] = [];
        let releaseResolver = () => {};
        const held = new Promise<void>((resolve) => (releaseResolver = resolve));
        const resolver = createMockNameResolver({
            resolveFunction: async ({ name }) => {
                resolverCalls.push(name);
                await held;
                return { publicKey: await getPKCAddressFromPublicKey(commentIpfs.signature.publicKey) };
            }
        });
        pkc = await mockGatewayPKC({ mockResolve: false, pkcOptions: { ipfsGatewayUrls: [gatewayUrl], nameResolvers: [resolver] } });
        return { pkc, cid, authorName, commentIpfs, resolverCalls, releaseResolver };
    };

    it("keeps resolving the author's name after getComment returns", async () => {
        const { pkc, cid, authorName, commentIpfs, resolverCalls, releaseResolver } = await servePKCWithHeldResolver();

        const comment = await pkc.getComment({ cid });
        expect(comment.state).to.equal("stopped");
        let updates = 0;
        comment.on("update", () => updates++);
        await vi.waitFor(() => expect(resolverCalls, "the author's name was never resolved").to.deep.equal([authorName]), {
            timeout: 5000
        });

        releaseResolver();
        await vi.waitFor(() => expect(comment.author.nameResolved, "getComment cancelled its comment's resolve").to.equal(true), {
            timeout: 5000
        });
        expect(updates).to.equal(1);
        expect(pkc._memCaches.nameResolvedCache.get(sha256(authorName + commentIpfs.signature.publicKey))).to.equal(true);
    });
});
