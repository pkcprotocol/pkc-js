import { beforeAll, afterAll, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, addStringToIpfs } from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import validModQueuePage from "../../../fixtures/valid_modqueue_page.json" with { type: "json" };

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;
const cloneModQueuePage = () => JSON.parse(JSON.stringify(validModQueuePage));

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    describe(`community.modQueue.clients.pkcRpcClients - ${config.name}`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.modQueue.clients.pkcRpcClients[sortType][url] is stopped by default`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const rpcUrl = Object.keys(community.clients.pkcRpcClients)[0];
            expect(Object.keys(community.modQueue.clients.pkcRpcClients.pendingApproval).length).to.equal(1);
            expect(community.modQueue.clients.pkcRpcClients.pendingApproval[rpcUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'pendingApproval' sort is updated after fetching from community.modQueue.pageCids.pendingApproval`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const page = cloneModQueuePage();
            const pageCid = await addStringToIpfs(JSON.stringify(page));
            community.modQueue.pageCids.pendingApproval = pageCid;
            const rpcUrl = Object.keys(community.clients.pkcRpcClients)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            community.modQueue.clients.pkcRpcClients.pendingApproval[rpcUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await community.modQueue.getPage({ cid: community.modQueue.pageCids.pendingApproval });
            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});
