import { beforeAll, afterAll, describe, it, beforeEach } from "vitest";
import {
    createMockNameResolver,
    publishRandomPost,
    mockPlebbit,
    createSubWithNoChallenge,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    describeIfRpc,
    waitTillPostInSubplebbitPages,
    mockPlebbitV2
} from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import fs from "fs";
import path from "path";
import * as remeda from "remeda";

import { v4 as uuidV4 } from "uuid";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { RemoteSubplebbit } from "../../../dist/node/subplebbit/remote-subplebbit.js";
import type { SubplebbitEditOptions } from "../../../dist/node/subplebbit/types.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

describeSkipIfRpc(`subplebbit.edit`, async () => {
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let postToPublishAfterEdit: Comment;
    let bsoNameAddress: string;
    let plebbitResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;
    beforeAll(async () => {
        plebbitResolverRecords = new Map();
        remoteResolverRecords = new Map();
        plebbit = await mockPlebbitV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
        remotePlebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });

        subplebbit = await createSubWithNoChallenge({}, plebbit);
        bsoNameAddress = `test-edit-${uuidV4()}.bso`;

        plebbitResolverRecords.set(bsoNameAddress, subplebbit.signer.address);
        remoteResolverRecords.set(bsoNameAddress, subplebbit.signer.address);

        const resolvedSubAddress = await remotePlebbit._clientsManager.resolveCommunityNameIfNeeded(bsoNameAddress);
        expect(resolvedSubAddress).to.equal(subplebbit.signer.address);

        await plebbit.resolveAuthorName({ address: "esteban.bso" });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit });
    });
    afterAll(async () => {
        await subplebbit.stop();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    [{ title: `Test subplebbit title edit ${Date.now()}` }, { description: `Test subplebbit description edit ${Date.now()}` }].map(
        (editArgs) =>
            it(`subplebbit.edit(${JSON.stringify(editArgs)})`, async () => {
                const [keyToEdit, newValue] = Object.entries(editArgs)[0] as [keyof typeof editArgs, string];
                await subplebbit.edit(editArgs);
                expect(subplebbit[keyToEdit]).to.equal(newValue);
                const updatingRemoteSubplebbit = (await remotePlebbit.getSubplebbit({
                    address: subplebbit.address
                })) as RemoteSubplebbit;
                await updatingRemoteSubplebbit.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: updatingRemoteSubplebbit,
                    predicate: async () => updatingRemoteSubplebbit[keyToEdit] === newValue
                });
                await updatingRemoteSubplebbit.stop();
                expect(updatingRemoteSubplebbit[keyToEdit]).to.equal(newValue);
                expect(updatingRemoteSubplebbit.raw.subplebbitIpfs).to.deep.equal(subplebbit.raw.subplebbitIpfs);
            })
    );

    it(`An update is triggered after calling subplebbit.edit()`, async () => {
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        await sub.edit({ features: { requirePostLink: true } });
        expect(sub.features!.requirePostLink).to.be.true;
        // Access private property via casting
        expect((sub as LocalSubplebbit)["_subplebbitUpdateTrigger"]).to.be.true;
        await new Promise((resolve) => sub.once("update", resolve)); // the edit should trigger an update immedietely
        expect((sub as LocalSubplebbit)["_subplebbitUpdateTrigger"]).to.be.false;
        expect(sub.features!.requirePostLink).to.be.true;

        await sub.delete();
    });
    it(`Sub is locked for start`, async () => {
        // Check for locks
        const localSub = subplebbit as LocalSubplebbit;
        expect(await localSub._dbHandler.isSubStartLocked(subplebbit.signer.address)).to.be.true;
    });

    it(`Can edit a subplebbit to have ENS domain as address`, async () => {
        expect(subplebbit.posts.pages).to.not.deep.equal({});
        await subplebbit.edit({ address: bsoNameAddress });
        expect(subplebbit.address).to.equal(bsoNameAddress);
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(bsoNameAddress);
    });

    it(`plebbit.subplebbits includes the new ENS address, and not the old address`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: plebbit,
            predicate: async () => plebbit.subplebbits.includes(bsoNameAddress) && !plebbit.subplebbits.includes(subplebbit.signer.address),
            eventName: "subplebbitschange"
        });
        const subs = plebbit.subplebbits;
        expect(subs).to.include(bsoNameAddress);
        expect(subs).to.not.include(subplebbit.signer.address);
    });

    it(`Local subplebbit resets posts after changing address`, async () => {
        expect(subplebbit.posts.pages).to.deep.equal({});
        expect(subplebbit.posts.pageCids).to.deep.equal({});
    });

    it(`Start locks are moved to the new address`, async () => {
        // Check for locks
        expect(fs.existsSync(path.join(subplebbit._plebbit.dataPath!, "subplebbits", `${subplebbit.signer.address}.start.lock`))).to.be
            .false;
        expect(fs.existsSync(path.join(subplebbit._plebbit.dataPath!, "subplebbits", `${bsoNameAddress}.start.lock`))).to.be.true;
    });

    it(`Can load a subplebbit with ENS domain as address`, async () => {
        const loadedSubplebbit = (await remotePlebbit.getSubplebbit({ address: bsoNameAddress })) as RemoteSubplebbit;
        expect(loadedSubplebbit.address).to.equal(bsoNameAddress);
        expect(loadedSubplebbit.raw.subplebbitIpfs).to.deep.equal(subplebbit.raw.subplebbitIpfs);
    });

    it(`remote subplebbit.posts is reset after changing address`, async () => {
        const loadedSubplebbit = (await plebbit.getSubplebbit({ address: bsoNameAddress })) as RemoteSubplebbit;
        // subplebbit.posts should omit all comments that referenced the old subplebbit address
        // So in essence it be undefined
        expect(loadedSubplebbit.posts.pages).to.deep.equal({});
        expect(loadedSubplebbit.posts.pageCids).to.deep.equal({});
    });

    it(`Started Sub can receive publications on new ENS address`, async () => {
        postToPublishAfterEdit = await publishRandomPost({ subplebbitAddress: bsoNameAddress, plebbit: plebbit });
    });

    it(`Posts submitted to new sub address are shown in subplebbit.posts`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postToPublishAfterEdit.cid))
        });
        expect(Object.keys(subplebbit.posts.pageCids).sort()).to.deep.equal([]); // empty array because it's a single preloaded page
    });

    it(`calling subplebbit.edit() should not add subplebbit to plebbit._updatingSubplebbits or plebbit._startedSubplebbits`, async () => {
        const plebbitInstance = await mockPlebbit();
        const sub = (await plebbitInstance.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(plebbitInstance._updatingSubplebbits[sub.address]).to.be.undefined;
        expect(plebbitInstance._startedSubplebbits[sub.address]).to.be.undefined;
        await sub.edit({ address: "123" + bsoNameAddress });
        expect(plebbitInstance._updatingSubplebbits[sub.address]).to.be.undefined;
        expect(plebbitInstance._startedSubplebbits[sub.address]).to.be.undefined;

        await plebbitInstance.destroy();
    });
});

