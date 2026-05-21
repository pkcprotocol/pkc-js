// Unit tests for src/runtime/node/community/local-community/cleanup.ts.
// Most cleanup helpers are IO-heavy (kubo pin.ls/pin.rm/files.* + GC), so this
// file focuses on a few testable seams:
//   - addAllCidsUnderPurgedCommentToBeRemoved (pure-ish state mutation)
//   - early-return / no-op behaviour for purgeDisapprovedCommentsOlderThan
//   - export shape for the remaining functions
// Full coverage lives in the integration suite (test/node/community/garbage.collection.community.test.ts etc.).

import { describe, it, expect, vi } from "vitest";
import {
    addAllCidsUnderPurgedCommentToBeRemoved,
    cleanUpIpfsRepoRarely,
    purgeDisapprovedCommentsOlderThan,
    repinCommentUpdateIfNeeded,
    repinCommentsIPFSIfNeeded,
    rmUnneededMfsPaths,
    unpinStaleCids
} from "../../../../dist/node/runtime/node/community/local-community/cleanup.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { PurgedCommentTableRows } from "../../../../dist/node/runtime/node/community/db-handler-types.js";

describe("cleanup: export shape", () => {
    it("exports all the expected helpers", () => {
        // Smoke check: every cleanup helper is a function. Heavy coverage is integration.
        expect(typeof addAllCidsUnderPurgedCommentToBeRemoved).to.equal("function");
        expect(typeof cleanUpIpfsRepoRarely).to.equal("function");
        expect(typeof purgeDisapprovedCommentsOlderThan).to.equal("function");
        expect(typeof repinCommentUpdateIfNeeded).to.equal("function");
        expect(typeof repinCommentsIPFSIfNeeded).to.equal("function");
        expect(typeof rmUnneededMfsPaths).to.equal("function");
        expect(typeof unpinStaleCids).to.equal("function");
    });
});

describe("cleanup: addAllCidsUnderPurgedCommentToBeRemoved", () => {
    it("adds the comment cid to _cidsToUnPin and _blocksToRm", async () => {
        const cidsToUnPin = new Set<string>();
        const blocksToRm: string[] = [];
        const mfsPathsToRemove = new Set<string>();
        const community = {
            address: "community.bso",
            _cidsToUnPin: cidsToUnPin,
            _blocksToRm: blocksToRm,
            _mfsPathsToRemove: mfsPathsToRemove
        } as unknown as LocalCommunity;

        const purged = {
            commentTableRow: { cid: "QmPurged" }
        } as unknown as PurgedCommentTableRows;

        await addAllCidsUnderPurgedCommentToBeRemoved(community, purged);

        expect(cidsToUnPin.has("QmPurged")).to.equal(true);
        expect(blocksToRm).to.deep.equal(["QmPurged"]);
        expect(mfsPathsToRemove.size).to.equal(0);
    });

    it("adds the post-update MFS path when commentUpdate has a postUpdatesBucket", async () => {
        const cidsToUnPin = new Set<string>();
        const blocksToRm: string[] = [];
        const mfsPathsToRemove = new Set<string>();
        const community = {
            address: "community.bso",
            _cidsToUnPin: cidsToUnPin,
            _blocksToRm: blocksToRm,
            _mfsPathsToRemove: mfsPathsToRemove
        } as unknown as LocalCommunity;

        const purged = {
            commentTableRow: { cid: "QmPurged" },
            commentUpdateTableRow: { postUpdatesBucket: 86400 }
        } as unknown as PurgedCommentTableRows;

        await addAllCidsUnderPurgedCommentToBeRemoved(community, purged);

        // calculateLocalMfsPathForCommentUpdate(community, comment, bucket) builds
        // `/<address>/postUpdates/<bucket>/<comment.cid>/update`
        expect(mfsPathsToRemove.has("/community.bso/postUpdates/86400/QmPurged/update")).to.equal(true);
    });

    it("adds reply allPageCids to _cidsToUnPin and _blocksToRm", async () => {
        const cidsToUnPin = new Set<string>();
        const blocksToRm: string[] = [];
        const community = {
            address: "community.bso",
            _cidsToUnPin: cidsToUnPin,
            _blocksToRm: blocksToRm,
            _mfsPathsToRemove: new Set<string>()
        } as unknown as LocalCommunity;

        const purged = {
            commentTableRow: { cid: "QmPurged" },
            commentUpdateTableRow: {
                replies: {
                    best: { allPageCids: ["QmReply1", "QmReply2"] },
                    new: { allPageCids: ["QmReply3"] }
                }
            }
        } as unknown as PurgedCommentTableRows;

        await addAllCidsUnderPurgedCommentToBeRemoved(community, purged);

        expect(cidsToUnPin.has("QmReply1")).to.equal(true);
        expect(cidsToUnPin.has("QmReply2")).to.equal(true);
        expect(cidsToUnPin.has("QmReply3")).to.equal(true);
        // The post cid is appended first, then each reply cid is pushed onto _blocksToRm.
        expect(blocksToRm).to.include("QmPurged");
        expect(blocksToRm).to.include("QmReply1");
        expect(blocksToRm).to.include("QmReply3");
    });
});

