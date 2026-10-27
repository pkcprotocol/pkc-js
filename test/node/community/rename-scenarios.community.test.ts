import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    createMockNameResolver,
    publishRandomPost,
    publishRandomReply,
    mockPKCV2,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityPages,
    waitTillReplyInParentPages,
    generateMockComment
} from "../../../dist/node/test/test-util.js";
import { updateDbInternalState } from "../../../dist/node/runtime/node/community/local-community/db-state.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { v4 as uuidV4 } from "uuid";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import type { ChallengeVerificationMessageType } from "../../../dist/node/pubsub-messages/types.js";

// Rename scenarios PR #414 (issue #430) does not cover yet. Each one renames a named community N -> M that has comments
// signed with N. The remote PKC validates pages, so a page the community publishes that clients reject surfaces as an
// error on the reader.

const createPKCsWithResolverRecords = async () => {
    const records = new Map<string, string | undefined>();
    const nameResolvers = () => [createMockNameResolver({ includeDefaultRecords: true, records })];
    const pkc = await mockPKCV2({ stubStorage: false, mockResolve: false, pkcOptions: { nameResolvers: nameResolvers() } });
    const remotePKC = await mockPKCV2({
        stubStorage: false,
        remotePKC: true,
        mockResolve: false,
        pkcOptions: { nameResolvers: nameResolvers(), validatePages: true }
    });
    return { pkc, remotePKC, records };
};

const postsInPreloadedPages = (community: { posts: { pages: Record<string, { comments: { cid: string }[] } | undefined> } }) =>
    Object.values(community.posts.pages).flatMap((page) => page?.comments ?? []);

// Collects every error and "failed" startedState of a local community, so a test can assert it never failed a cycle
const watchCommunityHealth = (community: LocalCommunity) => {
    const health = { errors: [] as Error[], failed: false };
    community.on("error", (e) => health.errors.push(e));
    community.on("startedstatechange", (state) => {
        if (state === "failed") health.failed = true;
    });
    return health;
};

// Resolves once a record with an updateCid other than `updateCidBefore` is published, or a cycle fails
const waitForNextPublishedRecord = async (
    community: LocalCommunity,
    updateCidBefore: string | undefined,
    health: ReturnType<typeof watchCommunityHealth>
) => {
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => health.failed || health.errors.length > 0 || community.updateCid !== updateCidBefore
    });
};

const publishAndGetVerification = async (publication: Comment): Promise<ChallengeVerificationMessageType> => {
    const verification = new Promise<ChallengeVerificationMessageType>((resolve) =>
        publication.once("challengeverification", (v) => resolve(v as ChallengeVerificationMessageType))
    );
    await publication.publish();
    return verification;
};

type NamedCommunityWithComments = {
    pkc: PKCType;
    remotePKC: PKCType;
    records: Map<string, string | undefined>;
    community: LocalCommunity;
    health: ReturnType<typeof watchCommunityHealth>;
    oldName: string;
    newName: string;
    publicKey: string;
    post: Comment & { cid: string };
    reply: Comment & { cid: string };
};

// A started community named N (oldName) with a post and a reply signed N. M (newName) resolves to the same key.
const setupNamedCommunityWithComments = async (prefix: string): Promise<NamedCommunityWithComments> => {
    const { pkc, remotePKC, records } = await createPKCsWithResolverRecords();
    const signer = await pkc.createSigner();
    const oldName = `${prefix}-old-${uuidV4()}.bso`;
    const newName = `${prefix}-new-${uuidV4()}.bso`;
    records.set(oldName, signer.address);
    records.set(newName, signer.address);

    const community = (await createSubWithNoChallenge({ signer }, pkc)) as LocalCommunity;
    await community.edit({ address: oldName });
    const health = watchCommunityHealth(community);
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

    const post = (await publishRandomPost({ communityAddress: community.address, pkc })) as Comment & { cid: string };
    await waitTillPostInCommunityPages(post, pkc);
    const reply = (await publishRandomReply({ parentComment: post as unknown as CommentIpfsWithCidDefined, pkc })) as Comment & {
        cid: string;
    };
    await waitTillReplyInParentPages(reply as Parameters<typeof waitTillReplyInParentPages>[0], pkc);
    return { pkc, remotePKC, records, community, health, oldName, newName, publicKey: signer.address, post, reply };
};

const teardown = async (ctx: NamedCommunityWithComments | undefined) => {
    if (!ctx) return;
    await ctx.community.delete().catch(() => {});
    await ctx.pkc.destroy();
    await ctx.remotePKC.destroy();
};

