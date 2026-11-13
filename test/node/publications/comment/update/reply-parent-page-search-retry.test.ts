import { describe, it, expect, vi, afterEach } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient, publishStaticCommunityWithPostInPages } from "../../../../../dist/node/test/test-util.js";
import { RepliesPages } from "../../../../../dist/node/pages/pages.js";
import { FailedToFetchPageIpfsFromGatewaysError, PKCError } from "../../../../../dist/node/pkc-error.js";
import { isParentPageFetchErrorWorthARetry } from "../../../../../dist/node/publications/comment/comment-client-manager.js";
import { findUpdatingComment } from "../../../../../dist/node/pkc/tracked-instance-registry-util.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";

// Issue #515: a reply that updates through its parent's replies.pageCids walks the parent's pages to find its own
// CommentUpdate. The community here is static (published exactly once), so nothing but the reply's own retry can run the
// walk again after a page fetch fails: the post never emits another update.
// The reply sits on the second page. `getPage` is stubbed per page cid; every other call goes to the real one.

type GetPageArgs = Parameters<RepliesPages["getPage"]>[0];
type GetPageResult = Awaited<ReturnType<RepliesPages["getPage"]>>;
type PageBehaviour = (attempt: number) => "fetch" | PKCError | GetPageResult;

interface ReplyClientsManagerInternals {
    _parentFirstPageCidsAlreadyLoaded: Set<string>;
    _transientFetchRetry: { attempts: number; timer?: unknown };
    handleUpdateEventFromPostToFetchReplyCommentUpdate(post: Comment): Promise<void>;
}

const waitForReplyUpdateMs = 30_000;
// Longer than the first two backoff delays (1s, then 2s), so a retry that should not happen would be seen
const noRetryWindowMs = 3500;
const emptyPage = { comments: [] } as unknown as GetPageResult;

const fetchTimeout = (pageCid: string) => new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: pageCid, simulated: true });

// Decides per call what a fetch of `pageCid` does. Returns the times at which that page was requested.
function stubGetPageFor(pageCid: string, behaviour: PageBehaviour) {
    const originalGetPage = RepliesPages.prototype.getPage;
    const requestedAt: number[] = [];
    vi.spyOn(RepliesPages.prototype, "getPage").mockImplementation(async function (this: RepliesPages, args: GetPageArgs) {
        if (args.cid !== pageCid) return originalGetPage.call(this, args);
        requestedAt.push(Date.now());
        const outcome = behaviour(requestedAt.length);
        if (outcome === "fetch") return originalGetPage.call(this, args);
        if (outcome instanceof PKCError) throw outcome;
        return outcome;
    });
    return requestedAt;
}

async function withReplyOnSecondPage(
    run: (ctx: {
        pkc: PKC;
        fixture: Awaited<ReturnType<typeof publishStaticCommunityWithPostInPages>>;
        pages: { first: string; second: string };
    }) => Promise<void>
) {
    const fixture = await publishStaticCommunityWithPostInPages({ withReplyOnSecondPageOfPostPageCids: true });
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
    try {
        await run({ pkc, fixture, pages: fixture.replyPageCids! });
    } finally {
        await pkc.destroy();
        await fixture.ipnsObj.pkc.destroy();
    }
}

// Records every error with the updatingState it was emitted under. The state is read inside the emission: the post's
// mirrored community states overwrite it on the next poll of the community.
function recordErrors(reply: Comment) {
    const errors: { error: PKCError; updatingState: string }[] = [];
    reply.on("error", (error) => errors.push({ error: error as PKCError, updatingState: reply.updatingState }));
    return errors;
}

const waitForUpdate = (reply: Comment, context: () => string) =>
    vi.waitFor(() => expect(reply.updatedAt, `the reply never got its CommentUpdate (${context()})`).to.be.a("number"), {
        timeout: waitForReplyUpdateMs,
        interval: 100
    });

const updatingInternals = (pkc: PKC, replyCid: string, postCid: string) => {
    const updatingReply = findUpdatingComment(pkc, { cid: replyCid });
    const updatingPost = findUpdatingComment(pkc, { cid: postCid });
    if (!updatingReply || !updatingPost) throw Error("the reply and its post should both be updating");
    return { manager: updatingReply._clientsManager as unknown as ReplyClientsManagerInternals, updatingPost };
};

