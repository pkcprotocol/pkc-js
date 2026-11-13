import { describe, it, expect, vi, afterEach } from "vitest";
import {
    mockGatewayPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    publishStaticCommunityWithPostInPages
} from "../../../../../dist/node/test/test-util.js";
import { CommentClientsManager } from "../../../../../dist/node/publications/comment/comment-client-manager.js";
import { FailedToFetchCommentUpdateFromGatewaysError, PKCError } from "../../../../../dist/node/pkc-error.js";
import type { CommunityIpfsType } from "../../../../../dist/node/community/types.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";

// A post whose file is not under the community record's postUpdates: published a moment ago, so the record predates
// it, or no longer kept there. The folders of postUpdates are named by immutable cids, so once a folder was read and
// has no entry for the post, reading it again gives the same answer. That is "nothing there yet", not a failure to
// load: the post waits for the next record, reports no error and does not retry against the same record.
//
// It only counts when the folder was actually read. A folder that could not be loaded says nothing about what is in
// it, so that lookup is a loading failure and is retried (issue #515), also when another folder was read and lacks
// the post. With gateways, "read" is every gateway answering 404 for the path.
//
// The community is static (published once), so nothing but the post's own retry can run the lookup again.

interface PostLookupInternals {
    useCommunityPostUpdatesToFetchCommentUpdateForPost(record: CommunityIpfsType): Promise<"fetch-failed" | undefined>;
    _calculatePathForPostCommentUpdate(folderCid: string, postCid: string): string;
    _resolveIpfsPathToCid(args: { root: string; path: string }): Promise<string | undefined>;
    fetchFromMultipleGateways(loadOpts: { root: string; recordPKCType: string }): Promise<unknown>;
}

const prototype = CommentClientsManager.prototype as unknown as PostLookupInternals;
const waitForLookupMs = 30_000;
// Longer than the first two backoff delays (1s, then 2s), so a retry that should not happen would be seen
const noRetryWindowMs = 3500;
// The UnixFS directory with no entries: a folder any kubo node has, and one the post is not in
const emptyFolderCid = "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn";
const nameNotInAnyFolder = "QmPostThatIsNotUnderPostUpdates";

// Runs a post's update against the fixture's record with `postUpdates` replaced and the post looked up under a name
// no folder has. Returns what the post reported during `noRetryWindowMs` after its first lookup.
async function lookUpPostThatIsInNoFolder({
    pkc,
    postCid,
    postUpdates,
    beforeUpdate
}: {
    pkc: PKC;
    postCid: string;
    postUpdates: NonNullable<CommunityIpfsType["postUpdates"]>;
    beforeUpdate?: () => void;
}) {
    const originalLookup = prototype.useCommunityPostUpdatesToFetchCommentUpdateForPost;
    let lookups = 0;
    vi.spyOn(prototype, "useCommunityPostUpdatesToFetchCommentUpdateForPost").mockImplementation(function (
        this: PostLookupInternals,
        record: CommunityIpfsType
    ) {
        lookups++;
        return originalLookup.call(this, { ...record, postUpdates });
    });
    vi.spyOn(prototype, "_calculatePathForPostCommentUpdate").mockImplementation(
        (folderCid: string) => `${folderCid}/${nameNotInAnyFolder}/update`
    );
    beforeUpdate?.();

    const post = await pkc.createComment({ cid: postCid });
    const errors: PKCError[] = [];
    post.on("error", (error) => errors.push(error as PKCError));
    const states: string[] = [];
    post.on("updatingstatechange", (state) => states.push(state));
    await post.update();
    await vi.waitFor(() => expect(lookups, "the post never looked in postUpdates").to.be.greaterThan(0), {
        timeout: waitForLookupMs,
        interval: 50
    });
    await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
    const result = { lookups, errors: [...errors], states: [...states], updatedAt: post.updatedAt };
    await post.stop();
    return result;
}

const expectNoRetryAndNoError = (result: Awaited<ReturnType<typeof lookUpPostThatIsInNoFolder>>) => {
    expect(result.errors.map((error) => error.code)).to.deep.equal([]);
    expect(result.lookups, "the same folders hold the same entries however often they are read").to.equal(1);
    expect(result.states, `states: ${result.states.join(", ")}`).to.include("waiting-retry");
    expect(result.states).to.not.include("failed");
    expect(result.updatedAt).to.be.undefined;
};

const expectRetryWithError = (result: Awaited<ReturnType<typeof lookUpPostThatIsInNoFolder>>) => {
    expect(result.lookups, "a folder that failed to load is looked in again").to.be.greaterThan(1);
    expect(result.errors.length).to.be.greaterThan(0);
    for (const error of result.errors) expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES");
    expect(result.states).to.not.include("failed");
};

// Makes the resolve of every path under `folderCid` fail the way a walk that could not reach the folder's blocks does
const failToLoadFolder = (folderCid: string) => {
    const originalResolve = prototype._resolveIpfsPathToCid;
    vi.spyOn(prototype, "_resolveIpfsPathToCid").mockImplementation(async function (
        this: PostLookupInternals,
        args: { root: string; path: string }
    ) {
        if (args.root === folderCid) throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { ipfsPath: `/ipfs/${args.root}/${args.path}` });
        return originalResolve.call(this, args);
    });
};

