import { beforeAll, afterAll, afterEach } from "vitest";
import tempy from "tempy";
import net from "node:net";

import PKCWsServerModule from "../../../../dist/node/rpc/src/index.js";
import { restorePKCJs } from "../../../../dist/node/rpc/src/lib/pkc-js/index.js";
import {
    describeSkipIfRpc,
    mockRpcServerForTests,
    mockRpcServerPKC,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createPendingApprovalChallenge,
    publishCommentToModQueue
} from "../../../../dist/node/test/test-util.js";
import PKC from "../../../../dist/node/index.js";
import { messages } from "../../../../dist/node/errors.js";
import { createMockPubsubClient } from "../../../../dist/node/test/mock-ipfs-client.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";

const { PKCWsServer: createPKCWsServer, setPKCJs } = PKCWsServerModule;

type PKCWsServerType = Awaited<ReturnType<typeof createPKCWsServer>>;

type MockPubsubClientType = ReturnType<typeof createMockPubsubClient>;

const getAvailablePort = async (): Promise<number> =>
    await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", (error) => {
            server.close();
            reject(error);
        });
        server.listen(0, () => {
            const address = server.address();
            server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
        });
    });

describeSkipIfRpc("PKC RPC server stress publish", function () {
    let rpcServer: PKCWsServerType | undefined;
    let plebbit: PKCType;
    let subplebbit: RpcLocalCommunity;
    let moderatorSigner: SignerType;
    let rpcPort: number;
    const stressClients: PKCType[] = [];
    let pubsubModified = false;

    function configureServerPubsubClients(options: { dropRate?: number; throwOnPublish?: boolean } = {}) {
        const { dropRate, throwOnPublish } = options;
        const pubsubClients = rpcServer?.plebbit?.clients?.pubsubKuboRpcClients;
        if (!pubsubClients) return;
        for (const pubsubUrl of Object.keys(pubsubClients)) {
            const wrapper = pubsubClients[pubsubUrl] as unknown as { _client?: MockPubsubClientType; destroy?: () => Promise<void> };
            if (!wrapper) continue;
            if (wrapper._client?.destroy) {
                try {
                    wrapper._client.destroy();
                } catch {}
            }
            const mockClient = createMockPubsubClient({ dropRate });
            if (throwOnPublish) {
                const originalPublish = mockClient.pubsub.publish;
                mockClient.pubsub.publish = async (...publishArgs: Parameters<typeof mockClient.pubsub.publish>) => {
                    try {
                        await originalPublish?.(...publishArgs);
                    } catch {}
                    throw new Error("MOCK_PUBSUB_FORCED_FAILURE");
                };
            }
            wrapper._client = mockClient;
            wrapper.destroy = mockClient.destroy.bind(mockClient);
        }
    }

    beforeAll(async () => {
        setPKCJs(async (options: Record<string, unknown>) => mockRpcServerPKC({ dataPath: tempy.directory(), ...(options || {}) }));

        const port = await getAvailablePort();
        rpcPort = port;
        const dataPath = tempy.directory();
        rpcServer = await createPKCWsServer({ port, plebbitOptions: { dataPath } });
        mockRpcServerForTests(rpcServer);
        rpcServer?.plebbit?.setMaxListeners?.(1000);
        configureServerPubsubClients();

        plebbit = await PKC({ pkcRpcClientsOptions: [`ws://127.0.0.1:${port}`], dataPath: undefined, httpRoutersOptions: [] });
        subplebbit = (await plebbit.createCommunity({})) as RpcLocalCommunity;
        subplebbit.setMaxListeners(100);
        moderatorSigner = await plebbit.createSigner();
        await subplebbit.edit({
            roles: {
                [moderatorSigner.address]: { role: "moderator" }
            },
            settings: {
                challenges: [createPendingApprovalChallenge()]
            }
        });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    afterAll(async () => {
        if (subplebbit) {
            try {
                await subplebbit.stop();
            } catch {}
        }
        if (plebbit) await plebbit.destroy();
        if (rpcServer) await rpcServer.destroy();
        restorePKCJs();
    });

    afterEach(async () => {
        if (pubsubModified) {
            configureServerPubsubClients();
            pubsubModified = false;
        }
        if (stressClients.length === 0) return;
        await Promise.allSettled(stressClients.splice(0).map((client) => client.destroy().catch(() => {})));
    });

    const createPKCRpcClient = async (): Promise<PKCType> => {
        const client = await PKC({
            pkcRpcClientsOptions: [`ws://127.0.0.1:${rpcPort}`],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        stressClients.push(client);
        return client;
    };

    it("keeps delivering challenge verifications when multiple RPC clients reject edits concurrently", async () => {
        const PARALLEL_EDITS = 20;
        const expectedReason = messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT;

        const parallelFlows = Array.from({ length: PARALLEL_EDITS }).map((_, i) => {
            return (async () => {
                const client = await createPKCRpcClient();
                const authorSigner = await client.createSigner();
                const pendingComment = await client.createComment({
                    communityAddress: subplebbit.address,
                    content: `stress comment ${i}`,
                    title: `stress ${i}`,
                    signer: authorSigner,
                    challengeRequest: { challengeAnswers: ["pending"] }
                });
                await publishWithExpectedResult({ publication: pendingComment, expectedChallengeSuccess: true });

                const rejection = await plebbit.createCommentModeration({
                    communityAddress: subplebbit.address,
                    commentCid: pendingComment.cid!,
                    signer: moderatorSigner,
                    commentModeration: { approved: false, reason: `reject-${i}` }
                });
                await publishWithExpectedResult({ publication: rejection, expectedChallengeSuccess: true });

                const edit = await client.createCommentEdit({
                    communityAddress: subplebbit.address,
                    commentCid: pendingComment.cid!,
                    reason: "stress-edit",
                    content: "text to edit on pending comment",
                    signer: authorSigner
                });

                await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: false, expectedReason: expectedReason });
            })();
        });

        const results = await Promise.allSettled(parallelFlows);
        const failures = results.filter((result) => result.status === "rejected");

        expect(
            failures.length,
            "RPC server failed to deliver challenge verification for some comment edits when stress publishing in parallel"
        ).to.equal(0);
    });

    it("surfaces deterministic errors when pubsub providers drop challenge exchanges", async () => {
        configureServerPubsubClients({ throwOnPublish: true });
        pubsubModified = true;
        await new Promise((r) => setTimeout(r, 2000));

        const ATTEMPTS = 10;
        const flows = Array.from({ length: ATTEMPTS }).map((_, i) => {
            return (async () => {
                const client = await createPKCRpcClient();
                const authorSigner = await client.createSigner();
                const pendingComment = await client.createComment({
                    communityAddress: subplebbit.address,
                    content: `drop stress comment ${i}`,
                    title: `drop stress ${i}`,
                    signer: authorSigner,
                    challengeRequest: { challengeAnswers: ["pending"] }
                });
                await publishWithExpectedResult({ publication: pendingComment, expectedChallengeSuccess: true });

                const rejection = await plebbit.createCommentModeration({
                    communityAddress: subplebbit.address,
                    commentCid: pendingComment.cid!,
                    signer: moderatorSigner,
                    commentModeration: { approved: false, reason: `drop-reject-${i}` }
                });
                await publishWithExpectedResult({ publication: rejection, expectedChallengeSuccess: true });

                const edit = await client.createCommentEdit({
                    communityAddress: subplebbit.address,
                    commentCid: pendingComment.cid!,
                    reason: "drop-stress-edit",
                    content: "drop text to edit on pending comment",
                    signer: authorSigner
                });

                return publishWithExpectedResult({
                    publication: edit,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT
                });
            })();
        });

        const results = await Promise.allSettled(flows);
        const timedOut = results.filter((result) => result.status === "rejected");

        expect(timedOut.length, "RPC server should surface forced pubsub failures as immediate errors instead of timing out").to.equal(0);
    });

    it("keeps pending-approval settings stable while publishng many pending comments", async () => {
        const publishAttempts = 40;

        const runPublishFlow = async (index: number) => {
            const client = await createPKCRpcClient();
            const authorSigner = await client.createSigner();

            const { comment: pendingComment, challengeVerification } = await publishCommentToModQueue({
                plebbit: client,
                subplebbit: subplebbit,
                commentProps: {
                    communityAddress: subplebbit.address,
                    content: `toggle stress comment ${index}`,
                    title: `toggle stress ${index}`,
                    signer: authorSigner,
                    challengeRequest: { challengeAnswers: ["pending"] } // when we provide the correct answer we go to pending approval
                }
            });

            const rejection = await plebbit.createCommentModeration({
                communityAddress: subplebbit.address,
                commentCid: pendingComment.cid!,
                signer: moderatorSigner,
                commentModeration: { approved: false, reason: `toggle-reject-${index}` }
            });
            await publishWithExpectedResult({ publication: rejection, expectedChallengeSuccess: true });

            const edit = await client.createCommentEdit({
                communityAddress: subplebbit.address,
                commentCid: pendingComment.cid!,
                reason: "toggle-stress-edit",
                content: "toggle edit content",
                signer: authorSigner
            });
            await publishWithExpectedResult({
                publication: edit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT
            });
        };

        const batchSize = 10;
        for (let i = 0; i < publishAttempts; i += batchSize) {
            const batch = Array.from({ length: Math.min(batchSize, publishAttempts - i) }, (_, j) => runPublishFlow(i + j));
            await Promise.all(batch);
        }
    });
});
