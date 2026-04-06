import Plebbit from "../../dist/node/index.js";
// example of browser only tests

describe("plebbit", () => {
    it("Plebbit() has default plebbit options", async () => {
        // RPC exception
        const plebbit = await Plebbit({ httpRoutersOptions: [] });
        expect(Object.keys(plebbit.clients.ipfsGateways).sort()).to.deep.equal(
            ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"].sort()
        );
        expect(Object.keys(plebbit.clients.pubsubKuboRpcClients).sort()).to.deep.equal(
            ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"].sort()
        );

        // no dataPath in brower
        expect(plebbit.dataPath).to.equal(undefined);
        JSON.stringify(plebbit); // Will throw an error if circular json
        await plebbit.destroy();
    });
});

describe(`Plebbit.subplebbits in browser`, async () => {
    it(`plebbit.subplebbits = [] in browser`, async () => {
        const plebbit = await Plebbit({ httpRoutersOptions: [] });
        expect(plebbit.subplebbits).to.deep.equal([]);
        await plebbit.destroy();
    });
});

describe(`Plebbit.challenges`, async () => {
    it(`Plebbit.challenges = {} in browser environments`, async () => {
        expect(Plebbit.challenges).to.deep.equal({});
    });
});