describe("cleanup: purgeDisapprovedCommentsOlderThan", () => {
    it("is a no-op when settings.purgeDisapprovedCommentsOlderThan is not a number", async () => {
        const purgeDisapprovedCommentsOlderThanSpy = vi.fn();
        const community = {
            address: "community.bso",
            settings: { purgeDisapprovedCommentsOlderThan: undefined },
            _dbHandler: { purgeDisapprovedCommentsOlderThan: purgeDisapprovedCommentsOlderThanSpy }
        } as unknown as LocalCommunity;

        await purgeDisapprovedCommentsOlderThan(community);

        expect(purgeDisapprovedCommentsOlderThanSpy).not.toHaveBeenCalled();
    });

    it("is a no-op when the db reports no purged comments", async () => {
        const purgeSpy = vi.fn().mockReturnValue([]);
        const rmUnneededMfsPathsSpy = vi.fn();
        const community = {
            address: "community.bso",
            settings: { purgeDisapprovedCommentsOlderThan: 60 },
            _mfsPathsToRemove: new Set<string>(),
            _blocksToRm: [] as string[],
            _cidsToUnPin: new Set<string>(),
            updateCid: undefined,
            _dbHandler: { purgeDisapprovedCommentsOlderThan: purgeSpy },
            _clientsManager: { getDefaultKuboRpcClient: rmUnneededMfsPathsSpy }
        } as unknown as LocalCommunity;

        await purgeDisapprovedCommentsOlderThan(community);

        expect(purgeSpy).toHaveBeenCalledWith(60);
        // Nothing was purged, so no follow-up MFS/IPFS calls fired.
        expect(rmUnneededMfsPathsSpy).not.toHaveBeenCalled();
    });
});

describe("cleanup: cleanUpIpfsRepoRarely", () => {
    it("skips GC when not forced and random gate doesn't fire", async () => {
        const getDefaultKuboRpcClient = vi.fn();
        const community = {
            _clientsManager: { getDefaultKuboRpcClient }
        } as unknown as LocalCommunity;

        // Stub Math.random to a value guaranteed to fail the 0.00001 threshold.
        const original = Math.random;
        Math.random = () => 0.5;
        try {
            await cleanUpIpfsRepoRarely(community);
        } finally {
            Math.random = original;
        }

        expect(getDefaultKuboRpcClient).not.toHaveBeenCalled();
    });
});

describe("cleanup: unpinStaleCids", () => {
    it("is a no-op when _cidsToUnPin is empty", async () => {
        const getDefaultKuboRpcClient = vi.fn();
        const community = {
            address: "community.bso",
            _cidsToUnPin: new Set<string>(),
            _clientsManager: { getDefaultKuboRpcClient }
        } as unknown as LocalCommunity;

        await unpinStaleCids(community);

        expect(getDefaultKuboRpcClient).not.toHaveBeenCalled();
    });
});

describe("cleanup: rmUnneededMfsPaths", () => {
    it("returns an empty array when _mfsPathsToRemove is empty", async () => {
        const community = {
            address: "community.bso",
            _mfsPathsToRemove: new Set<string>(),
            _clientsManager: { getDefaultKuboRpcClient: vi.fn() }
        } as unknown as LocalCommunity;

        const result = await rmUnneededMfsPaths(community);
        expect(result).to.deep.equal([]);
    });
});
