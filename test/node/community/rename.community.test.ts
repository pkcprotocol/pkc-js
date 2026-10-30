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
    publishWithExpectedResult,
    expectCommunityListed,
    expectCommunityNotListed
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { v4 as uuidV4 } from "uuid";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

const createPKCsWithResolverRecords = async () => {
    const records = new Map<string, string | undefined>();
    const nameResolvers = () => [createMockNameResolver({ includeDefaultRecords: true, records })];
    const pkc = await mockPKCV2({ stubStorage: false, mockResolve: false, pkcOptions: { nameResolvers: nameResolvers() } });
    const remotePKC = await mockPKCV2({
        stubStorage: false,
        remotePKC: true,
        mockResolve: false,
        // mockPKC defaults to validatePages: false; a reader that verifies pages is what rejects a bad page
        pkcOptions: { nameResolvers: nameResolvers(), validatePages: true }
    });
    return { pkc, remotePKC, records };
};

const postsInPreloadedPages = (community: { posts: { pages: Record<string, { comments: { cid: string }[] } | undefined> } }) =>
    Object.values(community.posts.pages).flatMap((page) => page?.comments ?? []);

// Renaming a named community (domain N -> domain M) that already has comments signed with N (issue #430).
// edit({ name }) used to change community.name but leave community.address, the DB file and the start lock on N. The
// page generator filters rows by community.address, so the comments signed N stayed in the pages, and
// verifyPageComment (which requires a named community's comments to carry its name, M) made the community's own
// pre-publish check reject every record after the rename (ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE). A name edit
// is now the same move as an address edit, and the comments signed N are hidden, the #401 rule for N -> M.
for (const editKey of ["name", "address"] as const) {
    // Skipped under RPC because it inspects the LocalCommunity's start locks and DB, and waits on its startedState
    describeSkipIfRpc(`Renaming a community that has comments, edit({ ${editKey} })`, async () => {
        let pkc: PKCType;
        let remotePKC: PKCType;
        let community: LocalCommunity | RpcLocalCommunity;
        let oldName: string;
        let newName: string;
        let publicKey: string;
        let post: Comment & { cid: string };

        beforeAll(async () => {
            let records: Map<string, string | undefined>;
            ({ pkc, remotePKC, records } = await createPKCsWithResolverRecords());
            const signer = await pkc.createSigner();
            publicKey = signer.address;
            oldName = `rename-old-${uuidV4()}.bso`;
            newName = `rename-new-${uuidV4()}.bso`;
            records.set(oldName, signer.address);
            records.set(newName, signer.address);

            community = await createSubWithNoChallenge({ signer }, pkc);
            await community.edit({ address: oldName });
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            post = (await publishRandomPost({ communityAddress: community.address, pkc })) as Comment & { cid: string };
            await waitTillPostInCommunityPages(post, pkc);
            const reply = await publishRandomReply({ parentComment: post as unknown as CommentIpfsWithCidDefined, pkc });
            await waitTillReplyInParentPages(reply as Parameters<typeof waitTillReplyInParentPages>[0], pkc);
        });

        afterAll(async () => {
            await community.delete();
            await pkc.destroy();
            await remotePKC.destroy();
        });

        it(`publishes a record with the new name instead of failing its own signature check`, async () => {
            // updateCid changes only when a record is published; edit() itself already sets name and raw.communityIpfs
            const updateCidBeforeEdit = community.updateCid;
            let failed = false;
            const onStartedState = (state: string) => {
                if (state === "failed") failed = true;
            };
            community.on("startedstatechange", onStartedState);
            await community.edit({ [editKey]: newName });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => failed || community.updateCid !== updateCidBeforeEdit,
                eventName: "startedstatechange"
            });
            expect(failed).to.be.false;
            expect(community.name).to.equal(newName);
            expect(community.address).to.equal(newName);

            // A cycle already running when edit() was called can publish the first record after it, built before the
            // rename. Wait for a record from a cycle that started after it, so the tests below check the renamed pages.
            const updateCidAfterRename = community.updateCid;
            await community.edit({ title: `after rename ${uuidV4()}` });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => failed || community.updateCid !== updateCidAfterRename,
                eventName: "startedstatechange"
            });
            community.removeListener("startedstatechange", onStartedState);
            expect(failed).to.be.false;
        });

        it(`moves the start lock and the community list entry to the new name`, async () => {
            const localCommunity = community as LocalCommunity;
            expect(await localCommunity._dbHandler.isCommunityStartLocked(newName)).to.be.true;
            expect(await localCommunity._dbHandler.isCommunityStartLocked(oldName)).to.be.false;
            expectCommunityListed({ pkc: pkc, publicKey: community.publicKey!, address: newName, name: newName });
            expectCommunityNotListed({ pkc, address: oldName }); // moved: still listed by its key, under the new name
        });

        it(`hides the comments signed with the old name (#401: N -> M)`, async () => {
            expect(postsInPreloadedPages(community).map((comment) => comment.cid)).to.not.include(post.cid);
        });

        it(`a remote reader loads the renamed community by its new name`, async () => {
            const remote = await remotePKC.createCommunity({ address: newName });
            const errors: Error[] = [];
            remote.on("error", (e) => errors.push(e));
            await remote.update();
            await resolveWhenConditionIsTrue({ toUpdate: remote, predicate: async () => remote.name === newName || errors.length > 0 });
            await remote.stop();
            expect(errors).to.deep.equal([]);
            expect(remote.name).to.equal(newName);
            expect(postsInPreloadedPages(remote).map((comment) => comment.cid)).to.not.include(post.cid);
        });

        it(`a remote reader loads the renamed community by its public key`, async () => {
            const remote = await remotePKC.createCommunity({ address: publicKey });
            const errors: Error[] = [];
            remote.on("error", (e) => errors.push(e));
            await remote.update();
            await resolveWhenConditionIsTrue({ toUpdate: remote, predicate: async () => remote.name === newName || errors.length > 0 });
            await remote.stop();
            expect(errors).to.deep.equal([]);
            expect(remote.name).to.equal(newName);
        });

        it(`keeps the new name after a restart`, async () => {
            await community.stop();
            community = (await pkc.createCommunity({ address: newName })) as LocalCommunity | RpcLocalCommunity;
            expect(community.name).to.equal(newName);
            expect(community.address).to.equal(newName);
            const updateCidBeforeStart = community.updateCid;
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updateCid !== updateCidBeforeStart });
            expect(community.name).to.equal(newName);
        });
    });
}

