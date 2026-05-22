// Unit tests for src/runtime/node/community/local-community/ipns-publishing.ts.
// updateCommunityIpnsIfNeeded, calculateNextCommunityRecord, syncIpnsWithDb, etc.
// are orchestrators that touch sqlite + kubo + signing + IPNS pubsub. They are
// covered end-to-end by the integration suite (test/node/community/ipns/ and
// test/node/community/local.publishing.community.test.ts).
// Unit tests here focus on a few pure-ish helpers:
//   - shouldResolveDomainForVerification (pure, random gated)
//   - calculateLatestUpdateTrigger (mutates community._communityUpdateTrigger based on cheap predicates)
//   - requireCommunityUpdateIfModQueueChanged (single DB call + state mutation)
//   - addOldPageCidsToCidsToUnpin (early-return branch)

import { describe, it, expect, vi } from "vitest";
import {
    addOldPageCidsToCidsToUnpin,
    calculateLatestUpdateTrigger,
    calculateNewPostUpdates,
    requireCommunityUpdateIfModQueueChanged,
    resolveIpnsAndLogIfPotentialProblematicSequence,
    shouldResolveDomainForVerification,
    syncIpnsWithDb,
    updateCommunityIpnsIfNeeded
} from "../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

describe("ipns-publishing: export shape", () => {
    it("exports all ipns-publishing helpers", () => {
        expect(typeof addOldPageCidsToCidsToUnpin).to.equal("function");
        expect(typeof calculateLatestUpdateTrigger).to.equal("function");
        expect(typeof calculateNewPostUpdates).to.equal("function");
        expect(typeof requireCommunityUpdateIfModQueueChanged).to.equal("function");
        expect(typeof resolveIpnsAndLogIfPotentialProblematicSequence).to.equal("function");
        expect(typeof shouldResolveDomainForVerification).to.equal("function");
        expect(typeof syncIpnsWithDb).to.equal("function");
        expect(typeof updateCommunityIpnsIfNeeded).to.equal("function");
    });
});

describe("ipns-publishing: shouldResolveDomainForVerification", () => {
    it("returns false for a non-domain address regardless of random", () => {
        const community = { address: "12D3KoooSomeKey" } as unknown as LocalCommunity;
        // Force the random gate to its smallest value; address contains no dot so result must be false.
        const original = Math.random;
        Math.random = () => 0;
        try {
            expect(shouldResolveDomainForVerification(community)).to.equal(false);
        } finally {
            Math.random = original;
        }
    });

    it("returns false for a domain address when the random gate doesn't fire", () => {
        const community = { address: "alice.bso" } as unknown as LocalCommunity;
        const original = Math.random;
        Math.random = () => 0.999;
        try {
            expect(shouldResolveDomainForVerification(community)).to.equal(false);
        } finally {
            Math.random = original;
        }
    });

    it("returns true for a domain address when the random gate fires (Math.random < 0.005)", () => {
        const community = { address: "alice.bso" } as unknown as LocalCommunity;
        const original = Math.random;
        Math.random = () => 0.001;
        try {
            expect(shouldResolveDomainForVerification(community)).to.equal(true);
        } finally {
            Math.random = original;
        }
    });
});

