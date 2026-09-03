import signers from "../../fixtures/signers.js";

import {
    createNewIpns,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    encryptionForSigner,
    publishStaticCommunityWithPostInPages
} from "../../../dist/node/test/test-util.js";

import { signCommunity } from "../../../dist/node/signer/signatures.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import { expect } from "vitest";

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
            record.encryption = encryptionForSigner(newIpns.signer);
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
            // A STATIC community (fresh key, published once) rather than "plebbit.bso" (signers[3]),
            // which other suites publish to: this asserts the WHOLE state sequence with deep.equal,
            // and since the update loop is arrival-driven (issue #308) each concurrent publish
            // starts a fetch cycle at a random moment, inserting states mid-assertion (issue #323).
            // The RPC server's mock resolver records are fixed at startup, so the community carries
            // a self-resolving mock name (its own IPNS name in base36 + ".bso") that the default
            // mock resolver maps back to this key without a pre-registered record.
            const staticCommunity = await publishStaticCommunityWithPostInPages({ withSelfResolvingName: true });
            const community = await pkc.createCommunity({ address: staticCommunity.communityName });
            const rpcUrl = Object.keys(pkc.clients.pkcRpcClients)[0];
            const recordedStates: string[] = [];
            const expectedStates = ["fetching-ipns", "fetching-ipfs", "stopped"];

            // "resolving-community-name" is only emitted on a server-side name-resolution cache miss.
            // The persistent 1h cache (src/clients/name-resolution-cache.ts) can be warmed by any earlier
            // test in the same RPC server run, in which case the resolve returns synchronously and
            // bypasses preResolveNameResolver. Filter the state out so the assertion is deterministic.
            community.clients.pkcRpcClients[rpcUrl].on("statechange", (newState: string) => {
                if (newState === "resolving-community-name") return;
                recordedStates.push(newState);
            });

            await community.update();

            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            await community.stop();
            expect(recordedStates).to.deep.equal(expectedStates);
            expect(community.clients.pkcRpcClients[rpcUrl].state).to.equal("stopped");
            expect(community.updatingState).to.equal("stopped");
            await staticCommunity.ipnsObj.pkc.destroy();
        });
    });
});
