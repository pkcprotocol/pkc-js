import { afterAll, beforeAll, expect, it } from "vitest";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { createCommunityWithDefaultDb, seedComments } from "../page-sorts/page-sorts-test-util.js";
import { updateCommentsThatNeedToBeUpdated } from "../../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import type { CommunityContext, TreeNode } from "../page-sorts/page-sorts-test-util.js";
import type { PageIpfs, RepliesPagesTypeIpfs } from "../../../../dist/node/pages/types.js";
import type { CommentUpdateType } from "../../../../dist/node/publications/comment/types.js";

// A post's page entry is its comment plus the CommentUpdate the community last signed and published, nested reply
// pages included: `replies` is a signed field, so a page must carry it byte for byte. The community stores that
// canonical `replies` JSON on the row when it signs the update (commentUpdates.wireReplies, issue #351) and builds
// post pages from it, resolving the CID-ref tree only for a row that lacks it. This pins the output to the published
// updates: every page added to IPFS is byte-identical to the deterministic JSON of the published entries, every
// embedded first page holds the same objects, every sort's chain lists each post exactly once, with and without the
// stored column. Uses the fake kubo client of the page-sort tests, so it cannot run over RPC (the generator is driven
// in-process).
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
        const updates = await updateCommentsThatNeedToBeUpdated(ctx.community);
        const db = ctx.community._dbHandler;
        db.markCommentsAsPublishedToPostUpdates(updates.map((u) => u.newCommentUpdate.cid));
        const posts = db.queryPosts({
            parentCid: null,
            excludeRemovedComments: true,
            excludeDeletedComments: true,
            excludeCommentPendingApproval: true,
            excludeCommentWithApprovedFalse: true,
            excludeCommentsWithDifferentCommunityAddress: true
        });
        expect(posts).to.have.length(60);
        for (const post of posts) {
            const update = updates.find((u) => u.newCommentUpdate.cid === post.commentUpdate.cid);
            expect(update, `published update of ${post.commentUpdate.cid}`).to.exist;
            publishedByCid.set(post.commentUpdate.cid, { comment: post.comment, commentUpdate: update!.newCommentUpdate });
        }
        const repliesOf = (entry: PageIpfs["comments"][number]) => entry.commentUpdate.replies as RepliesPagesTypeIpfs | undefined;
        expect([...publishedByCid.values()].some((entry) => (repliesOf(entry)?.pages?.best?.comments.length ?? 0) > 0)).to.be.true;
    });

    afterAll(async () => {
        await ctx.cleanup();
    });

    it("stores the canonical replies JSON of every signed CommentUpdate on its row", () => {
        const rows = ctx.community._dbHandler["_db"].prepare("SELECT cid, wireReplies FROM commentUpdates").all() as {
            cid: string;
            wireReplies: string | null;
        }[];
        expect(rows.length).to.be.greaterThan(60);
        for (const post of publishedByCid.values()) {
            const row = rows.find((r) => r.cid === post.commentUpdate.cid)!;
            expect(row.wireReplies).to.equal(deterministicStringify(post.commentUpdate.replies));
        }
        const leaf = rows.filter((row) => !publishedByCid.has(row.cid) && row.wireReplies === null);
        expect(leaf.length, "replies without children store no wire replies").to.be.greaterThan(0);
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

    it("resolves the CID-ref tree for rows without stored wire replies and still matches the published entries", async () => {
        // Rows written before the column existed, or seeded straight into the table: half the posts lose the column
        const db = ctx.community._dbHandler["_db"];
        const cids = [...publishedByCid.keys()].filter((_, index) => index % 2 === 0);
        db.prepare(`UPDATE commentUpdates SET wireReplies = NULL WHERE cid IN (${cids.map(() => "?").join(",")})`).run(...cids);
        expect(
            (
                db.prepare("SELECT COUNT(*) AS n FROM commentUpdates WHERE wireReplies IS NULL AND replies IS NOT NULL").get() as {
                    n: number;
                }
            ).n
        ).to.equal(cids.length);
        await generateAndCheck();
    });

    it("materializes a resolved entry the same way from the stored column and from the CID-ref tree", () => {
        const db = ctx.community._dbHandler;
        const posts = db.queryPosts({
            parentCid: null,
            excludeRemovedComments: true,
            excludeDeletedComments: true,
            excludeCommentPendingApproval: true,
            excludeCommentWithApprovedFalse: true,
            excludeCommentsWithDifferentCommunityAddress: true
        });
        const resolved = db.resolveRepliesCidRefsForEntries(posts);
        for (const entry of resolved) {
            const reference = publishedByCid.get(entry.commentUpdate.cid)!;
            expect(entry.commentUpdate.replies as CommentUpdateType["replies"]).to.deep.equal(reference.commentUpdate.replies);
            expect(JSON.stringify(entry)).to.equal(deterministicStringify(reference)); // built with sorted keys
        }
        expect(db.serializePageEntries(posts)).to.deep.equal(resolved.map((entry) => deterministicStringify(entry)));
    });
});
