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

describeSkipIfRpc(`community.edit`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let postToPublishAfterEdit: Comment;
    let bsoNameAddress: string;
    let pkcResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;
    beforeAll(async () => {
        pkcResolverRecords = new Map();
        remoteResolverRecords = new Map();
        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: pkcResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });

        community = await createSubWithNoChallenge({}, pkc);
        bsoNameAddress = `test-edit-${uuidV4()}.bso`;

        pkcResolverRecords.set(bsoNameAddress, community.signer.address);
        remoteResolverRecords.set(bsoNameAddress, community.signer.address);

        const resolvedSubAddress = await remotePKC._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: bsoNameAddress });
        expect(resolvedSubAddress).to.equal(community.signer.address);

        await pkc.resolveAuthorName({ address: "esteban.bso" });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
    });
    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    [{ title: `Test community title edit ${Date.now()}` }, { description: `Test community description edit ${Date.now()}` }].map(
        (editArgs) =>
            it(`community.edit(${JSON.stringify(editArgs)})`, async () => {
                const [keyToEdit, newValue] = Object.entries(editArgs)[0] as [keyof typeof editArgs, string];
                await community.edit(editArgs);
                expect(community[keyToEdit]).to.equal(newValue);
                const updatingRemoteCommunity = (await remotePKC.getCommunity({
                    address: community.address
                })) as RemoteCommunity;
                await updatingRemoteCommunity.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: updatingRemoteCommunity,
                    predicate: async () => updatingRemoteCommunity[keyToEdit] === newValue
                });
                await updatingRemoteCommunity.stop();
                expect(updatingRemoteCommunity[keyToEdit]).to.equal(newValue);
                expect(updatingRemoteCommunity.raw.communityIpfs).to.deep.equal(community.raw.communityIpfs);
            })
    );

    it(`An update is triggered after calling community.edit()`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });

        await sub.edit({ features: { requirePostLink: true } });
        expect(sub.features!.requirePostLink).to.be.true;
        // Access private property via casting
        expect((sub as LocalCommunity)["_communityUpdateTrigger"]).to.be.true;
        await new Promise((resolve) => sub.once("update", resolve)); // the edit should trigger an update immedietely
        expect((sub as LocalCommunity)["_communityUpdateTrigger"]).to.be.false;
        expect(sub.features!.requirePostLink).to.be.true;

        await sub.delete();
    });
    it(`Sub is locked for start`, async () => {
        // Check for locks
        const localSub = community as LocalCommunity;
        expect(await localSub._dbHandler.isSubStartLocked(community.signer.address)).to.be.true;
    });

    it(`Can edit a community to have ENS domain as address`, async () => {
        expect(community.posts.pages).to.not.deep.equal({});
        await community.edit({ address: bsoNameAddress });
        expect(community.address).to.equal(bsoNameAddress);
        expect(community.name).to.equal(bsoNameAddress);
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.address).to.equal(bsoNameAddress);
        expect(community.name).to.equal(bsoNameAddress);
    });

    it(`Wire format includes name after editing address to domain`, async () => {
        expect(community.raw.communityIpfs?.name).to.equal(bsoNameAddress);
    });

    it(`pkc.communities includes the new ENS address, and not the old address`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: pkc,
            predicate: async () => pkc.communities.includes(bsoNameAddress) && !pkc.communities.includes(community.signer.address),
            eventName: "communitieschange"
        });
        const subs = pkc.communities;
        expect(subs).to.include(bsoNameAddress);
        expect(subs).to.not.include(community.signer.address);
    });

    it(`Local community resets posts after changing address`, async () => {
        expect(community.posts.pages).to.deep.equal({});
        expect(community.posts.pageCids).to.deep.equal({});
    });

    it(`Start locks are moved to the new address`, async () => {
        // Check for locks
        expect(fs.existsSync(path.join(community._pkc.dataPath!, "communities", `${community.signer.address}.start.lock`))).to.be.false;
        expect(fs.existsSync(path.join(community._pkc.dataPath!, "communities", `${bsoNameAddress}.start.lock`))).to.be.true;
    });

    it(`Can load a community with ENS domain as address`, async () => {
        const loadedCommunity = (await remotePKC.getCommunity({ address: bsoNameAddress })) as RemoteCommunity;
        expect(loadedCommunity.address).to.equal(bsoNameAddress);
        expect(loadedCommunity.raw.communityIpfs).to.deep.equal(community.raw.communityIpfs);
    });

    it(`remote community.posts is reset after changing address`, async () => {
        const loadedCommunity = (await pkc.getCommunity({ address: bsoNameAddress })) as RemoteCommunity;
        // community.posts should omit all comments that referenced the old community address
        // So in essence it be undefined
        expect(loadedCommunity.posts.pages).to.deep.equal({});
        expect(loadedCommunity.posts.pageCids).to.deep.equal({});
    });

    it(`Started Sub can receive publications on new ENS address`, async () => {
        postToPublishAfterEdit = await publishRandomPost({ communityAddress: bsoNameAddress, pkc: pkc });
    });

    it(`Posts submitted to new sub address are shown in community.posts`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postToPublishAfterEdit.cid))
        });
        expect(Object.keys(community.posts.pageCids).sort()).to.deep.equal([]); // empty array because it's a single preloaded page
    });

    it(`calling community.edit() should not add community to pkc._updatingCommunities or pkc._startedCommunities`, async () => {
        const pkcInstance = await mockPKC();
        const sub = (await pkcInstance.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        expect(pkcInstance._updatingCommunities[sub.address]).to.be.undefined;
        expect(pkcInstance._startedCommunities[sub.address]).to.be.undefined;
        await sub.edit({ address: "123" + bsoNameAddress });
        expect(pkcInstance._updatingCommunities[sub.address]).to.be.undefined;
        expect(pkcInstance._startedCommunities[sub.address]).to.be.undefined;

        await pkcInstance.destroy();
    });
});

