import { mockPKC } from "../../../dist/node/test/test-util.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type PKCRpcClient from "../../../dist/node/clients/rpc-client/pkc-rpc-client.js";

// The `include: ["started"]` fast path only exists on the RPC client path (pkc-with-rpc-client):
// it reads `started` from the daemon's in-memory registry via a single createCommunity RPC call,
// skipping the subscribe -> update() -> wait -> stop() cycle. In non-RPC mode `include` is ignored,
// so these assertions are meaningful only under RPC. See issue #175.
describeIfRpc(`createCommunity({ include: ["started"] }) fast path (RPC)`, () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockPKC();
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it(`returns started true/false without opening an update subscription (unlike the full path)`, async () => {
        const community = (await pkc.createCommunity()) as RpcLocalCommunity;
        await community.start();

        const rpcClient = (pkc as unknown as { _pkcRpcClient: PKCRpcClient })._pkcRpcClient;
        const updateSubscribeSpy = vi.spyOn(rpcClient, "communityUpdateSubscribe");

        // Fast path while the community is running: single request/response, no subscription.
        updateSubscribeSpy.mockClear();
        const startedSnapshot = (await pkc.createCommunity({
            address: community.address,
            include: ["started"]
        })) as RpcLocalCommunity;
        expect(startedSnapshot.address).to.equal(community.address);
        expect(startedSnapshot.started).to.equal(true);
        expect(startedSnapshot.updatedAt).to.be.undefined; // read-only snapshot: never waited for an update
        expect(updateSubscribeSpy).toHaveBeenCalledTimes(0); // did NOT open an update subscription
        expect(findUpdatingCommunity(pkc, { publicKey: community.publicKey, name: community.name })).to.be.undefined;

        // Contrast: the plain (full) path DOES open an update subscription.
        updateSubscribeSpy.mockClear();
        await pkc.createCommunity({ address: community.address });
        expect(updateSubscribeSpy.mock.calls.length).to.be.greaterThan(0);

        await community.stop();

        // Fast path after stop reports started=false, still without a subscription.
        updateSubscribeSpy.mockClear();
        const stoppedSnapshot = (await pkc.createCommunity({
            address: community.address,
            include: ["started"]
        })) as RpcLocalCommunity;
        expect(stoppedSnapshot.started).to.equal(false);
        expect(stoppedSnapshot.updatedAt).to.be.undefined;
        expect(updateSubscribeSpy).toHaveBeenCalledTimes(0);

        updateSubscribeSpy.mockRestore();
    });
});
