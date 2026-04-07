import { beforeAll, afterAll } from "vitest";
import signers from "../../../fixtures/signers.js";

import {
    describeSkipIfRpc,
    mockGatewayPKC,
    getAvailablePKCConfigsToTestAgainst,
    addStringToIpfs
} from "../../../../dist/node/test/test-util.js";
import validModQueuePage from "../../../fixtures/valid_modqueue_page.json" with { type: "json" };

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;
const cloneModQueuePage = () => JSON.parse(JSON.stringify(validModQueuePage));

const clientsFieldName: Record<string, string> = {
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describeSkipIfRpc(`community.modQueue.clients.${clientFieldName} - ${config.name}`, async () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`community.modQueue.clients.${clientFieldName} is undefined for gateway pkc`, async () => {
            const gatewayPKC = await mockGatewayPKC();
            const community = await gatewayPKC.getCommunity({ address: communityAddress });
            const sortTypes = Object.keys(
                (community.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                    clientFieldName
                ]
            );
            expect(sortTypes.length).to.be.greaterThan(0);
            for (const sortType of sortTypes)
                expect(
                    (
                        community.modQueue.clients as unknown as Record<
                            string,
                            Record<string, Record<string, { on: Function; state: string }>>
                        >
                    )[clientFieldName][sortType]
                ).to.deep.equal({});
            await gatewayPKC.destroy();
        });

        it(`community.modQueue.clients.${clientFieldName}[sortType][url] is stopped by default`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const key = Object.keys((community.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];
            expect(
                Object.keys(
                    (
                        community.modQueue.clients as unknown as Record<
                            string,
                            Record<string, Record<string, { on: Function; state: string }>>
                        >
                    )[clientFieldName].pendingApproval
                ).length
            ).to.equal(1);
            expect(
                (
                    (
                        community.modQueue.clients as unknown as Record<
                            string,
                            Record<string, Record<string, { on: Function; state: string }>>
                        >
                    )[clientFieldName].pendingApproval[key] as { state: string }
                ).state
            ).to.equal("stopped");
        });

        it(`Correct state of 'pendingApproval' sort is updated after fetching from community.modQueue.pageCids.pendingApproval`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const firstPage = cloneModQueuePage();

            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            community.modQueue.pageCids.pendingApproval = firstPageCid;

            const clientKey = Object.keys((community.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (community.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ].pendingApproval[clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await community.modQueue.getPage({ cid: community.modQueue.pageCids.pendingApproval });
            expect(actualStates).to.deep.equal(expectedStates);
        });

        it("Correct state of 'pendingApproval' sort is updated after fetching second page of 'pendingApproval' pages", async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const clientKey = Object.keys((community.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const secondPage = cloneModQueuePage();
            secondPage.comments = secondPage.comments.slice(1, 5);
            const secondPageCid = await addStringToIpfs(JSON.stringify(secondPage));

            const firstPage = cloneModQueuePage();
            firstPage.nextCid = secondPageCid;
            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            community.modQueue.pageCids.pendingApproval = firstPageCid;

            const expectedStates = ["fetching-ipfs", "stopped", "fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (community.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ].pendingApproval[clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            const pendingFirstPage = await community.modQueue.getPage({ cid: community.modQueue.pageCids.pendingApproval });
            expect(pendingFirstPage.nextCid).to.be.a("string");
            await community.modQueue.getPage({ cid: pendingFirstPage.nextCid });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct state of 'pendingApproval' sort is updated after fetching with a community created with pkc.createCommunity({address, modQueue})`, async () => {
            const remotePKC: PKCType = await config.pkcInstancePromise();
            const community = await remotePKC.getCommunity({ address: communityAddress });

            const firstPage = cloneModQueuePage();

            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            const fetchSub = await remotePKC.createCommunity({
                address: communityAddress,
                modQueue: { pageCids: { ...community.modQueue.pageCids, pendingApproval: firstPageCid } }
            });
            expect(fetchSub.updatedAt).to.be.undefined;

            const clientKey = Object.keys((fetchSub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (fetchSub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ].pendingApproval[clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await fetchSub.modQueue.getPage({ cid: fetchSub.modQueue.pageCids.pendingApproval });
            expect(actualStates).to.deep.equal(expectedStates);
            await remotePKC.destroy();
        });
    });
});