describeSkipIfRpc(`community.edit .eth -> .bso transition`, async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let ethAddress: string;
    let bsoAddress: string;
    let postPublishedOnBso: Comment;
    let pkcResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        pkcResolverRecords = new Map();
        remoteResolverRecords = new Map();
        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: pkcResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });
        community = await createSubWithNoChallenge({}, pkc);

        const domainPrefix = `test-edit-${uuidV4()}`;
        ethAddress = `${domainPrefix}.eth`;
        bsoAddress = `${domainPrefix}.bso`;

        pkcResolverRecords.set(ethAddress, community.signer.address);
        pkcResolverRecords.set(bsoAddress, community.signer.address);
        remoteResolverRecords.set(ethAddress, community.signer.address);
        remoteResolverRecords.set(bsoAddress, community.signer.address);

        expect(await remotePKC._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: ethAddress })).to.equal(
            community.signer.address
        );
        expect(await remotePKC._clientsManager.resolveCommunityNameIfNeeded({ communityAddress: bsoAddress })).to.equal(
            community.signer.address
        );

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: pkc }); // ensure posts are non-empty before edits
        await waitTillPostInCommunityPages(publishedPost as Comment & { cid: string }, pkc);
    });

    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`started sub can transition from .eth to .bso with update events`, async () => {
        expect(community.posts.pages).to.not.deep.equal({});

        await community.edit({ address: ethAddress });
        expect(community.address).to.equal(ethAddress);
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.address).to.equal(ethAddress);

        const postPublishedOnEth = await publishRandomPost({ communityAddress: ethAddress, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });

        await community.edit({ address: bsoAddress });
        expect(community.address).to.equal(bsoAddress);
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.address).to.equal(bsoAddress);
    });

    it(`pkc.communities includes only the final .bso address`, async () => {
        await resolveWhenConditionIsTrue({
            toUpdate: pkc,
            predicate: async () =>
                pkc.communities.includes(bsoAddress) &&
                !pkc.communities.includes(ethAddress) &&
                !pkc.communities.includes(community.signer.address),
            eventName: "communitieschange"
        });

        expect(pkc.communities).to.include(bsoAddress);
        expect(pkc.communities).to.not.include(ethAddress);
        expect(pkc.communities).to.not.include(community.signer.address);
    });

    it(`start locks are moved from signer/.eth to .bso`, async () => {
        const communitiesDir = path.join(community._pkc.dataPath!, "communities");
        expect(fs.existsSync(path.join(communitiesDir, `${community.signer.address}.start.lock`))).to.be.false;
        expect(fs.existsSync(path.join(communitiesDir, `${ethAddress}.start.lock`))).to.be.false;
        expect(fs.existsSync(path.join(communitiesDir, `${bsoAddress}.start.lock`))).to.be.true;
    });

    it(`posts are preserved locally after .eth -> .bso edit (alias transition)`, async () => {
        // .eth and .bso are equivalent aliases, so posts published under .eth should still be visible under .bso
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => Object.keys(community.posts.pages).length > 0
        });
        expect(community.posts.pages).to.not.deep.equal({});
    });

    it(`started sub keeps accepting publications on the new .bso address`, async () => {
        postPublishedOnBso = await publishRandomPost({ communityAddress: bsoAddress, pkc: pkc });

        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnBso.cid))
        });
    });
});

