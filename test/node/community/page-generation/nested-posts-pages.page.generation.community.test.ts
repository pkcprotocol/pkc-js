import { afterAll, beforeAll, expect, it } from "vitest";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { createCommunityWithDefaultDb, seedComments } from "../page-sorts/page-sorts-test-util.js";
import { updateCommentsThatNeedToBeUpdated } from "../../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import type { CommunityContext, TreeNode } from "../page-sorts/page-sorts-test-util.js";
import type { PageIpfs, RepliesPagesTypeIpfs } from "../../../../dist/node/pages/types.js";

// A post's page entry is its comment plus the CommentUpdate the community last signed and published, nested reply
// pages included: `replies` is a signed field, so a page must carry it byte for byte. The generator rebuilds each
// post's tree from the reply rows a batch of posts at a time (issue #351), keeps serialized entries across
// generations while their CommentUpdate is unchanged, and re-serializes a post whose update changed. This pins the
// output to the published updates: every page added to IPFS is byte-identical to the deterministic JSON of the
// published entries, every embedded first page holds the same objects, every sort's chain lists each post exactly
// once, before and after a post changes between two generations. Uses the fake kubo client of the page-sort tests,
// so it cannot run over RPC (the generator is driven in-process).
describeSkipIfRpc("post pages with nested replies are built from the published CommentUpdates", () => {
    let ctx: CommunityContext;
    const added = new Map<string, string>(); // cid -> page content
    const publishedByCid = new Map<string, PageIpfs["comments"][number]>(); // reference entries: comment row + signed update

    beforeAll(async () => {
        ctx = await createCommunityWithDefaultDb();
        const client = ctx.community._clientsManager.getDefaultKuboRpcClient()!._client as unknown as {
            add: (content: string) => Promise<{ cid: string; path: string; size: number }>;
        };
        const originalAdd = client.add;
        client.add = async (content: string) => {
            const res = await originalAdd(content);
            added.set(res.path, content);
            return res;
        };
        const trees: TreeNode[] = [];
        for (let p = 0; p < 60; p++) {
            const children: TreeNode[] = [];
            const replyCount = 3 + (p % 6);
            for (let r = 0; r < replyCount; r++)
                children.push({
                    label: `p${p}r${r}`,
                    contentBytes: r % 3 === 0 ? 900 : 120,
                    children: r % 2 === 0 ? [{ label: `p${p}r${r}c0`, contentBytes: 200 }] : []
                });
            // Escaping must match safe-stable-stringify byte for byte: quotes, backslashes, control chars, multi-byte
            const escapes = 'quote " backslash \\ newline \n tab \t control \u0001 emoji 😀 accents é 中文 '.repeat(p % 3 === 0 ? 40 : 1);
            if (p % 5 === 0) children[0].content = escapes;
            trees.push({ label: `p${p}`, contentBytes: p % 7 === 0 ? 6000 : 300, ...(p % 4 === 0 ? { content: escapes } : {}), children });
        }
        await seedComments(ctx.community, trees);
        await publishUpdates();
        const repliesOf = (entry: PageIpfs["comments"][number]) => entry.commentUpdate.replies as RepliesPagesTypeIpfs | undefined;
        expect([...publishedByCid.values()].some((entry) => (repliesOf(entry)?.pages?.best?.comments.length ?? 0) > 0)).to.be.true;
    });

    const exclusions = {
        parentCid: null as string | null,
        excludeRemovedComments: true,
        excludeDeletedComments: true,
        excludeCommentPendingApproval: true,
        excludeCommentWithApprovedFalse: true,
        excludeCommentsWithDifferentCommunityAddress: true
    };

    // Run the CommentUpdate pass the sync loop runs and refresh the reference entries of the posts it touched
    async function publishUpdates() {
        const db = ctx.community._dbHandler;
        const updates = await updateCommentsThatNeedToBeUpdated(ctx.community);
        db.markCommentsAsPublishedToPostUpdates(updates.map((u) => u.newCommentUpdate.cid));
        const posts = db.queryPosts(exclusions);
        expect(posts).to.have.length(60);
        for (const post of posts) {
            const update = updates.find((u) => u.newCommentUpdate.cid === post.commentUpdate.cid);
            if (!update) {
                expect(publishedByCid.has(post.commentUpdate.cid), `untouched post ${post.commentUpdate.cid} has a reference`).to.be.true;
                continue;
            }
            publishedByCid.set(post.commentUpdate.cid, { comment: post.comment, commentUpdate: update.newCommentUpdate });
        }
        return updates;
    }

    afterAll(async () => {
        await ctx.cleanup();
    });

    async function generateAndCheck() {
        added.clear();
        const budget = 48 * 1024; // small enough that hot spans several chunks and best is not the only sort in pageCids
        const generated = await ctx.community._pageGenerator.generateCommunityPosts({ preloadedPageSizeBytes: budget });
        expect(generated).to.exist;
        expect(generated).to.not.have.property("singlePreloadedPage");
        const full = generated as Extract<typeof generated, { allPageCids: unknown }>;
        expect(Object.keys(full.failedSorts)).to.deep.equal([]);
        expect(Object.keys(full.pages)).to.deep.equal(["hot"]);
        expect(Object.keys(full.allPageCids).length).to.be.greaterThan(1);

        const checkPage = (page: PageIpfs, label: string) => {
            const expectedEntries = page.comments.map((entry) => {
                const reference = publishedByCid.get(entry.commentUpdate.cid);
                expect(reference, `${label}: unknown post ${entry.commentUpdate.cid}`).to.exist;
                return reference!;
            });
            expect(page.comments, `${label}: entries`).to.deep.equal(expectedEntries);
            const expectedPage: PageIpfs = { comments: expectedEntries, ...(page.nextCid ? { nextCid: page.nextCid } : {}) };
            return deterministicStringify(expectedPage);
        };

        for (const [sortName, cids] of Object.entries(full.allPageCids)) {
            const embedded = full.pages[sortName];
            const seen: string[] = [];
            if (embedded) {
                checkPage(embedded, `${sortName} embedded`);
                seen.push(...embedded.comments.map((c) => c.commentUpdate.cid));
                if (cids.length > 0) expect(embedded.nextCid).to.equal(cids[0]);
                else expect(embedded.nextCid).to.be.undefined;
            } else expect(full.pageCids?.[sortName]).to.equal(cids[0]);
            for (const [index, cid] of cids.entries()) {
                const content = added.get(cid);
                expect(content, `${sortName} page ${index} was added`).to.be.a("string");
                const page = JSON.parse(content!) as PageIpfs;
                expect(content).to.equal(checkPage(page, `${sortName} page ${index}`));
                expect(page.nextCid).to.equal(cids[index + 1]);
                seen.push(...page.comments.map((c) => c.commentUpdate.cid));
            }
            expect(seen.length, `${sortName} lists every post once`).to.equal(60);
            expect(new Set(seen).size).to.equal(60);
        }
    }

    it("adds pages byte-identical to the deterministic JSON of the published entries and embeds the same objects", async () => {
        await generateAndCheck();
    });

    it("re-serializes a post whose CommentUpdate changed between generations and reuses the rest", async () => {
        // A new reply under one post re-flags that post (and only it): its entry must come out fresh, the other 59
        // may come from the cache. The reference is refreshed from the published update, so a stale cached entry
        // would break byte-identity.
        const target = [...publishedByCid.keys()][7];
        await seedComments(ctx.community, [{ label: "late-reply", contentBytes: 400 }], { cid: target, depth: 0, postCid: target });
        const updates = await publishUpdates();
        expect(updates.map((u) => u.newCommentUpdate.cid)).to.include(target);
        await generateAndCheck();
        await generateAndCheck(); // and again with everything cached
    });

    it("resolves the same trees through the flat post read and through the recursive CID-ref walk", () => {
        const db = ctx.community._dbHandler;
        const posts = db.queryPosts(exclusions);
        const flat = db.resolveRepliesCidRefsForEntries(posts); // every entry a post: one indexed read of their subtrees
        const anyReply = db.queryPageComments({
            ...exclusions,
            parentCid: posts[0].commentUpdate.cid,
            baseTimestamp: Math.floor(Date.now() / 1000)
        })[0];
        const recursive = db.resolveRepliesCidRefsForEntries([...posts, anyReply]).slice(0, posts.length); // a reply in the set: the CID-ref walk
        expect(flat.map((entry) => JSON.stringify(entry))).to.deep.equal(recursive.map((entry) => JSON.stringify(entry)));
        for (const entry of flat) {
            const reference = publishedByCid.get(entry.commentUpdate.cid)!;
            expect(JSON.stringify(entry)).to.equal(deterministicStringify(reference)); // built with sorted keys
        }
    });
});
