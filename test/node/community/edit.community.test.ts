import { beforeAll, afterAll, describe, it, beforeEach } from "vitest";
import {
    createMockNameResolver,
    publishRandomPost,
    mockPKC,
    createSubWithNoChallenge,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    describeIfRpc,
    waitTillPostInCommunityPages,
    mockPKCV2
} from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import fs from "fs";
import path from "path";
import * as remeda from "remeda";

import { v4 as uuidV4 } from "uuid";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommunityEditOptions } from "../../../dist/node/community/types.js";

describeSkipIfRpc(`subplebbit.edit`, async () => {
    let plebbit: PKCType;
    let remotePKC: PKCType;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let postToPublishAfterEdit: Comment;
    let bsoNameAddress: string;
    let plebbitResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;
    beforeAll(async () => {
        plebbitResolverRecords = new Map();
        remoteResolverRecords = new Map();
        plebbit = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });

        subplebbit = await createSubWithNoChallenge({}, plebbit);
        bsoNameAddress = `test-edit-${uuidV4()}.bso`;

        plebbitResolverRecords.set(bsoNameAddress, subplebbit.signer.address);
        remoteResolverRecords.set(bsoNameAddress, subplebbit.signer.address);

        const resolvedSubAddress = await remotePKC._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: bsoNameAddress });
        expect(resolvedSubAddress).to.equal(subplebbit.signer.address);

        await plebbit.resolveAuthorName({ address: "esteban.bso" });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
    });
    afterAll(async () => {
        await subplebbit.stop();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    [{ title: `Test subplebbit title edit ${Date.now()}` }, { description: `Test subplebbit description edit ${Date.now()}` }].map(
        (editArgs) =>
            it(`subplebbit.edit(${JSON.stringify(editArgs)})`, async () => {
                const [keyToEdit, newValue] = Object.entries(editArgs)[0] as [keyof typeof editArgs, string];
                await subplebbit.edit(editArgs);
                expect(subplebbit[keyToEdit]).to.equal(newValue);
                const updatingRemoteCommunity = (await remotePKC.getCommunity({
                    address: subplebbit.address
                })) as RemoteCommunity;
                await updatingRemoteCommunity.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: updatingRemoteCommunity,
                    predicate: async () => updatingRemoteCommunity[keyToEdit] === newValue
                });
                await updatingRemoteCommunity.stop();
                expect(updatingRemoteCommunity[keyToEdit]).to.equal(newValue);
                expect(updatingRemoteCommunity.raw.subplebbitIpfs).to.deep.equal(subplebbit.raw.subplebbitIpfs);
            })
    );

    it(`An update is triggered after calling subplebbit.edit()`, async () => {
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        await sub.edit({ features: { requirePostLink: true } });
        expect(sub.features!.requirePostLink).to.be.true;
        // Access private property via casting
        expect((sub as LocalCommunity)["_subplebbitUpdateTrigger"]).to.be.true;
        await new Promise((resolve) => sub.once("update", resolve)); // the edit should trigger an update immedietely
        expect((sub as LocalCommunity)["_subplebbitUpdateTrigger"]).to.be.false;
        expect(sub.features!.requirePostLink).to.be.true;

        await sub.delete();
    });
    it(`Sub is locked for start`, async () => {
        // Check for locks
        const localSub = subplebbit as LocalCommunity;
        expect(await localSub._dbHandler.isSubStartLocked(subplebbit.signer.address)).to.be.true;
    });

    it(`Can edit a subplebbit to have ENS domain as address`, async () => {
        expect(subplebbit.posts.pages).to.not.deep.equal({});
        await subplebbit.edit({ address: bsoNameAddress });
        expect(subplebbit.address).to.equal(bsoNameAddress);
        expect(subplebbit.name).to.equal(bsoNameAddress);
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(bsoNameAddress);
        expect(subplebbit.name).to.equal(bsoNameAddress);
    });

    it(`Wire format includes name after editing address to domain`, async () => {
        expect(subplebbit.raw.subplebbitIpfs?.name).to.equal(bsoNameAddress);
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
        const loadedCommunity = (await remotePKC.getCommunity({ address: bsoNameAddress })) as RemoteCommunity;
        expect(loadedCommunity.address).to.equal(bsoNameAddress);
        expect(loadedCommunity.raw.subplebbitIpfs).to.deep.equal(subplebbit.raw.subplebbitIpfs);
    });

    it(`remote subplebbit.posts is reset after changing address`, async () => {
        const loadedCommunity = (await plebbit.getCommunity({ address: bsoNameAddress })) as RemoteCommunity;
        // subplebbit.posts should omit all comments that referenced the old subplebbit address
        // So in essence it be undefined
        expect(loadedCommunity.posts.pages).to.deep.equal({});
        expect(loadedCommunity.posts.pageCids).to.deep.equal({});
    });

    it(`Started Sub can receive publications on new ENS address`, async () => {
        postToPublishAfterEdit = await publishRandomPost({ communityAddress: bsoNameAddress, plebbit: plebbit });
    });

    it(`Posts submitted to new sub address are shown in subplebbit.posts`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postToPublishAfterEdit.cid))
        });
        expect(Object.keys(subplebbit.posts.pageCids).sort()).to.deep.equal([]); // empty array because it's a single preloaded page
    });

    it(`calling subplebbit.edit() should not add subplebbit to plebbit._updatingCommunitys or plebbit._startedCommunitys`, async () => {
        const plebbitInstance = await mockPKC();
        const sub = (await plebbitInstance.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        expect(plebbitInstance._updatingCommunitys[sub.address]).to.be.undefined;
        expect(plebbitInstance._startedCommunitys[sub.address]).to.be.undefined;
        await sub.edit({ address: "123" + bsoNameAddress });
        expect(plebbitInstance._updatingCommunitys[sub.address]).to.be.undefined;
        expect(plebbitInstance._startedCommunitys[sub.address]).to.be.undefined;

        await plebbitInstance.destroy();
    });
});

