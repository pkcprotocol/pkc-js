import { beforeAll, afterAll, describe, it } from "vitest";
import { itSkipIfRpc, mockPKCV2, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";

import path from "path";
import fs from "fs";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe(`subplebbit.delete`, async () => {
    let plebbit: PKCType;
    let sub: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        plebbit = await mockPKCV2({ forceMockPubsub: true, stubStorage: false });

        sub = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Deleted sub is not listed in plebbit.subplebbits`, async () => {
        const subs = plebbit.subplebbits;
        expect(subs).to.include(sub.address);
        const subRecreated = await plebbit.createCommunity({ address: sub.address });
        await subRecreated.delete();
        await resolveWhenConditionIsTrue({
            toUpdate: plebbit,
            predicate: async () => !plebbit.subplebbits.includes(sub.address),
            eventName: "subplebbitschange"
        });
        const subsAfterDeletion = plebbit.subplebbits;
        expect(subsAfterDeletion).to.not.include(sub.address);
    });

    itSkipIfRpc(`Deleted sub ipfs keys are not listed in ipfs node`, async () => {
        const ipfsKeys = await plebbit._clientsManager.getDefaultKuboRpcClient()!._client.key.list();
        const localSub = sub as LocalCommunity;
        const subKeyExists = ipfsKeys.some((key) => key.name === localSub.signer?.ipnsKeyName);
        expect(subKeyExists).to.be.false;
    });

    itSkipIfRpc(`Deleted sub db is moved to datapath/subplebbits/deleted`, async () => {
        const expectedPath = path.join(plebbit.dataPath!, "subplebbits", "deleted", sub.address);
        expect(fs.existsSync(expectedPath)).to.be.true;
    });

    itSkipIfRpc(`Deleted sub has no locks in subplebbits directory`, async () => {
        const subFiles = await fs.promises.readdir(path.join(plebbit.dataPath!, "subplebbits"));
        const startLockFilename = `${sub.address}.start.lock`;
        const stateLockFilename = `${sub.address}.state.lock`;
        expect(subFiles).to.not.include(startLockFilename);
        expect(subFiles).to.not.include(stateLockFilename);
    });

    it(`Deleting an updating subplebbit will stop the subplebbit`, async () => {
        const updatingCommunity = await plebbit.createCommunity();
        await updatingCommunity.update();
        await updatingCommunity.delete();
        expect(updatingCommunity.state).to.equal("stopped");
    });
});
