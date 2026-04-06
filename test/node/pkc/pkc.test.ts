import PKC from "../../../dist/node/index.js";
import { describe, it } from "vitest";
import {
    createSubWithNoChallenge,
    itIfRpc,
    publishRandomPost,
    itSkipIfRpc,
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

// example of node only tests

describe("await plebbit()", () => {
    it("has default plebbit options", async () => {
        const plebbit = await PKC({ httpRoutersOptions: [] });
        expect(Object.keys(plebbit.clients.ipfsGateways).sort()).to.deep.equal(
            ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"].sort()
        );
        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients)).to.deep.equal([
            "https://pubsubprovider.xyz/api/v0",
            "https://plebpubsub.xyz/api/v0"
        ]);
        expect(plebbit.clients.kuboRpcClients).to.deep.equal({});
        expect(plebbit.kuboRpcClientsOptions).to.be.undefined;
        expect(plebbit.nameResolvers).to.be.undefined;

        expect(plebbit.dataPath).to.match(/\.plebbit$/);

        JSON.stringify(plebbit); // Will throw an error if circular json

        await plebbit.destroy();
    });
});

describe.concurrent(`plebbit.subplebbits`, async () => {
    it(`plebbit.subplebbits updates after creating a new sub`, async () => {
        const plebbit = await mockPKC();
        const newCommunity = await plebbit.createCommunity({
            signer: await plebbit.createSigner()
        });
        // A new subplebbit should be created, and its SQLite db file be listed under plebbit.dataPath/subplebbits
        expect(plebbit.subplebbits).to.include(newCommunity.address);

        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });

    itSkipIfRpc(`plebbit.subplebbits should be defined after creating PKC instance (NodeJS/IPFS-P2P)`, async () => {
        const plebbit = await mockPKC(); // mockPKC will set up a nodejs plebbit or RPC plebbit
        expect(plebbit.subplebbits).to.be.a("array");
        expect(plebbit.subplebbits).to.have.length.of.at.least(1);
        await plebbit.destroy();
    });

    itIfRpc(`plebbit.subplebbits is defined after emitting rpcstatechange with rpcState=connected (RPC client)`, async () => {
        const plebbit = await mockPKC(); // mockPKC will set up a RPC plebbit
        await new Promise((resolve) => plebbit.once("subplebbitschange", resolve));
        const defaultRpcClient = plebbit.clients.plebbitRpcClients[Object.keys(plebbit.clients.plebbitRpcClients)[0]];
        expect(defaultRpcClient.state).to.equal("connected");
        expect(plebbit.subplebbits).to.be.a("array");
        expect(plebbit.subplebbits).to.have.length.of.at.least(1);
        expect(defaultRpcClient.subplebbits).to.deep.equal(plebbit.subplebbits);
        await plebbit.destroy();
        expect(defaultRpcClient.state).to.equal("stopped");
    });
});

describe(`PKC.challenges`, async () => {
    it(`PKC.challenges contains default challenges`, async () => {
        const challenges = Object.keys(PKC.challenges);
        expect(challenges).to.deep.equal(["text-math", "fail", "blacklist", "whitelist", "question", "publication-match"]);
    });
});

describe.concurrent(`plebbit.destroy()`, async () => {
    itSkipIfRpc(`plebbit.destroy() should stop running local sub`, async () => {
        const plebbit = await mockPKC();
        const sub = (await createSubWithNoChallenge({}, plebbit)) as LocalCommunity;
        await sub.start();
        expect(sub.state).to.equal("started");
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await plebbit.destroy();
        expect(sub.state).to.equal("stopped");
    });

    it(`plebbit.destroy() should stop updating local subs`, async () => {
        const plebbit = await mockPKC();
        const sub = (await createSubWithNoChallenge({}, plebbit)) as LocalCommunity | RpcLocalCommunity;

        await sub.update();
        expect(plebbit._updatingCommunitys[sub.address]).to.exist;
        expect(plebbit._startedCommunitys[sub.address]).to.not.exist;

        let calledUpdate = false;
        await plebbit.destroy();

        sub._setUpdatingStateNoEmission = sub._setUpdatingStateWithEventEmissionIfNewState = () => {
            calledUpdate = true;
        };
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(plebbit._updatingCommunitys[sub.address]).to.not.exist;
        expect(plebbit._startedCommunitys[sub.address]).to.not.exist;

        expect(calledUpdate).to.be.false;
    });

    itIfRpc(`plebbit.destroy() should not stop running local subplebbits (RPC client)`, async () => {
        const plebbit = await mockPKC();
        const sub = (await createSubWithNoChallenge({}, plebbit)) as RpcLocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        expect(sub.state).to.equal("started");
        await plebbit.destroy();

        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        await publishRandomPost({ communityAddress: sub.address, plebbit: remotePKC }); // if we can publish a post, the sub is running

        await remotePKC.destroy();
    });
});
