import { describe, it, afterEach, beforeAll, vi, type Mock, type MockInstance } from "vitest";
import * as util from "../../../dist/node/util.js";
import * as pagesUtil from "../../../dist/node/pages/util.js";
import * as signatures from "../../../dist/node/signer/signatures.js";

import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { PurgedCommentTableRows } from "../../../dist/node/runtime/node/subplebbit/db-handler-types.js";
import type { SubplebbitSignature, SubplebbitSettings, SubplebbitIpfsType } from "../../../dist/node/subplebbit/types.js";
import type { CommentUpdatesRow, CommentsTableRow } from "../../../dist/node/publications/comment/types.js";
import type { AddResult } from "kubo-rpc-client";
import { CID } from "kubo-rpc-client";
import { TrackedInstanceRegistry } from "../../../dist/node/plebbit/tracked-instance-registry.js";

vi.mock("../../../dist/node/runtime/node/util.js", () => ({
    nativeFunctions: { fetch: vi.fn() },
    calculateExpectedSignatureSize: vi.fn(() => 0),
    calculateInlineRepliesBudget: vi.fn(() => 0),
    deriveCommentIpfsFromCommentTableRow: vi.fn((row: Record<string, string>) => row),
    getThumbnailPropsOfLink: vi.fn(),
    importSignerIntoKuboNode: vi.fn(),
    moveSubplebbitDbToDeletedDirectory: vi.fn()
}));

interface StubKuboClient {
    _client: {
        block: { rm: Mock };
        pin: { rm: Mock };
        files: {
            stat: Mock;
            flush: Mock;
            write: Mock;
            rm: Mock;
        };
        name: { publish: Mock };
        key?: { rm: Mock };
    };
    url: string;
    removedBlocks: string[];
    pinRmCalls: string[];
}

// Type for partial mock of PurgedCommentTableRows used in tests
type TestPurgedCommentTableRows = {
    commentTableRow: Pick<CommentsTableRow, "cid">;
    commentUpdateTableRow?: Pick<CommentUpdatesRow, "postUpdatesBucket" | "replies">;
};

// Use a permissive type for the test subplebbit mock since we're mocking internal/private properties
interface TestLocalSubplebbit {
    address: string;
    _cidsToUnPin: Set<string>;
    _mfsPathsToRemove: Set<string>;
    _blocksToRm: string[];
    _subplebbitUpdateTrigger: boolean;
    updateCid?: string;
    statsCid?: string;
    settings: SubplebbitSettings;
    signer: {
        ipnsKeyName: string;
        address: string;
        publicKey: string;
        privateKey: string;
        shortAddress: string;
        type: "ed25519";
    };
    // Use partial mock type for testing
    _addAllCidsUnderPurgedCommentToBeRemoved(purgedCommentAndCommentUpdate: TestPurgedCommentTableRows): void;
    _unpinStaleCids(): Promise<void>;
    _rmUnneededMfsPaths(): Promise<string[]>;
    updateSubplebbitIpnsIfNeeded(args: { commentUpdateRowsToPublishToIpfs: unknown[]; signal?: AbortSignal }): Promise<void>;
    _addOldPageCidsToCidsToUnpin(pages: SubplebbitIpfsType["posts"]): Promise<void>;
    delete(): Promise<void>;
}

let LocalSubplebbitClass: typeof LocalSubplebbit;

const VALID_CID_A = "QmYwAPJzv5CZsnAzt8auVTLcAckU4iigFsMNBvYHiYAv5k";
const VALID_CID_B = "QmZtrqcSJR25CzAJhDigw1VE3DybMTDfjQX5nGoK2cHpik";
const VALID_CID_C = "QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB";
const VALID_CID_D = "QmcRD4wkPPi6dig81r5sLj9Zm1gDCL4zgpEj9CfuRrGbzF";

