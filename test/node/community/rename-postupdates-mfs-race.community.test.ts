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
// community (`files.flush` of the new directory: "file does not exist", windows, name-added-comments.community.test.ts).
// Every post published before the rename must still have its CommentUpdate under the new address afterwards.
// Skipped under RPC: the domain only resolves through this PKC's mock name resolver, and the RPC test server strips
// client-supplied nameResolvers in setSettings, so the community could never take the domain address there. The test
// also reads the community's MFS through LocalCommunity internals.
for (const editKey of ["address", "name"] as const) {
    describeSkipIfRpc(`edit({ ${editKey} }) on a started community vs its postUpdates MFS directory`, async () => {
        let pkc: PKCType;
        let community: LocalCommunity;
        let publicKey: string;
        let domainAddress: string;
        let postCids: string[];
        const errors: Error[] = [];
        // community.address each time the restarted cycle reached its flush of the old postUpdates directory
        const addressesAtHeldFlush: string[] = [];

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

            // Pin the interleaving CI hit on windows: the restarted loop's first cycle writes the posts' CommentUpdates
            // under the old address, the rename moves the directory, and only then does that cycle flush the old path.
            // The posts are flagged as the rename restarts the community so that cycle has post updates to write.
            const kuboFiles = community._clientsManager.getDefaultKuboRpcClient()._client.files;
            const originalFlush = kuboFiles.flush;
            const originalMv = kuboFiles.mv;
            const originalStart = community.start;
            let restarted = false;
            let resolveFlushReached!: () => void;
            const flushReached = new Promise<void>((resolve) => (resolveFlushReached = resolve));
            let resolveMvDone!: () => void;
            const mvDone = new Promise<void>((resolve) => (resolveMvDone = resolve));
            community.start = async () => {
                restarted = true;
                community._dbHandler.forceUpdateOnAllCommentsWithCid(postCids);
                return originalStart.call(community);
            };
            kuboFiles.flush = (async (...args: Parameters<typeof originalFlush>) => {
                if (restarted && args[0] === `/${publicKey}`) {
                    addressesAtHeldFlush.push(community.address);
                    resolveFlushReached();
                    await mvDone;
                }
                return originalFlush.apply(kuboFiles, args);
            }) as typeof originalFlush;
            kuboFiles.mv = (async (...args: Parameters<typeof originalMv>) => {
                if (args[0] !== `/${publicKey}`) return originalMv.apply(kuboFiles, args);
                await Promise.race([flushReached, new Promise((resolve) => setTimeout(resolve, 20000))]);
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
                kuboFiles.mv = originalMv;
                resolveMvDone();
            }
            expect(addressesAtHeldFlush, "the restarted cycle flushed the old postUpdates directory").to.not.be.empty;
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

        it(`the old address directory is not nested inside the new one`, async () => {
            expect(await listMfs(`/${domainAddress}`)).to.not.include(publicKey);
        });

        it(`no directory is left at the old address`, async () => {
            expect(await listMfs(`/${publicKey}`)).to.be.undefined;
        });
    });
}
