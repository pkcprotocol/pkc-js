import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
    createMockNameResolver,
    publishRandomPost,
    createSubWithNoChallenge,
    resolveWhenConditionIsTrue,
    mockPKCV2
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import { v4 as uuidV4 } from "uuid";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Renaming a started community (edit({ address }) or edit({ name })) stops it, renames the DB, starts it again, and only
// then moves its postUpdates MFS directory from /<old address> to /<new address>. The restarted publish loop runs a cycle
// while that move is pending, so the postUpdates directory and the move race. Seen in CI as a sync error on the renamed
// community (`files.flush` of the old directory: "file does not exist", windows, name-added-comments.community.test.ts).
// Each suite pins one interleaving by holding a call of the restarted cycle until the move is done:
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
            // community.address each time the restarted cycle reached the held call on the old postUpdates directory
            const addressesAtHeldCall: string[] = [];

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
                    addressesAtHeldCall.push(community.address);
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
                    await Promise.race([heldCallReached, new Promise((resolve) => setTimeout(resolve, 20000))]);
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
                expect(addressesAtHeldCall, `the restarted cycle reached its ${heldCall} on the old postUpdates directory`).to.not.be.empty;
                expect(community.address).to.equal(domainAddress);
                // two records, so the second comes from a cycle that started after the rename returned
                await waitForNewRecord();
                await community.edit({ title: `after rename ${uuidV4()}` });
                await waitForNewRecord();
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
