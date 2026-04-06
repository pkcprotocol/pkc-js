import {
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    mockPKCV2,
    createSubWithNoChallenge,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    jsonifyCommunityAndRemoveInternalProps,
    waitTillPostInCommunityPages,
    itSkipIfRpc
} from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import signers from "../../fixtures/signers.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import tempy from "tempy";
import PKCWsServer from "../../../dist/node/rpc/src/index.js";
import PKC from "../../../dist/node/index.js";
import type { CreatePKCWsServerOptions } from "../../../dist/node/rpc/src/types.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

import * as remeda from "remeda";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { CreateNewLocalCommunityUserOptions } from "../../../dist/node/community/types.js";

describe.concurrent(`plebbit.createCommunity (local)`, async () => {
    let plebbit: PKCType;
    let remotePKC: PKCType;
    beforeAll(async () => {
        plebbit = await mockPKC({});
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    const _createAndValidateSubArgs = async (subArgs: CreateNewLocalCommunityUserOptions) => {
        const newCommunity = (await plebbit.createCommunity(subArgs)) as LocalCommunity | RpcLocalCommunity;
        if (!("signer" in subArgs))
            // signer shape changes after createCommunity
            expect(remeda.pick(newCommunity, Object.keys(subArgs) as (keyof typeof subArgs)[])).to.deep.equal(subArgs); // the args should exist after creating immedietely
        await newCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => typeof newCommunity.updatedAt === "number" });
        await newCommunity.stop();

        // Sub has finished its first sync loop, should have address now
        expect(newCommunity.address.startsWith("12D3")).to.be.true;
        expect(newCommunity.signer!.address).to.equal(newCommunity.address);
        const listedSubs = plebbit.subplebbits;
        expect(listedSubs).to.include(newCommunity.address);

        const remoteSub = await remotePKC.getCommunity({ address: newCommunity.address });

        const remoteSubJson = jsonifyCommunityAndRemoveInternalProps(remoteSub);

        const localSubRemoteJson = jsonifyCommunityAndRemoveInternalProps(newCommunity);

        expect(localSubRemoteJson).to.deep.equal(remoteSubJson);

        expect(remoteSub.raw.subplebbitIpfs!).to.deep.equal(newCommunity.raw.subplebbitIpfs!);
        return newCommunity;
    };

    ([{}, { title: `Test title - ${Date.now()}` }] as CreateNewLocalCommunityUserOptions[]).map((subArgs) =>
        it(`createCommunity(${JSON.stringify(subArgs)})`, async () => {
            await _createAndValidateSubArgs(subArgs);
        })
    );

    it(`createCommunity({signer: await plebbit.createSigner()})`, async () => {
        await _createAndValidateSubArgs({ signer: await plebbit.createSigner() });
    });

    it(`createCommunity({signer: {privateKey, type}})`, async () => {
        const signer = await plebbit.createSigner();
        await _createAndValidateSubArgs({ signer: { privateKey: signer.privateKey, type: signer.type } });
    });

    it(`createCommunity({roles, settings})`, async () => {
        const newEditProps: CreateNewLocalCommunityUserOptions = {
            roles: { ["hello.bso"]: { role: "admin" } },
            settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] }
        };
        const sub = (await plebbit.createCommunity(newEditProps)) as LocalCommunity | RpcLocalCommunity;
        expect(sub.roles).to.deep.equal(newEditProps.roles);
        expect(sub.settings).to.deep.equal({
            ...newEditProps.settings,
            maxPendingApprovalCount: 500,
            purgeDisapprovedCommentsOlderThan: 1210000
        });
        await sub.delete();
    });

    it(`subplebbit = await createCommunity(await createCommunity)`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: "subplebbit = await createCommunity(await createCommunity)" };
        const firstSub = (await plebbit.createCommunity(props)) as LocalCommunity | RpcLocalCommunity;
        const createdSub = (await plebbit.createCommunity(firstSub)) as LocalCommunity | RpcLocalCommunity;
        expect(createdSub.title).to.equal(props.title);
        expect(createdSub.signer!.address).to.be.a("string");
        await createdSub.delete();
    });

    it(`subplebbit = await createCommunity(JSON.parse(JSON.stringify(subplebbitInstance)))`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: Math.random() + "123" };
        const firstSub = (await plebbit.createCommunity(props)) as LocalCommunity | RpcLocalCommunity;
        expect(firstSub.title).to.equal(props.title);
        const secondSub = (await plebbit.createCommunity(JSON.parse(JSON.stringify(firstSub)))) as LocalCommunity | RpcLocalCommunity;
        expect(secondSub.title).to.equal(props.title);

        const firstSubJson = jsonifyCommunityAndRemoveInternalProps(firstSub);
        const secondSubJson = jsonifyCommunityAndRemoveInternalProps(secondSub);
        expect(firstSubJson).to.deep.equal(secondSubJson);
    });

    it(`Can recreate a subplebbit with replies instance with plebbit.createCommunity`, async () => {
        const props: CreateNewLocalCommunityUserOptions = { title: "Test hello", description: "Hello there" };
        const sub = await createSubWithNoChallenge(props, plebbit);
        await sub.start();
        await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => typeof sub.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: sub.address, plebbit: plebbit });
        await waitTillPostInCommunityPages(post as never, plebbit);
        await publishRandomReply({ parentComment: post as never, plebbit: plebbit });
        expect(sub.posts).to.be.a("object");
        const clonedSub = (await plebbit.createCommunity(sub)) as LocalCommunity | RpcLocalCommunity;
        expect(clonedSub.posts).to.be.a("object");
        const internalProps = ["clients", "state", "startedState"] as const;
        const clonedSubJson = JSON.parse(JSON.stringify(remeda.omit(clonedSub, internalProps)));
        const localSubJson = JSON.parse(JSON.stringify(remeda.omit(sub, internalProps)));
        delete clonedSubJson["raw"]["localCommunity"];
        delete localSubJson["raw"]["localCommunity"];
        expect(localSubJson).to.deep.equal(clonedSubJson);
        await sub.delete();
    });

    it.skip(`createCommunity on online IPFS node doesn't take more than 10s`, async () => {
        const onlinePKC = await mockPKC({
            kuboRpcClientsOptions: ["http://localhost:15003/api/v0"],
            pubsubKuboRpcClientsOptions: [`http://localhost:15003/api/v0`]
        });
        const startTime = timestamp();
        const title = `Test online plebbit`;
        const createdSub = (await onlinePKC.createCommunity({ title: title })) as LocalCommunity | RpcLocalCommunity;
        const endTime = timestamp();
        await createdSub.delete();
        expect(endTime).to.be.lessThanOrEqual(startTime + 10, "createCommunity took more than 10s in an online ipfs node");
        await onlinePKC.destroy();
    });

    it(`local subplebbit retains fields upon createCommunity(address)`, async () => {
        const title = `Test retention ${Date.now()}`;
        const sub = await _createAndValidateSubArgs({ title });
        const createdSub = (await plebbit.createCommunity({ address: sub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(createdSub.title).to.equal(title);
        expect(jsonifyCommunityAndRemoveInternalProps(createdSub)).to.deep.equal(jsonifyCommunityAndRemoveInternalProps(sub));
        await createdSub.delete();
    });

    it(`Recreating a local sub with createCommunity({address, ...extraProps}) should not override local sub props`, async () => {
        const newSub = await createSubWithNoChallenge(
            {
                title: `Test for extra props`,
                description: "Test for description extra props"
            },
            plebbit
        );
        await newSub.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSub, predicate: async () => typeof newSub?.updatedAt === "number" });
        await newSub.stop();

        const createdCommunity = (await plebbit.createCommunity({
            address: newSub.address,
            title: "nothing",
            description: "nothing also"
        })) as LocalCommunity | RpcLocalCommunity;
        expect(createdCommunity.title).to.equal(newSub.title);
        expect(createdCommunity.description).to.equal(newSub.description);

        await createdCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: newSub, predicate: async () => createdCommunity.title === newSub.title });

        await new Promise((resolve) => createdCommunity.once("update", resolve));
        expect(createdCommunity.title).to.equal(newSub.title);
        expect(createdCommunity.description).to.equal(newSub.description);
        await createdCommunity.delete();
    });

    it(`Recreating a local running subplebbit should not stop it`, async () => {
        const sub = await createSubWithNoChallenge({}, plebbit);
        await sub.start();
        await new Promise((resolve) => sub.once("update", resolve));
        if (!sub.updatedAt) await new Promise((resolve) => sub.once("update", resolve));
        expect(sub.startedState).to.not.equal("stopped");

        const recreatedSub = (await plebbit.createCommunity({ address: sub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedSub.startedState).to.equal("stopped"); // startedState is only set by the actual instance, not synced across instances
        expect(sub.startedState).to.not.equal("stopped");
        await sub.stop();
    });

    itSkipIfRpc(`Can create a subplebbit if it's running in another PKC instance`, async () => {
        const firstPKC = await mockPKC();

        const sub = (await firstPKC.createCommunity({ address: signers[0].address })) as LocalCommunity | RpcLocalCommunity; // this sub is running in test-server process instance
        expect(sub.updatedAt).to.be.greaterThan(0);

        await firstPKC.destroy();
    });

    itSkipIfRpc(`Can create a subplebbit if it's running in the same plebbit instance`, async () => {
        const firstPKC = await mockPKC();
        const firstSub = (await firstPKC.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        await firstSub.start();
        const differentPKC = await mockPKCV2({
            plebbitOptions: { dataPath: firstPKC.dataPath },
            stubStorage: false,
            mockResolve: true
        });

        const recreatedSub = (await differentPKC.createCommunity({ address: firstSub.address })) as LocalCommunity | RpcLocalCommunity;
        expect(recreatedSub.startedState).to.equal("stopped");
        expect(recreatedSub.address).to.equal(firstSub.address);
        expect(recreatedSub.signer!.address).to.equal(firstSub.signer!.address);
        expect(recreatedSub.title).to.equal(firstSub.title);
        expect(recreatedSub.description).to.equal(firstSub.description);

        await firstPKC.destroy();
        await differentPKC.destroy();
    });

    it(`Fail to create a sub with ENS address has a capital letter`, async () => {
        try {
            await plebbit.createCommunity({ address: "testBso.bso" });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER");
        }
    });

    it(`plebbit.createCommunity({address: undefined}) should throw a proper error if plebbit has no data path`, async () => {
        const plebbitWithNoDataPath = await mockPKCV2({ plebbitOptions: { dataPath: undefined } });
        expect(plebbitWithNoDataPath.dataPath).to.be.undefined;
        try {
            await plebbitWithNoDataPath.createCommunity({ address: undefined });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.be.oneOf([
                "ERR_INVALID_CREATE_REMOTE_COMMUNITY_ARGS_SCHEMA",
                "ERR_INVALID_CREATE_COMMUNITY_WITH_RPC_ARGS_SCHEMA"
            ]);
        }
    });

    it(`plebbit.subplebbits shows unlocked created subplebbits`, async () => {
        const title = "Test plebbit.subplebbits" + Date.now();
        const subSigner = await plebbit.createSigner();

        const createdCommunity = (await plebbit.createCommunity({ signer: subSigner, title: title })) as LocalCommunity | RpcLocalCommunity;
        // At this point the sub should be unlocked and ready to be recreated by another instance
        const listedSubs = plebbit.subplebbits;
        expect(listedSubs).to.include(createdCommunity.address);

        expect(createdCommunity.address).to.equal(subSigner.address);
        expect(createdCommunity.title).to.equal(title);
    });
});

describe(`plebbit.createCommunity - performance regression`, async () => {
    let plebbit: PKCType;

    beforeAll(async () => {
        plebbit = await mockPKCV2();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`createCommunity({address}) for a stopped local subplebbit should not trigger IPNS resolution`, async () => {
        // Create a new local sub (it will NOT be started)
        const newSub = await plebbit.createCommunity();
        const address = newSub.address;

        // Now call createCommunity({address}) for the stopped sub.
        // Before the fix, this would await subplebbit.update() on the RPC server
        // which triggered IPNS resolution, taking 60+ seconds.
        const timeoutMs = 15000;
        const result = await Promise.race([
            plebbit.createCommunity({ address }).then((sub) => ({ sub, timedOut: false as const })),
            new Promise<{ sub: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ sub: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createCommunity({address}) for stopped local sub took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.sub!.address).to.equal(address);

        await newSub.delete();
    });

    itSkipIfRpc(`createCommunity({address}) over RPC for a stopped local subplebbit should not trigger IPNS resolution`, async () => {
        // This test creates its own RPC server to test the RPC-specific code path
        // The direct (non-RPC) case is covered by the test above
        const dataPath = tempy.directory();
        const rpcServerPort = 19170;

        const options: CreatePKCWsServerOptions = {
            port: rpcServerPort,
            plebbitOptions: {
                kuboRpcClientsOptions: plebbit.kuboRpcClientsOptions as CreatePKCWsServerOptions["plebbitOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: plebbit.httpRoutersOptions,
                dataPath
            },
            startStartedCommunitysOnStartup: false
        };

        const rpcServer = await PKCWsServer.PKCWsServer(options);
        const rpcUrl = `ws://localhost:${rpcServerPort}`;
        const rpcPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });

        // Create a sub (not started)
        const newSub = await rpcPKC.createCommunity({});
        const address = newSub.address;

        // Now call createCommunity({address}) — before the fix this took 60s
        const timeoutMs = 15000;
        const result = await Promise.race([
            rpcPKC.createCommunity({ address }).then((sub) => ({ sub, timedOut: false as const })),
            new Promise<{ sub: undefined; timedOut: true }>((resolve) =>
                setTimeout(() => resolve({ sub: undefined, timedOut: true }), timeoutMs)
            )
        ]);

        expect(result.timedOut, `createCommunity({address}) over RPC took longer than ${timeoutMs}ms`).to.be.false;
        expect(result.sub!.address).to.equal(address);

        await newSub.delete();
        await rpcPKC.destroy();
        await rpcServer.destroy();
    });
});