describeSkipIfRpc(`subplebbit.edit .eth -> .bso transition`, async () => {
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let ethAddress: string;
    let bsoAddress: string;
    let postPublishedOnBso: Comment;
    let plebbitResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        plebbitResolverRecords = new Map();
        remoteResolverRecords = new Map();
        plebbit = await mockPlebbitV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
        remotePlebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });
        subplebbit = await createSubWithNoChallenge({}, plebbit);

        const domainPrefix = `test-edit-${uuidV4()}`;
        ethAddress = `${domainPrefix}.eth`;
        bsoAddress = `${domainPrefix}.bso`;

        plebbitResolverRecords.set(ethAddress, subplebbit.signer.address);
        plebbitResolverRecords.set(bsoAddress, subplebbit.signer.address);
        remoteResolverRecords.set(ethAddress, subplebbit.signer.address);
        remoteResolverRecords.set(bsoAddress, subplebbit.signer.address);

        expect(await remotePlebbit._clientsManager.resolveCommunityNameIfNeeded(ethAddress)).to.equal(subplebbit.signer.address);
        expect(await remotePlebbit._clientsManager.resolveCommunityNameIfNeeded(bsoAddress)).to.equal(subplebbit.signer.address);

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        const publishedPost = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit }); // ensure posts are non-empty before edits
        await waitTillPostInSubplebbitPages(publishedPost as CommentIpfsWithCidDefined, plebbit);
    });

    afterAll(async () => {
        await subplebbit.stop();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`started sub can transition from .eth to .bso with update events`, async () => {
        expect(subplebbit.posts.pages).to.not.deep.equal({});

        await subplebbit.edit({ address: ethAddress });
        expect(subplebbit.address).to.equal(ethAddress);
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(ethAddress);

        const postPublishedOnEth = await publishRandomPost({ subplebbitAddress: ethAddress, plebbit: plebbit });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });

        await subplebbit.edit({ address: bsoAddress });
        expect(subplebbit.address).to.equal(bsoAddress);
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(bsoAddress);
    });

    it(`plebbit.subplebbits includes only the final .bso address`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: plebbit,
            predicate: async () =>
                plebbit.subplebbits.includes(bsoAddress) &&
                !plebbit.subplebbits.includes(ethAddress) &&
                !plebbit.subplebbits.includes(subplebbit.signer.address),
            eventName: "subplebbitschange"
        });

        expect(plebbit.subplebbits).to.include(bsoAddress);
        expect(plebbit.subplebbits).to.not.include(ethAddress);
        expect(plebbit.subplebbits).to.not.include(subplebbit.signer.address);
    });

    it(`start locks are moved from signer/.eth to .bso`, async () => {
        const subplebbitsDir = path.join(subplebbit._plebbit.dataPath!, "subplebbits");
        expect(fs.existsSync(path.join(subplebbitsDir, `${subplebbit.signer.address}.start.lock`))).to.be.false;
        expect(fs.existsSync(path.join(subplebbitsDir, `${ethAddress}.start.lock`))).to.be.false;
        expect(fs.existsSync(path.join(subplebbitsDir, `${bsoAddress}.start.lock`))).to.be.true;
    });

    it(`posts are preserved locally after .eth -> .bso edit (alias transition)`, async () => {
        // .eth and .bso are equivalent aliases, so posts published under .eth should still be visible under .bso
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () => Object.keys(subplebbit.posts.pages).length > 0
        });
        expect(subplebbit.posts.pages).to.not.deep.equal({});
    });

    it(`started sub keeps accepting publications on the new .bso address`, async () => {
        postPublishedOnBso = await publishRandomPost({ subplebbitAddress: bsoAddress, plebbit: plebbit });

        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnBso.cid))
        });
    });
});