// Loads the community by `address` on the remote PKC until `predicate` holds or it emits an error
const loadRemotely = async (remotePKC: PKCType, address: string, predicate: (remote: RemoteCommunity) => boolean) => {
    const remote = (await remotePKC.createCommunity({ address })) as RemoteCommunity;
    const errors: Error[] = [];
    remote.on("error", (e) => errors.push(e));
    await remote.update();
    await resolveWhenConditionIsTrue({ toUpdate: remote, predicate: async () => predicate(remote) || errors.length > 0 });
    await remote.stop();
    return { remote, errors };
};

// 1. Renaming a stopped community. edit() on a not-started community moves the DB on disk, and the first start after
// it builds pages under the new name.
for (const editKey of ["name", "address"] as const) {
    // Skipped under RPC because it inspects the LocalCommunity's error and startedState events across stop/start
    describeSkipIfRpc(`Renaming a stopped community that has comments, then starting it, edit({ ${editKey} })`, async () => {
        let ctx: NamedCommunityWithComments;

        beforeAll(async () => {
            ctx = await setupNamedCommunityWithComments("stopped-rename");
            await ctx.community.stop();
        });

        afterAll(async () => teardown(ctx));

        it(`publishes a valid record under the new name on start, and hides the comments signed with the old name`, async () => {
            const stopped = (await ctx.pkc.createCommunity({ address: ctx.oldName })) as LocalCommunity;
            await stopped.edit({ [editKey]: ctx.newName });
            expect(stopped.address).to.equal(ctx.newName);
            expect(stopped.name).to.equal(ctx.newName);

            const started = (await ctx.pkc.createCommunity({ address: ctx.newName })) as LocalCommunity;
            ctx.community = started;
            const health = watchCommunityHealth(started);
            const updateCidBefore = started.updateCid;
            await started.start();
            await waitForNextPublishedRecord(started, updateCidBefore, health);

            expect(health.errors.map((e) => (e as { code?: string }).code ?? e.message)).to.deep.equal([]);
            expect(health.failed).to.be.false;
            expect(started.address).to.equal(ctx.newName);
            expect(started.name).to.equal(ctx.newName);
            expect(postsInPreloadedPages(started).map((c) => c.cid)).to.not.include(ctx.post.cid);

            const { remote, errors } = await loadRemotely(ctx.remotePKC, ctx.newName, (r) => r.updateCid === started.updateCid);
            expect(errors).to.deep.equal([]);
            expect(remote.name).to.equal(ctx.newName);
        });
    });
}

// 2. Publishing after a rename: a new post signed M, and a reply signed M to a post signed N (hidden from the pages)
for (const editKey of ["name", "address"] as const) {
    // Skipped under RPC because it inspects the LocalCommunity's error and startedState events
    describeSkipIfRpc(`Publishing to a community after renaming it, edit({ ${editKey} })`, async () => {
        let ctx: NamedCommunityWithComments;

        beforeAll(async () => {
            ctx = await setupNamedCommunityWithComments("publish-after-rename");
            const updateCidBefore = ctx.community.updateCid;
            await ctx.community.edit({ [editKey]: ctx.newName });
            await waitForNextPublishedRecord(ctx.community, updateCidBefore, ctx.health);
        });

        afterAll(async () => teardown(ctx));

        it(`a new post signed with the new name shows in the pages, and the record stays valid`, async () => {
            const newPost = (await publishRandomPost({ communityAddress: ctx.newName, pkc: ctx.pkc })) as Comment & { cid: string };
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => ctx.health.failed || postsInPreloadedPages(ctx.community).some((c) => c.cid === newPost.cid)
            });
            expect(ctx.health.failed).to.be.false;
            expect(ctx.health.errors).to.deep.equal([]);
            expect(postsInPreloadedPages(ctx.community).map((c) => c.cid)).to.include(newPost.cid);

            const { errors } = await loadRemotely(ctx.remotePKC, ctx.newName, (r) =>
                postsInPreloadedPages(r).some((c) => c.cid === newPost.cid)
            );
            expect(errors).to.deep.equal([]);
        });

        it(`a reply signed with the new name to a post signed with the old name never makes the community fail`, async () => {
            const reply = await generateMockComment(ctx.post as unknown as CommentIpfsWithCidDefined, ctx.pkc, false, {
                communityAddress: ctx.newName
            });
            await publishAndGetVerification(reply);

            const updateCidBefore = ctx.community.updateCid;
            await ctx.community.edit({ title: `after reply to hidden post ${Date.now()}` });
            await waitForNextPublishedRecord(ctx.community, updateCidBefore, ctx.health);
            expect(ctx.health.failed).to.be.false;
            expect(ctx.health.errors).to.deep.equal([]);

            const { errors } = await loadRemotely(ctx.remotePKC, ctx.newName, (r) => r.updateCid === ctx.community.updateCid);
            expect(errors).to.deep.equal([]);
        });
    });
}

