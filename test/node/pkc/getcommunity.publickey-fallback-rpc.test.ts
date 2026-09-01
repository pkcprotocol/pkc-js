import { describe, beforeAll, afterAll, expect } from "vitest";
import path from "path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import {
    createMockedCommunityIpns,
    createMockNameResolver,
    mockRpcServerForTests,
    mockRpcServerPKC
} from "../../../dist/node/test/test-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { InputPKCOptions } from "../../../dist/node/types.js";

const RPC_AUTH_KEY = "test-getcommunity-publickey-fallback";

const createResolverLimitedNameResolvers = () => [
    createMockNameResolver({
        canResolve: ({ name }: { name: string }) => name.endsWith(".eth") || name.endsWith(".bso")
    })
];

describe("pkc.getCommunity publicKey fallback over RPC", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;

    beforeAll(async () => {
        dataPath = path.join(
            process.cwd(),
            `.pkc-rpc-getcommunity-publickey-fallback-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`
        );
        serverPKC = await mockRpcServerPKC({
            dataPath,
            nameResolvers: createResolverLimitedNameResolvers()
        });

        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));

        const server = rpcServer as unknown as Record<string, Function>;
        server._createPKCInstanceFromSetSettings = async (newOptions: InputPKCOptions) =>
            mockRpcServerPKC({
                dataPath,
                ...newOptions,
                nameResolvers: createResolverLimitedNameResolvers()
            });
        mockRpcServerForTests(rpcServer);
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    itIfRpc(`getCommunity({ name, publicKey }) loads via publicKey when .sol cannot be resolved`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        try {
            const { communityAddress: communityAddress } = await createMockedCommunityIpns({});
            const community = await clientPKC.getCommunity({ name: "test.sol", publicKey: communityAddress });

            expect(community.address).to.equal("test.sol");
            expect(community.publicKey).to.equal(communityAddress);
            expect(community.updatedAt).to.be.a("number");
            expect(community.nameResolved).to.equal(false);
            expect(community.state).to.equal("stopped");
        } finally {
            await clientPKC.destroy();
        }
    });

    itIfRpc(`getCommunity({}) fails validation`, async () => {
        const clientPKC = await PKC({
            pkcRpcClientsOptions: [rpcUrl],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        clientPKC.on("error", () => {});

        try {
            await expect(clientPKC.getCommunity({})).rejects.toThrow("At least one of address, name, or publicKey must be provided");
        } finally {
            await clientPKC.destroy();
        }
    });
});
