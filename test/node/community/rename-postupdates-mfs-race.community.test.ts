import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import {
    createMockNameResolver,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    mockPKCV2
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import { v4 as uuidV4 } from "uuid";
import fs from "node:fs";
import path from "node:path";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Issue #469. Renaming a started community (edit({ address }) or edit({ name })) used to stop it, rename the DB, start it
// again, and only then move its postUpdates MFS directory from /<old address> to /<new address>. start() reloaded the old
// address from the DB, so the restarted publish loop ran a cycle under the old address while the move was pending. Seen
// in CI as a sync error on the renamed community (`files.flush` of the old directory: "file does not exist", windows,
// name-added-comments.community.test.ts). Each suite pins one interleaving of that race by holding a call the restarted
// cycle makes on the old directory until the move is done (a fixed rename finishes before the restart, so nothing waits):
// - flush: the cycle wrote under the old address, the move took the directory, then the cycle flushes the old path (CI)
// - write: the cycle computed its paths under the old address, the move ran, then the cycle writes, recreating the old
//   directory, so the posts' new CommentUpdates never reach the directory the community publishes
// Every post published before the rename must have its latest CommentUpdate under the new address afterwards.
// Skipped under RPC: the domain only resolves through this PKC's mock name resolver, and the RPC test server strips
// client-supplied nameResolvers in setSettings, so the community could never take the domain address there. The test
// also reads the community's MFS through LocalCommunity internals.
const heldCalls = ["flush", "write"] as const;
for (const editKey of ["address", "name"] as const)
    for (const heldCall of heldCalls) {
        describeSkipIfRpc(`edit({ ${editKey} }) on a started community, restarted cycle's ${heldCall} held until the move`, async () => {
            let pkc: PKCType;
            let community: LocalCommunity;
            let publicKey: string;
            let domainAddress: string;
            let postCids: string[];
            const errors: Error[] = [];

            const listMfs = async (path: string): Promise<string[] | undefined> => {
                const kuboClient = community._clientsManager.getDefaultKuboRpcClient()._client;
                const names: string[] = [];
                try {
                    for await (const entry of kuboClient.files.ls(path)) names.push(entry.name);
                } catch (e) {
                    if ((e as Error).message === "file does not exist") return undefined;
                    throw e;
                }
                return names;
            };

            const postCidsInPostUpdates = async (address: string): Promise<string[]> => {
                const cids: string[] = [];
                for (const bucket of (await listMfs(`/${address}/postUpdates`)) ?? [])
                    cids.push(...((await listMfs(`/${address}/postUpdates/${bucket}`)) ?? []));
                return cids;
            };

            const readMfsFile = async (path: string): Promise<string> => {
                const kuboClient = community._clientsManager.getDefaultKuboRpcClient()._client;
                const chunks: Uint8Array[] = [];
                for await (const chunk of kuboClient.files.read(path)) chunks.push(chunk);
                return Buffer.concat(chunks).toString("utf8");
            };

            const waitForNewRecord = async () => {
                const updateCidBefore = community.updateCid;
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => errors.length > 0 || community.updateCid !== updateCidBefore
                });
            };

            beforeAll(async () => {
                const resolverRecords = new Map<string, string | undefined>();
                pkc = await mockPKCV2({
                    stubStorage: false,
                    mockResolve: false,
                    pkcOptions: { nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: resolverRecords })] }
                });
                community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
                publicKey = community.signer.address;
                domainAddress = `test-rename-postupdates-${uuidV4()}.bso`;
                resolverRecords.set(domainAddress, publicKey);
                community.on("error", (e) => errors.push(e));

                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

                postCids = [];
                for (let i = 0; i < 3; i++) postCids.push((await publishRandomPost({ communityAddress: publicKey, pkc })).cid!);
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => {
                        const cids = await postCidsInPostUpdates(publicKey);
                        return postCids.every((cid) => cids.includes(cid));
                    }
                });

                // The restarted cycle gets post updates to write by flagging the posts as the rename restarts the community.
                // Wait for a new second first: a CommentUpdate signed in the same second as the stored one is byte-identical,
                // so a stale file could not be told apart from the latest one.
                const latestStoredUpdatedAt = Math.max(
                    ...postCids.map((cid) => community._dbHandler.queryStoredCommentUpdate({ cid })!.updatedAt)
                );
                while (Math.floor(Date.now() / 1000) <= latestStoredUpdatedAt) await new Promise((resolve) => setTimeout(resolve, 100));

                const kuboFiles = community._clientsManager.getDefaultKuboRpcClient()._client.files;
                const originalFlush = kuboFiles.flush;
                const originalWrite = kuboFiles.write;
                const originalMv = kuboFiles.mv;
                const originalStart = community.start;
                let restarted = false;
                let resolveHeldCallReached!: () => void;
                const heldCallReached = new Promise<void>((resolve) => (resolveHeldCallReached = resolve));
                let resolveMvDone!: () => void;
                const mvDone = new Promise<void>((resolve) => (resolveMvDone = resolve));
                const holdUntilMoved = async () => {
                    resolveHeldCallReached();
                    await mvDone;
                };
                community.start = async () => {
                    restarted = true;
                    community._dbHandler.forceUpdateOnAllCommentsWithCid(postCids);
                    return originalStart.call(community);
                };
                if (heldCall === "flush")
                    kuboFiles.flush = (async (...args: Parameters<typeof originalFlush>) => {
                        if (restarted && args[0] === `/${publicKey}`) await holdUntilMoved();
                        return originalFlush.apply(kuboFiles, args);
                    }) as typeof originalFlush;
                else
                    kuboFiles.write = (async (...args: Parameters<typeof originalWrite>) => {
                        if (restarted && String(args[0]).startsWith(`/${publicKey}/postUpdates/`)) await holdUntilMoved();
                        return originalWrite.apply(kuboFiles, args);
                    }) as typeof originalWrite;
                kuboFiles.mv = (async (...args: Parameters<typeof originalMv>) => {
                    if (args[0] !== `/${publicKey}`) return originalMv.apply(kuboFiles, args);
                    // a move before the restart has no cycle to race with
                    if (restarted) await Promise.race([heldCallReached, new Promise((resolve) => setTimeout(resolve, 20000))]);
                    try {
                        return await originalMv.apply(kuboFiles, args);
                    } finally {
                        resolveMvDone();
                    }
                }) as typeof originalMv;
                try {
                    await community.edit({ [editKey]: domainAddress });
                } finally {
                    community.start = originalStart;
                    kuboFiles.flush = originalFlush;
                    kuboFiles.write = originalWrite;
                    kuboFiles.mv = originalMv;
                    resolveMvDone();
                }
                expect(community.address).to.equal(domainAddress);
                // two records, so the second comes from a cycle that started after the rename returned
                await waitForNewRecord();
                await community.edit({ title: `after rename ${uuidV4()}` });
                await waitForNewRecord();
                // the restarted loop did write a new CommentUpdate for every post, so the checks below are not vacuous
                for (const cid of postCids)
                    expect(community._dbHandler.queryStoredCommentUpdate({ cid })!.updatedAt, `post ${cid}`).to.be.greaterThan(
                        latestStoredUpdatedAt
                    );
            });

            afterAll(async () => {
                await community?.delete();
                await pkc?.destroy();
            });

            it(`the publish loop emits no error across the rename`, () => {
                expect(errors.map((e) => e.message)).to.deep.equal([]);
            });

            it(`every post published before the rename has its CommentUpdate under the new address`, async () => {
                const cids = await postCidsInPostUpdates(domainAddress);
                expect(cids).to.include.members(postCids);
            });

            it(`every post's file under the new address is its latest CommentUpdate`, async () => {
                for (const cid of postCids) {
                    const stored = community._dbHandler.queryStoredCommentUpdate({ cid })!;
                    const file = JSON.parse(
                        await readMfsFile(`/${domainAddress}/postUpdates/${stored.postUpdatesBucket}/${cid}/update`)
                    ) as {
                        updatedAt: number;
                    };
                    expect(file.updatedAt, `post ${cid}`).to.equal(stored.updatedAt);
                }
            });

            it(`the old address directory is not nested inside the new one`, async () => {
                expect(await listMfs(`/${domainAddress}`)).to.not.include(publicKey);
            });

            it(`no directory is left at the old address`, async () => {
                expect(await listMfs(`/${publicKey}`)).to.be.undefined;
            });
        });
    }

