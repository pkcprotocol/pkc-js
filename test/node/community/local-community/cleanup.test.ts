// Unit tests for src/runtime/node/community/local-community/cleanup.ts.
// Most cleanup helpers are IO-heavy (kubo pin.ls/pin.rm/files.* + GC), so this
// file focuses on a few testable seams:
//   - addAllCidsUnderPurgedCommentToBeRemoved (pure-ish state mutation)
//   - early-return / no-op behaviour for purgeDisapprovedCommentsOlderThan
//   - export shape for the remaining functions
// Full coverage lives in the integration suite (test/node/community/garbage.collection.community.test.ts etc.).

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    _describeReclaimedSpace,
    _resetRepoGcSchedulingState,
    addAllCidsUnderPurgedCommentToBeRemoved,
    cleanUpIpfsRepoIfDue,
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
        expect(typeof cleanUpIpfsRepoIfDue).to.equal("function");
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

describe("cleanup: repinCommentsIPFSIfNeeded", () => {
    // Regression: the same transient Kubo RPC connection blip that repinCommentUpdateIfNeeded
    // already tolerates used to throw straight out of community.start() one call earlier, from the
    // un-retried pin.ls probe (seen on CI as `TypeError: fetch failed` at kubo-rpc-client pin/ls).
    it("retries pin.ls on a transient Kubo connection error and still succeeds", async () => {
        const connectionErr = new TypeError("fetch failed"); // mimics undici ETIMEDOUT/ECONNRESET wrapper
        const pinLsSpy = vi
            .fn()
            .mockImplementationOnce(() => {
                throw connectionErr;
            })
            .mockImplementationOnce(async function* () {
                yield { cid: "QmLatestComment", type: "recursive" };
            });
        const queryAllCommentsOrderedByIdAsc = vi.fn();
        const community = {
            address: "community.bso",
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { pin: { ls: pinLsSpy } } }) },
            _dbHandler: { queryLatestCommentCid: () => ({ cid: "QmLatestComment" }), queryAllCommentsOrderedByIdAsc }
        } as unknown as LocalCommunity;

        vi.useFakeTimers();
        try {
            const promise = repinCommentsIPFSIfNeeded(community);
            await vi.advanceTimersByTimeAsync(5000); // let the retry backoff fire
            await promise;
        } finally {
            vi.useRealTimers();
        }

        // pin.ls was retried (2 calls), the pin was found on the 2nd attempt, so nothing was repinned.
        expect(pinLsSpy).toHaveBeenCalledTimes(2);
        expect(queryAllCommentsOrderedByIdAsc).not.toHaveBeenCalled();
    });

    it("does NOT retry an 'is not pinned' pin.ls (it is the legitimate repin signal)", async () => {
        const notPinnedErr = new Error("path 'QmLatestComment' is not pinned");
        const pinLsSpy = vi.fn().mockImplementation(() => {
            throw notPinnedErr;
        });
        const forceUpdateOnAllComments = vi.fn();
        const community = {
            address: "community.bso",
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { pin: { ls: pinLsSpy } } }) },
            _dbHandler: {
                queryLatestCommentCid: () => ({ cid: "QmLatestComment" }),
                queryAllCommentsOrderedByIdAsc: (): never[] => [],
                forceUpdateOnAllComments
            }
        } as unknown as LocalCommunity;

        await repinCommentsIPFSIfNeeded(community);

        expect(pinLsSpy).toHaveBeenCalledTimes(1); // not retried
        expect(forceUpdateOnAllComments).toHaveBeenCalledTimes(1); // went down the repin path instead
    });
});

