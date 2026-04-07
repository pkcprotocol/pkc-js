import signers from "../../fixtures/signers.js";

import { createNewIpns, resolveWhenConditionIsTrue, getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";

import { signCommunity } from "../../../dist/node/signer/signatures.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    describe(`community.clients.pkcRpcClients (remote community)`, async () => {
        let pkc: PKCType;

        beforeEach(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterEach(async () => {
            await pkc.destroy();
        });

        it(`community.clients.pkcRpcClients[rpcUrl] is stopped by default`, async () => {
            const community = await pkc.createCommunity({ address: signers[0].address });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            expect(community.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(community.updatingState).to.equal("stopped");
        });

        it(`community.clients.pkcRpcClients states are correct if fetching a community with IPNS address`, async () => {
            const newIpns = await createNewIpns();
            const actualCommunity = await pkc.getCommunity({ address: signers[0].address });

            const record: Record<string, unknown> = JSON.parse(JSON.stringify(actualCommunity.raw.communityIpfs));
            delete record["posts"];
            record.signature = await signCommunity({
                community: record as Parameters<typeof signCommunity>[0]["community"],
                signer: newIpns.signer
            });

            await newIpns.publishToIpns(JSON.stringify(record));

            const community = await pkc.createCommunity({ address: newIpns.signer.address });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            community.clients.pkcRpcClients[rpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await community.update();

            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            await community.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            await newIpns.pkc.destroy();
            expect(community.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(community.updatingState).to.equal("stopped");
        });

        it(`community.clients.pkcRpcClients states are correct if fetching a community with ENS address`, async () => {
            const community = await pkc.createCommunity({ address: "plebbit.bso" });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["resolving-community-name", "fetching-ipns", "fetching-ipfs", "stopped"];

            community.clients.pkcRpcClients[rpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await community.update();

            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            await community.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            expect(community.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(community.updatingState).to.equal("stopped");
        });
    });
});