describe("ipns-publishing: calculateLatestUpdateTrigger", () => {
    it("forces _communityUpdateTrigger=true when updatedAt is stale (> 15 min old)", () => {
        const community = {
            // Old updatedAt — stale by definition.
            updatedAt: 0,
            _communityUpdateTrigger: false,
            lastPostCid: "QmPost",
            lastCommentCid: "QmComment",
            _pendingEditProps: [],
            _blocksToRm: [],
            _dbHandler: {
                queryLatestPostCid: () => ({ cid: "QmPost" }),
                queryLatestCommentCid: () => ({ cid: "QmComment" })
            }
        } as unknown as LocalCommunity;

        calculateLatestUpdateTrigger(community);
        expect(community._communityUpdateTrigger).to.equal(true);
    });

    it("forces _communityUpdateTrigger=true when there is at least one pending edit", () => {
        const community = {
            // Fresh updatedAt so the lastPublishTooOld check doesn't bias the result.
            updatedAt: Math.floor(Date.now() / 1000),
            _communityUpdateTrigger: false,
            lastPostCid: "QmPost",
            lastCommentCid: "QmComment",
            _pendingEditProps: [{ editId: "edit-1" }],
            _blocksToRm: [],
            _dbHandler: {
                queryLatestPostCid: () => ({ cid: "QmPost" }),
                queryLatestCommentCid: () => ({ cid: "QmComment" })
            }
        } as unknown as LocalCommunity;

        calculateLatestUpdateTrigger(community);
        expect(community._communityUpdateTrigger).to.equal(true);
    });

    it("forces _communityUpdateTrigger=true when the latest post cid changed", () => {
        const community = {
            updatedAt: Math.floor(Date.now() / 1000),
            _communityUpdateTrigger: false,
            lastPostCid: "QmOldPost",
            lastCommentCid: "QmComment",
            _pendingEditProps: [],
            _blocksToRm: [],
            _dbHandler: {
                queryLatestPostCid: () => ({ cid: "QmNewPost" }),
                queryLatestCommentCid: () => ({ cid: "QmComment" })
            }
        } as unknown as LocalCommunity;

        calculateLatestUpdateTrigger(community);
        expect(community._communityUpdateTrigger).to.equal(true);
    });

    it("does NOT flip _communityUpdateTrigger when everything is fresh and unchanged", () => {
        const community = {
            updatedAt: Math.floor(Date.now() / 1000),
            _communityUpdateTrigger: false,
            lastPostCid: "QmPost",
            lastCommentCid: "QmComment",
            _pendingEditProps: [],
            _blocksToRm: [],
            _dbHandler: {
                queryLatestPostCid: () => ({ cid: "QmPost" }),
                queryLatestCommentCid: () => ({ cid: "QmComment" })
            }
        } as unknown as LocalCommunity;

        calculateLatestUpdateTrigger(community);
        expect(community._communityUpdateTrigger).to.equal(false);
    });
});

describe("ipns-publishing: requireCommunityUpdateIfModQueueChanged", () => {
    it("sets _communityUpdateTrigger=true when the DB's combined-hash differs from cached", () => {
        const community = {
            _combinedHashOfPendingCommentsCids: "old-hash",
            _communityUpdateTrigger: false,
            _dbHandler: { queryCombinedHashOfPendingComments: () => "new-hash" }
        } as unknown as LocalCommunity;

        requireCommunityUpdateIfModQueueChanged(community);
        expect(community._communityUpdateTrigger).to.equal(true);
    });

    it("leaves _communityUpdateTrigger untouched when the hashes match", () => {
        const community = {
            _combinedHashOfPendingCommentsCids: "same-hash",
            _communityUpdateTrigger: false,
            _dbHandler: { queryCombinedHashOfPendingComments: () => "same-hash" }
        } as unknown as LocalCommunity;

        requireCommunityUpdateIfModQueueChanged(community);
        expect(community._communityUpdateTrigger).to.equal(false);
    });
});

describe("ipns-publishing: addOldPageCidsToCidsToUnpin", () => {
    it("is a no-op when both curPages and newPages are undefined", async () => {
        const cidsToUnPin = new Set<string>();
        const community = {
            _cidsToUnPin: cidsToUnPin,
            _blocksToRm: [] as string[],
            _clientsManager: {}
        } as unknown as LocalCommunity;

        await addOldPageCidsToCidsToUnpin(community, undefined, undefined);
        expect(cidsToUnPin.size).to.equal(0);
    });
});

describe("ipns-publishing: updateCommunityIpnsIfNeeded", () => {
    it("returns early without touching the DB or IPFS when _communityUpdateTrigger is false and everything is fresh", async () => {
        const queryCommunityStats = vi.fn();
        const community = {
            address: "community.bso",
            updatedAt: Math.floor(Date.now() / 1000),
            _communityUpdateTrigger: false,
            lastPostCid: "QmPost",
            lastCommentCid: "QmComment",
            _pendingEditProps: [],
            _blocksToRm: [],
            _dbHandler: {
                queryLatestPostCid: () => ({ cid: "QmPost" }),
                queryLatestCommentCid: () => ({ cid: "QmComment" }),
                queryCommunityStats
            },
            _clientsManager: {},
            // The orchestrator delegates the trigger calculation through this facade method
            // so integration tests can monkey-patch it; we no-op it here so the early-return
            // path stays intact.
            _calculateLatestUpdateTrigger: vi.fn()
        } as unknown as LocalCommunity;

        await updateCommunityIpnsIfNeeded(community, []);
        expect(queryCommunityStats).not.toHaveBeenCalled();
    });
});