describe("cleanup: repinCommentUpdateIfNeeded", () => {
    // Regression: a transient Kubo RPC connection blip (daemon briefly restarting) used to
    // throw straight out of community.start(). The files.stat call must now retry on connection
    // errors (`fetch failed` / ETIMEDOUT / ECONNREFUSED) instead of failing start().
    it("retries files.stat on a transient Kubo connection error and still succeeds", async () => {
        const connectionErr = new TypeError("fetch failed"); // mimics undici ETIMEDOUT/ECONNREFUSED wrapper
        const statSpy = vi.fn().mockRejectedValueOnce(connectionErr).mockResolvedValueOnce({ cid: "QmCommunityDir", blocks: 1 });
        const forceUpdateOnAllComments = vi.fn();
        const community = {
            address: "community.bso",
            lastCommentCid: "QmLastComment",
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { files: { stat: statSpy } } }) },
            _dbHandler: { forceUpdateOnAllComments }
        } as unknown as LocalCommunity;

        vi.useFakeTimers();
        try {
            const promise = repinCommentUpdateIfNeeded(community);
            await vi.advanceTimersByTimeAsync(5000); // let the retry backoff fire
            await promise;
        } finally {
            vi.useRealTimers();
        }

        // stat was retried (2 calls), the dir was found on the 2nd attempt, so no forced re-publish.
        expect(statSpy).toHaveBeenCalledTimes(2);
        expect(forceUpdateOnAllComments).not.toHaveBeenCalled();
    });

    it("does NOT retry a 'file does not exist' stat (it is the legitimate empty-dir signal)", async () => {
        const notExistErr = new Error("file does not exist");
        const statSpy = vi.fn().mockRejectedValue(notExistErr);
        const forceUpdateOnAllComments = vi.fn();
        const community = {
            address: "community.bso",
            lastCommentCid: undefined, // no comment updates -> early return without forcing republish
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: { files: { stat: statSpy } } }) },
            _dbHandler: { forceUpdateOnAllComments }
        } as unknown as LocalCommunity;

        await repinCommentUpdateIfNeeded(community);

        expect(statSpy).toHaveBeenCalledTimes(1); // not retried
        expect(forceUpdateOnAllComments).not.toHaveBeenCalled();
    });
});

describe("cleanup: cleanUpIpfsRepoIfDue", () => {
    // Builds a fake community wired to one kubo URL. repoSize only feeds the before/after log line —
    // nothing branches on it — while repo.gc records its calls so a test can assert whether it ran.
    const makeCommunity = ({
        url = "http://localhost:15001/api/v0",
        repoSize = 1n,
        gcImpl
    }: {
        url?: string;
        repoSize?: bigint;
        gcImpl?: () => AsyncGenerator<{ cid: string }>;
    } = {}) => {
        const stat = vi.fn(async (_options?: { searchParams?: URLSearchParams }) => ({
            numObjects: 0n,
            repoPath: "/repo",
            repoSize,
            version: "fs-repo@18",
            storageMax: 100n
        }));
        const gc = vi.fn(
            gcImpl ??
                (() =>
                    (async function* () {
                        yield { cid: "QmCollected" };
                    })())
        );
        // One stable client object: tests below re-stub methods on it after construction.
        const kuboRpcClient = { url, _client: { repo: { stat, gc } } };
        const community = {
            _clientsManager: { getDefaultKuboRpcClient: () => kuboRpcClient }
        } as unknown as LocalCommunity;
        return { community, kuboRpcClient, stat, gc };
    };

    beforeEach(() => _resetRepoGcSchedulingState());

    // /api/v0/repo/gc has no watermark of its own — Datastore.StorageGCWatermark is only read by the
    // daemon's `--enable-gc` loop, which pkc-js cannot turn on since it never spawns the daemon. The
    // interval floor is therefore the entire policy, and repo size must not gate the sweep.
    it("GCs on the interval alone, whatever the repo size", async () => {
        const { community, gc } = makeCommunity({ repoSize: 1n });

        await cleanUpIpfsRepoIfDue(community);

        expect(gc).toHaveBeenCalledTimes(1);
    });

    it("asks the daemon for size-only stats, not a full object count", async () => {
        // A default repo/stat counts every object, which walks the whole flatfs blockstore — millions
        // of files on exactly the repos this feature exists for.
        const { community, stat } = makeCommunity();

        await cleanUpIpfsRepoIfDue(community);

        for (const call of stat.mock.calls) {
            const passedSearchParams = call?.[0]?.searchParams as URLSearchParams | undefined;
            expect(passedSearchParams?.get("size-only")).to.equal("true");
        }
    });

    it("does not GC again within the interval floor", async () => {
        const { community, gc } = makeCommunity();

        await cleanUpIpfsRepoIfDue(community);
        await cleanUpIpfsRepoIfDue(community);
        await cleanUpIpfsRepoIfDue(community);

        expect(gc).toHaveBeenCalledTimes(1);
    });

    // repo.gc is a whole-daemon operation but this runs once per community sync, so a node hosting
    // dozens of communities calls it dozens of times against one daemon within the same tick.
    it("collapses concurrent callers on one kubo url into a single GC run", async () => {
        let releaseGc: () => void = () => {};
        const gcStarted = new Promise<void>((resolve) => (releaseGc = resolve));
        const { community, gc } = makeCommunity({
            gcImpl: () =>
                (async function* () {
                    await gcStarted;
                    yield { cid: "QmCollected" };
                })()
        });

        const runs = [cleanUpIpfsRepoIfDue(community), cleanUpIpfsRepoIfDue(community), cleanUpIpfsRepoIfDue(community)];
        releaseGc();
        await Promise.all(runs);

        expect(gc).toHaveBeenCalledTimes(1);
    });

    it("keys the interval floor per kubo url, so a second daemon still GCs", async () => {
        const first = makeCommunity({ url: "http://localhost:15001/api/v0" });
        const second = makeCommunity({ url: "http://localhost:15004/api/v0" });

        await cleanUpIpfsRepoIfDue(first.community);
        await cleanUpIpfsRepoIfDue(second.community);

        expect(first.gc).toHaveBeenCalledTimes(1);
        expect(second.gc).toHaveBeenCalledTimes(1);
    });

    it("force bypasses the interval floor", async () => {
        const { community, gc } = makeCommunity();

        await cleanUpIpfsRepoIfDue(community, true);
        await cleanUpIpfsRepoIfDue(community, true);

        expect(gc).toHaveBeenCalledTimes(2);
    });

    // repo.stat is only read to log how much the sweep reclaimed, so a daemon that cannot answer it
    // must still get GCed. Gating on it would mean a node under memory pressure never reclaims.
    it("still GCs when repo.stat fails, losing only the size readings", async () => {
        const { community, kuboRpcClient, gc } = makeCommunity();
        kuboRpcClient._client.repo.stat = vi.fn().mockRejectedValue(new Error("fetch failed"));

        await cleanUpIpfsRepoIfDue(community);

        expect(gc).toHaveBeenCalledTimes(1);
    });
});