// Dropping a name returns the address to the community's key, whichever of the two keys the edit uses, and keeps the
// comments signed with the dropped name (#401: clients accept them on an unnamed community).
for (const [editKey, describeTitle] of [
    ["name", "edit({ name: undefined })"],
    ["address", "edit({ address: <public key> })"]
] as const) {
    // Skipped under RPC because it inspects the LocalCommunity's start locks
    describeSkipIfRpc(`Dropping the name of a community that has comments, ${describeTitle}`, async () => {
        let pkc: PKCType;
        let remotePKC: PKCType;
        let community: LocalCommunity | RpcLocalCommunity;
        let name: string;
        let publicKey: string;
        let post: Comment & { cid: string };

        beforeAll(async () => {
            let records: Map<string, string | undefined>;
            ({ pkc, remotePKC, records } = await createPKCsWithResolverRecords());
            const signer = await pkc.createSigner();
            publicKey = signer.address;
            name = `drop-name-${uuidV4()}.bso`;
            records.set(name, signer.address);

            community = await createSubWithNoChallenge({ signer }, pkc);
            await community.edit({ address: name });
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            post = (await publishRandomPost({ communityAddress: community.address, pkc })) as Comment & { cid: string };
            await waitTillPostInCommunityPages(post, pkc);
        });

        afterAll(async () => {
            await community.delete();
            await pkc.destroy();
            await remotePKC.destroy();
        });

        it(`publishes a record without a name, under the public key`, async () => {
            const updateCidBeforeEdit = community.updateCid;
            await community.edit(editKey === "name" ? { name: undefined } : { address: publicKey });
            expect(community.address).to.equal(publicKey);
            expect(community.name).to.be.undefined;
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updateCid !== updateCidBeforeEdit });
            expect(community.startedState).to.not.equal("failed");
            expect(community.name).to.be.undefined;
            expect(await (community as LocalCommunity)._dbHandler.isCommunityStartLocked(publicKey)).to.be.true;
            expect(await (community as LocalCommunity)._dbHandler.isCommunityStartLocked(name)).to.be.false;
        });

        it(`keeps the comments signed with the dropped name`, async () => {
            expect(postsInPreloadedPages(community).map((comment) => comment.cid)).to.include(post.cid);
            const remote = await remotePKC.createCommunity({ address: publicKey });
            await remote.update();
            await resolveWhenConditionIsTrue({
                toUpdate: remote,
                predicate: async () => typeof remote.updatedAt === "number" && !remote.name
            });
            await remote.stop();
            expect(postsInPreloadedPages(remote).map((comment) => comment.cid)).to.include(post.cid);
        });
    });
}