describeSkipIfRpc(`Concurrency with community.edit`, async () => {
    let pkc: PKCType;
    let pkcResolverRecords: Map<string, string | undefined>;
    beforeEach(async () => {
        if (pkc) await pkc.destroy();
        pkcResolverRecords = new Map();
        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: pkcResolverRecords })]
            }
        });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("Two unstarted local sub instances can receive each other updates with community.update and edit", async () => {
        const subOne = await createSubWithNoChallenge({}, pkc);
        // subOne is published now
        const subTwo = (await pkc.createCommunity({ address: subOne.address })) as LocalCommunity | RpcLocalCommunity;
        await subTwo.update();

        const newTitle = "Test new Title" + Date.now();
        await subOne.edit({ title: newTitle });
        expect(subOne.title).to.equal(newTitle);

        await new Promise((resolve) => subTwo.once("update", resolve));

        expect(subTwo.title).to.equal(newTitle);
        expect(subTwo.raw.communityIpfs).to.deep.equal(subOne.raw.communityIpfs);

        await subTwo.stop();
    });

    (
        [
            { address: `address-bso-${uuidV4()}-1.bso` },
            { rules: ["rule 1", "rule 2"] },
            { address: `address-bso-${uuidV4()}-2.bso`, rules: ["rule 1", "rule 2"] }
        ] as CommunityEditOptions[]
    ).map((editArgs) =>
        it(`Calling startedCommunity.stop() after edit while updating another community should not reset the edit (${Object.keys(editArgs)})`, async () => {
            const startedSub = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
            const editKeys = Object.keys(editArgs) as (keyof CommunityEditOptions)[];

            const hasLatestEditProps = (sub: LocalCommunity | RpcLocalCommunity): boolean => {
                const picked = remeda.pick(sub, editKeys);
                return remeda.isDeepEqual(picked, editArgs as typeof picked);
            };

            const expectSubToHaveLatestEditProps = (sub: LocalCommunity | RpcLocalCommunity) => {
                expect(remeda.pick(sub, editKeys)).to.deep.equal(editArgs);
            };

            const updatingCommunity = (await pkc.createCommunity({ address: startedSub.address })) as LocalCommunity | RpcLocalCommunity;
            await updatingCommunity.update();

            await startedSub.start();

            const subToEdit = (await pkc.createCommunity({ address: startedSub.address })) as LocalCommunity | RpcLocalCommunity;
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
        it(`edit community with multiple community instances running (${Object.keys(editArgs)})`, async () => {
            // TODO investigate why this test gets slower the more times it's run
            const communityTitle = "community title" + timestamp();
            const communityInstance = (await pkc.createCommunity({ title: communityTitle })) as LocalCommunity | RpcLocalCommunity;
            const editKeys = Object.keys(editArgs) as (keyof CommunityEditOptions)[];
            if (editArgs.address) {
                pkcResolverRecords.set(editArgs.address, communityInstance.signer.address);
                pkc._storage.removeItem = () => Promise.resolve(false); // stop clearing cache when editing community address

                const resolvedSubAddress = await pkc._clientsManager.resolveCommunityNameIfNeeded({
                    communityAddress: editArgs.address
                });
                expect(resolvedSubAddress).to.equal(communityInstance.signer.address);
            }

            let editIsFinished: boolean;

            // community is updating
            const updatingCommunity = (await pkc.createCommunity({ address: communityInstance.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            updatingCommunity.on("update", () => {
                const picked = remeda.pick(updatingCommunity, editKeys);
                if (remeda.isDeepEqual(picked, editArgs as typeof picked)) editIsFinished = true; // there's a case where the edit is finished and update is emitted before we get to update editIsFinished
            });

            expect(updatingCommunity.signer).to.be.a("object");
            expect(updatingCommunity.title).to.equal(communityTitle);
            await updatingCommunity.update();

            // start community
            const startedCommunity = (await pkc.createCommunity({ address: communityInstance.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            await startedCommunity.start();

            startedCommunity.on("update", () => {
                const picked = remeda.pick(startedCommunity, editKeys);
                if (remeda.isDeepEqual(picked, editArgs as typeof picked)) editIsFinished = true; // there's a case where the edit is finished and update is emitted before we get to update editIsFinished
            });

            expect(startedCommunity.title).to.equal(communityTitle);

            const updateEventPromise = new Promise((resolve) =>
                updatingCommunity.on("update", (updatedCommunity) => editIsFinished && resolve(updatedCommunity))
            );

            updatingCommunity.on("update", (updatedCommunity) => {
                console.log("updatingCommunity update", updatedCommunity.rules);
            });

            const updateStartedSubEventPromise = new Promise((resolve) =>
                startedCommunity.on("update", (updatedCommunity) => editIsFinished && resolve(updatedCommunity))
            );

            // edit community
            console.log("editCommunity");
            const editedCommunity = (await pkc.createCommunity({ address: communityInstance.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            await editedCommunity.edit(editArgs); // it should be sent to the started community
            expect(remeda.pick(editedCommunity, editKeys)).to.deep.equal(editArgs);
            expect(remeda.pick(startedCommunity, editKeys)).to.deep.equal(editArgs);

            editIsFinished = true;
            expect(editedCommunity.title).to.equal(communityTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(editedCommunity[editKey as keyof CommunityEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );

            // wait for community update
            // both started and updating community should now have the community edit
            console.log("wait for community update");
            await updateEventPromise;

            expect(remeda.pick(editedCommunity, editKeys)).to.deep.equal(editArgs);
            expect(remeda.pick(startedCommunity, editKeys)).to.deep.equal(editArgs); // this fails

            expect(updatingCommunity.title).to.equal(communityTitle);
            for (const [editKey, editValue] of Object.entries(editArgs))
                expect(deterministicStringify(updatingCommunity[editKey as keyof CommunityEditOptions])).to.equal(
                    deterministicStringify(editValue)
                );

            await updatingCommunity.stop();

            console.log("Before await updateStartedSubEventPromise");
            await updateStartedSubEventPromise;

            expect(startedCommunity.title).to.equal(communityTitle);
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

            expect(communityInstance.rules).to.equal(undefined); // community is not updating, started or editing so it has no way to get the rules

            const newlyCreatedCommunity = (await pkc.createCommunity({ address: startedCommunity.address })) as
                | LocalCommunity
                | RpcLocalCommunity;
            expect(newlyCreatedCommunity.title).to.equal(communityTitle);
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
            pkcOptions: {
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

        const post = await publishRandomPost({ communityAddress: sub.address, pkc: customPKC });
        await waitTillPostInCommunityPages(post as Comment & { cid: string }, customPKC);
        await sub.stop();
        await customPKC.destroy();
    });

    it(`community.edit() changes persist through IPNS publish cycles`, async () => {
        const sub = await createSubWithNoChallenge({}, pkc);
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
    it(`Can edit community.address to a new domain even if community-address text record does not exist`, async () => {
        const customPKC = await mockPKCV2({ stubStorage: false, mockResolve: true });
        const newSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        if (!customPKC._pkcRpcClient) {
            const resolvedSubAddress = await customPKC._clientsManager.resolveCommunityNameIfNeeded({
                communityAddress: "no-sub-address.bso"
            });
            expect(resolvedSubAddress).to.equal(null);
        }

        // Has no community-address text record
        await newSub.edit({ address: "no-sub-address.bso" });

        expect(newSub.address).to.equal("no-sub-address.bso");
        await newSub.delete();
        await customPKC.destroy();
    });

    it(`Can edit community.address to a new domain even if community-address text record does not match community.signer.address`, async () => {
        const customPKC = await mockPKC();
        const subAddress = "different-signer.bso";
        if (customPKC.communities.includes(subAddress)) {
            const sub = (await customPKC.createCommunity({ address: subAddress })) as LocalCommunity | RpcLocalCommunity;
            await sub.delete();
            await new Promise((resolve) => customPKC.once("communitieschange", resolve));
        }
        const newSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;

        // Should not match signer.address
        await newSub.edit({ address: subAddress });
        expect(newSub.address).to.equal(subAddress);
        await newSub.delete();
        await customPKC.destroy();
    });

    it(`community.edit({address}) fails if the new address is already taken by another community`, async () => {
        const customPKC = await mockPKC();
        const newSub = (await customPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const bsoNameAddress = `community-address-${uuidV4()}.bso`;
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

describe(`Editing community.roles`, async () => {
    let pkc: PKCType;
    let sub: LocalCommunity | RpcLocalCommunity;
    let remotePKC: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        sub = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => Boolean(sub.updatedAt) });
    });

    afterAll(async () => {
        await sub.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Setting sub.roles[author-address] to undefined removes the role`, async () => {
        const signer1 = await pkc.createSigner();
        const signer2 = await pkc.createSigner();
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

        // Now set the other author role to null, this should set community.roles to undefined
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
        // "plebbit.eth" resolves pkc-author-address in the mock resolver
        await sub.edit({ roles: { "plebbit.eth": { role: "moderator" } } });
        expect(sub.roles!["plebbit.eth"].role).to.equal("moderator");
        // Clean up
        await sub.edit({ roles: { "plebbit.eth": undefined } });
    });

    it.skip(`Setting sub.roles.[author-address.bso].role to null doesn't corrupt the signature`, async () => {
        // This test is not needed anymore because zod will catch it
        const newSub = await createSubWithNoChallenge({}, pkc);
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
describeIfRpc(`community.edit (RPC)`, async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        const signer = await pkc.createSigner();
        community = (await pkc.createCommunity({ signer })) as LocalCommunity | RpcLocalCommunity;
        expect(community.address).to.equal(signer.address);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });
    [
        { title: `Test community RPC title edit ${Date.now()}` },
        { description: `Test community RPC description edit ${Date.now()}` },
        { address: `rpc-edit-test.bso` }
    ].map((editArgs) =>
        it(`community.edit(${JSON.stringify(editArgs)})`, async () => {
            const [keyToEdit, newValue] = Object.entries(editArgs)[0] as [keyof typeof editArgs, string];
            await community.edit(editArgs);
            expect(community[keyToEdit]).to.equal(newValue);
            await new Promise((resolve) => community.once("update", resolve));
            const remotePKCInstance = await mockPKCNoDataPathWithOnlyKuboClient(); // This pkc instance won't use RPC
            const loadedCommunity = (await remotePKCInstance.createCommunity({ address: community.address })) as
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
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let ethNameAddress: string;
    let bsoNameAddress: string;
    let postPublishedOnEth: Comment;
    let pkcResolverRecords: Map<string, string | undefined>;
    let remoteResolverRecords: Map<string, string | undefined>;

    beforeAll(async () => {
        pkcResolverRecords = new Map();
        remoteResolverRecords = new Map();
        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: pkcResolverRecords })]
            }
        });
        remotePKC = await mockPKCV2({
            stubStorage: false,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: remoteResolverRecords })]
            }
        });

        community = await createSubWithNoChallenge({}, pkc);
        const domainBase = `test-alias-${uuidV4()}`;
        ethNameAddress = `${domainBase}.eth`;
        bsoNameAddress = `${domainBase}.bso`;

        // Mock both .eth and .bso domains to resolve to the same signer address
        for (const domain of [ethNameAddress, bsoNameAddress]) {
            pkcResolverRecords.set(domain, community.signer.address);
            remoteResolverRecords.set(domain, community.signer.address);
        }

        // First, edit to .eth domain
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.edit({ address: ethNameAddress });
        await new Promise((resolve) => community.once("update", resolve));
        expect(community.address).to.equal(ethNameAddress);

        // Publish a post under the .eth address
        postPublishedOnEth = await publishRandomPost({ communityAddress: ethNameAddress, pkc: pkc });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });
        expect(community.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Posts are preserved after editing address from .eth to .bso`, async () => {
        // Edit from .eth to .bso (equivalent alias)
        await community.edit({ address: bsoNameAddress });
        expect(community.address).to.equal(bsoNameAddress);
        await new Promise((resolve) => community.once("update", resolve));

        // Wait for pages to be regenerated with the post still included
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                Boolean(community?.posts?.pages?.hot?.comments?.some((comment) => comment.cid === postPublishedOnEth.cid))
        });
        expect(community.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    it(`Remote loading of .bso sub also has the post published under .eth`, async () => {
        const loadedSub = (await remotePKC.getCommunity({ address: bsoNameAddress })) as RemoteCommunity;
        expect(loadedSub.address).to.equal(bsoNameAddress);
        expect(loadedSub.posts.pages.hot!.comments.length).to.be.greaterThan(0);
    });

    it(`Can load a local community by .eth alias when address is .bso`, async () => {
        // The sub's current address is bsoNameAddress, but loading with ethNameAddress should still find the local sub
        const loadedSub = await pkc.createCommunity({ address: ethNameAddress });
        expect(loadedSub.address).to.equal(bsoNameAddress);
        expect((loadedSub as LocalCommunity).signer).to.not.be.undefined;
    });

    it(`Can load a local community by .bso alias when address is .eth`, async () => {
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

    it(`community.edit({address}) fails if the .eth/.bso equivalent is already taken by another community`, async () => {
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