type KuboFiles = ReturnType<LocalCommunity["_clientsManager"]["getDefaultKuboRpcClient"]>["_client"]["files"];

// A started community with one post whose CommentUpdate is in its postUpdates folder, and a domain it can be renamed to
const startCommunityWithOnePost = async (domainPrefix: string) => {
    const resolverRecords = new Map<string, string | undefined>();
    const pkc = await mockPKCV2({
        stubStorage: false,
        mockResolve: false,
        pkcOptions: { nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: resolverRecords })] }
    });
    const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    const publicKey = community.signer.address;
    const domainAddress = `${domainPrefix}-${uuidV4()}.bso`;
    resolverRecords.set(domainAddress, publicKey);
    const errors: Error[] = [];
    community.on("error", (e) => errors.push(e));
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    const postCid = (await publishRandomPost({ communityAddress: publicKey, pkc })).cid!;
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => community._dbHandler.queryStoredCommentUpdate({ cid: postCid }) !== undefined
    });
    const kuboFiles: KuboFiles = community._clientsManager.getDefaultKuboRpcClient()._client.files;
    // The row is stored before its file is written to MFS later in the same cycle. A rename that starts in between
    // finds no postUpdates folder to move, and the checks on the folder afterwards would have nothing to find
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => {
            const stored = community._dbHandler.queryStoredCommentUpdate({ cid: postCid });
            return (
                stored?.postUpdatesBucket !== undefined &&
                (await mfsPathExists(kuboFiles, `/${publicKey}/postUpdates/${stored.postUpdatesBucket}/${postCid}/update`))
            );
        }
    });
    return { pkc, community, publicKey, domainAddress, postCid, errors, kuboFiles };
};