// An owner can rename the community over pubsub with a CommunityEdit publication (owner-only since #373). The community
// applies it through the same edit(), so it is the same address move, which now stops and restarts it to move the
// address while the challenge exchange is still in flight.
type PubsubRenameCase = {
    title: string;
    communityEdit: (names: { newName: string; publicKey: string }) => Record<string, string>;
    expectedAddress: (names: { newName: string; publicKey: string }) => string;
    // N -> M hides the comments signed N; dropping the name keeps them (#401)
    oldCommentsVisible: boolean;
};
const pubsubRenameCases: PubsubRenameCase[] = [
    {
        title: "{ name: M }",
        communityEdit: ({ newName }) => ({ name: newName }),
        expectedAddress: ({ newName }) => newName,
        oldCommentsVisible: false
    },
    {
        title: "{ address: M }",
        communityEdit: ({ newName }) => ({ address: newName }),
        expectedAddress: ({ newName }) => newName,
        oldCommentsVisible: false
    },
    {
        title: "{ address: <public key> }",
        communityEdit: ({ publicKey }) => ({ address: publicKey }),
        expectedAddress: ({ publicKey }) => publicKey,
        oldCommentsVisible: true
    }
];

// A started community named N with a post signed N, and a signer of the remote PKC holding `role`
const setupCommunityForPubsubEdit = async (role: "owner" | "admin" | "moderator") => {
    const { pkc, remotePKC, records } = await createPKCsWithResolverRecords();
    const signer = await pkc.createSigner();
    const oldName = `pubsub-rename-old-${uuidV4()}.bso`;
    const newName = `pubsub-rename-new-${uuidV4()}.bso`;
    const otherName = `pubsub-rename-other-${uuidV4()}.bso`;
    for (const name of [oldName, newName, otherName]) records.set(name, signer.address);
    const community = (await createSubWithNoChallenge({ signer }, pkc)) as LocalCommunity;
    await community.edit({ address: oldName });
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    const post = (await publishRandomPost({ communityAddress: community.address, pkc })) as Comment & { cid: string };
    await waitTillPostInCommunityPages(post, pkc);
    const editorSigner = await remotePKC.createSigner();
    const updateCidBeforeRoles = community.updateCid;
    await community.edit({ roles: { [editorSigner.address]: { role } } });
    // the roles record first, so a later updateCid change can only come from the edit under test
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updateCid !== updateCidBeforeRoles });
    return { pkc, remotePKC, community, publicKey: signer.address, oldName, newName, otherName, post, editorSigner };
};

for (const renameCase of pubsubRenameCases) {
    // Skipped under RPC because it inspects the LocalCommunity's address and start locks
    describeSkipIfRpc(`Renaming a community that has comments through an owner's CommunityEdit ${renameCase.title}`, async () => {
        let ctx: Awaited<ReturnType<typeof setupCommunityForPubsubEdit>>;
        let expectedAddress: string;

        beforeAll(async () => {
            ctx = await setupCommunityForPubsubEdit("owner");
            expectedAddress = renameCase.expectedAddress(ctx);
        });

        afterAll(async () => {
            await ctx.community.delete();
            await ctx.pkc.destroy();
            await ctx.remotePKC.destroy();
        });

        it(`answers the owner with challenge success and moves the address, lock and community list`, async () => {
            let failed = false;
            ctx.community.on("startedstatechange", (state) => {
                if (state === "failed") failed = true;
            });
            const updateCidBeforeRename = ctx.community.updateCid;
            const communityEdit = await ctx.remotePKC.createCommunityEdit({
                communityEdit: renameCase.communityEdit(ctx),
                communityAddress: ctx.oldName,
                signer: ctx.editorSigner
            });
            await publishWithExpectedResult({ publication: communityEdit, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () =>
                    failed || (ctx.community.address === expectedAddress && ctx.community.updateCid !== updateCidBeforeRename)
            });
            // and a record from a cycle that started after the rename
            const updateCidAfterRename = ctx.community.updateCid;
            await ctx.community.edit({ title: `after pubsub rename ${uuidV4()}` });
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => failed || ctx.community.updateCid !== updateCidAfterRename
            });
            expect(failed).to.be.false;
            expect(ctx.community.address).to.equal(expectedAddress);
            expect(await ctx.community._dbHandler.isCommunityStartLocked(expectedAddress)).to.be.true;
            expect(await ctx.community._dbHandler.isCommunityStartLocked(ctx.oldName)).to.be.false;
            expectCommunityListed({
                pkc: ctx.pkc,
                publicKey: ctx.community.publicKey!,
                address: expectedAddress,
                name: ctx.community.name
            });
            expectCommunityNotListed({ pkc: ctx.pkc, address: ctx.oldName }); // moved: still listed by its key
        });

        it(`${renameCase.oldCommentsVisible ? "keeps" : "hides"} the comments signed with the old name`, async () => {
            const cids = postsInPreloadedPages(ctx.community).map((comment) => comment.cid);
            if (renameCase.oldCommentsVisible) expect(cids).to.include(ctx.post.cid);
            else expect(cids).to.not.include(ctx.post.cid);
        });

        it(`a remote reader that validates pages loads the community at its new address`, async () => {
            const remote = await ctx.remotePKC.createCommunity({ address: expectedAddress });
            const errors: Error[] = [];
            remote.on("error", (e) => errors.push(e));
            await remote.update();
            await resolveWhenConditionIsTrue({
                toUpdate: remote,
                predicate: async () => remote.updateCid === ctx.community.updateCid || errors.length > 0
            });
            await remote.stop();
            expect(errors).to.deep.equal([]);
            expect(remote.address).to.equal(expectedAddress);
        });
    });
}

