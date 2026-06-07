import { mockPKC, mockPKCNoDataPathWithOnlyKuboClient, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import { temporaryDirectory } from "tempy";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import PKC from "../../../dist/node/index.js";
import type { CreatePKCWsServerOptions } from "../../../dist/node/rpc/src/types.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

// `community.ipnsHops` records the IPNS delegation chain traversed to RESOLVE a community
// (ipnsHops[0] = anchor, ipnsHops.at(-1) = terminal). See docs/protocol/delegated-ipns.md.
//
// This suite pins down what ipnsHops looks like for each kind of community instance:
//   - LocalCommunity / RpcLocalCommunity OWN the keys and PUBLISH their own IPNS record, so they
//     never resolve a delegation chain -> ipnsHops is undefined.
//   - A RemoteCommunity that loaded a normal (non-delegated) community resolves a single hop, so
//     ipnsHops === [address] (the anchor equals the terminal for a non-delegated community).
//
// Delegated multi-hop remote resolution (anchor -> minter), including over RPC, is covered in
// test/node-and-browser/community/delegated-ipns.test.ts. This file focuses on the local-vs-remote
// distinction, which can only be exercised under test/node (LocalCommunity is node-only).
describe("community.ipnsHops across community kinds", async () => {
    let localPKC: PKCType;
    let remotePKC: PKCType;
    beforeAll(async () => {
        localPKC = await mockPKC({});
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });
    afterAll(async () => {
        await localPKC.destroy();
        await remotePKC.destroy();
    });

    it("a local community (key owner) has no ipnsHops, while the same community loaded remotely resolves a single hop [address]", async () => {
        const localCommunity = (await localPKC.createCommunity({})) as LocalCommunity;
        await localCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: localCommunity,
            predicate: async () => typeof localCommunity.updatedAt === "number"
        });

        // The owner publishes its own IPNS record; it never resolves a delegation chain, so even
        // after a full publish loop there is no ipnsHops to expose.
        expect(localCommunity.ipnsHops).to.be.undefined;
        const address = localCommunity.address;
        await localCommunity.stop();

        // Re-creating the local instance (clone) also has no chain — creation never resolves.
        const localClone = await localPKC.createCommunity(localCommunity);
        expect(localClone.ipnsHops).to.be.undefined;

        // Loading the same (non-delegated) community remotely resolves a single hop. The chain is
        // just [address] because a non-delegated community's anchor equals its terminal.
        const remoteCommunity = (await remotePKC.createCommunity({ address })) as RemoteCommunity;
        const remoteUpdated = new Promise<void>((resolve) => remoteCommunity.once("update", () => resolve()));
        await remoteCommunity.update();
        await remoteUpdated;
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => typeof remoteCommunity.updatedAt === "number"
        });

        try {
            expect(remoteCommunity.ipnsHops).to.deep.equal([address]);

            // Cloning a resolved remote instance preserves the resolved chain (createCommunity carry).
            const remoteClone = (await remotePKC.createCommunity(remoteCommunity)) as RemoteCommunity;
            expect(remoteClone.ipnsHops).to.deep.equal([address]);
        } finally {
            await remoteCommunity.stop();
        }

        await localClone.delete();
    });

    // A local community over RPC (RpcLocalCommunity) is still a key owner — it publishes via the RPC
    // server and never resolves a chain, so ipnsHops is undefined. Uses a self-contained RPC server
    // and is skipped when the whole suite already runs under the RPC config (USE_RPC), mirroring
    // create.community.test.ts, to avoid clashing with the suite-wide RPC setup.
    itSkipIfRpc("a local community over RPC (RpcLocalCommunity) has no ipnsHops", async () => {
        const dataPath = temporaryDirectory();
        const rpcServerPort = 19181;
        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            pkcOptions: {
                kuboRpcClientsOptions: localPKC.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: localPKC.httpRoutersOptions,
                dataPath
            },
            startStartedCommunitysOnStartup: false
        };
        const rpcServer = await PKCWsServer.PKCWsServer(options);
        const rpcUrl = `ws://localhost:${rpcServerPort}`;
        const rpcPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        try {
            const rpcLocalCommunity = (await rpcPKC.createCommunity({})) as RpcLocalCommunity;
            await rpcLocalCommunity.start();
            await resolveWhenConditionIsTrue({
                toUpdate: rpcLocalCommunity,
                predicate: async () => typeof rpcLocalCommunity.updatedAt === "number"
            });
            expect(rpcLocalCommunity.ipnsHops).to.be.undefined;
            await rpcLocalCommunity.stop();
            await rpcLocalCommunity.delete();
        } finally {
            await rpcPKC.destroy();
            await rpcServer.destroy();
        }
    });
});
