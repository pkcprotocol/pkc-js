import signers from "../../fixtures/signers.js";

import { createNewIpns, resolveWhenConditionIsTrue, getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";

import { signCommunity } from "../../../dist/node/signer/signatures.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-pkc-rpc"] }).map((config) => {
    describe(`community.clients.pkcRpcClients (remote sub)`, async () => {
        let pkc: PKCType;

        beforeEach(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterEach(async () => {
            await pkc.destroy();
        });

        it(`community.clients.pkcRpcClients[rpcUrl] is stopped by default`, async () => {
            const sub = await pkc.createCommunity({ address: signers[0].address });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            expect(sub.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
        });

        it(`community.clients.pkcRpcClients states are correct if fetching a sub with IPNS address`, async () => {
            const newIpns = await createNewIpns();
            const actualSub = await pkc.getCommunity({ address: signers[0].address });

            const record: Record<string, unknown> = JSON.parse(JSON.stringify(actualSub.raw.communityIpfs));
            delete record["posts"];
            record.signature = await signCommunity({
                community: record as Parameters<typeof signCommunity>[0]["community"],
                signer: newIpns.signer
            });

            await newIpns.publishToIpns(JSON.stringify(record));

            const sub = await pkc.createCommunity({ address: newIpns.signer.address });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            sub.clients.pkcRpcClients[rpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await sub.update();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            await sub.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            await newIpns.pkc.destroy();
            expect(sub.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
        });

        it(`community.clients.pkcRpcClients states are correct if fetching a sub with ENS address`, async () => {
            const sub = await pkc.createCommunity({ address: "plebbit.bso" });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["resolving-community-name", "fetching-ipns", "fetching-ipfs", "stopped"];

            sub.clients.pkcRpcClients[rpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await sub.update();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            await sub.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            expect(sub.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
        });
    });
});
