import { beforeAll, afterAll } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, addStringToIpfs } from "../../../../dist/node/test/test-util.js";

import signers from "../../../fixtures/signers.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`community.posts.clients.ipfsGateways - ${config.name}`, async () => {
        let gatewayPKC: PKCType;
        beforeAll(async () => {
            gatewayPKC = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await gatewayPKC.destroy();
        });

        it(`community.posts.clients.ipfsGateways[sortType][url] is stopped by default`, async () => {
            const mockSub = await gatewayPKC.getCommunity({ address: communityAddress });
            const gatewayUrl = Object.keys(mockSub.clients.ipfsGateways)[0];
            // add tests here
            expect(Object.keys(mockSub.posts.clients.ipfsGateways["new"]).length).to.equal(1);
            expect(mockSub.posts.clients.ipfsGateways["new"][gatewayUrl].state).to.equal("stopped");
        });

        it(`Correct state of 'new' sort is updated after fetching from community.posts.pageCids.new`, async () => {
            const mockSub = await gatewayPKC.getCommunity({ address: communityAddress });
            const firstPageMocked = {
                comments: mockSub.posts.pages.hot.comments.slice(0, 10).map((comment) => comment.raw)
            };
            const firstPageMockedCid = await addStringToIpfs(JSON.stringify(firstPageMocked));
            mockSub.posts.pageCids.new = firstPageMockedCid;

            const gatewayUrl = Object.keys(mockSub.clients.ipfsGateways)[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            mockSub.posts.clients.ipfsGateways["new"][gatewayUrl].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await mockSub.posts.getPage({ cid: mockSub.posts.pageCids.new });
            expect(actualStates).to.deep.equal(expectedStates);
        });
    });
});