describeSkipIfRpc(`Concurrency with subplebbit.edit`, async () => {
    let plebbit: PlebbitType;
    let plebbitResolverRecords: Map<string, string | undefined>;
    beforeEach(async () => {
        if (plebbit) await plebbit.destroy();
        plebbitResolverRecords = new Map();
        plebbit = await mockPlebbitV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it("Two unstarted local sub instances can receive each other updates with subplebbit.update and edit", async () => {
        const subOne = await createSubWithNoChallenge({}, plebbit);
        // subOne is published now
        const subTwo = (await plebbit.createSubplebbit({ address: subOne.address })) as LocalSubplebbit | RpcLocalSubplebbit;
        await subTwo.update();

        const newTitle = "Test new Title" + Date.now();
        await subOne.edit({ title: newTitle });
        expect(subOne.title).to.equal(newTitle);

        await new Promise((resolve) => subTwo.once("update", resolve));

        expect(subTwo.title).to.equal(newTitle);
        expect(subTwo.raw.subplebbitIpfs).to.deep.equal(subOne.raw.subplebbitIpfs);

        await subTwo.stop();
    });

    (
        [
            { address: `address-bso-${uuidV4()}-1.bso` },
            { rules: ["rule 1", "rule 2"] },
            { address: `address-bso-${uuidV4()}-2.bso`, rules: ["rule 1", "rule 2"] }
        ] as SubplebbitEditOptions[]
    ).map((editArgs) =>
        it(`Calling startedSubplebbit.stop() after edit while updating another subplebbit should not reset the edit (${Object.keys(editArgs)})`, async () => {
            const startedSub = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
            const editKeys = Object.keys(editArgs) as (keyof SubplebbitEditOptions)[];

            const hasLatestEditProps = (sub: LocalSubplebbit | RpcLocalSubplebbit): boolean => {
                const picked = remeda.pick(sub, editKeys);
                return remeda.isDeepEqual(picked, editArgs as typeof picked);
            };

            const expectSubToHaveLatestEditProps = (sub: LocalSubplebbit | RpcLocalSubplebbit) => {
                expect(remeda.pick(sub, editKeys)).to.deep.equal(editArgs);
            };

            const updatingSubplebbit = (await plebbit.createSubplebbit({ address: startedSub.address })) as
                | LocalSubplebbit
                | RpcLocalSubplebbit;
            await updatingSubplebbit.update();

            await startedSub.start();

            const subToEdit = (await plebbit.createSubplebbit({ address: startedSub.address })) as LocalSubplebbit | RpcLocalSubplebbit;
            await subToEdit.edit(editArgs);
            expectSubToHaveLatestEditProps(subToEdit);
            expectSubToHaveLatestEditProps(startedSub);

            await resolveWhenConditionIsTrue({
                toUpdate: updatingSubplebbit,
                predicate: async () => hasLatestEditProps(updatingSubplebbit)
            });
            expectSubToHaveLatestEditProps(startedSub);
            expectSubToHaveLatestEditProps(subToEdit);
            expectSubToHaveLatestEditProps(updatingSubplebbit);

            await startedSub.stop();
            expectSubToHaveLatestEditProps(startedSub);
            expectSubToHaveLatestEditProps(updatingSubplebbit);
            expectSubToHaveLatestEditProps(subToEdit);

            await updatingSubplebbit.stop();
            expectSubToHaveLatestEditProps(startedSub);
            expectSubToHaveLatestEditProps(updatingSubplebbit);
            expectSubToHaveLatestEditProps(subToEdit);
        })
    );

    (
        [
            { address: `address-bso-${uuidV4()}-1.bso` },
            { rules: ["rule 1", "rule 2"] },
            { address: `address-bso-${uuidV4()}-2.bso`, rules: ["rule 1", "rule 2"] }
        ] as SubplebbitEditOptions[]
    ).map((editArgs) =>
        it(`edit subplebbit with multiple subplebbit instances running (${Object.keys(editArgs)})`, async () => {
            // TODO investigate why this test gets slower the more times it's run
            const subplebbitTitle = "subplebbit title" + timestamp();
            const subplebbitInstance = (await plebbit.createSubplebbit({ title: subplebbitTitle })) as LocalSubplebbit | RpcLocalSubplebbit;
            const editKeys = Object.keys(editArgs) as (keyof SubplebbitEditOptions)[];
            if (editArgs.address) {
                plebbitResolverRecords.set(editArgs.address, subplebbitInstance.signer.address);
                plebbit._storage.removeItem = () => Promise.resolve(false); // stop clearing cache when editing subplebbit address

                const resolvedSubAddress = await plebbit._clientsManager.resolveCommunityNameIfNeeded(editArgs.address);
                expect(resolvedSubAddress).to.equal(subplebbitInstance.signer.address);
            }

            let editIsFinished: boolean;

            // subplebbit is updating
            const updatingSubplebbit = (await plebbit.createSubplebbit({ address: subplebbitInstance.address })) as
                | LocalSubplebbit
                | RpcLocalSubplebbit;
            updatingSubplebbit.on("update", () => {
                const picked = remeda.pick(updatingSubplebbit, editKeys);
                if (remeda.isDeepEqual(picked, editArgs as typeof picked)) editIsFinished = true; // there's a case where the edit is finished and update is emitted before we get to update editIsFinished
            });

            expect(updatingSubplebbit.signer).to.be.a("object");
            expect(updatingSubplebbit.title).to.equal(subplebbitTitle);
            await updatingSubplebbit.update();

            // start subplebbit
            const startedSubplebbit = (await plebbit.createSubplebbit({ address: subplebbitInstance.address })) as
                | LocalSubplebbit
                | RpcLocalSubplebbit;
            await startedSubplebbit.start();

            startedSubplebbit.on("update", () => {
                const picked = remeda.pick(startedSubplebbit, editKeys);
                if (remeda.isDeepEqual(picked, editArgs as typeof picked)) editIsFinished = true; // there's a case where the edit is finished and update is emitted before we get to update editIsFinished
            });

            expect(startedSubplebbit.title).to.equal(subplebbitTitle);

            const updateEventPromise = new Promise((resolve) =>
                updatingSubplebbit.on("update", (updatedSubplebbit) => editIsFinished && resolve(updatedSubplebbit))
            );

            updatingSubplebbit.on("update", (updatedSubplebbit) => {
                console.log("updatingSubplebbit update", updatedSubplebbit.rules);
            });

            const updateStartedSubEventPromise = new Promise((resolve) =>
                startedSubplebbit.on("update", (updatedSubplebbit) => editIsFinished && resolve(updatedSubplebbit))
            );

            // edit subplebbit
            console.log("editSubplebbit");
            const editedSubplebbit = (await plebbit.createSubplebbit({ address: subplebbitInstance.address })) as
                | LocalSubplebbit
                | RpcLocalSubplebbit;
            await editedSubplebbit.edit(editArgs); // it should be sent to the started subplebbit
            expect(remeda.pick(editedSubplebbit, editKeys)).to.deep.equal(editArgs);
            expect(remeda.pick(startedSubplebbit, editKeys)).to.deep.equal(editArgs);

            editIsFinished = true;
            expect(editedSubplebbit.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(editedSubplebbit[editKey as keyof SubplebbitEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );

            // wait for subplebbit update
            // both started and updating subplebbit should now have the subplebbit edit
            console.log("wait for subplebbit update");
            await updateEventPromise;

            expect(remeda.pick(editedSubplebbit, editKeys)).to.deep.equal(editArgs);
            expect(remeda.pick(startedSubplebbit, editKeys)).to.deep.equal(editArgs); // this fails

            expect(updatingSubplebbit.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(updatingSubplebbit[editKey as keyof SubplebbitEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );

            await updatingSubplebbit.stop();

            console.log("Before await updateStartedSubEventPromise");
            await updateStartedSubEventPromise;

            expect(startedSubplebbit.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs)) {
                if (deterministicStringify(startedSubplebbit[editKey as keyof SubplebbitEditOptions]) !== deterministicStringify(editValue))
                    await new Promise((resolve) => startedSubplebbit.once("update", resolve)); // Wait until the new props are included in the next update
                expect(deterministicStringify(startedSubplebbit[editKey as keyof SubplebbitEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );
            }

            expect(remeda.pick(startedSubplebbit, editKeys)).to.deep.equal(editArgs);
            await startedSubplebbit.stop();
            expect(remeda.pick(startedSubplebbit, editKeys)).to.deep.equal(editArgs);

            expect(subplebbitInstance.rules).to.equal(undefined); // subplebbit is not updating, started or editing so it has no way to get the rules

            const newlyCreatedSubplebbit = (await plebbit.createSubplebbit({ address: startedSubplebbit.address })) as
                | LocalSubplebbit
                | RpcLocalSubplebbit;
            expect(newlyCreatedSubplebbit.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(newlyCreatedSubplebbit[editKey as keyof SubplebbitEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );
        })
    );

    it(`Can edit a local sub address, then start it`, async () => {
        const customResolverRecords = new Map<string, string | undefined>();
        const customPlebbit = await mockPlebbitV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: customResolverRecords })]
            }
        });
        const signer = await customPlebbit.createSigner();
        const domain = `edit-before-start-${uuidV4()}.bso`;

        customResolverRecords.set(domain, signer.address);

        const sub = await createSubWithNoChallenge({ signer }, customPlebbit);
        await sub.edit({ address: domain });
        // Check for locks
        const localSub = sub as LocalSubplebbit;
        expect(await localSub._dbHandler.isSubStartLocked(sub.signer.address)).to.be.false;
        expect(await localSub._dbHandler.isSubStartLocked(domain)).to.be.false;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        expect(sub.address).to.equal(domain);
        // Check for locks
        expect(await localSub._dbHandler.isSubStartLocked(sub.signer.address)).to.be.false;
        expect(await localSub._dbHandler.isSubStartLocked(domain)).to.be.true;

        const post = await publishRandomPost({ subplebbitAddress: sub.address, plebbit: customPlebbit });
        await waitTillPostInSubplebbitPages(post as Required<Pick<Comment, "cid" | "subplebbitAddress">>, customPlebbit);
        await sub.stop();
        await customPlebbit.destroy();
    });

    it(`subplebbit.edit() changes persist through IPNS publish cycles`, async () => {
        const sub = await createSubWithNoChallenge({}, plebbit);
        const localSub = sub as LocalSubplebbit;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        // Access the kubo client to mock name.publish
        const kuboClient = localSub._clientsManager.getDefaultKuboRpcClient();
        const originalPublish = kuboClient._client.name.publish.bind(kuboClient._client.name);

        let publishStartedResolve: () => void;
        const publishStartedPromise = new Promise<void>((resolve) => {
            publishStartedResolve = resolve;
        });
        let firstCall = true;

        // Mock name.publish to signal when it starts and add delay.
        // This creates a guaranteed window for edit() to run during the IPNS publish.
        kuboClient._client.name.publish = (async (cid: any, options: any) => {
            if (firstCall) {
                firstCall = false;
                publishStartedResolve();
                // Delay so edit() executes during the publish
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return originalPublish(cid, options);
        }) as typeof kuboClient._client.name.publish;

        // Edit #1: triggers a new publish cycle
        await sub.edit({ title: "trigger publish " + Date.now() });

        // Wait for name.publish to be called.
        // At this point, lines 688-696 have already captured _pendingEditProps
        // (which only contains edit #1), and the IPNS record was constructed WITHOUT features.
        await publishStartedPromise;

        // Edit #2: happens DURING the IPNS publish (after state was captured)
        await sub.edit({ features: { authorFlairs: true } });
        expect(sub.features?.authorFlairs).to.be.true;

        // Wait for the publish cycle to complete
        await new Promise((resolve) => sub.once("update", resolve));

        // Without the fix, initSubplebbitIpfsPropsNoMerge overwrites this.features
        // with the stale IPNS record (which was constructed before edit #2)
        expect(sub.features?.authorFlairs).to.be.true;

        // Restore original and cleanup
        kuboClient._client.name.publish = originalPublish;
        await sub.delete();
    });
});

describe(`Edit misc`, async () => {
    it(`Can edit subplebbit.address to a new domain even if subplebbit-address text record does not exist`, async () => {
        const customPlebbit = await mockPlebbitV2({ stubStorage: false, mockResolve: true });
        const newSub = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        if (!customPlebbit._plebbitRpcClient) {
            const resolvedSubAddress = await customPlebbit._clientsManager.resolveCommunityNameIfNeeded("no-sub-address.bso");
            expect(resolvedSubAddress).to.equal(null);
        }

        // Has no subplebbit-address text record
        await newSub.edit({ address: "no-sub-address.bso" });

        expect(newSub.address).to.equal("no-sub-address.bso");
        await newSub.delete();
        await customPlebbit.destroy();
    });

    it(`Can edit subplebbit.address to a new domain even if subplebbit-address text record does not match subplebbit.signer.address`, async () => {
        const customPlebbit = await mockPlebbit();
        const subAddress = "different-signer.bso";
        if (customPlebbit.subplebbits.includes(subAddress)) {
            const sub = (await customPlebbit.createSubplebbit({ address: subAddress })) as LocalSubplebbit | RpcLocalSubplebbit;
            await sub.delete();
            await new Promise((resolve) => customPlebbit.once("subplebbitschange", resolve));
        }
        const newSub = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;

        // Should not match signer.address
        await newSub.edit({ address: subAddress });
        expect(newSub.address).to.equal(subAddress);
        await newSub.delete();
        await customPlebbit.destroy();
    });

    it(`subplebbit.edit({address}) fails if the new address is already taken by another subplebbit`, async () => {
        const customPlebbit = await mockPlebbit();
        const newSub = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        const bsoNameAddress = `subplebbit-address-${uuidV4()}.bso`;
        await newSub.edit({ address: bsoNameAddress });

        const anotherSub = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        try {
            await anotherSub.edit({ address: newSub.address });
            expect.fail("Should fail");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_SUB_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS");
        }
        await customPlebbit.destroy();
    });
});

describe(`Editing subplebbit.roles`, async () => {
    let plebbit: PlebbitType;
    let sub: LocalSubplebbit | RpcLocalSubplebbit;
    let remotePlebbit: PlebbitType;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        sub = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => Boolean(sub.updatedAt) });
    });

    afterAll(async () => {
        await sub.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Setting sub.roles[author-address] to undefined removes the role`, async () => {
        const signer1 = await plebbit.createSigner();
        const signer2 = await plebbit.createSigner();
        const authorAddress = signer1.address;
        const secondAuthorAddress = signer2.address;
        await sub.edit({ roles: { [authorAddress]: { role: "admin" }, [secondAuthorAddress]: { role: "moderator" } } });

        expect(sub.roles![authorAddress].role).to.equal("admin");
        expect(sub.roles![secondAuthorAddress].role).to.equal("moderator");

        await new Promise((resolve) => sub.once("update", resolve));

        let remoteSub = (await remotePlebbit.getSubplebbit({ address: sub.address })) as RemoteSubplebbit;
        expect(remoteSub.roles![authorAddress].role).to.equal("admin");
        expect(remoteSub.roles![secondAuthorAddress].role).to.equal("moderator");

        await sub.edit({ roles: { [authorAddress]: undefined, [secondAuthorAddress]: { role: "moderator" } } });
        expect(sub.roles![authorAddress]).to.be.undefined;
        expect(sub.roles![secondAuthorAddress].role).to.equal("moderator");

        await new Promise((resolve) => sub.once("update", resolve));

        remoteSub = (await remotePlebbit.getSubplebbit({ address: sub.address })) as RemoteSubplebbit;
        expect(remoteSub.roles![authorAddress]).to.be.undefined;
        expect(remoteSub.roles![secondAuthorAddress].role).to.equal("moderator");

        // Now set the other author role to null, this should set subplebbit.roles to undefined
        await sub.edit({ roles: { [authorAddress]: undefined, [secondAuthorAddress]: undefined } });
        expect(sub.roles).to.deep.equal({}); // {} after edit, but will be undefined after publishing because we remove any empty objects {} before publishing to IPFS

        await new Promise((resolve) => sub.once("update", resolve));
        expect(sub.roles).to.be.undefined;

        remoteSub = (await remotePlebbit.getSubplebbit({ address: sub.address })) as RemoteSubplebbit;
        expect(remoteSub.roles).to.be.undefined;
    });

    it(`Editing roles with an unresolvable domain throws ERR_ROLE_ADDRESS_DOMAIN_COULD_NOT_BE_RESOLVED`, async () => {
        // "nonexistent.bso" doesn't resolve in the mock resolver
        await expect(sub.edit({ roles: { "nonexistent.bso": { role: "moderator" } } })).rejects.toMatchObject({
            code: "ERR_ROLE_ADDRESS_DOMAIN_COULD_NOT_BE_RESOLVED"
        });
    });

    it(`Removing an unresolvable domain role (setting to undefined) does NOT throw`, async () => {
        // Removing a role should skip resolution
        await sub.edit({ roles: { "nonexistent.bso": undefined } });
    });

    it(`Editing roles with a resolvable domain succeeds`, async () => {
        // "plebbit.eth" resolves plebbit-author-address in the mock resolver
        await sub.edit({ roles: { "plebbit.eth": { role: "moderator" } } });
        expect(sub.roles!["plebbit.eth"].role).to.equal("moderator");
        // Clean up
        await sub.edit({ roles: { "plebbit.eth": undefined } });
    });

    it.skip(`Setting sub.roles.[author-address.bso].role to null doesn't corrupt the signature`, async () => {
        // This test is not needed anymore because zod will catch it
        const newSub = await createSubWithNoChallenge({}, plebbit);
        await newSub.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSub, predicate: async () => Boolean(newSub.updatedAt) }); // wait until it publishes an ipns record
        await remotePlebbit.getSubplebbit({ address: newSub.address }); // no problem with signature

        const newRoles: Record<string, { role: string | null }> = {
            "author-address.bso": { role: null },
            "author-address2.bso": { role: "admin" }
        };
        await newSub.edit({ roles: newRoles as { [key: string]: { role: string } } });
        expect(newSub.roles).to.deep.equal({ "author-address2.bso": { role: "admin" } });

        await new Promise((resolve) => newSub.once("update", resolve));
        expect(newSub.roles).to.deep.equal({ "author-address2.bso": { role: "admin" } });

        const remoteSub = (await remotePlebbit.getSubplebbit({ address: newSub.address })) as RemoteSubplebbit;
        expect(remoteSub.roles).to.deep.equal({ "author-address2.bso": { role: "admin" } });

        await newSub.delete();
    });
});