// What a DB backup that fails partway does: closes the connection, leaves the DB's first page at the new address (which
// passes listCommunitiesSync's SQLite header check) and throws
const failDbRenameLeavingPartialCopy = (community: LocalCommunity) => {
    const dbHandler = community._dbHandler;
    const originalChangeDbFilename = dbHandler.changeDbFilename;
    dbHandler.changeDbFilename = async (oldDbName: string, newDbName: string) => {
        await dbHandler.destoryConnection();
        await fs.promises.writeFile(path.join(community._pkc.dataPath!, "communities", newDbName), "SQLite format 3\0partial backup");
        throw new Error(`simulated DB rename failure from ${oldDbName}`);
    };
    return () => {
        dbHandler.changeDbFilename = originalChangeDbFilename;
    };
};

const expectDbRenameError = (
    editError: unknown,
    expected: { oldAddress: string; newAddress: string; dataPath: string; originalMessage: string }
) => {
    const error = editError as PKCError | undefined;
    expect(error?.code).to.equal("ERR_FAILED_TO_RENAME_COMMUNITY_DB");
    expect(error!.details.oldAddress).to.equal(expected.oldAddress);
    expect(error!.details.newAddress).to.equal(expected.newAddress);
    expect(error!.details.oldDbPath).to.equal(path.join(expected.dataPath, "communities", expected.oldAddress));
    expect(error!.details.newDbPath).to.equal(path.join(expected.dataPath, "communities", expected.newAddress));
    // the error the copy itself raised, for whoever has to find out why it failed
    expect((error!.details.error as Error).message).to.equal(expected.originalMessage);
    expect(error!.details.errorMessage).to.equal(expected.originalMessage);
    return error!;
};

const mfsPathExists = async (kuboFiles: KuboFiles, mfsPath: string): Promise<boolean> => {
    try {
        await kuboFiles.stat(mfsPath);
        return true;
    } catch (e) {
        if ((e as Error).message === "file does not exist") return false;
        throw e;
    }
};

const expectToKeepPublishingUnderOldAddress = async (community: LocalCommunity, publicKey: string) => {
    const updateCidBefore = community.updateCid;
    await community.edit({ title: `after failed rename ${uuidV4()}` });
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updateCid !== updateCidBefore });
    expect(community.address).to.equal(publicKey);
    expect(community.name).to.be.undefined;
};

const waitForCommunitiesEntry = async (pkc: PKCType, publicKey: string) => {
    const entryOfThisCommunity = () => pkc.communities.find((entry) => entry.publicKey === publicKey);
    await resolveWhenConditionIsTrue({
        toUpdate: pkc,
        predicate: async () => entryOfThisCommunity() !== undefined,
        eventName: "communitieschange"
    });
    return entryOfThisCommunity()!;
};