// 3. Renaming back N -> M -> N: docs/protocol/names-and-addresses.md says the comments signed N are published again,
// since the identity rule is evaluated against the current name at every page build
for (const editKey of ["name", "address"] as const) {
    // Skipped under RPC because it inspects the LocalCommunity's error and startedState events
    describeSkipIfRpc(`Renaming a community back to its old name, edit({ ${editKey} })`, async () => {
        let ctx: NamedCommunityWithComments;

        beforeAll(async () => {
            ctx = await setupNamedCommunityWithComments("rename-back");
        });

        afterAll(async () => teardown(ctx));

        it(`the comments signed with the old name are published again`, async () => {
            let updateCidBefore = ctx.community.updateCid;
            await ctx.community.edit({ [editKey]: ctx.newName });
            await waitForNextPublishedRecord(ctx.community, updateCidBefore, ctx.health);
            expect(postsInPreloadedPages(ctx.community).map((c) => c.cid)).to.not.include(ctx.post.cid);

            updateCidBefore = ctx.community.updateCid;
            await ctx.community.edit({ [editKey]: ctx.oldName });
            await waitForNextPublishedRecord(ctx.community, updateCidBefore, ctx.health);
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => ctx.health.failed || postsInPreloadedPages(ctx.community).some((c) => c.cid === ctx.post.cid)
            });
            expect(ctx.health.failed).to.be.false;
            expect(ctx.health.errors).to.deep.equal([]);
            expect(ctx.community.address).to.equal(ctx.oldName);
            expect(postsInPreloadedPages(ctx.community).map((c) => c.cid)).to.include(ctx.post.cid);

            const { remote, errors } = await loadRemotely(ctx.remotePKC, ctx.oldName, (r) =>
                postsInPreloadedPages(r).some((c) => c.cid === ctx.post.cid)
            );
            expect(errors).to.deep.equal([]);
            expect(remote.name).to.equal(ctx.oldName);
            expect(postsInPreloadedPages(remote).map((c) => c.cid)).to.include(ctx.post.cid);
        });
    });
}

// 4. What else the rename hides. The identity rule applies to the counts and the stats so they match the pages.
// (lastPostCid and lastCommentCid still point at the hidden comments; tracked separately in issue #432.)
for (const editKey of ["name", "address"] as const) {
    // Skipped under RPC because it reads the LocalCommunity's published record fields directly
    describeSkipIfRpc(`Record fields after a rename hides every comment, edit({ ${editKey} })`, async () => {
        let ctx: NamedCommunityWithComments;

        beforeAll(async () => {
            ctx = await setupNamedCommunityWithComments("hidden-fields");
            expect(ctx.community.lastPostCid).to.equal(ctx.post.cid);
            const updateCidBefore = ctx.community.updateCid;
            await ctx.community.edit({ [editKey]: ctx.newName });
            await waitForNextPublishedRecord(ctx.community, updateCidBefore, ctx.health);
            // A cycle already running when edit() was called can publish after it, so wait for a record whose whole
            // cycle started after the rename
            const updateCidAfterRename = ctx.community.updateCid;
            await ctx.community.edit({ title: `after rename ${Date.now()}` });
            await waitForNextPublishedRecord(ctx.community, updateCidAfterRename, ctx.health);
            expect(ctx.health.failed).to.be.false;
        });

        afterAll(async () => teardown(ctx));

        it(`the pages are empty`, async () => {
            expect(postsInPreloadedPages(ctx.community)).to.deep.equal([]);
        });

        it(`the stats count no hidden post or reply`, async () => {
            const { content } = await ctx.pkc.fetchCid({ cid: ctx.community.statsCid! });
            const stats = JSON.parse(content) as Record<string, number>;
            expect(stats.allPostCount).to.equal(0);
            expect(stats.allReplyCount).to.equal(0);
        });
    });
}