describe("a reply updating through its parent's pageCids (#515)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The control: with no failure the walk over both pages finds the reply, so a red case below is the missing retry
    it("receives its CommentUpdate from the parent's second page when no fetch fails", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();
            await waitForUpdate(reply, () => `state ${reply.updatingState}`);
            expect(errors).to.deep.equal([]);
            const { manager } = updatingInternals(pkc, fixture.replyCid!, fixture.commentCid);
            expect([...manager._parentFirstPageCidsAlreadyLoaded], "a walk that found the reply is not repeated").to.deep.equal([
                pages.first
            ]);
            await reply.stop();
        }));

    // reply.updatingstate.test.ts runs on a live community and counts a fetch cycle repeated after a failed fetch once
    // (issue #543), so it would not notice a reply that walks its parent's pages twice on every load. Here nothing
    // fails and the community is static, so one walk is all there can be: each page is requested exactly once and no
    // retry is pending when the update arrives.
    it("walks the parent's pages once when no fetch fails", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            const originalGetPage = RepliesPages.prototype.getPage;
            const requestedPageCids: string[] = [];
            vi.spyOn(RepliesPages.prototype, "getPage").mockImplementation(async function (this: RepliesPages, args: GetPageArgs) {
                requestedPageCids.push(args.cid);
                return originalGetPage.call(this, args);
            });
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();
            await waitForUpdate(reply, () => `state ${reply.updatingState}, pages requested: ${requestedPageCids.join(", ")}`);

            expect(requestedPageCids).to.deep.equal([pages.first, pages.second]);
            expect(errors).to.deep.equal([]);
            const { manager } = updatingInternals(pkc, fixture.replyCid!, fixture.commentCid);
            expect(manager._transientFetchRetry.attempts).to.equal(0);
            expect(manager._transientFetchRetry.timer).to.be.undefined;

            // And no second walk follows the one that found the reply
            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(requestedPageCids).to.deep.equal([pages.first, pages.second]);
            await reply.stop();
        }));

    for (const failingPage of ["first", "second"] as const) {
        it(`still receives its CommentUpdate when the fetch of the parent's ${failingPage} page fails once`, () =>
            withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
                const requestedAt = stubGetPageFor(pages[failingPage], (attempt) =>
                    attempt === 1 ? fetchTimeout(pages[failingPage]) : "fetch"
                );
                const reply = await pkc.createComment({ cid: fixture.replyCid! });
                const errors = recordErrors(reply);
                await reply.update();

                await waitForUpdate(
                    reply,
                    () =>
                        `state ${reply.updatingState}, ${requestedAt.length} fetches of the failing page, ` +
                        `errors: ${errors.map((e) => e.error.code).join(", ")}`
                );
                expect(requestedAt, "the failing page is fetched once more, by the retry").to.have.length(2);
                expect(errors).to.have.length(1);
                expect(errors[0].error.code).to.equal("ERR_FAILED_TO_FIND_REPLY_COMMENT_UPDATE_WITHIN_PARENT_COMMENT_PAGE_CIDS");
                expect(errors[0].error.details.reason).to.equal("page-fetch-failed");
                expect(errors[0].updatingState, "a fetch failure that is retried is not a failed state").to.equal("waiting-retry");
                await reply.stop();
            }));
    }

    it("keeps retrying with a delay that doubles while the page fetch keeps failing", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            const requestedAt = stubGetPageFor(pages.first, (attempt) => (attempt <= 3 ? fetchTimeout(pages.first) : "fetch"));
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();

            await waitForUpdate(reply, () => `${requestedAt.length} fetches of the failing page`);
            expect(requestedAt).to.have.length(4);
            expect(errors.map((e) => e.updatingState)).to.deep.equal(["waiting-retry", "waiting-retry", "waiting-retry"]);
            const gaps = requestedAt.slice(1).map((time, i) => time - requestedAt[i]);
            // Timers never fire early, and the walk itself adds a little on top of each delay
            expect(gaps[0], `gaps: ${gaps.join(", ")}`).to.be.within(990, 1900);
            expect(gaps[1], `gaps: ${gaps.join(", ")}`).to.be.within(1990, 3900);
            expect(gaps[2], `gaps: ${gaps.join(", ")}`).to.be.within(3990, 7900);
            await reply.stop();
        }));

    // A post update that arrives while a retry is pending replaces it. When that search succeeds, the failures before it
    // are forgotten, so a later unrelated failure starts over at the shortest delay instead of where the backoff had got
    it("starts the backoff over after a search that replaced a pending retry succeeds", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            const requestedAt = stubGetPageFor(pages.first, (attempt) => (attempt === 1 ? fetchTimeout(pages.first) : "fetch"));
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();
            await vi.waitFor(() => expect(errors).to.have.length(1), { timeout: waitForReplyUpdateMs, interval: 20 });
            const { manager, updatingPost } = updatingInternals(pkc, fixture.replyCid!, fixture.commentCid);
            expect(manager._transientFetchRetry.attempts).to.equal(1);

            // well inside the 1s the retry waits
            await manager.handleUpdateEventFromPostToFetchReplyCommentUpdate(updatingPost);
            expect(reply.updatedAt, "the search that replaced the retry found the reply").to.be.a("number");
            expect(manager._transientFetchRetry.attempts, "the failed attempt is still counted after a success").to.equal(0);
            expect(manager._transientFetchRetry.timer, "the replaced retry is still recorded as pending").to.be.undefined;

            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(requestedAt, "the replaced retry still ran").to.have.length(2);
            await reply.stop();
        }));

    it("stops retrying once the reply is stopped", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            const requestedAt = stubGetPageFor(pages.first, () => fetchTimeout(pages.first));
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();
            await vi.waitFor(() => expect(errors).to.have.length(1), { timeout: waitForReplyUpdateMs, interval: 50 });

            await reply.stop();
            const fetchesAtStop = requestedAt.length;
            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(requestedAt, "a stopped reply fetched its parent's page again").to.have.length(fetchesAtStop);
            expect(errors).to.have.length(fetchesAtStop);
        }));

    it("goes to failed and does not retry when the parent's page is invalid", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            const requestedAt = stubGetPageFor(pages.second, () => new PKCError("ERR_REPLIES_PAGE_IS_INVALID", { simulated: true }));
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();
            await vi.waitFor(() => expect(errors).to.have.length(1), { timeout: waitForReplyUpdateMs, interval: 50 });

            expect(errors[0].error.code).to.equal("ERR_FAILED_TO_FIND_REPLY_COMMENT_UPDATE_WITHIN_PARENT_COMMENT_PAGE_CIDS");
            expect(errors[0].error.details.reason).to.equal("page-invalid");
            expect(errors[0].updatingState).to.equal("failed");

            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(requestedAt, "the same page cid holds the same invalid bytes, fetching it again cannot help").to.have.length(1);
            expect(errors).to.have.length(1);
            const { manager } = updatingInternals(pkc, fixture.replyCid!, fixture.commentCid);
            expect([...manager._parentFirstPageCidsAlreadyLoaded]).to.deep.equal([pages.first]);
            expect(reply.updatedAt).to.be.undefined;
            await reply.stop();
        }));

    it("waits without an error when every page loaded and none holds the reply, and walks again only for another first page", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            // The second page is served without the reply, as if the community had not added the reply to its pages yet
            const requestedAt = stubGetPageFor(pages.second, () => emptyPage);
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            const states: string[] = [];
            reply.on("updatingstatechange", (state) => states.push(state));
            await reply.update();
            await vi.waitFor(() => expect(requestedAt).to.have.length(1), { timeout: waitForReplyUpdateMs, interval: 50 });
            const { manager, updatingPost } = updatingInternals(pkc, fixture.replyCid!, fixture.commentCid);
            await vi.waitFor(() => expect([...manager._parentFirstPageCidsAlreadyLoaded]).to.deep.equal([pages.first]), {
                timeout: waitForReplyUpdateMs,
                interval: 50
            });

            expect(errors, "nothing failed to load, so there is no error to report").to.deep.equal([]);
            expect(states[states.indexOf("fetching-update-ipfs") + 1], `states: ${states.join(", ")}`).to.equal("waiting-retry");
            expect(states).to.not.include("failed");
            expect(reply.updatedAt).to.be.undefined;

            // Another update of the post that lists the same first page: the same pages are not downloaded again
            await manager.handleUpdateEventFromPostToFetchReplyCommentUpdate(updatingPost);
            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(requestedAt, "pages that did not hold the reply were fetched again although none changed").to.have.length(1);
            expect(errors).to.deep.equal([]);

            // The parent lists another first page, which holds the reply: this one is walked
            vi.restoreAllMocks();
            updatingPost.replies.pageCids = { new: pages.second, old: pages.second };
            await manager.handleUpdateEventFromPostToFetchReplyCommentUpdate(updatingPost);
            await waitForUpdate(reply, () => `state ${reply.updatingState}`);
            expect(errors).to.deep.equal([]);
            await reply.stop();
        }));

    it("waits with an error when the parent lists pageCids but none for the sort the search walks", () =>
        withReplyOnSecondPage(async ({ pkc, fixture, pages }) => {
            stubGetPageFor(pages.second, () => emptyPage);
            const reply = await pkc.createComment({ cid: fixture.replyCid! });
            const errors = recordErrors(reply);
            await reply.update();
            const { manager, updatingPost } = await vi.waitFor(() => updatingInternals(pkc, fixture.replyCid!, fixture.commentCid), {
                timeout: waitForReplyUpdateMs,
                interval: 50
            });
            await vi.waitFor(() => expect(manager._parentFirstPageCidsAlreadyLoaded.size).to.equal(1), {
                timeout: waitForReplyUpdateMs,
                interval: 50
            });

            updatingPost.replies.pageCids = { best: pages.first };
            await manager.handleUpdateEventFromPostToFetchReplyCommentUpdate(updatingPost);
            expect(errors).to.have.length(1);
            expect(errors[0].error.message).to.equal("Parent comment does not have any new or old pages");
            expect(errors[0].updatingState, "a later update of the parent may list the pages").to.equal("waiting-retry");
            await reply.stop();
        }));
});