// Issue #469: the rename moves the postUpdates folder before it changes anything else, so a move that fails (with
// anything but "file does not exist", which only means there is no folder yet) leaves the community as it was: still
// started, under its old address, with its DB and folder untouched.
// Skipped under RPC: the domain only resolves through this PKC's mock name resolver (stripped by the RPC test server), and
// the test stubs the community's Kubo client through LocalCommunity internals.
describeSkipIfRpc(`edit({ address }) on a started community when moving the postUpdates folder fails`, async () => {
    let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
    let editError: unknown;

    beforeAll(async () => {
        setup = await startCommunityWithOnePost("test-rename-mv-fails");
        const { kuboFiles, publicKey } = setup;
        const originalMv = kuboFiles.mv;
        kuboFiles.mv = (async (...args: Parameters<typeof originalMv>) => {
            if (args[0] === `/${publicKey}`) throw new Error("simulated MFS move failure");
            return originalMv.apply(kuboFiles, args);
        }) as typeof originalMv;
        try {
            await setup.community.edit({ address: setup.domainAddress });
        } catch (e) {
            editError = e;
        } finally {
            kuboFiles.mv = originalMv;
        }
    });

    afterAll(async () => {
        await setup?.community?.delete();
        await setup?.pkc?.destroy();
    });

    it(`edit() rejects with the move's error`, () => {
        expect((editError as Error | undefined)?.message).to.equal("simulated MFS move failure");
    });

    it(`the community keeps its old address and is still started`, () => {
        expect(setup.community.address).to.equal(setup.publicKey);
        expect(setup.community.state).to.equal("started");
    });

    it(`pkc.communities still lists the community under its old address`, async () => {
        expect((await waitForCommunitiesEntry(setup.pkc, setup.publicKey)).address).to.equal(setup.publicKey);
    });

    it(`the community keeps publishing under its old address`, async () => {
        await expectToKeepPublishingUnderOldAddress(setup.community, setup.publicKey);
    });
});

// Issue #469: when the move fails because Kubo is unreachable, the restart that puts the community back fails too. The
// owner still gets the move's error from edit(), the cause, and the failed restart is reported as an error event.
// Skipped under RPC: same as above, the domain resolves only through this PKC's mock resolver and the test stubs
// LocalCommunity internals.
describeSkipIfRpc(`edit({ address }) on a started community when the move fails and the restart after it fails too`, async () => {
    let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
    let editError: unknown;

    beforeAll(async () => {
        setup = await startCommunityWithOnePost("test-rename-mv-and-restart-fail");
        const { community, kuboFiles, publicKey } = setup;
        const originalMv = kuboFiles.mv;
        const originalStart = community.start;
        kuboFiles.mv = (async (...args: Parameters<typeof originalMv>) => {
            if (args[0] === `/${publicKey}`) throw new Error("simulated MFS move failure");
            return originalMv.apply(kuboFiles, args);
        }) as typeof originalMv;
        community.start = async () => {
            throw new Error("simulated restart failure");
        };
        try {
            await community.edit({ address: setup.domainAddress });
        } catch (e) {
            editError = e;
        } finally {
            kuboFiles.mv = originalMv;
            community.start = originalStart;
        }
    });

    afterAll(async () => {
        await setup?.community?.delete();
        await setup?.pkc?.destroy();
    });

    it(`edit() rejects with the move's error, not the restart's`, () => {
        expect((editError as Error | undefined)?.message).to.equal("simulated MFS move failure");
    });

    it(`the failed restart is emitted as an error event`, () => {
        expect(setup.errors.map((e) => e.message)).to.include("simulated restart failure");
    });
});