// Renaming over pubsub is owner-only, and a CommunityEdit naming two different addresses is rejected like edit() is
// Skipped under RPC because it inspects the LocalCommunity's address
describeSkipIfRpc(`CommunityEdit renames that the community rejects`, async () => {
    for (const role of ["admin", "moderator"] as const) {
        it(`rejects a rename from an ${role} with ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS`, async () => {
            const ctx = await setupCommunityForPubsubEdit(role);
            try {
                const communityEdit = await ctx.remotePKC.createCommunityEdit({
                    communityEdit: { name: ctx.newName },
                    communityAddress: ctx.oldName,
                    signer: ctx.editorSigner
                });
                await publishWithExpectedResult({
                    publication: communityEdit,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS
                });
                expect(ctx.community.address).to.equal(ctx.oldName);
            } finally {
                await ctx.community.delete();
                await ctx.pkc.destroy();
                await ctx.remotePKC.destroy();
            }
        });
    }

    it(`rejects an owner's CommunityEdit whose name and address differ, and changes nothing`, async () => {
        const ctx = await setupCommunityForPubsubEdit("owner");
        let failed = false;
        ctx.community.on("startedstatechange", (state) => {
            if (state === "failed") failed = true;
        });
        try {
            const communityEdit = await ctx.remotePKC.createCommunityEdit({
                communityEdit: { name: ctx.newName, address: ctx.otherName, title: "should not apply" },
                communityAddress: ctx.oldName,
                signer: ctx.editorSigner
            });
            await publishWithExpectedResult({
                publication: communityEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH
            });
            expect(ctx.community.address).to.equal(ctx.oldName);
            expect(ctx.community.title).to.not.equal("should not apply");
            expect(failed).to.be.false;
        } finally {
            await ctx.community.delete();
            await ctx.pkc.destroy();
            await ctx.remotePKC.destroy();
        }
    });
});

// edit() accepts name and address together only when they name the same address (issue #430): which one wins is the
// owner's call, so a disagreement is rejected before anything is changed.
describe(`community.edit() with both name and address`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let records: Map<string, string | undefined>;

    beforeAll(async () => {
        ({ pkc, remotePKC, records } = await createPKCsWithResolverRecords());
    });

    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    const createCommunityWithResolvableNames = async (count: number) => {
        const community = await createSubWithNoChallenge({}, pkc);
        const names = Array.from({ length: count }, () => `name-and-address-${uuidV4()}.bso`);
        for (const name of names) records.set(name, community.signer.address);
        return { community, names };
    };

    it(`throws ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH when name and address differ, and changes nothing`, async () => {
        const { community, names } = await createCommunityWithResolvableNames(2);
        const addressBefore = community.address;
        try {
            await expect(community.edit({ name: names[0], address: names[1], title: "should not apply" })).rejects.toMatchObject({
                code: "ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH"
            });
            expect(community.address).to.equal(addressBefore);
            expect(community.title).to.not.equal("should not apply");
        } finally {
            await community.delete();
        }
    });

    it(`throws ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH when the name is dropped but the address is a domain`, async () => {
        const { community, names } = await createCommunityWithResolvableNames(1);
        try {
            await expect(community.edit({ name: undefined, address: names[0] })).rejects.toMatchObject({
                code: "ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH"
            });
        } finally {
            await community.delete();
        }
    });

    it(`accepts name and address with the same value`, async () => {
        const { community, names } = await createCommunityWithResolvableNames(1);
        try {
            await community.edit({ name: names[0], address: names[0] });
            expect(community.address).to.equal(names[0]);
            expect(community.name).to.equal(names[0]);
        } finally {
            await community.delete();
        }
    });
});
