import signers from "../../fixtures/signers.js";

import { createNewIpns, resolveWhenConditionIsTrue, getAvailablePlebbitConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";

import { signCommunity } from "../../../dist/node/signer/signatures.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/pkc/pkc.js";

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-plebbit-rpc"] }).map((config) => {
    describe(`subplebbit.clients.plebbitRpcClients (remote sub)`, async () => {
        let plebbit: PlebbitType;

        beforeEach(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterEach(async () => {
            await plebbit.destroy();
        });

        it(`subplebbit.clients.plebbitRpcClients[rpcUrl] is stopped by default`, async () => {
            const sub = await plebbit.createSubplebbit({ address: signers[0].address });
            const rpcUrl = Object.keys(plebbit.clients.plebbitRpcClients)[0];
            expect(sub.clients.plebbitRpcClients[rpcUrl].state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
        });

        it(`subplebbit.clients.plebbitRpcClients states are correct if fetching a sub with IPNS address`, async () => {
            const newIpns = await createNewIpns();
            const actualSub = await plebbit.getSubplebbit({ address: signers[0].address });

            const record: Record<string, unknown> = JSON.parse(JSON.stringify(actualSub.raw.subplebbitIpfs));
            delete record["posts"];
            record.signature = await signCommunity({
                subplebbit: record as Parameters<typeof signCommunity>[0]["subplebbit"],
                signer: newIpns.signer
            });

            await newIpns.publishToIpns(JSON.stringify(record));

            const sub = await plebbit.createSubplebbit({ address: newIpns.signer.address });
            const rpcUrl = Object.keys(plebbit.clients.plebbitRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            sub.clients.plebbitRpcClients[rpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await sub.update();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            await sub.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            await newIpns.plebbit.destroy();
            expect(sub.clients.plebbitRpcClients[rpcUrl].state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
        });

        it(`subplebbit.clients.plebbitRpcClients states are correct if fetching a sub with ENS address`, async () => {
            const sub = await plebbit.createSubplebbit({ address: "plebbit.bso" });
            const rpcUrl = Object.keys(plebbit.clients.plebbitRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["resolving-community-name", "fetching-ipns", "fetching-ipfs", "stopped"];

            sub.clients.plebbitRpcClients[rpcUrl].on("statechange", (newState: string) => recordedStates.push(newState));

            await sub.update();

            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

            await sub.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            expect(sub.clients.plebbitRpcClients[rpcUrl].state).to.equal("stopped");
            expect(sub.updatingState).to.equal("stopped");
        });
    });
});
