import { beforeAll, afterAll, it } from "vitest";
import { createSubWithNoChallenge, mockPKC, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { getIpnsRecordInLocalKuboNode } from "../../../../dist/node/util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
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
