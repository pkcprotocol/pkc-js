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

describe("await pkc()", () => {
    it("has default pkc options", async () => {
        const pkc = await PKC({ httpRoutersOptions: [] });
        expect(Object.keys(pkc.clients.ipfsGateways).sort()).to.deep.equal(
            ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"].sort()
        );
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients)).to.deep.equal([
            "https://pubsubprovider.xyz/api/v0",
            "https://plebpubsub.xyz/api/v0"
        ]);
        expect(pkc.clients.kuboRpcClients).to.deep.equal({});
        expect(pkc.kuboRpcClientsOptions).to.be.undefined;
        expect(pkc.nameResolvers).to.be.undefined;

        expect(pkc.dataPath).to.match(/\.pkc$/);

        JSON.stringify(pkc); // Will throw an error if circular json

        await pkc.destroy();
    });
});

describe.concurrent(`pkc.communities`, async () => {
    it(`pkc.communities updates after creating a new sub`, async () => {
        const pkc = await mockPKC();
        const newCommunity = await pkc.createCommunity({
            signer: await pkc.createSigner()
        });
        // A new community should be created, and its SQLite db file be listed under pkc.dataPath/communities
        expect(pkc.communities).to.include(newCommunity.address);

        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });

    itSkipIfRpc(`pkc.communities should be defined after creating PKC instance (NodeJS/IPFS-P2P)`, async () => {
        const pkc = await mockPKC(); // mockPKC will set up a nodejs pkc or RPC pkc
        expect(pkc.communities).to.be.a("array");
        expect(pkc.communities).to.have.length.of.at.least(1);
        await pkc.destroy();
    });

    itIfRpc(`pkc.communities is defined after emitting rpcstatechange with rpcState=connected (RPC client)`, async () => {
        const pkc = await mockPKC(); // mockPKC will set up a RPC pkc
        await new Promise((resolve) => pkc.once("communitieschange", resolve));
        const defaultRpcClient = pkc.clients.pkcRpcClients[Object.keys(pkc.clients.pkcRpcClients)[0]];
        expect(defaultRpcClient.state).to.equal("connected");
        expect(pkc.communities).to.be.a("array");
        expect(pkc.communities).to.have.length.of.at.least(1);
        expect(defaultRpcClient.communities).to.deep.equal(pkc.communities);
        await pkc.destroy();
        expect(defaultRpcClient.state).to.equal("stopped");
    });
});

describe(`PKC.challenges`, async () => {
    it(`PKC.challenges contains default challenges`, async () => {
        const challenges = Object.keys(PKC.challenges);
        expect(challenges).to.deep.equal(["text-math", "fail", "blacklist", "whitelist", "question", "publication-match"]);
    });
});

describe.concurrent(`pkc.destroy()`, async () => {
    itSkipIfRpc(`pkc.destroy() should stop running local sub`, async () => {
        const pkc = await mockPKC();
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await sub.start();
        expect(sub.state).to.equal("started");
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        await pkc.destroy();
        expect(sub.state).to.equal("stopped");
    });

    it(`pkc.destroy() should stop updating local subs`, async () => {
        const pkc = await mockPKC();
        const sub = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;

        await sub.update();
        expect(pkc._updatingCommunities[sub.address]).to.exist;
        expect(pkc._startedCommunities[sub.address]).to.not.exist;

        let calledUpdate = false;
        await pkc.destroy();

        sub._setUpdatingStateNoEmission = sub._setUpdatingStateWithEventEmissionIfNewState = () => {
            calledUpdate = true;
        };
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(pkc._updatingCommunities[sub.address]).to.not.exist;
        expect(pkc._startedCommunities[sub.address]).to.not.exist;

        expect(calledUpdate).to.be.false;
    });

    itIfRpc(`pkc.destroy() should not stop running local communities (RPC client)`, async () => {
        const pkc = await mockPKC();
        const sub = (await createSubWithNoChallenge({}, pkc)) as RpcLocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        expect(sub.state).to.equal("started");
        await pkc.destroy();

        const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        await publishRandomPost({ communityAddress: sub.address, pkc: remotePKC }); // if we can publish a post, the sub is running

        await remotePKC.destroy();
    });
});
