// #275 follow-up: getCommunity()'s abortSignal reaches the IPNS wait in
// waitForUpdateInCommunityInstanceWithErrorAndTimeout, but not createCommunity(), which runs first.
// For a community the RPC server hosts, PKCWithRpcClient.createCommunity() takes the
// isCommunityRpcLocal branch and blocks inside _createAndSubscribeToNewUpdatingCommunity ->
// _initRpcUpdateSubscription, and then on `Promise.race([updatePromise, errorPromise])`. Neither has
// a timeout and neither sees the signal, so a caller that aborts (or destroys the pkc) stays
// blocked. The instance is already tracked in pkc._updatingCommunities by then, which is why
// stopping it is a plausible way to unblock the wait.
import { describe, it, expect, vi } from "vitest";
import { mockRpcRemotePKC } from "../../../dist/node/test/test-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

const STILL_PENDING = "still pending" as const;

// Resolves to STILL_PENDING if `promise` has not settled within `ms`, so a hang is reported as a
// failed assertion instead of a 160s vitest timeout with no explanation.
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof STILL_PENDING> {
    return Promise.race([promise, new Promise<typeof STILL_PENDING>((resolve) => setTimeout(() => resolve(STILL_PENDING), ms))]);
}

describe("pkc.getCommunity abortSignal on a community the RPC server hosts", () => {
    itIfRpc("abort unwinds getCommunity while the update subscription is still pending", async () => {
        const pkc: PKCType = await mockRpcRemotePKC();
        try {
            // Created over RPC, so its address lands in pkc.communities and getCommunity() below
            // takes the isCommunityRpcLocal branch.
            const localCommunity = await pkc.createCommunity();
            const communityAddress = localCommunity.address;

            // Models an RPC server that accepts the subscribe and never answers it. Mocked on the
            // client so the per-call RPC timeout (#196) does not fire and mask the hang.
            vi.spyOn(pkc._pkcRpcClient!, "communityUpdateSubscribe").mockImplementation(() => new Promise(() => {}));

            const abortController = new AbortController();
            const getCommunityOutcome = pkc.getCommunity({ address: communityAddress, abortSignal: abortController.signal }).then(
                (): Error | undefined => undefined,
                (e): Error | undefined => e as Error
            );
            abortController.abort();

            const outcome = await settleWithin(getCommunityOutcome, 10000);
            expect(outcome, "getCommunity() ignored the abort and is still waiting on the RPC subscription").to.not.equal(STILL_PENDING);
            expect((outcome as PKCError | undefined)?.code).to.equal("ERR_GET_COMMUNITY_ABORTED");
            // The instance is tracked before the first wait, so cancelling has to stop it rather
            // than leave a dead entry behind for findUpdatingCommunity to hand out.
            expect(pkc._updatingCommunities.size()).to.equal(0);
        } finally {
            // destroy() is itself part of what this bug blocks, so do not let it hang the run.
            await settleWithin(pkc.destroy(), 20000);
        }
    });

    itIfRpc("destroy() unwinds getCommunity while the update subscription is still pending", async () => {
        const pkc: PKCType = await mockRpcRemotePKC();
        try {
            const localCommunity = await pkc.createCommunity();
            const communityAddress = localCommunity.address;
            vi.spyOn(pkc._pkcRpcClient!, "communityUpdateSubscribe").mockImplementation(() => new Promise(() => {}));

            const getCommunityOutcome = pkc.getCommunity({ address: communityAddress }).then(
                (): Error | undefined => undefined,
                (e): Error | undefined => e as Error
            );

            // The instance is tracked in pkc._updatingCommunities before the subscribe is awaited, so
            // destroy() reaches it through listUpdatingCommunities and stops it. Nothing observes
            // that stop today, which is why the caller stays blocked.
            const destroyOutcome = await settleWithin(pkc.destroy(), 20000);
            expect(destroyOutcome, "pkc.destroy() itself blocked on the pending subscription").to.not.equal(STILL_PENDING);

            const outcome = await settleWithin(getCommunityOutcome, 10000);
            expect(outcome, "getCommunity() is still waiting on the RPC subscription after destroy()").to.not.equal(STILL_PENDING);
        } finally {
            if (!pkc.destroyed) await settleWithin(pkc.destroy(), 20000);
        }
    });
});
