import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

type ClientsField = "ipfsGateways" | "kuboRpcClients" | "pkcRpcClients" | "libp2pJsClients";

const clientsFieldName: Record<string, ClientsField> = {
    "remote-ipfs-gateway": "ipfsGateways",
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-pkc-rpc": "pkcRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

// A community may publish pageCids under any sort name a page-sort package declares (settings.pages, issue #73, #348), so
// the pages client state must be seeded for keys that are not built-in, on every transport.
getAvailablePKCConfigsToTestAgainst({
    includeOnlyTheseTests: ["remote-ipfs-gateway", "remote-kubo-rpc", "remote-pkc-rpc", "remote-libp2pjs"]
}).map((config) => {
    const clientField = clientsFieldName[config.testConfigCode];
    describe(`pages.clients.${clientField} for a custom sort name - ${config.name}`, () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("a pageCids key that is not a built-in sort gets its own client state entry", async () => {
            const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
            const customPageCid = "QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH";
            community.posts._clientsManager.updatePageCidsToSortTypes({ activeNoBump: customPageCid });
            const clients = community.posts.clients as unknown as Record<ClientsField, Record<string, Record<string, { state: string }>>>;
            expect(clients[clientField]).to.have.property("activeNoBump");
            const perClient = Object.values(clients[clientField]["activeNoBump"]);
            expect(perClient.length).to.be.greaterThan(0);
            for (const client of perClient) expect(client.state).to.equal("stopped");
        });
    });
});