// TODO change this testing to be about capturing the edit args sent to RPC server
describeIfRpc(`subplebbit.edit (RPC)`, async () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        const signer = await plebbit.createSigner();
        subplebbit = (await plebbit.createSubplebbit({ signer })) as LocalSubplebbit | RpcLocalSubplebbit;
        expect(subplebbit.address).to.equal(signer.address);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });
    [
        { title: `Test subplebbit RPC title edit ${Date.now()}` },
        { description: `Test subplebbit RPC description edit ${Date.now()}` },
        { address: `rpc-edit-test.bso` }
    ].map((editArgs) =>
        it(`subplebbit.edit(${JSON.stringify(editArgs)})`, async () => {
            const [keyToEdit, newValue] = Object.entries(editArgs)[0] as [keyof typeof editArgs, string];
            await subplebbit.edit(editArgs);
            expect(subplebbit[keyToEdit]).to.equal(newValue);
            await new Promise((resolve) => subplebbit.once("update", resolve));
            const remotePlebbitInstance = await mockPlebbitNoDataPathWithOnlyKuboClient(); // This plebbit instance won't use RPC
            const loadedSubplebbit = (await remotePlebbitInstance.createSubplebbit({ address: subplebbit.address })) as
                | LocalSubplebbit
                | RpcLocalSubplebbit;
            await loadedSubplebbit.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedSubplebbit,
                predicate: async () => loadedSubplebbit[keyToEdit] === newValue
            });
            expect(loadedSubplebbit[keyToEdit]).to.equal(newValue);
            await loadedSubplebbit.stop();
            await remotePlebbitInstance.destroy();
        })
    );
});