describe("cleanup: _describeReclaimedSpace", () => {
    // The cid count from repo.gc says how many blocks went; only these numbers say whether that
    // mattered. On pkc-js#225 a repo that stays huge after a sweep is the signal that everything
    // left is pinned, which no GC schedule can fix.
    it("reports the reclaimed bytes and both sizes", () => {
        const oneGb = 1024n ** 3n;
        expect(_describeReclaimedSpace({ before: 12n * oneGb, after: 10n * oneGb })).to.equal("reclaimed 2.00GB (12.00GB -> 10.00GB)");
    });

    it("scales each unit and keeps raw bytes below 1KB", () => {
        expect(_describeReclaimedSpace({ before: 900n, after: 400n })).to.equal("reclaimed 500B (900B -> 400B)");
        expect(_describeReclaimedSpace({ before: 5n * 1024n * 1024n, after: 1n * 1024n * 1024n })).to.equal(
            "reclaimed 4.00MB (5.00MB -> 1.00MB)"
        );
    });

    it("reports a repo that grew during the sweep, rather than a negative reclaim", () => {
        // GC and the community syncs writing new blocks share one daemon, and nothing pauses
        // publishing for the length of a sweep, so after > before is a real outcome.
        expect(_describeReclaimedSpace({ before: 10n * 1024n * 1024n, after: 12n * 1024n * 1024n })).to.equal(
            "reclaimed no space, the repo grew 2.00MB during the sweep (10.00MB -> 12.00MB)"
        );
    });

    it("says so when repo.stat gave us nothing, on either side", () => {
        const unavailable = "reclaimed an unknown amount, repo.stat was unavailable";
        expect(_describeReclaimedSpace({ before: undefined, after: 10n })).to.equal(unavailable);
        expect(_describeReclaimedSpace({ before: 10n, after: undefined })).to.equal(unavailable);
        expect(_describeReclaimedSpace({ before: undefined, after: undefined })).to.equal(unavailable);
    });

    it("does not treat a zero-byte reclaim as unknown", () => {
        expect(_describeReclaimedSpace({ before: 0n, after: 0n })).to.equal("reclaimed 0B (0B -> 0B)");
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
