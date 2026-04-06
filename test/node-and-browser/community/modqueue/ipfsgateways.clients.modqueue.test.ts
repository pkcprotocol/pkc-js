import { beforeAll, afterAll } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, addStringToIpfs } from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import validModQueuePage from "../../../fixtures/valid_modqueue_page.json" with { type: "json" };

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;
const cloneModQueuePage = () => JSON.parse(JSON.stringify(validModQueuePage));

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`community.modQueue.clients.ipfsGateways - ${config.name}`, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.modQueue.clients.ipfsGateways[sortType][url] is stopped by default`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const gatewayUrl = Object.keys(sub.clients.ipfsGateways)[0];
            expect(Object.keys(sub.modQueue.clients.ipfsGateways.pendingApproval).length).to.equal(1);
            expect(sub.modQueue.clients.ipfsGateways.pendingApproval[gatewayUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'pendingApproval' sort is updated after fetching from community.modQueue.pageCids.pendingApproval`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const page = cloneModQueuePage();
            const pageCid = await addStringToIpfs(JSON.stringify(page));
            sub.modQueue.pageCids.pendingApproval = pageCid;

            const gatewayUrl = Object.keys(sub.clients.ipfsGateways)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            sub.modQueue.clients.ipfsGateways.pendingApproval[gatewayUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await sub.modQueue.getPage({ cid: sub.modQueue.pageCids.pendingApproval });
            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});