describeSkipIfRpc(`.eth <-> .bso alias address transitions`, async () => {
    let plebbit: PlebbitType;
    let remotePlebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let ethNameAddress: string;
    let bsoNameAddress: string;
    let postPublishedOnEth: Comment;
    let plebbitResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        plebbitResolverRecords = new Map();
        remoteResolverRecords = new Map();
        plebbit = await mockPlebbitV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
        remotePlebbit = await mockPlebbitV2({
            stubStorage: false,
            remotePlebbit: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });

        subplebbit = await createSubWithNoChallenge({}, plebbit);
        const domainBase = `test-alias-${uuidV4()}`;
        ethNameAddress = `${domainBase}.eth`;
        bsoNameAddress = `${domainBase}.bso`;

        // Mock both .eth and .bso domains to resolve to the same signer address
        for (const domain of [ethNameAddress, bsoNameAddress]) {
            plebbitResolverRecords.set(domain, subplebbit.signer.address);
            remoteResolverRecords.set(domain, subplebbit.signer.address);
        }

        // First, edit to .eth domain
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        await subplebbit.edit({ address: ethNameAddress });
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(ethNameAddress);

        // Publish a post under the .eth address
        postPublishedOnEth = await publishRandomPost({ subplebbitAddress: ethNameAddress, plebbit: plebbit });
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });
        expect(subplebbit.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    afterAll(async () => {
        await subplebbit.stop();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Posts are preserved after editing address from .eth to .bso`, async () => {
        // Edit from .eth to .bso (equivalent alias)
        await subplebbit.edit({ address: bsoNameAddress });
        expect(subplebbit.address).to.equal(bsoNameAddress);
        await new Promise((resolve) => subplebbit.once("update", resolve));

        // Wait for pages to be regenerated with the post still included
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });
        expect(subplebbit.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    it(`Remote loading of .bso sub also has the post published under .eth`, async () => {
        const loadedSub = (await remotePlebbit.getSubplebbit({ address: bsoNameAddress })) as RemoteSubplebbit;
        expect(loadedSub.address).to.equal(bsoNameAddress);
        expect(loadedSub.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    it(`Can load a local subplebbit by .eth alias when address is .bso`, async () => {
        // The sub's current address is bsoNameAddress, but loading with ethNameAddress should still find the local sub
        const loadedSub = await plebbit.createSubplebbit({ address: ethNameAddress });
        expect(loadedSub.address).to.equal(bsoNameAddress);
        expect((loadedSub as LocalSubplebbit).signer).to.not.be.undefined;
    });

    it(`Can load a local subplebbit by .bso alias when address is .eth`, async () => {
        // Create a separate non-started sub with .eth address and load it with .bso
        const customPlebbit = await mockPlebbit();
        const sub = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        const domain = `load-alias-${uuidV4()}`;
        await sub.edit({ address: `${domain}.eth` });
        expect(sub.address).to.equal(`${domain}.eth`);

        // Load with .bso — should find the local sub
        const loadedSub = await customPlebbit.createSubplebbit({ address: `${domain}.bso` });
        expect(loadedSub.address).to.equal(`${domain}.eth`);
        expect((loadedSub as LocalSubplebbit).signer).to.not.be.undefined;
        await customPlebbit.destroy();
    });

    it(`subplebbit.edit({address}) fails if the .eth/.bso equivalent is already taken by another subplebbit`, async () => {
        const customPlebbit = await mockPlebbit();
        const sub1 = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        const domain = `address-equiv-${uuidV4()}`;
        await sub1.edit({ address: `${domain}.eth` });

        const sub2 = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        try {
            // Trying to claim the .bso alias of a domain already taken by another sub
            await sub2.edit({ address: `${domain}.bso` });
            expect.fail("Should fail");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_SUB_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS");
        }
        await customPlebbit.destroy();
    });

    it(`Same sub can transition between .eth and .bso aliases`, async () => {
        const customPlebbit = await mockPlebbit();
        const sub = (await customPlebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        const domain = `self-alias-${uuidV4()}`;
        await sub.edit({ address: `${domain}.eth` });
        expect(sub.address).to.equal(`${domain}.eth`);

        // Should NOT throw — it's the same sub changing its own alias
        await sub.edit({ address: `${domain}.bso` });
        expect(sub.address).to.equal(`${domain}.bso`);
        await customPlebbit.destroy();
    });
});