function createStubKuboClient(): StubKuboClient {
    const removedBlocks: string[] = [];
    const pinRmCalls: string[] = [];
    const blockRm = vi.fn(async function* (cids: string[]) {
        for (const cid of cids) {
            removedBlocks.push(cid);
            yield { cid };
        }
    });

    const kuboClient: StubKuboClient = {
        _client: {
            block: { rm: blockRm },
            pin: {
                rm: vi.fn(async (cid: string) => {
                    pinRmCalls.push(cid);
                })
            },
            files: {
                stat: vi.fn(),
                flush: vi.fn(),
                write: vi.fn(),
                rm: vi.fn()
            },
            name: {
                publish: vi.fn(async (path: string) => ({ name: "stub-key", value: path }))
            }
        },
        url: "kubo-url",
        removedBlocks,
        pinRmCalls
    };

    return kuboClient;
}

function createTestSubplebbit(overrides: { address?: string } = {}): { subplebbit: TestLocalSubplebbit; kuboClient: StubKuboClient } {
    const kuboClient = createStubKuboClient();

    const subplebbit = Object.assign(Object.create(LocalSubplebbitClass.prototype), {
        address: overrides.address || "test-address",
        _cidsToUnPin: new Set<string>(),
        _mfsPathsToRemove: new Set<string>(),
        _blocksToRm: [] as string[],
        _pendingEditProps: [],
        _subplebbitUpdateTrigger: true,
        _firstUpdateAfterStart: false,
        _plebbit: {
            publishInterval: 20,
            _timeouts: { "page-ipfs": 1000 },
            _startedSubplebbits: new TrackedInstanceRegistry(),
            _updatingSubplebbits: new TrackedInstanceRegistry(),
            _updatingComments: new TrackedInstanceRegistry()
        },
        raw: { subplebbitIpfs: {} },
        modQueue: { resetPages: vi.fn() },
        settings: { challenges: [] } as SubplebbitSettings,
        lastPostCid: undefined,
        lastCommentCid: undefined,
        _clientsManager: {
            getDefaultKuboRpcClient: vi.fn(() => kuboClient),
            updateKuboRpcState: vi.fn(),
            updateKuboRpcPubsubState: vi.fn()
        },
        _dbHandler: {
            createTransaction: vi.fn(),
            queryLatestPostCid: vi.fn().mockReturnValue(undefined),
            queryLatestCommentCid: vi.fn().mockReturnValue(undefined),
            commitTransaction: vi.fn(),
            querySubplebbitStats: vi.fn().mockReturnValue({}),
            keyvGet: vi.fn().mockReturnValue(undefined),
            keyvSet: vi.fn().mockReturnValue(undefined)
        },
        _pageGenerator: {
            generateModQueuePages: vi.fn().mockResolvedValue(undefined),
            generateSubplebbitPosts: vi.fn().mockResolvedValue(undefined)
        },
        signer: {
            ipnsKeyName: "test-key",
            address: "12D3KooStubAddress",
            publicKey: "stub-public-key",
            privateKey: "stub-private-key",
            shortAddress: "stub-short",
            type: "ed25519" as const
        },
        _calculateLatestUpdateTrigger: vi.fn(function (this: TestLocalSubplebbit) {
            this._subplebbitUpdateTrigger = true;
        }),
        _toJSONIpfsBaseNoPosts: vi.fn(() => ({
            address: overrides.address || "test-address",
            createdAt: 0,
            updatedAt: 0,
            title: "test title",
            description: "test description",
            rules: [],
            features: {},
            roles: {},
            suggested: [],
            settings: { challenges: [] },
            protocolVersion: "1"
        })),
        _updateDbInternalState: vi.fn(),
        _updateIpnsPubsubPropsIfNeeded: vi.fn(),
        _validateSubSizeSchemaAndSignatureBeforePublishing: vi.fn(),
        initSubplebbitIpfsPropsNoMerge: vi.fn(),
        _resolveIpnsAndLogIfPotentialProblematicSequence: vi.fn(),
        _calculateNewPostUpdates: vi.fn().mockResolvedValue(undefined),
        _changeStateEmitEventEmitStateChangeEvent: vi.fn()
    }) as TestLocalSubplebbit;

    return { subplebbit, kuboClient };
}

