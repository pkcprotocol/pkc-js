import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, expect, beforeAll, afterAll } from "vitest";
import { updateCommentsThatNeedToBeUpdated } from "../../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import { wirePagesFromGeneration } from "../../../../dist/node/runtime/node/community/page-generator.js";
import {
    createCommunityWithDefaultDb,
    getPageGenerator,
    seedComments,
    KEYWORD_FILTER_SORT_PATH,
    type CommunityContext,
    type TreeNode
} from "./page-sorts-test-util.js";

import type { CommentUpdateType, DbRepliesFormat } from "../../../../dist/node/publications/comment/types.js";
import type { CommunitySettings } from "../../../../dist/node/community/types.js";

// Issue #477. A CommentUpdate is stored with CID refs and its wire form is rebuilt whenever it is embedded in a page, so
// the rebuilt form must equal what was signed, byte for byte, at every embedded level and on both resolve paths (a page of
// posts reads flat subtrees, a page of replies walks the CID refs). Rows are seeded and IPFS adds are faked; CommentUpdates
// are really signed, and the comparison names the exact field that differs.
// These drive the page generator and the DB directly, which only exists on a LocalCommunity in this process.

type WirePages = NonNullable<CommentUpdateType["replies"]>["pages"] | undefined;

function diffForms(signed: unknown, rebuilt: unknown, at: string, out: string[]): void {
    if (typeof signed !== "object" || signed === null || typeof rebuilt !== "object" || rebuilt === null) {
        if (signed !== rebuilt) out.push(`${at}: signed ${JSON.stringify(signed)} rebuilt ${JSON.stringify(rebuilt)}`);
        return;
    }
    const signedRecord = signed as Record<string, unknown>;
    const rebuiltRecord = rebuilt as Record<string, unknown>;
    for (const key of new Set([...Object.keys(signedRecord), ...Object.keys(rebuiltRecord)])) {
        if (!(key in signedRecord)) out.push(`${at}.${key}: only in rebuilt`);
        else if (!(key in rebuiltRecord)) out.push(`${at}.${key}: only in signed`);
        else diffForms(signedRecord[key], rebuiltRecord[key], `${at}.${key}`, out);
    }
}

// Every difference between what was signed and what the pages embed. An entry of a flat page was signed without its own
// `replies`, so it is compared as part of the post that embeds it, not against its own row
function differencesInPages(
    pages: WirePages,
    signedByCid: Map<string, unknown>,
    flatSorts: ReadonlySet<string>,
    at = "page",
    out: string[] = []
): string[] {
    for (const [sortName, page] of Object.entries(pages ?? {})) {
        if (flatSorts.has(sortName)) continue;
        for (const entry of page?.comments ?? []) {
            const update = entry.commentUpdate as unknown as CommentUpdateType;
            const entryAt = `${at}/${sortName}/depth${entry.comment.depth}`;
            diffForms(signedByCid.get(update.cid), JSON.parse(JSON.stringify(update)), entryAt, out);
            differencesInPages(update.replies?.pages, signedByCid, flatSorts, entryAt, out);
        }
    }
    return out;
}

function defineCases(args: {
    name: string;
    pages?: NonNullable<CommunitySettings["pages"]>;
    flatSorts?: string[];
    tree: TreeNode[];
    assertSetup?: (ctx: { storedReplies: (label: string) => DbRepliesFormat }) => void;
}) {
    describeSkipIfRpc(`issue #477 rebuilt replies equal signed replies: ${args.name}`, () => {
        let context: CommunityContext;
        let cidOf: (label: string) => string;
        const signedByCid = new Map<string, unknown>();
        const flatSorts = new Set(args.flatSorts ?? []);

        beforeAll(async () => {
            context = await createCommunityWithDefaultDb();
            if (args.pages) {
                await context.community.edit({ settings: { ...context.community.settings, pages: args.pages } });
                await context.community._dbHandler.initDbIfNeeded();
            }
            cidOf = (await seedComments(context.community, args.tree)).cidOf;
            const rows = await updateCommentsThatNeedToBeUpdated(context.community);
            for (const row of rows) signedByCid.set(row.newCommentUpdate.cid, JSON.parse(JSON.stringify(row.newCommentUpdate)));
        });
        afterAll(async () => {
            await context.cleanup();
        });

        const storedReplies = (label: string): DbRepliesFormat => {
            const row = context.community._dbHandler["_db"]
                .prepare("SELECT replies FROM commentUpdates WHERE cid = ?")
                .get(cidOf(label)) as {
                replies: string | null;
            };
            return JSON.parse(row.replies ?? "{}");
        };

        if (args.assertSetup) it("the seeded tree produces the row shape this case is about", () => args.assertSetup!({ storedReplies }));

        it("in a page of replies (the CID ref walk)", async () => {
            const generated = await getPageGenerator(context.community).generatePostPages({ cid: cidOf("post") }, 1024 * 1024);
            if (!generated) throw new Error("no reply pages generated");
            const pages = wirePagesFromGeneration(generated).pages as WirePages;
            expect(differencesInPages(pages, signedByCid, flatSorts)).to.deep.equal([]);
        });

        it("in a community posts page (the flat subtree read)", async () => {
            const generated = await getPageGenerator(context.community).generateCommunityPosts({ preloadedPageSizeBytes: 1024 * 1024 });
            if (!generated) throw new Error("no posts pages generated");
            const pages = wirePagesFromGeneration(generated).pages as WirePages;
            expect(differencesInPages(pages, signedByCid, flatSorts)).to.deep.equal([]);
        });
    });
}

