import PKC from "../../dist/node/index.js";
import { expect } from "vitest";
// example of browser only tests

describe("pkc", () => {
    it("PKC() has default pkc options", async () => {
        // RPC exception
        const pkc = await PKC({ httpRoutersOptions: [] });
        expect(Object.keys(pkc.clients.ipfsGateways).sort()).to.deep.equal(
            ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"].sort()
        );
        expect(Object.keys(pkc.clients.pubsubKuboRpcClients).sort()).to.deep.equal(
            ["https://pubsubprovider.xyz/api/v0", "https://plebpubsub.xyz/api/v0"].sort()
        );

        // no dataPath in brower
        expect(pkc.dataPath).to.equal(undefined);
        JSON.stringify(pkc); // Will throw an error if circular json
        await pkc.destroy();
    });
});

describe(`PKC.communities in browser`, async () => {
    it(`pkc.communities = [] in browser`, async () => {
        const pkc = await PKC({ httpRoutersOptions: [] });
        expect(pkc.communities).to.deep.equal([]);
        await pkc.destroy();
    });
});

describe(`PKC.challenges`, async () => {
    it(`PKC.challenges = {} in browser environments`, async () => {
        expect(PKC.challenges).to.deep.equal({});
    });
});
