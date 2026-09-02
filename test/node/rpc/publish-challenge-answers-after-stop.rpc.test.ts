// Regression test for the publishChallengeAnswers misroute over PKC RPC (found by review on PR
// #313). publishChallengeAnswers routed to the RPC server only when BOTH an RPC client existed
// AND _rpcPublishSubscriptionId was a number. Once the subscription id is cleared (the exchange
// concluded, the publication was stopped, or publish() was never called), the call fell through
// to the local-pubsub branch, which can never succeed in RPC mode (the exchange runs server-side
// and the client-side _challengeExchanges carry no signer), and died with a misleading error
// ("No challenge exchanges with challenge" or "Signer is undefined for this challenge
// exchange"). PR #313's synchronous id clearing widened the window in which a racing answer hits
// this by one RPC round trip, so the routing is hardened here: with an RPC client the call
// always takes the RPC branch, and a missing subscription id raises a clear
// ERR_RPC_CLIENT_NO_ACTIVE_PUBLISH_SUBSCRIPTION instead.
import { describe, beforeAll, afterAll, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { mockRpcServerPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

const RPC_AUTH_KEY = "test-publish-challenge-answers-after-stop";

describe("RPC: publishChallengeAnswers after the publish subscription is gone raises a clear error", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let serverCommunity: Awaited<ReturnType<typeof createSubWithNoChallenge>>;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = uniqueTmpDataPath("pkc-rpc-answers-after-stop-test");
        serverPKC = await mockRpcServerPKC({ dataPath });

        serverCommunity = await createSubWithNoChallenge({}, serverPKC);
        await serverCommunity.start();

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("answers published after stop() reject with ERR_RPC_CLIENT_NO_ACTIVE_PUBLISH_SUBSCRIPTION", async () => {
        const client = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });

        let comment: Comment | undefined;
        try {
            const signer = await client.createSigner();
            comment = await client.createComment({
                signer,
                communityAddress: serverCommunity.address,
                title: `Answers-after-stop repro - ${Date.now()}`,
                content: "publishChallengeAnswers must not fall into the local-pubsub branch over RPC"
            });
            comment.on("error", () => undefined); // The publish outcome is irrelevant here

            await comment.publish();
            // Stop the publication: teardown clears _rpcPublishSubscriptionId, the state the
            // routing guard used to misinterpret as "publish locally"
            await comment.stop();

            let thrown: unknown;
            try {
                await comment.publishChallengeAnswers({ challengeAnswers: ["2"] });
            } catch (e) {
                thrown = e;
            }

            expect({
                threw: Boolean(thrown),
                code: (thrown as { code?: string } | undefined)?.code
            }).toEqual({
                threw: true,
                code: "ERR_RPC_CLIENT_NO_ACTIVE_PUBLISH_SUBSCRIPTION"
            });
        } finally {
            if (comment) await comment.stop();
            await client.destroy();
        }
    });
});