// Issue #469: the DB rename comes after the folder move, so a DB rename that fails (a backup that runs out of disk, say)
// must move the folder back before restarting, or the restarted community publishes under its old address without its
// postUpdates. A backup that fails partway can leave a partial DB file at the new address, which lookups by filename
// (findLocalCommunityAddress) would still match, so the rename removes it too.
// Skipped under RPC: same as above, the domain resolves only through this PKC's mock resolver and the test stubs
// LocalCommunity internals.
describeSkipIfRpc(`edit({ address }) on a started community when renaming the DB fails`, async () => {
    let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
    let editError: unknown;
    let newDbPath: string;

    beforeAll(async () => {
        setup = await startCommunityWithOnePost("test-rename-db-fails");
        const { community, pkc } = setup;
        newDbPath = path.join(pkc.dataPath!, "communities", setup.domainAddress);
        const restoreDbRename = failDbRenameLeavingPartialCopy(community);
        try {
            await community.edit({ address: setup.domainAddress });
        } catch (e) {
            editError = e;
        } finally {
            restoreDbRename();
        }
    });

    afterAll(async () => {
        await setup?.community?.delete();
        await setup?.pkc?.destroy();
        await fs.promises.rm(newDbPath, { force: true });
    });

    it(`edit() rejects with an error that carries the DB rename's own error and what was cleaned up`, () => {
        const error = expectDbRenameError(editError, {
            oldAddress: setup.publicKey,
            newAddress: setup.domainAddress,
            dataPath: setup.pkc.dataPath!,
            originalMessage: `simulated DB rename failure from ${setup.publicKey}`
        });
        expect(error.details.partialDbCopyRemoved).to.be.true;
        expect(error.details.partialDbCopyPath).to.be.undefined;
        expect(error.details.postUpdatesFolderMovedBack).to.be.true;
    });

    it(`the community keeps its old address and is still started`, () => {
        expect(setup.community.address).to.equal(setup.publicKey);
        expect(setup.community.state).to.equal("started");
    });

    it(`the postUpdates folder is back under the old address`, async () => {
        const stored = setup.community._dbHandler.queryStoredCommentUpdate({ cid: setup.postCid })!;
        expect(await mfsPathExists(setup.kuboFiles, `/${setup.publicKey}/postUpdates/${stored.postUpdatesBucket}/${setup.postCid}/update`))
            .to.be.true;
        expect(await mfsPathExists(setup.kuboFiles, `/${setup.domainAddress}`)).to.be.false;
    });

    it(`the partial DB file at the new address is removed`, () => {
        expect(fs.existsSync(newDbPath)).to.be.false;
    });

    it(`pkc.communities still lists the community under its old address`, async () => {
        expect((await waitForCommunitiesEntry(setup.pkc, setup.publicKey)).address).to.equal(setup.publicKey);
    });

    it(`the community keeps publishing under its old address`, async () => {
        await expectToKeepPublishingUnderOldAddress(setup.community, setup.publicKey);
    });
});

// Issue #469: when the DB rename fails and moving the folder back fails too, the folder sits under the new address while
// the DB is under the old one. Starting the community then would publish without its postUpdates, so it stays stopped:
// edit() rejects with the DB rename's error and the failed move back is emitted as an error event.
// Skipped under RPC: same as above, the domain resolves only through this PKC's mock resolver and the test stubs
// LocalCommunity internals.
describeSkipIfRpc(`edit({ address }) on a started community when renaming the DB and moving the folder back both fail`, async () => {
    let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
    let editError: unknown;

    beforeAll(async () => {
        setup = await startCommunityWithOnePost("test-rename-db-and-rollback-fail");
        const { community, kuboFiles, domainAddress } = setup;
        const dbHandler = community._dbHandler;
        const originalChangeDbFilename = dbHandler.changeDbFilename;
        const originalMv = kuboFiles.mv;
        dbHandler.changeDbFilename = async () => {
            await dbHandler.destoryConnection();
            throw new Error("simulated DB rename failure");
        };
        kuboFiles.mv = (async (...args: Parameters<typeof originalMv>) => {
            if (args[0] === `/${domainAddress}`) throw new Error("simulated rollback move failure");
            return originalMv.apply(kuboFiles, args);
        }) as typeof originalMv;
        try {
            await community.edit({ address: domainAddress });
        } catch (e) {
            editError = e;
        } finally {
            dbHandler.changeDbFilename = originalChangeDbFilename;
            kuboFiles.mv = originalMv;
        }
    });

    afterAll(async () => {
        if (setup && (await mfsPathExists(setup.kuboFiles, `/${setup.domainAddress}`)))
            await setup.kuboFiles.rm(`/${setup.domainAddress}`, { recursive: true });
        await setup?.community?.delete();
        await setup?.pkc?.destroy();
    });

    it(`edit() rejects with an error that carries the DB rename's own error and says the folder was not moved back`, () => {
        const error = expectDbRenameError(editError, {
            oldAddress: setup.publicKey,
            newAddress: setup.domainAddress,
            dataPath: setup.pkc.dataPath!,
            originalMessage: "simulated DB rename failure"
        });
        expect(error.details.postUpdatesFolderMovedBack).to.be.false;
    });

    it(`the failed move back is emitted as an error event`, () => {
        expect(setup.errors.map((e) => e.message)).to.include("simulated rollback move failure");
    });

    it(`the community stays stopped under its old address`, () => {
        expect(setup.community.address).to.equal(setup.publicKey);
        expect(setup.community.state).to.equal("stopped");
    });
});