describe("which parent page fetch errors are worth a retry (#515)", () => {
    const worthARetry = [
        "ERR_FETCH_CID_P2P_TIMEOUT",
        "ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P",
        "ERR_GATEWAY_TIMED_OUT_OR_ABORTED",
        "ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS"
    ] as const;
    const notWorthARetry = [
        "ERR_REPLIES_PAGE_IS_INVALID",
        "ERR_POSTS_PAGE_IS_INVALID",
        "ERR_PAGE_SIGNATURE_IS_INVALID",
        "ERR_PAGE_COMMENT_IS_INVALID",
        "ERR_INVALID_PAGE_IPFS_SCHEMA",
        "ERR_CALCULATED_CID_DOES_NOT_MATCH",
        "ERR_OVER_DOWNLOAD_LIMIT",
        "ERR_INVALID_JSON"
    ] as const;

    for (const code of worthARetry)
        it(`${code} is a loading failure, retried`, () => {
            expect(isParentPageFetchErrorWorthARetry(new PKCError(code, {}))).to.be.true;
        });
    for (const code of notWorthARetry)
        it(`${code} is a problem with the page itself, not retried`, () => {
            expect(isParentPageFetchErrorWorthARetry(new PKCError(code, {}))).to.be.false;
        });

    it("an error pkc-js does not recognize is not retried", () => {
        expect(isParentPageFetchErrorWorthARetry(new Error("something unexpected"))).to.be.false;
    });

    it("a gateways failure is retried as long as one gateway failed to load the page", () => {
        const error = new FailedToFetchPageIpfsFromGatewaysError({
            pageCid: "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx",
            gatewayToError: {
                "http://gateway-a": new PKCError("ERR_INVALID_PAGE_IPFS_SCHEMA", {}),
                "http://gateway-b": new PKCError("ERR_GATEWAY_TIMED_OUT_OR_ABORTED", {})
            }
        });
        expect(isParentPageFetchErrorWorthARetry(error)).to.be.true;
    });

    it("a gateways failure is not retried when every gateway served an invalid page", () => {
        const error = new FailedToFetchPageIpfsFromGatewaysError({
            pageCid: "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx",
            gatewayToError: {
                "http://gateway-a": new PKCError("ERR_INVALID_PAGE_IPFS_SCHEMA", {}),
                "http://gateway-b": new PKCError("ERR_OVER_DOWNLOAD_LIMIT", {})
            }
        });
        expect(isParentPageFetchErrorWorthARetry(error)).to.be.false;
    });
});
