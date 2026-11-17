import { beforeAll, afterAll, it } from "vitest";
import { createSubWithNoChallenge, mockPKC, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { getIpnsRecordInLocalKuboNode } from "../../../../dist/node/util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import * as cborg from "cborg";
import type { KuboRpcClient } from "../../../../dist/node/types.js";

describeSkipIfRpc(`Generation of new IPNS records`, async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let kuboRpcClientOfCommunity: KuboRpcClient;
    let numberOfEmittedUpdates = 0;
    let numberOfEmittedUpdatesWithUpdatedAt = 0;

    beforeAll(async () => {
        pkc = await mockPKC();
        kuboRpcClientOfCommunity = Object.values(pkc.clients.kuboRpcClients)[0];

        community = await createSubWithNoChallenge({}, pkc);

        community.setMaxListeners(100);

        community.on("update", async () => {
            numberOfEmittedUpdates++;
            if (typeof community.updatedAt === "number") numberOfEmittedUpdatesWithUpdatedAt++;
        });

        await community.start();

        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`IPNS sequence number and value are correct with each update`, async () => {
        // need to have a for loop of 20 iterations

        for (let i = 0; i < 20; i++) {
            // @ts-expect-error Accessing private property _communityUpdateTrigger for testing
            community._communityUpdateTrigger = true;
            await new Promise((resolve) => community.once("update", resolve));
            const latestIpnsRecord = await getIpnsRecordInLocalKuboNode(kuboRpcClientOfCommunity, community.address);
            expect(latestIpnsRecord.sequence).to.equal(BigInt(numberOfEmittedUpdatesWithUpdatedAt - 1));

            expect(latestIpnsRecord.value).to.equal("/ipfs/" + community.updateCid);
        }
    });

    // we need to test that IPNS' sequence keeps incrementing
    // we need to test updateCid is also changing on the community instace
    // need to test that updatedAt keeps increasing
    // they should all match on community, and on community from remotePKC
});

// Issue #553: the community publishes with the sequence of the record stored in its DB, plus one. That stored
// record is refreshed after every publish, and the refresh is allowed to fail, so it can fall behind the record
// kubo holds. Kubo rejects a sequence that is not above its own, and a rejected publish must not stall the
// community: it publishes again and lets kubo continue its own sequence.
//
// Skipped under RPC: it rewrites the community's DB through LocalCommunity._dbHandler and reads the record from
// the kubo node the community publishes through, neither of which exists on an RPC client.
describeSkipIfRpc(`Publishing when the stored IPNS record is behind kubo's`, async () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let kuboRpcClientOfCommunity: KuboRpcClient;

    const publishNewRecord = async () => {
        const cidBefore = community.updateCid;
        community._communityUpdateTrigger = true;
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updateCid !== cidBefore });
    };

    const storedSequence = (): bigint => {
        const stored = community._dbHandler.keyvGet<object>("LAST_IPNS_RECORD");
        return BigInt(cborg.decode(new Uint8Array(Object.values(stored!)), { allowBigInt: true }).sequence);
    };

    beforeAll(async () => {
        pkc = await mockPKC();
        kuboRpcClientOfCommunity = Object.values(pkc.clients.kuboRpcClients)[0];
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        for (let i = 0; i < 3; i++) await publishNewRecord();
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it(`publishes with kubo's own next sequence and brings the stored record back in line`, async () => {
        const recordBefore = await getIpnsRecordInLocalKuboNode(kuboRpcClientOfCommunity, community.signer.address);
        expect(recordBefore.sequence >= 3n, `expected sequence 3 or above, got ${recordBefore.sequence}`).to.be.true;
        expect(storedSequence()).to.equal(recordBefore.sequence);

        // Two behind: the next publish asks for sequence 1, which kubo refuses
        await community._dbHandler.keyvSet("LAST_IPNS_RECORD", cborg.encode({ ...recordBefore, sequence: 0n }));
        expect(storedSequence()).to.equal(0n);

        await publishNewRecord();

        const recordAfter = await getIpnsRecordInLocalKuboNode(kuboRpcClientOfCommunity, community.signer.address);
        expect(recordAfter.sequence).to.equal(recordBefore.sequence + 1n);
        expect(recordAfter.value).to.equal("/ipfs/" + community.updateCid);
        expect(storedSequence()).to.equal(recordAfter.sequence);
    });
});