// 5. A reader already following the community by its old name when the owner renames it. A name is part of the
// community's identity (#401), so the reader does not follow the rename: the next record claims a different name
// than the one it asked for, so it refuses that record, keeps the last one that claimed the old name and errors. It
// has to load the community again by the new name or by its key (docs/protocol/names-and-addresses.md, "Changing a
// community's name"). A reader following the same community by its key shares the reader's updating instance and
// does follow the rename: the refusal is the by-name reader's own and must not stop it.
for (const editKey of ["name", "address"] as const) {
    // Skipped under RPC because it inspects the LocalCommunity's error and startedState events
    describeSkipIfRpc(`A reader subscribed by the old name during a rename, edit({ ${editKey} })`, async () => {
        let ctx: NamedCommunityWithComments;

        beforeAll(async () => {
            ctx = await setupNamedCommunityWithComments("subscribed-reader");
        });

        afterAll(async () => teardown(ctx));

        it(`errors with ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME instead of following the rename, while a reader by key follows it`, async () => {
            const reader = (await ctx.remotePKC.createCommunity({ address: ctx.oldName })) as RemoteCommunity;
            const errors: Error[] = [];
            reader.on("error", (e) => errors.push(e));
            await reader.update();
            await resolveWhenConditionIsTrue({
                toUpdate: reader,
                predicate: async () => typeof reader.updatedAt === "number" || errors.length > 0
            });
            expect(errors).to.deep.equal([]);
            expect(reader.name).to.equal(ctx.oldName);
            const updatedAtBeforeRename = reader.updatedAt;

            const readerByKey = (await ctx.remotePKC.createCommunity({ address: ctx.community.signer.address })) as RemoteCommunity;
            const readerByKeyErrors: Error[] = [];
            readerByKey.on("error", (e) => readerByKeyErrors.push(e));
            await readerByKey.update();
            await resolveWhenConditionIsTrue({ toUpdate: readerByKey, predicate: async () => readerByKey.name === ctx.oldName });

            const updateCidBefore = ctx.community.updateCid;
            await ctx.community.edit({ [editKey]: ctx.newName });
            await waitForNextPublishedRecord(ctx.community, updateCidBefore, ctx.health);
            try {
                await resolveWhenConditionIsTrue({ toUpdate: reader, predicate: async () => errors.length > 0, eventName: "error" });
                expect(errors.map((e) => (e as { code?: string }).code)).to.include(
                    "ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME"
                );
                expect(reader.name).to.equal(ctx.oldName);
                expect(reader.updatedAt).to.equal(updatedAtBeforeRename);
                expect(reader.state).to.equal("updating");

                await resolveWhenConditionIsTrue({ toUpdate: readerByKey, predicate: async () => readerByKey.name === ctx.newName });
                expect(readerByKey.state).to.equal("updating");
                const readerByKeyErrorCodes = readerByKeyErrors.map((e) => (e as { code?: string }).code);
                expect(readerByKeyErrorCodes).to.not.include("ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME");
                expect(readerByKeyErrorCodes).to.not.include("ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED");
            } finally {
                await reader.stop();
                await readerByKey.stop();
            }
        });
    });
}

// 6. A community left stranded by the bug before #430's fix: edit({ name: M }) stored name M in the internal state but
// left the address, DB file and lock on N, and every cycle after it failed. Simulated by writing that state into the DB
// directly, with comments signed N present. A node upgrading to the fix starts from exactly this.
// Skipped under RPC because it writes the LocalCommunity's internal state directly
describeSkipIfRpc(`A community stranded by the pre-#430 edit({ name }) bug`, async () => {
    let ctx: NamedCommunityWithComments;

    beforeAll(async () => {
        ctx = await setupNamedCommunityWithComments("stranded");
        await ctx.community.stop();
        const stopped = (await ctx.pkc.createCommunity({ address: ctx.oldName })) as LocalCommunity;
        await updateDbInternalState(stopped, { name: ctx.newName });
        await stopped._dbHandler.destoryConnection();
    });

    afterAll(async () => teardown(ctx));

    it(`(a) starts and publishes a valid record instead of failing every cycle`, async () => {
        const community = (await ctx.pkc.createCommunity({ address: ctx.oldName })) as LocalCommunity;
        ctx.community = community;
        const health = watchCommunityHealth(community);
        ctx.health = health;
        const updateCidBefore = community.updateCid;
        await community.start();
        await waitForNextPublishedRecord(community, updateCidBefore, health);
        expect(health.errors.map((e) => (e as { code?: string }).code ?? e.message)).to.deep.equal([]);
        expect(health.failed).to.be.false;
        expect(community.updateCid).to.not.equal(updateCidBefore);
    });

    it(`(b) redoing edit({ name: M }) moves the address and publishes a valid record`, async () => {
        const community = ctx.community;
        if (community.state !== "started") await community.start();
        ctx.health.errors.length = 0;
        ctx.health.failed = false;
        const updateCidBefore = community.updateCid;
        await community.edit({ name: ctx.newName });
        expect(community.address).to.equal(ctx.newName);
        await waitForNextPublishedRecord(community, updateCidBefore, ctx.health);
        expect(ctx.health.errors.map((e) => (e as { code?: string }).code ?? e.message)).to.deep.equal([]);
        expect(ctx.health.failed).to.be.false;
        expect(community.updateCid).to.not.equal(updateCidBefore);
        expect(await community._dbHandler.isCommunityStartLocked(ctx.newName)).to.be.true;
        expect(postsInPreloadedPages(community).map((c) => c.cid)).to.not.include(ctx.post.cid);
    });
});