describe("a post whose file is not under postUpdates, with a kubo client", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const withFixture = async (run: (ctx: { pkc: PKC; postCid: string; folderCid: string }) => Promise<void>) => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        try {
            await run({ pkc, postCid: fixture.commentCid, folderCid: fixture.postUpdatesFolderCid! });
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    };

    it("waits without an error and does not retry when the one folder was read and lacks the post", () =>
        withFixture(async ({ pkc, postCid, folderCid }) => {
            expectNoRetryAndNoError(await lookUpPostThatIsInNoFolder({ pkc, postCid, postUpdates: { "86400": folderCid } }));
        }));

    it("waits without an error and does not retry when every folder was read and none has the post", () =>
        withFixture(async ({ pkc, postCid, folderCid }) => {
            expectNoRetryAndNoError(
                await lookUpPostThatIsInNoFolder({ pkc, postCid, postUpdates: { "86400": folderCid, "604800": emptyFolderCid } })
            );
        }));

    it("retries when the first folder lacks the post and the second could not be loaded", () =>
        withFixture(async ({ pkc, postCid, folderCid }) => {
            expectRetryWithError(
                await lookUpPostThatIsInNoFolder({
                    pkc,
                    postCid,
                    postUpdates: { "86400": folderCid, "604800": emptyFolderCid },
                    beforeUpdate: () => failToLoadFolder(emptyFolderCid)
                })
            );
        }));

    it("retries when the first folder could not be loaded and the second lacks the post", () =>
        withFixture(async ({ pkc, postCid, folderCid }) => {
            expectRetryWithError(
                await lookUpPostThatIsInNoFolder({
                    pkc,
                    postCid,
                    postUpdates: { "86400": folderCid, "604800": emptyFolderCid },
                    beforeUpdate: () => failToLoadFolder(folderCid)
                })
            );
        }));
});

describe("a post whose file is not under postUpdates, with gateways only", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const gatewayUrls = ["http://localhost:18080", "http://127.0.0.1:18080"];
    const gatewayError = (gatewayUrl: string, details: Record<string, unknown>) =>
        new PKCError("ERR_FAILED_TO_FETCH_IPFS_VIA_GATEWAY", { url: `${gatewayUrl}/ipfs/simulated`, ...details });
    const notFound = (gatewayUrl: string) => gatewayError(gatewayUrl, { status: 404, statusText: "Not Found" });

    // Replaces what the gateways answered for the post's update file. Every other gateway fetch is the real one
    const answerUpdateFileFetchWith = (gatewayToError: Record<string, PKCError>) => {
        const originalFetch = prototype.fetchFromMultipleGateways;
        vi.spyOn(prototype, "fetchFromMultipleGateways").mockImplementation(async function (
            this: PostLookupInternals,
            loadOpts: { root: string; recordPKCType: string }
        ) {
            if (loadOpts.recordPKCType !== "comment-update") return originalFetch.call(this, loadOpts);
            throw new FailedToFetchCommentUpdateFromGatewaysError({ gatewayToError, loadOpts });
        });
    };

    const withFixture = async (
        ipfsGatewayUrls: string[],
        run: (ctx: { pkc: PKC; postCid: string; folderCid: string }) => Promise<void>
    ) => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls } });
        try {
            await run({ pkc, postCid: fixture.commentCid, folderCid: fixture.postUpdatesFolderCid! });
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    };

    // The gateway's own answer, not a stubbed one: it reads the folder and reports the missing entry as 404
    it("waits without an error and does not retry when the only gateway answers 404", () =>
        withFixture([gatewayUrls[0]], async ({ pkc, postCid, folderCid }) => {
            expectNoRetryAndNoError(await lookUpPostThatIsInNoFolder({ pkc, postCid, postUpdates: { "86400": folderCid } }));
        }));

    it("waits without an error and does not retry when every gateway answers 404", () =>
        withFixture(gatewayUrls, async ({ pkc, postCid, folderCid }) => {
            expectNoRetryAndNoError(
                await lookUpPostThatIsInNoFolder({
                    pkc,
                    postCid,
                    postUpdates: { "86400": folderCid },
                    beforeUpdate: () =>
                        answerUpdateFileFetchWith({
                            [gatewayUrls[0]]: notFound(gatewayUrls[0]),
                            [gatewayUrls[1]]: notFound(gatewayUrls[1])
                        })
                })
            );
        }));

    it("retries when one gateway answers 404 and another failed to load", () =>
        withFixture(gatewayUrls, async ({ pkc, postCid, folderCid }) => {
            expectRetryWithError(
                await lookUpPostThatIsInNoFolder({
                    pkc,
                    postCid,
                    postUpdates: { "86400": folderCid },
                    beforeUpdate: () =>
                        answerUpdateFileFetchWith({
                            [gatewayUrls[0]]: notFound(gatewayUrls[0]),
                            [gatewayUrls[1]]: new PKCError("ERR_GATEWAY_TIMED_OUT_OR_ABORTED", { url: gatewayUrls[1] })
                        })
                })
            );
        }));

    it("retries when one gateway answers 404 and another has not answered at all", () =>
        withFixture(gatewayUrls, async ({ pkc, postCid, folderCid }) => {
            expectRetryWithError(
                await lookUpPostThatIsInNoFolder({
                    pkc,
                    postCid,
                    postUpdates: { "86400": folderCid },
                    beforeUpdate: () => answerUpdateFileFetchWith({ [gatewayUrls[0]]: notFound(gatewayUrls[0]) })
                })
            );
        }));

    for (const status of [500, 504, 429])
        it(`retries when the gateway answers ${status}, which is not an answer about the folder`, () =>
            withFixture([gatewayUrls[0]], async ({ pkc, postCid, folderCid }) => {
                expectRetryWithError(
                    await lookUpPostThatIsInNoFolder({
                        pkc,
                        postCid,
                        postUpdates: { "86400": folderCid },
                        beforeUpdate: () => answerUpdateFileFetchWith({ [gatewayUrls[0]]: gatewayError(gatewayUrls[0], { status }) })
                    })
                );
            }));
});
