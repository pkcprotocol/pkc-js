// Leak suite (#496): RPC publisher against an in-process RPC server.
// The target community's record loads but nobody answers on its pubsub topic.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import PKC from "../../../dist/node/index.js";
import { mockRpcServerPKC, generateMockPost, publishStaticCommunityWithPostInPages } from "../../../dist/node/test/test-util.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type StaticFixture = Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;
type ServerInternals = { publishing: Record<string, { publication: object }> };
type ClientInternals = { _subscriptionEvents: Record<string, unknown>; publishComment: (...args: unknown[]) => Promise<unknown> };
type PublishThresholds = { _publishToDifferentProviderThresholdSeconds: number; _setProviderFailureThresholdSeconds: number };

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
};

// Only meaningful with an RPC client: both tests are about the RPC publish subscription
describeIfRpc("leak: RPC publish teardown", () => {
    let fixture: StaticFixture;
    let serverPKC: PKCType;
    let rpcServer: PKCWsServerType;
    let client: PKCType;

    const server = () => rpcServer as unknown as ServerInternals;
    const rpcClient = () => client._pkcRpcClient as unknown as ClientInternals;
    const counts = () => ({
        clientSubscriptions: Object.keys(rpcClient()._subscriptionEvents).length,
        serverPublishing: Object.keys(server().publishing).length
    });

    beforeAll(async () => {
        fixture = await publishStaticCommunityWithPostInPages();
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("leak-pub-rpc") });
        serverPKC.on("error", () => {});
        let rpcUrl: string;
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "leak-pub-rpc" }));
        client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        client.on("error", () => {});
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await client?.destroy();
        await rpcServer?.destroy(); // destroys serverPKC too
        await fixture?.ipnsObj.pkc.destroy();
    });

    describe("in order", () => {
        it.fails("stop() while the RPC publish call is in flight leaves no subscription on either side", async () => {
            const post = await generateMockPost({ communityAddress: fixture.communityAddress, pkc: client });
            post.on("error", () => {});
            await new Promise((resolve) => setTimeout(resolve, 2000)); // the client's own settings/communities subscriptions land first
            const before = counts();
            let publishCallStarted = false;
            let releaseResponse!: () => void;
            const responseHeld = new Promise<void>((resolve) => (releaseResponse = resolve));
            const original = rpcClient().publishComment.bind(client._pkcRpcClient);
            const spy = vi.spyOn(rpcClient(), "publishComment").mockImplementation(async (...args: unknown[]) => {
                // The server has answered, but the client's publish() has not seen the response yet
                const response = await original(...args);
                publishCallStarted = true;
                await responseHeld;
                return response;
            });
            try {
                const publishing = post.publish();
                publishing.catch(() => {});
                const started = await waitFor(() => publishCallStarted, 60_000);
                await post.stop();
                releaseResponse();
                await publishing.catch(() => {});
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const after = counts();
                expect({
                    started,
                    subscriptionIdKept: (post as unknown as { _rpcPublishSubscriptionId?: number })._rpcPublishSubscriptionId !== undefined,
                    clientSubscriptionsAdded: after.clientSubscriptions - before.clientSubscriptions,
                    serverPublishingAdded: after.serverPublishing - before.serverPublishing
                }).toEqual({ started: true, subscriptionIdKept: false, clientSubscriptionsAdded: 0, serverPublishingAdded: 0 });
            } finally {
                spy.mockRestore();
                await post.stop();
            }
        });

        it.fails("an RPC publish that fails because nobody answers is torn down on both sides", async () => {
            const post = await generateMockPost({ communityAddress: fixture.communityAddress, pkc: client });
            const errors: string[] = [];
            post.on("error", (e: Error & { code?: string }) => errors.push(e.code ?? e.message));
            await new Promise((resolve) => setTimeout(resolve, 2000)); // same settle as above, so the test also holds when run alone
            const before = counts();
            const serverIdsBefore = new Set(Object.keys(server().publishing));
            try {
                await post.publish();
                const newServerIds = Object.keys(server().publishing).filter((id) => !serverIdsBefore.has(id));
                // Shorten the server-side watchdog; its first sleep already started at the default 10 s
                for (const id of newServerIds) {
                    const serverPublication = server().publishing[id].publication as unknown as PublishThresholds;
                    serverPublication._publishToDifferentProviderThresholdSeconds = 1;
                    serverPublication._setProviderFailureThresholdSeconds = 1;
                }
                const failed = await waitFor(() => post.publishingState === "failed", 90_000);
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const after = counts();
                expect({
                    serverRegisteredIt: newServerIds.length,
                    failed,
                    errors,
                    clientStillRegistered: client._publishingPublications.has(post),
                    clientState: post.state,
                    clientSubscriptionsAdded: after.clientSubscriptions - before.clientSubscriptions,
                    serverPublishingAdded: after.serverPublishing - before.serverPublishing
                }).toEqual({
                    serverRegisteredIt: 1,
                    failed: true,
                    errors: [expect.any(String)],
                    clientStillRegistered: false,
                    clientState: "stopped",
                    clientSubscriptionsAdded: 0,
                    serverPublishingAdded: 0
                });
            } finally {
                await post.stop();
            }
        });
    });
});
