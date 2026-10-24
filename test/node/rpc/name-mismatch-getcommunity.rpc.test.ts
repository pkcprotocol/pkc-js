// getCommunity() by a name the community's record does not claim rejects with
// ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME. Over RPC the refusal happens on the server, so
// this suite runs the PKCWsServer in-process to check what the client cannot see: once the client's
// getCommunity rejects, the server has dropped the subscription and stopped the updating instance it
// created for it, instead of polling the community for a subscriber that is gone.
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, pollUntil, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import {
    mockRpcServerForTests,
    mockRpcServerPKC,
    publishStaticCommunityWithPostInPages,
    selfResolvingMockNameForAddress
} from "../../../dist/node/test/test-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

const RPC_AUTH_KEY = "test-name-mismatch-getcommunity";

describe("getCommunity over RPC by a name the record does not claim", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;

    // (connectionId, subscriptionId) of every community update subscription the server bound. A client
    // also holds connect-time subscriptions (settings, communities list), which are not under test.
    const communityUpdateSubscriptions: { connectionId: string; subscriptionId: number }[] = [];
    const countLiveCommunityUpdateSubscriptions = (): number => {
        const cleanups = (rpcServer as unknown as { subscriptionCleanups: Record<string, Record<number, unknown>> }).subscriptionCleanups;
        return communityUpdateSubscriptions.filter(({ connectionId, subscriptionId }) => cleanups[connectionId]?.[subscriptionId]).length;
    };

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("rpc-name-mismatch-getcommunity") });
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));
        mockRpcServerForTests(rpcServer);
        const server = rpcServer as unknown as {
            _bindCommunityUpdateSubscription: (parsedArgs: unknown, connectionId: string, subscriptionId: number) => Promise<void>;
        };
        const originalBind = server._bindCommunityUpdateSubscription.bind(rpcServer);
        vi.spyOn(server, "_bindCommunityUpdateSubscription").mockImplementation(async (parsedArgs, connectionId, subscriptionId) => {
            communityUpdateSubscriptions.push({ connectionId, subscriptionId });
            await originalBind(parsedArgs, connectionId, subscriptionId);
        });
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc("rejects with the mismatch error and leaves no subscription or updating instance on the server", async () => {
        // The self-resolving name points at the fresh key, but the record never claims it
        const staticCommunity = await publishStaticCommunityWithPostInPages();
        const communityName = selfResolvingMockNameForAddress(staticCommunity.communityAddress);
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        client.on("error", () => {});
        try {
            const error = await client.getCommunity({ address: communityName }).then(
                (): undefined => undefined,
                (e: PKCError) => e
            );
            expect(error?.code).to.equal("ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME");
            expect(client._updatingCommunities.size()).to.equal(0);

            expect(communityUpdateSubscriptions.length).to.be.greaterThan(0);
            await pollUntil(() => countLiveCommunityUpdateSubscriptions() === 0 && serverPKC._updatingCommunities.size() === 0, {
                timeoutMs: 10_000
            });
            expect(countLiveCommunityUpdateSubscriptions()).to.equal(0);
            expect(serverPKC._updatingCommunities.size()).to.equal(0);
        } finally {
            await client.destroy();
            await staticCommunity.ipnsObj.pkc.destroy();
        }
    });
});