function createMockAddResult(cidStr: string, size: number): AddResult {
    return {
        path: cidStr,
        size,
        cid: CID.parse(cidStr)
    };
}

describe("local subplebbit garbage collection", () => {
    beforeAll(async () => {
        ({ LocalSubplebbit: LocalSubplebbitClass } = await import("../../../dist/node/runtime/node/subplebbit/local-subplebbit.js"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("collects purged comment tree cids, mfs paths, and blocks for cleanup", async () => {
        const { subplebbit } = createTestSubplebbit();
        const purgeCid = VALID_CID_A;
        const replyCids = [VALID_CID_B, "QmReplyExtraCid11111111111111111111111111111111111"];
        const iterateSpy = vi.spyOn(pagesUtil, "iterateOverPageCidsToFindAllCids").mockResolvedValue(replyCids);

        await subplebbit._addAllCidsUnderPurgedCommentToBeRemoved({
            commentTableRow: { cid: purgeCid },
            commentUpdateTableRow: {
                postUpdatesBucket: 86400,
                replies: { pageCids: { best: "QmRepliesPage" }, pages: {} }
            }
        });

        expect(Array.from(subplebbit._cidsToUnPin)).to.include.members([purgeCid, ...replyCids]);
        expect(subplebbit._blocksToRm).to.include.members([purgeCid, ...replyCids]);
        expect(subplebbit._mfsPathsToRemove.has(`/${subplebbit.address}/postUpdates/86400/${purgeCid}/update`)).to.equal(true);
        expect(iterateSpy.mock.calls.length).to.equal(1);
    });

    it("unpins stale cids and clears the queue even when pins are already removed", async () => {
        const { subplebbit, kuboClient } = createTestSubplebbit();
        const cidsToUnpin = [VALID_CID_A, VALID_CID_B];
        subplebbit._cidsToUnPin = new Set(cidsToUnpin);

        kuboClient._client.pin.rm = vi.fn(async (cid: string) => {
            if (cid === VALID_CID_B) {
                const error = new Error("not pinned: already removed");
                throw error;
            }
        });

        await subplebbit._unpinStaleCids();

        expect(kuboClient._client.pin.rm.mock.calls.length).to.equal(2);
        expect(subplebbit._cidsToUnPin.size).to.equal(0);
    });

    it("removes queued MFS paths and keeps pending ones when files are missing", async () => {
        const { subplebbit, kuboClient } = createTestSubplebbit();
        const toDelete = ["/sub/remove/first", "/sub/remove/second"];
        subplebbit._mfsPathsToRemove = new Set(toDelete);

        const removeSpy = vi.spyOn(util, "removeMfsFilesSafely").mockResolvedValue() as MockInstance<typeof util.removeMfsFilesSafely>;
        const removed = await subplebbit._rmUnneededMfsPaths();

        expect(removeSpy.mock.calls[0][0].paths).to.deep.equal(toDelete);
        expect(removed).to.have.members(toDelete);
        expect(subplebbit._mfsPathsToRemove.size).to.equal(0);

        const missingError = new Error("file does not exist");
        removeSpy.mockRejectedValueOnce(missingError);
        subplebbit._mfsPathsToRemove = new Set(toDelete);

        const missingResult = await subplebbit._rmUnneededMfsPaths();

        expect(missingResult).to.have.members(toDelete);
        expect(removeSpy.mock.calls.length).to.equal(2);
        expect(subplebbit._mfsPathsToRemove.size).to.equal(toDelete.length);
        expect(kuboClient._client.files.rm.mock.calls.length).to.equal(0);
    });

    it("clears block removal queue during an IPNS update", async () => {
        const { subplebbit } = createTestSubplebbit();
        subplebbit._blocksToRm = [VALID_CID_A, VALID_CID_B];

        const retrySpy = vi.spyOn(util, "retryKuboIpfsAddAndProvide");
        retrySpy.mockResolvedValueOnce(createMockAddResult(VALID_CID_C, 5));
        retrySpy.mockResolvedValueOnce(createMockAddResult(VALID_CID_D, 5));

        vi.spyOn(signatures, "signCommunity").mockResolvedValue({
            signature: "sig",
            publicKey: "pk",
            signedPropertyNames: [],
            type: "ed25519"
        } as SubplebbitSignature);

        const removeBlocksSpy = vi.spyOn(util, "removeBlocksFromKuboNode");

        await subplebbit.updateSubplebbitIpnsIfNeeded({ commentUpdateRowsToPublishToIpfs: [] });

        expect(removeBlocksSpy.mock.calls.length).to.equal(1);
        expect(subplebbit._blocksToRm).to.deep.equal([]);
        expect(subplebbit.updateCid).to.equal(VALID_CID_D);
        expect(subplebbit._subplebbitUpdateTrigger).to.equal(false);
    });

    it("delete() unpins all tracked cids and removes the subplebbit MFS path", async () => {
        const pinRmCalls: string[] = [];
        const kuboClient = {
            _client: {
                pin: { rm: vi.fn(async (cid: string) => pinRmCalls.push(cid)) },
                key: { rm: vi.fn(async () => {}) },
                files: { rm: vi.fn(async () => {}) }
            },
            url: "mock-kubo"
        };

        const removeMfsSpy = vi.spyOn(util, "removeMfsFilesSafely").mockResolvedValue();
        const runtimeNodeUtil = await import("../../../dist/node/runtime/node/util.js");
        const moveDbSpy = runtimeNodeUtil.moveSubplebbitDbToDeletedDirectory as Mock;

        const subplebbit = Object.assign(Object.create(LocalSubplebbitClass.prototype), {
            address: "test-sub-delete",
            state: "stopped",
            signer: { ipnsKeyName: "key-name", address: "12D3KooMock" },
            _plebbit: {
                _startedSubplebbits: new TrackedInstanceRegistry(),
                _updatingSubplebbits: new TrackedInstanceRegistry(),
                _updatingComments: new TrackedInstanceRegistry()
            },
            _clientsManager: { getDefaultKuboRpcClient: vi.fn(() => kuboClient) },
            _cidsToUnPin: new Set<string>(),
            _mfsPathsToRemove: new Set<string>(),
            _blocksToRm: [] as string[],
            raw: { subplebbitIpfs: { posts: { pageCids: { hot: "QmPostsPage" }, pages: {} } } },
            statsCid: "QmStatsCid",
            updateCid: "QmUpdateCid",
            stop: vi.fn(),
            _updateDbInternalState: vi.fn(),
            initDbHandlerIfNeeded: vi.fn(),
            _dbHandler: {
                initDbIfNeeded: vi.fn(),
                queryAllCommentCidsAndTheirReplies: vi.fn().mockReturnValue([
                    { cid: "QmComment1", replies: { pageCids: { best: "QmReplyPage" }, pages: {} } },
                    { cid: "QmComment2", replies: undefined }
                ]),
                destoryConnection: vi.fn()
            },
            _addOldPageCidsToCidsToUnpin: vi.fn(async function (this: TestLocalSubplebbit, pages: SubplebbitIpfsType["posts"]) {
                if (pages?.pageCids) Object.values(pages.pageCids).forEach((cid) => this._cidsToUnPin.add(cid));
            }),
            _setState: vi.fn()
        }) as TestLocalSubplebbit;

        await subplebbit.delete();

        const expectedCids = ["QmPostsPage", "QmReplyPage", "QmComment1", "QmComment2", "QmUpdateCid", "QmStatsCid"];
        expect(new Set(pinRmCalls)).to.deep.equal(new Set(expectedCids));
        expect(subplebbit._cidsToUnPin.size).to.equal(0);
        expect(removeMfsSpy.mock.calls[0][0].paths).to.deep.equal([`/${subplebbit.address}`]);
        expect(moveDbSpy.mock.calls.length).to.equal(1);
    });
});