describeSkipIfRpc(`subplebbit.edit .eth -> .bso transition`, async () => {
    let plebbit: PKCType;
    let remotePKC: PKCType;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let ethAddress: string;
    let bsoAddress: string;
    let postPublishedOnBso: Comment;
    let plebbitResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        plebbitResolverRecords = new Map();
        remoteResolverRecords = new Map();
        plebbit = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
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

        expect(await remotePKC._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: ethAddress })).to.equal(
            subplebbit.signer.address
        );
        expect(await remotePKC._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: bsoAddress })).to.equal(
            subplebbit.signer.address
        );

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        const publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit }); // ensure posts are non-empty before edits
        await waitTillPostInCommunityPages(publishedPost as Comment & { cid: string }, plebbit);
    });

    afterAll(async () => {
        await subplebbit.stop();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it(`started sub can transition from .eth to .bso with update events`, async () => {
        expect(subplebbit.posts.pages).to.not.deep.equal({});

        await subplebbit.edit({ address: ethAddress });
        expect(subplebbit.address).to.equal(ethAddress);
        await new Promise((resolve) => subplebbit.once("update", resolve));
        expect(subplebbit.address).to.equal(ethAddress);

        const postPublishedOnEth = await publishRandomPost({ communityAddress: ethAddress, plebbit: plebbit });
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
        postPublishedOnBso = await publishRandomPost({ communityAddress: bsoAddress, plebbit: plebbit });

        await resolveWhenConditionIsTrue({
            toUpdate: subplebbit,
            predicate: async () =>
                Boolean(subplebbit?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnBso.cid))
        });
    });
});