// Issue #514: on Windows the removal of the partial DB file can fail with EBUSY or EPERM while another handle still has
// the file open (a reader of the communities directory that opened it a moment earlier). The removal used to be tried
// once and its failure only logged, which left the partial file at the new address. A busy file is simulated here by
// failing fs.promises.rm with the codes Windows returns, so the cases run on every OS.
// Skipped under RPC: same as above, the domain resolves only through this PKC's mock resolver and the test stubs
// LocalCommunity internals.
const busyError = (code: string, filePath: string) =>
    Object.assign(new Error(`${code}: resource busy or locked, unlink '${filePath}'`), { code, syscall: "unlink" });

for (const code of ["EBUSY", "EPERM"])
    describeSkipIfRpc(
        `edit({ address }) on a started community when renaming the DB fails and the partial file is ${code} at first`,
        async () => {
            let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
            let editError: unknown;
            let newDbPath: string;
            let removalAttempts = 0;

            beforeAll(async () => {
                setup = await startCommunityWithOnePost("test-rename-db-fails-busy");
                const { community, pkc } = setup;
                newDbPath = path.join(pkc.dataPath!, "communities", setup.domainAddress);
                const restoreDbRename = failDbRenameLeavingPartialCopy(community);
                const realRm = fs.promises.rm.bind(fs.promises);
                const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
                    if (target !== newDbPath) return realRm(target, options);
                    removalAttempts++;
                    if (removalAttempts <= 2) throw busyError(code, newDbPath);
                    return realRm(target, options);
                });
                try {
                    await community.edit({ address: setup.domainAddress });
                } catch (e) {
                    editError = e;
                } finally {
                    restoreDbRename();
                    rmSpy.mockRestore();
                }
            });

            afterAll(async () => {
                await setup?.community?.delete();
                await setup?.pkc?.destroy();
                await fs.promises.rm(newDbPath, { force: true });
            });

            it(`the removal is retried until the file is released`, () => {
                expect(removalAttempts).to.equal(3);
            });

            it(`the partial DB file at the new address is removed`, () => {
                expect(fs.existsSync(newDbPath)).to.be.false;
            });

            it(`edit() rejects saying the partial file was removed`, () => {
                const error = editError as PKCError | undefined;
                expect(error?.code).to.equal("ERR_FAILED_TO_RENAME_COMMUNITY_DB");
                expect(error!.details.partialDbCopyRemoved).to.be.true;
            });

            it(`the community keeps publishing under its old address`, async () => {
                await expectToKeepPublishingUnderOldAddress(setup.community, setup.publicKey);
            });
        }
    );

