// Issue #353's RPC half. When a community runs behind an RPC server, the name resolvers live on the server,
// so a moderator whose role key is a domain sees only whatever the verification carries: the debug line
// explaining that the node cannot resolve names at all is not even on their machine. This stands up its own
// PKCWsServer, because the shared test server's resolvers cannot be reconfigured per test.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { temporaryDirectory } from "tempy";
import net from "node:net";

import PKCWsServerModule from "../../../dist/node/rpc/src/index.js";
import PKC from "../../../dist/node/index.js";
import {
    createMockNameResolver,
    mockPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import signers from "../../fixtures/signers.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CreatePKCWsServerOptions } from "../../../dist/node/rpc/src/types.js";
import type { NameResolver } from "../../../dist/node/types.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

const { PKCWsServer: createPKCWsServer } = PKCWsServerModule;
type PKCWsServerType = Awaited<ReturnType<typeof createPKCWsServer>>;

const getAvailablePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", (e) => {
            server.close();
            reject(e);
        });
        server.listen(0, () => {
            const address = server.address();
            server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
        });
    });

const ownerSigner = signers[6];

// Uses its own PKCWsServer so the server-side resolver can be made to fail on demand, which the shared
// test server cannot do.
describeSkipIfRpc("resolver failure surfaces through the RPC server (#353)", () => {
    let seedPkc: PKCType;
    let rpcServer: PKCWsServerType;
    let clientPkc: PKCType;
    let community: RpcLocalCommunity;
    let post: CommentIpfsWithCidDefined;
    const ownerDomain = `owner-353-${Date.now()}.bso`;
    const resolverShouldThrow = { value: false };

    beforeAll(async () => {
        // Only used to borrow the local kubo/router wiring for the server's own PKC.
        seedPkc = await mockPKC();
        const port = await getAvailablePort();

        // The resolver object lives in this process and is handed to the server's PKC, so the flag below
        // reaches the server side even though the resolution itself happens there.
        const resolver: NameResolver = createMockNameResolver({
            key: `rpc-353-resolver-${Date.now()}`,
            resolveFunction: async ({ name }) => {
                if (resolverShouldThrow.value) throw new Error("resolver is down");
                if (name === ownerDomain) return { publicKey: ownerSigner.address };
                return undefined;
            }
        });

        const opts: CreatePKCWsServerOptions = {
            port,
            pkcOptions: {
                kuboRpcClientsOptions: seedPkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: seedPkc.httpRoutersOptions,
                dataPath: temporaryDirectory(),
                nameResolvers: [resolver],
                resolveAuthorNames: false
            } as CreatePKCWsServerOptions["pkcOptions"]
        };
        rpcServer = await createPKCWsServer(opts);

        clientPkc = await PKC({ pkcRpcClientsOptions: [`ws://127.0.0.1:${port}`], dataPath: undefined, httpRoutersOptions: [] });

        community = <RpcLocalCommunity>await clientPkc.createCommunity({});
        await community.edit({ roles: { [ownerDomain]: { role: "moderator" } }, settings: { challenges: [] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        post = (await publishRandomPost({ communityAddress: community.address, pkc: clientPkc })) as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        resolverShouldThrow.value = false;
        if (community) await community.delete();
        if (clientPkc) await clientPkc.destroy();
        // destroy() on the server also destroys the PKC it built for itself.
        if (rpcServer) await rpcServer.destroy();
        if (seedPkc) await seedPkc.destroy();
    });

    it("pkc.resolveAuthorName rejects across the wire instead of answering null", async () => {
        resolverShouldThrow.value = true;
        // Returning {resolvedAuthorName: null} here would be the same conflation one layer up: an RPC client
        // could not tell "no such name" from "the node we are talking to is broken".
        // maxAge 0 so this actually reaches the resolver: the role edit above resolved and persisted the name.
        await expect(clientPkc.resolveAuthorName({ name: ownerDomain, cache: { maxAge: 0 } })).rejects.toMatchObject({
            code: "ERR_ALL_NAME_RESOLVERS_FAILED"
        });
    });

    it("resolves normally once the server's resolvers recover", async () => {
        resolverShouldThrow.value = false;
        const resolved = await clientPkc.resolveAuthorName({ name: ownerDomain, cache: { maxAge: 0 } });
        expect(resolved.resolvedAuthorName).to.equal(ownerSigner.address);
    });

    it("carries the resolver-failure reason to the moderator on the other side of the RPC server", async () => {
        resolverShouldThrow.value = true;
        const moderation = await clientPkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: post.cid,
            commentModeration: { pinned: true },
            author: { address: ownerDomain },
            signer: ownerSigner
        });
        await publishWithExpectedResult({
            publication: moderation,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME
        });
    });
});
