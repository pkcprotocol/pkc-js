// Regression test for the stop-after-verification misroute over RPC (found by CI on the #299/#314
// fix branch): _postSucessOrFailurePublishing routed its teardown on _rpcPublishSubscriptionId
// instead of on the presence of the RPC client. Once _handleRpcChallengeVerification started
// clearing the id synchronously (before its awaited unsubscribe, so the deferred attach-and-replay
// timer sees teardown immediately), a stop() issued after a completed publish - the natural
// `await publishWithExpectedResult(); await publication.stop();` order every publish test uses -
// found the id already cleared and fell into the local-pubsub teardown branch. That branch can
// never succeed in RPC mode: _updatePubsubState asks for a default pubsub provider and an
// RPC-mode PKC has none, so stop() rejected with ERR_NO_DEFAULT_PUBSUB_PROVIDER.
//
// Comment.stop() only funnels into _postSucessOrFailurePublishing while state === "publishing",
// so the base-class publication types (Vote, CommentEdit, CommentModeration, CommunityEdit) are
// the ones that hit it; this test pins the Vote path. No error injection is needed: a real
// publish against an in-process RPC server whose community has no challenge reproduces it
// deterministically, because the verification handler clears the id synchronously before the
// caller's continuation runs.
import { describe, beforeAll, afterAll, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import {
    mockRpcServerPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    publishWithExpectedResult
} from "../../../dist/node/test/test-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const RPC_AUTH_KEY = "test-publish-stop-after-verification";

describe("RPC: stop() after a completed publish stays on the RPC teardown path", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let serverCommunity: Awaited<ReturnType<typeof createSubWithNoChallenge>>;
    let fixturePostCid: string;
    let rpcUrl: string;

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-rpc-publish-stop-after-verification-test") });

        serverCommunity = await createSubWithNoChallenge({}, serverPKC);
        await serverCommunity.start();

        // Publish the post the vote targets directly through the server PKC (local community
        // publish, no RPC involved) so the client side of the test exercises only the vote flow
        const post = await publishRandomPost({ communityAddress: serverCommunity.address, pkc: serverPKC });
        if (!post.cid) throw new Error("Test setup failed: fixture post has no cid after publishing");
        fixturePostCid = post.cid;

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("vote.stop() after a successful publish resolves without misrouting to the local-pubsub teardown", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        const pkcLevelErrors: unknown[] = [];
        client.on("error", (err) => pkcLevelErrors.push(err));

        try {
            const vote = await client.createVote({
                communityAddress: serverCommunity.address,
                commentCid: fixturePostCid,
                vote: 1,
                signer: await client.createSigner()
            });

            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });

            // By the time the challengeverification await above resolves,
            // _handleRpcChallengeVerification has already cleared _rpcPublishSubscriptionId
            // synchronously, so this stop() sees no subscription id and must still route on the
            // RPC client's presence rather than fall into the local-pubsub teardown
            await vote.stop();

            expect(pkcLevelErrors).to.deep.equal([]);
        } finally {
            await client.destroy();
        }
    });
});