// Issue #514: a file that stays busy past the retry window is left behind. Nothing deletes it later on purpose: after a
// rename that succeeds on another attempt that path holds the community's real DB. The error names the file instead.
// Skipped under RPC: same as above, the domain resolves only through this PKC's mock resolver and the test stubs
// functions of the local community and of fs in this process, which an RPC client has no access to.
describeSkipIfRpc(`edit({ address }) on a started community when renaming the DB fails and the partial file stays busy`, async () => {
    let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
    let editError: unknown;
    let newDbPath: string;

    beforeAll(async () => {
        setup = await startCommunityWithOnePost("test-rename-db-fails-stays-busy");
        const { community, pkc } = setup;
        newDbPath = path.join(pkc.dataPath!, "communities", setup.domainAddress);
        const restoreDbRename = failDbRenameLeavingPartialCopy(community);
        const realRm = fs.promises.rm.bind(fs.promises);
        const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
            if (target !== newDbPath) return realRm(target, options);
            throw busyError("EBUSY", newDbPath);
        });
        try {
            await community.edit({ address: setup.domainAddress });
        } catch (e) {
            editError = e;
        } finally {
            restoreDbRename();
            rmSpy.mockRestore();
        }
    });

    afterAll(async () => {
        await setup?.community?.delete();
        await setup?.pkc?.destroy();
        await fs.promises.rm(newDbPath, { force: true });
    });

    it(`edit() rejects naming the partial file it could not remove`, () => {
        const error = editError as PKCError | undefined;
        expect(error?.code).to.equal("ERR_FAILED_TO_RENAME_COMMUNITY_DB");
        expect(error!.details.partialDbCopyRemoved).to.be.false;
        expect(error!.details.partialDbCopyPath).to.equal(newDbPath);
        expect((error!.details.partialDbCopyRemovalError as NodeJS.ErrnoException).code).to.equal("EBUSY");
    });

    it(`the community is restored under its old address and keeps publishing`, async () => {
        expect(setup.community.state).to.equal("started");
        await expectToKeepPublishingUnderOldAddress(setup.community, setup.publicKey);
    });
});

// A community that is not started takes another path through edit(), which had no cleanup at all: a DB rename that
// failed left the partial DB file at the new address and the postUpdates folder under the new address, with the DB still
// under the old one.
// Skipped under RPC: same as above, the domain resolves only through this PKC's mock resolver and the test stubs
// LocalCommunity internals.
describeSkipIfRpc(`edit({ address }) on a community that is not started when renaming the DB fails`, async () => {
    let setup: Awaited<ReturnType<typeof startCommunityWithOnePost>>;
    let editError: unknown;
    let newDbPath: string;
    let postUpdatesBucket: number;

    beforeAll(async () => {
        setup = await startCommunityWithOnePost("test-rename-stopped-db-fails");
        const { community, pkc } = setup;
        postUpdatesBucket = community._dbHandler.queryStoredCommentUpdate({ cid: setup.postCid })!.postUpdatesBucket!;
        await community.stop();
        newDbPath = path.join(pkc.dataPath!, "communities", setup.domainAddress);
        const restoreDbRename = failDbRenameLeavingPartialCopy(community);
        try {
            await community.edit({ address: setup.domainAddress });
        } catch (e) {
            editError = e;
        } finally {
            restoreDbRename();
        }
    });

    afterAll(async () => {
        if (setup && (await mfsPathExists(setup.kuboFiles, `/${setup.domainAddress}`)))
            await setup.kuboFiles.rm(`/${setup.domainAddress}`, { recursive: true });
        await setup?.community?.delete();
        await setup?.pkc?.destroy();
        await fs.promises.rm(newDbPath, { force: true });
    });

    it(`edit() rejects with an error that carries the DB rename's own error and what was cleaned up`, () => {
        const error = expectDbRenameError(editError, {
            oldAddress: setup.publicKey,
            newAddress: setup.domainAddress,
            dataPath: setup.pkc.dataPath!,
            originalMessage: `simulated DB rename failure from ${setup.publicKey}`
        });
        expect(error.details.partialDbCopyRemoved).to.be.true;
        expect(error.details.postUpdatesFolderMovedBack).to.be.true;
    });

    it(`the partial DB file at the new address is removed`, () => {
        expect(fs.existsSync(newDbPath)).to.be.false;
    });

    it(`the postUpdates folder is back under the old address`, async () => {
        expect(await mfsPathExists(setup.kuboFiles, `/${setup.publicKey}/postUpdates/${postUpdatesBucket}/${setup.postCid}/update`)).to.be
            .true;
        expect(await mfsPathExists(setup.kuboFiles, `/${setup.domainAddress}`)).to.be.false;
    });

    it(`the community keeps its old address and stays stopped`, () => {
        expect(setup.community.address).to.equal(setup.publicKey);
        expect(setup.community.state).to.equal("stopped");
    });

    it(`the community starts and publishes under its old address afterwards`, async () => {
        await setup.community.start();
        await expectToKeepPublishingUnderOldAddress(setup.community, setup.publicKey);
    });
});
