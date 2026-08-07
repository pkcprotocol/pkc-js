// Regression for the removal of the kubo#10842 "auto-nuke" recovery path.
//
// Until kubo 0.43.0, an MFS write timeout meant the daemon was permanently wedged, so
// calculateNextCommunityRecord string-matched "Timed out writing to MFS path" and responded by
// rm -r /<communityAddress> plus forceUpdateOnAllComments() — throwing away the community's whole
// postUpdates tree and republishing every CommentUpdate.
//
// 0.43.0 makes that reaction actively harmful. GC and in-flight MFS writes now hold each other off,
// so per the changelog "a single write can pause for the length of a GC and, with a short client
// timeout, look like it timed out and then succeed on retry". Nuking the tree over a few seconds of
// contention turns a recoverable blip into a full republish.
//
// This test drives the exact error the old branch keyed on and asserts nothing nukes.

import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue, publishRandomPost } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// LocalCommunity internals (_clientsManager, _dbHandler) are not reachable over RPC.
describeSkipIfRpc(`An MFS write timeout does not nuke the community's postUpdates tree`, async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`a "Timed out writing to MFS path" failure leaves /<communityAddress> and the DB alone`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const errors: PKCError[] = [];
        community.on("error", (err: PKCError | Error) => errors.push(err as PKCError));

        const ipfsClient = community._clientsManager.getDefaultKuboRpcClient()!._client;
        const rmSpy = vi.spyOn(ipfsClient.files, "rm");
        const forceUpdateSpy = vi.spyOn(community._dbHandler, "forceUpdateOnAllComments");

        // Reject with the exact message the deleted branch matched on. Rejecting rather than actually
        // hanging keeps the test fast: writeKuboFilesWithTimeout's own retries still run, and the
        // error that reaches calculateNextCommunityRecord is byte-for-byte the one it used to key on.
        const originalWrite = ipfsClient.files.write.bind(ipfsClient.files);
        ipfsClient.files.write = async (path: Parameters<typeof originalWrite>[0]) => {
            throw Error(`Timed out writing to MFS path ${String(path)} after 65000ms`);
        };

        try {
            await publishRandomPost({ communityAddress: community.address, pkc });
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length >= 1, eventName: "error" });

            // The sync failed and surfaced as an error, which is the intended behaviour...
            expect(errors.length).to.be.greaterThan(0);
            expect(errors.some((error) => error.message.includes("Timed out writing to MFS path"))).to.be.true;

            // ...but nothing removed the community's MFS root, and nothing forced a full republish.
            const nukeCalls = rmSpy.mock.calls.filter(([paths]) =>
                (Array.isArray(paths) ? paths : [paths]).includes("/" + community.address)
            );
            expect(nukeCalls.length).to.equal(0);
            expect(forceUpdateSpy).not.toHaveBeenCalled();
        } finally {
            ipfsClient.files.write = originalWrite;
            rmSpy.mockRestore();
            forceUpdateSpy.mockRestore();
            await community.delete();
        }
    });
});
