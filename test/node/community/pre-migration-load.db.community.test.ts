// A local community whose DB is still on an older DB_VERSION must remain loadable by
// pkc.createCommunity(), because that is the only way to reach start(), which is what runs the
// migration. pkc-js 0.0.82 broke this: createCommunity() -> updateInstanceStateWithDbState ->
// resolveDbPostsCidRefs queries the comments table with a column list derived from
// CommentIpfsSchema.shape (which gained `crosspost` in DB_VERSION 41), so every pre-migration DB
// carrying CID-ref posts threw `SqliteError: no such column: c.crosspost` before it could migrate.
//
// Issue: https://github.com/pkcprotocol/pkc-js/issues/273
import { describe, beforeAll, afterAll, expect, it } from "vitest";
import path from "node:path";
import Database from "better-sqlite3";
import env from "../../../dist/node/version.js";
import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityInstancePages
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// Rewrites a live community DB back to the state it would have had before the current DB_VERSION:
// the `crosspost` column removed from the comments table and user_version rolled back one version.
// This is the on-disk shape every community had after upgrading the client but before start()
// migrated it.
function downgradeCommunityDbBelowLatest(dbPath: string) {
    const db = new Database(dbPath);
    try {
        db.pragma("foreign_keys = OFF");
        db.exec("ALTER TABLE comments DROP COLUMN crosspost");
        db.pragma(`user_version = ${env.DB_VERSION - 1}`);
    } finally {
        db.close();
    }
}

function readCommentsColumns(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return (db.pragma("table_info(comments)") as { name: string }[]).map((col) => col.name);
    } finally {
        db.close();
    }
}

function readDbVersion(dbPath: string): number {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.pragma("user_version", { simple: true }) as number;
    } finally {
        db.close();
    }
}

// Rewrites the community's sqlite file directly and reads DbHandler internals, neither of which is
// reachable over RPC.
describeSkipIfRpc("Loading a community whose DB is behind the latest DB_VERSION", () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let dbPath: string;
    let postCid: string;

    beforeAll(async () => {
        pkc = await mockPKC({});
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // The failing query only runs for communities that have CID-ref posts in their internal
        // state, which is why empty communities kept starting fine on the affected hosts.
        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        postCid = post.cid!;
        await waitTillPostInCommunityInstancePages(post as Comment & { cid: string }, community);

        dbPath = path.join(pkc.dataPath!, "communities", community.address);
        await community.stop();
        downgradeCommunityDbBelowLatest(dbPath);
    }, 180000);

    afterAll(async () => {
        await community.stop().catch(() => {});
        await pkc.destroy();
    });

    it("the DB is set up on the pre-migration schema", () => {
        expect(readCommentsColumns(dbPath)).to.not.include("crosspost");
        expect(readDbVersion(dbPath)).to.equal(env.DB_VERSION - 1);
    });

    it("createCommunity() loads it instead of throwing on the missing column", async () => {
        const reloaded = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        expect(reloaded.address).to.equal(community.address);
        // The CID-ref posts still resolve, minus the column the old schema does not carry.
        const preloadedSort = Object.keys(reloaded.posts?.pages ?? {})[0];
        expect(preloadedSort).to.be.a("string");
        const loadedPostCids = reloaded.posts!.pages![preloadedSort]!.comments.map((c) => c.cid);
        expect(loadedPostCids).to.include(postCid);
    });

    it("start() then migrates the DB to the latest version", async () => {
        const reloaded = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        await reloaded.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: reloaded, predicate: async () => typeof reloaded.updatedAt === "number" });
            expect(reloaded._dbHandler.getDbVersion()).to.equal(env.DB_VERSION);
            expect(readCommentsColumns(dbPath)).to.include("crosspost");
        } finally {
            await reloaded.stop();
        }
    }, 180000);
});