describeSkipIfRpc(`Concurrency with subplebbit.edit`, async () => {
    let plebbit: PKCType;
    let plebbitResolverRecords: Map<string, string | undefined>;
    beforeEach(async () => {
        if (plebbit) await plebbit.destroy();
        plebbitResolverRecords = new Map();
        plebbit = await mockPKCV2({
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
        const subTwo = (await plebbit.createCommunity({ address: subOne.address })) as LocalCommunity | RpcLocalCommunity;
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
        ] as CommunityEditOptions[]
    ).map((editArgs) =>
        it(`Calling startedCommunity.stop() after edit while updating another subplebbit should not reset the edit (${Object.keys(editArgs)})`, async () => {
            const startedSub = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
            const editKeys = Object.keys(editArgs) as (keyof CommunityEditOptions)[];

            const hasLatestEditProps = (sub: LocalCommunity | RpcLocalCommunity): boolean => {
                const picked = remeda.pick(sub, editKeys);
                return remeda.isDeepEqual(picked, editArgs as typeof picked);
            };

            const expectSubToHaveLatestEditProps = (sub: LocalCommunity | RpcLocalCommunity) => {
                expect(remeda.pick(sub, editKeys)).to.deep.equal(editArgs);
            };

            const updatingCommunity = (await plebbit.createCommunity({ address: startedSub.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            await updatingCommunity.update();

            await startedSub.start();

            const subToEdit = (await plebbit.createCommunity({ address: startedSub.address })) as LocalCommunity | RpcLocalCommunity;
            await subToEdit.edit(editArgs);
            expectSubToHaveLatestEditProps(subToEdit);
            expectSubToHaveLatestEditProps(startedSub);

            await resolveWhenConditionIsTrue({
                toUpdate: updatingCommunity,
                predicate: async () => hasLatestEditProps(updatingCommunity)
            });
            expectSubToHaveLatestEditProps(startedSub);
            expectSubToHaveLatestEditProps(subToEdit);
            expectSubToHaveLatestEditProps(updatingCommunity);

            await startedSub.stop();
            expectSubToHaveLatestEditProps(startedSub);
            expectSubToHaveLatestEditProps(updatingCommunity);
            expectSubToHaveLatestEditProps(subToEdit);

            await updatingCommunity.stop();
            expectSubToHaveLatestEditProps(startedSub);
            expectSubToHaveLatestEditProps(updatingCommunity);
            expectSubToHaveLatestEditProps(subToEdit);
        })
    );

    (
        [
            { address: `address-bso-${uuidV4()}-1.bso` },
            { rules: ["rule 1", "rule 2"] },
            { address: `address-bso-${uuidV4()}-2.bso`, rules: ["rule 1", "rule 2"] }
        ] as CommunityEditOptions[]
    ).map((editArgs) =>
        it(`edit subplebbit with multiple subplebbit instances running (${Object.keys(editArgs)})`, async () => {
            // TODO investigate why this test gets slower the more times it's run
            const subplebbitTitle = "subplebbit title" + timestamp();
            const subplebbitInstance = (await plebbit.createCommunity({ title: subplebbitTitle })) as LocalCommunity | RpcLocalCommunity;
            const editKeys = Object.keys(editArgs) as (keyof CommunityEditOptions)[];
            if (editArgs.address) {
                plebbitResolverRecords.set(editArgs.address, subplebbitInstance.signer.address);
                plebbit._storage.removeItem = () => Promise.resolve(false); // stop clearing cache when editing subplebbit address

                const resolvedSubAddress = await plebbit._clientsManager.resolveCommunityNameIfNeeded({
                    communityAddress: editArgs.address
                });
                expect(resolvedSubAddress).to.equal(subplebbitInstance.signer.address);
            }

            let editIsFinished: boolean;

            // subplebbit is updating
            const updatingCommunity = (await plebbit.createCommunity({ address: subplebbitInstance.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            updatingCommunity.on("update", () => {
                const picked = remeda.pick(updatingCommunity, editKeys);
                if (remeda.isDeepEqual(picked, editArgs as typeof picked)) editIsFinished = true; // there's a case where the edit is finished and update is emitted before we get to update editIsFinished
            });

            expect(updatingCommunity.signer).to.be.a("object");
            expect(updatingCommunity.title).to.equal(subplebbitTitle);
            await updatingCommunity.update();

            // start subplebbit
            const startedCommunity = (await plebbit.createCommunity({ address: subplebbitInstance.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            await startedCommunity.start();

            startedCommunity.on("update", () => {
                const picked = remeda.pick(startedCommunity, editKeys);
                if (remeda.isDeepEqual(picked, editArgs as typeof picked)) editIsFinished = true; // there's a case where the edit is finished and update is emitted before we get to update editIsFinished
            });

            expect(startedCommunity.title).to.equal(subplebbitTitle);

            const updateEventPromise = new Promise((resolve) =>
                updatingCommunity.on("update", (updatedCommunity) => editIsFinished && resolve(updatedCommunity))
            );

            updatingCommunity.on("update", (updatedCommunity) => {
                console.log("updatingCommunity update", updatedCommunity.rules);
            });

            const updateStartedSubEventPromise = new Promise((resolve) =>
                startedCommunity.on("update", (updatedCommunity) => editIsFinished && resolve(updatedCommunity))
            );

            // edit subplebbit
            console.log("editCommunity");
            const editedCommunity = (await plebbit.createCommunity({ address: subplebbitInstance.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            await editedCommunity.edit(editArgs); // it should be sent to the started subplebbit
            expect(remeda.pick(editedCommunity, editKeys)).to.deep.equal(editArgs);
            expect(remeda.pick(startedCommunity, editKeys)).to.deep.equal(editArgs);

            editIsFinished = true;
            expect(editedCommunity.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(editedCommunity[editKey as keyof CommunityEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );

            // wait for subplebbit update
            // both started and updating subplebbit should now have the subplebbit edit
            console.log("wait for subplebbit update");
            await updateEventPromise;

            expect(remeda.pick(editedCommunity, editKeys)).to.deep.equal(editArgs);
            expect(remeda.pick(startedCommunity, editKeys)).to.deep.equal(editArgs); // this fails

            expect(updatingCommunity.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(updatingCommunity[editKey as keyof CommunityEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );

            await updatingCommunity.stop();

            console.log("Before await updateStartedSubEventPromise");
            await updateStartedSubEventPromise;

            expect(startedCommunity.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs)) {
                if (deterministicStringify(startedCommunity[editKey as keyof CommunityEditOptions]) !== deterministicStringify(editValue))
                    await new Promise((resolve) => startedCommunity.once("update", resolve)); // Wait until the new props are included in the next update
                expect(deterministicStringify(startedCommunity[editKey as keyof CommunityEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );
            }

            expect(remeda.pick(startedCommunity, editKeys)).to.deep.equal(editArgs);
            await startedCommunity.stop();
            expect(remeda.pick(startedCommunity, editKeys)).to.deep.equal(editArgs);

            expect(subplebbitInstance.rules).to.equal(undefined); // subplebbit is not updating, started or editing so it has no way to get the rules

            const newlyCreatedCommunity = (await plebbit.createCommunity({ address: startedCommunity.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            expect(newlyCreatedCommunity.title).to.equal(subplebbitTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(newlyCreatedCommunity[editKey as keyof CommunityEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );
        })
    );

    it(`Can edit a local sub address, then start it`, async () => {
        const customResolverRecords = new Map<string, string | undefined>();
        const customPKC = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: customResolverRecords })]
            }
        });
        const signer = await customPKC.createSigner();
        const domain = `edit-before-start-${uuidV4()}.bso`;

        customResolverRecords.set(domain, signer.address);

        const sub = await createSubWithNoChallenge({ signer }, customPKC);
        await sub.edit({ address: domain });
        // Check for locks
        const localSub = sub as LocalCommunity;
        expect(await localSub._dbHandler.isSubStartLocked(sub.signer.address)).to.be.false;
        expect(await localSub._dbHandler.isSubStartLocked(domain)).to.be.false;

        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        expect(sub.address).to.equal(domain);
        // Check for locks
        expect(await localSub._dbHandler.isSubStartLocked(sub.signer.address)).to.be.false;
        expect(await localSub._dbHandler.isSubStartLocked(domain)).to.be.true;

        const post = await publishRandomPost({ communityAddress: sub.address, plebbit: customPKC });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, customPKC);
        await sub.stop();
        await customPKC.destroy();
    });

    it(`subplebbit.edit() changes persist through IPNS publish cycles`, async () => {
        const sub = await createSubWithNoChallenge({}, plebbit);
        const localSub = sub as LocalCommunity;
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

        // Without the fix, initCommunityIpfsPropsNoMerge overwrites this.features
        // with the stale IPNS record (which was constructed before edit #2)
        expect(sub.features?.authorFlairs).to.be.true;

        // Restore original and cleanup
        kuboClient._client.name.publish = originalPublish;
        await sub.delete();
    });
});

describe(`Edit misc`, async () => {
    it(`Can edit subplebbit.address to a new domain even if subplebbit-address text record does not exist`, async () => {
        const customPKC = await mockPKCV2({ stubStorage: false, mockResolve: true });
        const newSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        if (!customPKC._plebbitRpcClient) {
            const resolvedSubAddress = await customPKC._clientsManager.resolveCommunityNameIfNeeded({
                communityAddress: "no-sub-address.bso"
            });
            expect(resolvedSubAddress).to.equal(null);
        }

        // Has no subplebbit-address text record
        await newSub.edit({ address: "no-sub-address.bso" });

        expect(newSub.address).to.equal("no-sub-address.bso");
        await newSub.delete();
        await customPKC.destroy();
    });

    it(`Can edit subplebbit.address to a new domain even if subplebbit-address text record does not match subplebbit.signer.address`, async () => {
        const customPKC = await mockPKC();
        const subAddress = "different-signer.bso";
        if (customPKC.subplebbits.includes(subAddress)) {
            const sub = (await customPKC.createCommunity({ address: subAddress })) as LocalCommunity | RpcLocalCommunity;
            await sub.delete();
            await new Promise((resolve) => customPKC.once("subplebbitschange", resolve));
        }
        const newSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;

        // Should not match signer.address
        await newSub.edit({ address: subAddress });
        expect(newSub.address).to.equal(subAddress);
        await newSub.delete();
        await customPKC.destroy();
    });

    it(`subplebbit.edit({address}) fails if the new address is already taken by another subplebbit`, async () => {
        const customPKC = await mockPKC();
        const newSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const bsoNameAddress = `subplebbit-address-${uuidV4()}.bso`;
        await newSub.edit({ address: bsoNameAddress });

        const anotherSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        try {
            await anotherSub.edit({ address: newSub.address });
            expect.fail("Should fail");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS");
        }
        await customPKC.destroy();
    });
});

describe(`Editing subplebbit.roles`, async () => {
    let plebbit: PKCType;
    let sub: LocalCommunity | RpcLocalCommunity;
    let remotePKC: PKCType;

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        sub = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => Boolean(sub.updatedAt) });
    });

    afterAll(async () => {
        await sub.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
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

        let remoteSub = (await remotePKC.getCommunity({ address: sub.address })) as RemoteCommunity;
        expect(remoteSub.roles![authorAddress].role).to.equal("admin");
        expect(remoteSub.roles![secondAuthorAddress].role).to.equal("moderator");

        await sub.edit({ roles: { [authorAddress]: undefined, [secondAuthorAddress]: { role: "moderator" } } });
        expect(sub.roles![authorAddress]).to.be.undefined;
        expect(sub.roles![secondAuthorAddress].role).to.equal("moderator");

        await new Promise((resolve) => sub.once("update", resolve));

        remoteSub = (await remotePKC.getCommunity({ address: sub.address })) as RemoteCommunity;
        expect(remoteSub.roles![authorAddress]).to.be.undefined;
        expect(remoteSub.roles![secondAuthorAddress].role).to.equal("moderator");

        // Now set the other author role to null, this should set subplebbit.roles to undefined
        await sub.edit({ roles: { [authorAddress]: undefined, [secondAuthorAddress]: undefined } });
        expect(sub.roles).to.deep.equal({}); // {} after edit, but will be undefined after publishing because we remove any empty objects {} before publishing to IPFS

        await new Promise((resolve) => sub.once("update", resolve));
        expect(sub.roles).to.be.undefined;

        remoteSub = (await remotePKC.getCommunity({ address: sub.address })) as RemoteCommunity;
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
        await remotePKC.getCommunity({ address: newSub.address }); // no problem with signature

        const newRoles: Record<string, { role: string | null }> = {
            "author-address.bso": { role: null },
            "author-address2.bso": { role: "admin" }
        };
        await newSub.edit({ roles: newRoles as { [key: string]: { role: string } } });
        expect(newSub.roles).to.deep.equal({ "author-address2.bso": { role: "admin" } });

        await new Promise((resolve) => newSub.once("update", resolve));
        expect(newSub.roles).to.deep.equal({ "author-address2.bso": { role: "admin" } });

        const remoteSub = (await remotePKC.getCommunity({ address: newSub.address })) as RemoteCommunity;
        expect(remoteSub.roles).to.deep.equal({ "author-address2.bso": { role: "admin" } });

        await newSub.delete();
    });
});

// TODO change this testing to be about capturing the edit args sent to RPC server
describeIfRpc(`subplebbit.edit (RPC)`, async () => {
    let plebbit: PKCType;
    let subplebbit: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        plebbit = await mockPKC();
        const signer = await plebbit.createSigner();
        subplebbit = (await plebbit.createCommunity({ signer })) as LocalCommunity | RpcLocalCommunity;
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
            const remotePKCInstance = await mockPKCNoDataPathWithOnlyKuboClient(); // This plebbit instance won't use RPC
            const loadedCommunity = (await remotePKCInstance.createCommunity({ address: subplebbit.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            await loadedCommunity.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loadedCommunity,
                predicate: async () => loadedCommunity[keyToEdit] === newValue
            });
            expect(loadedCommunity[keyToEdit]).to.equal(newValue);
            await loadedCommunity.stop();
            await remotePKCInstance.destroy();
        })
    );
});

describeSkipIfRpc(`.eth <-> .bso alias address transitions`, async () => {
    let plebbit: PKCType;
    let remotePKC: PKCType;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let ethNameAddress: string;
    let bsoNameAddress: string;
    let postPublishedOnEth: Comment;
    let plebbitResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        plebbitResolverRecords = new Map();
        remoteResolverRecords = new Map();
        plebbit = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            plebbitOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: plebbitResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
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
        postPublishedOnEth = await publishRandomPost({ communityAddress: ethNameAddress, plebbit: plebbit });
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
        await remotePKC.destroy();
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
        const loadedSub = (await remotePKC.getCommunity({ address: bsoNameAddress })) as RemoteCommunity;
        expect(loadedSub.address).to.equal(bsoNameAddress);
        expect(loadedSub.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    it(`Can load a local subplebbit by .eth alias when address is .bso`, async () => {
        // The sub's current address is bsoNameAddress, but loading with ethNameAddress should still find the local sub
        const loadedSub = await plebbit.createCommunity({ address: ethNameAddress });
        expect(loadedSub.address).to.equal(bsoNameAddress);
        expect((loadedSub as LocalCommunity).signer).to.not.be.undefined;
    });

    it(`Can load a local subplebbit by .bso alias when address is .eth`, async () => {
        // Create a separate non-started sub with .eth address and load it with .bso
        const customPKC = await mockPKC();
        const sub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const domain = `load-alias-${uuidV4()}`;
        await sub.edit({ address: `${domain}.eth` });
        expect(sub.address).to.equal(`${domain}.eth`);

        // Load with .bso — should find the local sub
        const loadedSub = await customPKC.createCommunity({ address: `${domain}.bso` });
        expect(loadedSub.address).to.equal(`${domain}.eth`);
        expect((loadedSub as LocalCommunity).signer).to.not.be.undefined;
        await customPKC.destroy();
    });

    it(`subplebbit.edit({address}) fails if the .eth/.bso equivalent is already taken by another subplebbit`, async () => {
        const customPKC = await mockPKC();
        const sub1 = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const domain = `address-equiv-${uuidV4()}`;
        await sub1.edit({ address: `${domain}.eth` });

        const sub2 = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        try {
            // Trying to claim the .bso alias of a domain already taken by another sub
            await sub2.edit({ address: `${domain}.bso` });
            expect.fail("Should fail");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS");
        }
        await customPKC.destroy();
    });

    it(`Same sub can transition between .eth and .bso aliases`, async () => {
        const customPKC = await mockPKC();
        const sub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const domain = `self-alias-${uuidV4()}`;
        await sub.edit({ address: `${domain}.eth` });
        expect(sub.address).to.equal(`${domain}.eth`);

        // Should NOT throw — it's the same sub changing its own alias
        await sub.edit({ address: `${domain}.bso` });
        expect(sub.address).to.equal(`${domain}.bso`);
        await customPKC.destroy();
    });
});
