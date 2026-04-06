import { beforeAll, afterAll } from "vitest";
import signers from "../../../fixtures/signers.js";

import {
    describeSkipIfRpc,
    mockGatewayPlebbit,
    getAvailablePlebbitConfigsToTestAgainst,
    addStringToIpfs
} from "../../../../dist/node/test/test-util.js";
import validModQueuePage from "../../../fixtures/valid_modqueue_page.json" with { type: "json" };

import type { Plebbit as PlebbitType } from "../../../../dist/node/pkc/pkc.js";

const subplebbitAddress = signers[0].address;
const cloneModQueuePage = () => JSON.parse(JSON.stringify(validModQueuePage));

const clientsFieldName: Record<string, string> = {
    "remote-kubo-rpc": "kuboRpcClients",
    "remote-libp2pjs": "libp2pJsClients"
};

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    const clientFieldName = clientsFieldName[config.testConfigCode];
    describeSkipIfRpc(`subplebbit.modQueue.clients.${clientFieldName} - ${config.name}`, async () => {
        let plebbit: PlebbitType;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit.modQueue.clients.${clientFieldName} is undefined for gateway plebbit`, async () => {
            const gatewayPlebbit = await mockGatewayPlebbit();
            const sub = await gatewayPlebbit.getSubplebbit({ address: subplebbitAddress });
            const sortTypes = Object.keys(
                (sub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                    clientFieldName
                ]
            );
            expect(sortTypes.length).to.be.greaterThan(0);
            for (const sortType of sortTypes)
                expect(
                    (sub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                        clientFieldName
                    ][sortType]
                ).to.deep.equal({});
            await gatewayPlebbit.destroy();
        });

        it(`subplebbit.modQueue.clients.${clientFieldName}[sortType][url] is stopped by default`, async () => {
            const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const key = Object.keys((sub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];
            expect(
                Object.keys(
                    (sub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                        clientFieldName
                    ].pendingApproval
                ).length
            ).to.equal(1);
            expect(
                (
                    (sub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                        clientFieldName
                    ].pendingApproval[key] as { state: string }
                ).state
            ).to.equal("stopped");
        });

        it(`Correct state of 'pendingApproval' sort is updated after fetching from subplebbit.modQueue.pageCids.pendingApproval`, async () => {
            const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const firstPage = cloneModQueuePage();

            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            sub.modQueue.pageCids.pendingApproval = firstPageCid;

            const clientKey = Object.keys((sub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const expectedStates = ["fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (sub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ].pendingApproval[clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            await sub.modQueue.getPage({ cid: sub.modQueue.pageCids.pendingApproval });
            expect(actualStates).to.deep.equal(expectedStates);
        });

        it("Correct state of 'pendingApproval' sort is updated after fetching second page of 'pendingApproval' pages", async () => {
            const sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const clientKey = Object.keys((sub.clients as unknown as Record<string, Record<string, unknown>>)[clientFieldName])[0];

            const secondPage = cloneModQueuePage();
            secondPage.comments = secondPage.comments.slice(1, 5);
            const secondPageCid = await addStringToIpfs(JSON.stringify(secondPage));

            const firstPage = cloneModQueuePage();
            firstPage.nextCid = secondPageCid;
            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            sub.modQueue.pageCids.pendingApproval = firstPageCid;

            const expectedStates = ["fetching-ipfs", "stopped", "fetching-ipfs", "stopped"];
            const actualStates: string[] = [];
            (sub.modQueue.clients as unknown as Record<string, Record<string, Record<string, { on: Function; state: string }>>>)[
                clientFieldName
            ].pendingApproval[clientKey].on("statechange", (newState: string) => {
                actualStates.push(newState);
            });

            const pendingFirstPage = await sub.modQueue.getPage({ cid: sub.modQueue.pageCids.pendingApproval });
            expect(pendingFirstPage.nextCid).to.be.a("string");
            await sub.modQueue.getPage({ cid: pendingFirstPage.nextCid });

            expect(actualStates).to.deep.equal(expectedStates);
        });

        it(`Correct state of 'pendingApproval' sort is updated after fetching with a subplebbit created with plebbit.createSubplebbit({address, modQueue})`, async () => {
            const remotePlebbit: PlebbitType = await config.plebbitInstancePromise();
            const sub = await remotePlebbit.getSubplebbit({ address: subplebbitAddress });

            const firstPage = cloneModQueuePage();

            const firstPageCid = await addStringToIpfs(JSON.stringify(firstPage));

            const fetchSub = await remotePlebbit.createSubplebbit({
                address: subplebbitAddress,
                modQueue: { pageCids: { ...sub.modQueue.pageCids, pendingApproval: firstPageCid } }
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
            await remotePlebbit.destroy();
        });
    });
});