const filteredSort = { path: KEYWORD_FILTER_SORT_PATH, options: { dropKeywords: "DROPME" }, preloaded: true };

// Every reply has a child the filter keeps and one it drops, so the preloaded sort never holds the whole set and the other
// sorts go to pageCids at every level
const filteredChain = (label: string, children?: TreeNode[]): TreeNode[] => [
    { label: `${label}-keep`, content: label, children },
    { label: `${label}-drop`, content: "DROPME" }
];
const filteredTree: TreeNode[] = [{ label: "post", children: filteredChain("d1", filteredChain("d2", filteredChain("d3"))) }];

defineCases({
    name: "a preloaded sort next to a non-preloaded sort",
    pages: { replies: [filteredSort, { name: "new" }] },
    tree: filteredTree,
    assertSetup: ({ storedReplies }) => {
        const stored = storedReplies("d2-keep");
        expect(stored.filtered?.commentCids?.length).to.equal(1);
        expect(stored.new?.allPageCids?.length).to.equal(1);
    }
});

defineCases({
    name: "two preloaded sorts next to a non-preloaded sort",
    pages: { replies: [filteredSort, { name: "best", preloaded: true }, { name: "new" }] },
    tree: filteredTree,
    assertSetup: ({ storedReplies }) => {
        const stored = storedReplies("d2-keep");
        expect(stored.filtered?.commentCids?.length).to.equal(1);
        expect(stored.best?.commentCids?.length).to.equal(2);
        expect(stored.new?.allPageCids?.length).to.equal(1);
    }
});

// No settings.pages. `busy` has more replies than its 256 KiB inline budget, so `best` embeds a first chunk continuing
// through nextCid and new/old go to pageCids, and its entry still fits the inline budget of the parent embedding it.
defineCases({
    name: "an unconfigured community with a reply over its inline budget",
    tree: [
        {
            label: "post",
            children: [
                {
                    label: "parent",
                    children: [
                        {
                            label: "busy",
                            children: Array.from({ length: 8 }, (_, i) => ({ label: `big-${i}`, contentBytes: 38 * 1000 }))
                        }
                    ]
                }
            ]
        }
    ],
    assertSetup: ({ storedReplies }) => {
        const stored = storedReplies("busy");
        expect(stored.best?.commentCids?.length).to.be.greaterThan(0);
        expect(stored.best?.allPageCids?.length).to.be.greaterThan(0);
        expect(stored.new?.allPageCids?.length).to.be.greaterThan(0);
        expect(storedReplies("parent").best?.commentCids?.length).to.equal(1);
        expect(storedReplies("post").best?.commentCids?.length).to.equal(1);
    }
});

// A flat page's entries were signed without their own `replies`, even when a nested sort gives them replies
defineCases({
    name: "a preloaded flat sort next to a preloaded nested sort",
    pages: {
        replies: [
            { name: "best", preloaded: true },
            { name: "newFlat", preloaded: true }
        ]
    },
    flatSorts: ["newFlat"],
    tree: [{ label: "post", children: [{ label: "r1", children: [{ label: "r2", children: [{ label: "r3" }] }] }] }],
    assertSetup: ({ storedReplies }) => {
        const stored = storedReplies("post");
        expect(stored.best?.commentCids?.length).to.equal(1);
        expect(stored.newFlat?.commentCids?.length).to.equal(3);
        expect(stored.newFlat?.flat).to.equal(true);
        expect(stored.best?.flat).to.be.undefined;
    }
});

// The same, with the flat sort overflowing into nextCid
defineCases({
    name: "an overflowed preloaded flat sort next to a preloaded nested sort",
    pages: {
        replies: [
            { name: "best", preloaded: true },
            { name: "newFlat", preloaded: true }
        ]
    },
    flatSorts: ["newFlat"],
    tree: [
        {
            label: "post",
            children: [
                {
                    label: "r1",
                    children: [{ label: "r2" }]
                },
                ...Array.from({ length: 8 }, (_, i) => ({ label: `big-${i}`, contentBytes: 38 * 1000 }))
            ]
        }
    ],
    assertSetup: ({ storedReplies }) => {
        expect(storedReplies("post").newFlat?.allPageCids?.length).to.be.greaterThan(0);
    }
});
