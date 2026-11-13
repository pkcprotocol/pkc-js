import http, { Server, ServerResponse } from "http";
import type { AddressInfo } from "net";
import { afterEach, expect, it, vi } from "vitest";
import { createMockNameResolver, mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import { calculateIpfsCidV0 } from "../../../dist/node/util.js";
import { getPKCAddressFromPublicKey } from "../../../dist/node/signer/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import validPageFixture from "../../fixtures/valid_page.json" with { type: "json" };
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// pkc.getComment({cid}) loads a comment and starts resolving its author's name in the background. When the
// returned comment then calls update(), update() hands the work to a separate updating instance
// (_setUpNewUpdatingCommentInstance) that the returned comment mirrors. That instance asks for the same author
// on each community update while the returned comment's resolve is still outstanding. Issue #353's dedup
// skipped that ask and never told the updating instance about the verdict, so its author.nameResolved stayed
// undefined until another CommentUpdate arrived.
//
// Gateway-only PKC against a local HTTP server, so no kubo and no test server. Under USE_RPC=1 names are
// resolved on the RPC server, so this runs non-RPC only.
describeSkipIfRpc("comment.update() after pkc.getComment while the author's name resolve is outstanding", () => {
    let pkc: PKC | undefined;
    let server: Server | undefined;

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

    // A local gateway that serves the comment for /ipfs/ requests and holds every other one (the community record)
    // open, so an updating instance stays waiting for its first community update. With holdFirstIpfsRequest it
    // also holds the first /ipfs/ request until releaseFirstIpfsRequest(). The pkc's name resolver holds every
    // resolve until releaseResolver(), then answers with the comment signer's address.
    const servePKCWithHeldResolver = async ({ holdFirstIpfsRequest }: { holdFirstIpfsRequest: boolean }) => {
        const commentIpfs = validPageFixture.comments.find(({ comment }) => "name" in comment.author)!.comment;
        const authorName = (<{ name: string }>commentIpfs.author).name;
        const body = JSON.stringify(commentIpfs);
        const cid = await calculateIpfsCidV0(body);
        const heldResponses: ServerResponse[] = [];
        let heldIpfsResponse: ServerResponse | undefined;
        let ipfsRequests = 0;
        const answer = (res: ServerResponse) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
        };
        server = http.createServer((req, res) => {
            if (!req.url?.startsWith("/ipfs/")) return void heldResponses.push(res);
            ipfsRequests++;
            if (holdFirstIpfsRequest && ipfsRequests === 1) return void (heldIpfsResponse = res);
            answer(res);
        });
        await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
        const gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
        return {
            pkc,
            cid,
            authorName,
            resolverCalls,
            releaseResolver,
            ipfsRequestsReceived: () => ipfsRequests,
            releaseFirstIpfsRequest: () => answer(heldIpfsResponse!)
        };
    };

    it("tells the updating instance about the verdict, and the returned comment emits one update", async () => {
        const { pkc, cid, authorName, resolverCalls, releaseResolver } = await servePKCWithHeldResolver({ holdFirstIpfsRequest: false });

        const comment = await pkc.getComment({ cid });
        await vi.waitFor(() => expect(resolverCalls, "the author's name was never resolved").to.deep.equal([authorName]), {
            timeout: 5000
        });

        await comment.update();
        const updatingInstance = comment._updatingCommentInstance?.comment;
        expect(updatingInstance, "update() did not hand the work to a separate updating instance").to.not.equal(undefined);
        expect(updatingInstance).to.not.equal(comment);
        let updates = 0;
        comment.on("update", () => updates++);
        let updatingInstanceUpdates = 0;
        updatingInstance!.on("update", () => updatingInstanceUpdates++);
        // What the updating instance does on each of its community updates (handleUpdateEventFromCommunity),
        // which the held community record never delivers here
        updatingInstance!._resolveAuthorNamesInBackground();
        updatingInstance!._resolveAuthorNamesInBackground();

        releaseResolver();
        await vi.waitFor(() => expect(comment.author.nameResolved).to.equal(true), { timeout: 5000 });
        await vi.waitFor(
            () => expect(updatingInstance!.author.nameResolved, "the updating instance never heard about the verdict").to.equal(true),
            { timeout: 2000 }
        );
        // Anything else the verdict could still set off (another update) runs right away
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(updates, "the returned comment emitted more than one update for the verdict").to.equal(1);
        expect(updatingInstanceUpdates, "the updating instance emitted more than one update for the verdict").to.equal(1);
        // The updating instance joined the returned comment's resolve instead of starting its own
        expect(resolverCalls).to.deep.equal([authorName]);
    });

    // The other way round: an updating instance is still loading the CommentIpfs when getComment is called, so
    // getComment joins its fetch, and both ask for the author once the comment loads. The updating instance asks
    // first and owns the resolve; getComment's comment joins it. The returned comment then calls update(), which
    // mirrors that updating instance. When the verdict lands, the updating instance hears it first, and the mirror
    // copies author.nameResolved and emits update. The returned comment's own callback then runs and must not emit
    // a second update for the same verdict.
    it("emits one update when the returned comment joined the updating instance's resolve and then mirrors it", async () => {
        const { pkc, cid, authorName, resolverCalls, releaseResolver, ipfsRequestsReceived, releaseFirstIpfsRequest } =
            await servePKCWithHeldResolver({ holdFirstIpfsRequest: true });

        const first = await pkc.createComment({ cid });
        await first.update();
        const updatingInstance = first._updatingCommentInstance?.comment;
        expect(updatingInstance, "update() did not hand the work to a separate updating instance").to.not.equal(undefined);
        await vi.waitFor(() => expect(ipfsRequestsReceived()).to.equal(1), { timeout: 10_000 });

        // getComment does not expose the comment it loads into; spyOn with no implementation calls through
        const createCommentSpy = vi.spyOn(pkc, "createComment");
        const withResourceSpy = vi.spyOn(pkc._inflightFetchManager, "withResource");
        const loading = pkc.getComment({ cid });
        await vi.waitFor(() => expect(withResourceSpy).toHaveBeenCalled(), { timeout: 10_000 });
        expect(ipfsRequestsReceived(), "getComment did not join the updating instance's fetch").to.equal(1);
        const returnedInstance = <Comment>await createCommentSpy.mock.results[0].value;
        const updatingInstanceAsks = vi.spyOn(updatingInstance!._clientsManager, "resolveAuthorNamesInBackground");
        const returnedInstanceAsks = vi.spyOn(returnedInstance._clientsManager, "resolveAuthorNamesInBackground");

        releaseFirstIpfsRequest();
        const comment = await loading;
        expect(comment).to.equal(returnedInstance);
        await vi.waitFor(() => expect(resolverCalls, "the author's name was never resolved").to.deep.equal([authorName]), {
            timeout: 5000
        });
        expect(updatingInstanceAsks).toHaveBeenCalledTimes(1);
        expect(returnedInstanceAsks).toHaveBeenCalledTimes(1);
        expect(
            updatingInstanceAsks.mock.invocationCallOrder[0],
            "getComment's comment asked first, so this is not the flow under test"
        ).toBeLessThan(returnedInstanceAsks.mock.invocationCallOrder[0]);

        await comment.update();
        expect(comment._updatingCommentInstance?.comment, "update() did not mirror the existing updating instance").to.equal(
            updatingInstance
        );
        let updates = 0;
        comment.on("update", () => updates++);

        releaseResolver();
        await vi.waitFor(() => expect(comment.author.nameResolved).to.equal(true), { timeout: 5000 });
        // Anything else the verdict could still set off (another update) runs right away
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(updates, "the returned comment emitted more than one update for the verdict").to.equal(1);
        expect(updatingInstance!.author.nameResolved).to.equal(true);
        expect(resolverCalls).to.deep.equal([authorName]);
    });
});
