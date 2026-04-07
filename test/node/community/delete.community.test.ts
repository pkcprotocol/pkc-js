import { beforeAll, afterAll, describe, it } from "vitest";
import { itSkipIfRpc, mockPKCV2, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";

import path from "path";
import fs from "fs";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe(`community.delete`, async () => {
    let pkc: PKCType;
    let sub: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKCV2({ forceMockPubsub: true, stubStorage: false });

        sub = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Deleted sub is not listed in pkc.communities`, async () => {
        const subs = pkc.communities;
        expect(subs).to.include(sub.address);
        const subRecreated = await pkc.createCommunity({ address: sub.address });
        await subRecreated.delete();
        await resolveWhenConditionIsTrue({
            toUpdate: pkc,
            predicate: async () => !pkc.communities.includes(sub.address),
            eventName: "communitieschange"
        });
        const subsAfterDeletion = pkc.communities;
        expect(subsAfterDeletion).to.not.include(sub.address);
    });

    itSkipIfRpc(`Deleted sub ipfs keys are not listed in ipfs node`, async () => {
        const ipfsKeys = await pkc._clientsManager.getDefaultKuboRpcClient()!._client.key.list();
        const localSub = sub as LocalCommunity;
        const subKeyExists = ipfsKeys.some((key) => key.name === localSub.signer?.ipnsKeyName);
        expect(subKeyExists).to.be.false;
    });

    itSkipIfRpc(`Deleted sub db is moved to datapath/communities/deleted`, async () => {
        const expectedPath = path.join(pkc.dataPath!, "communities", "deleted", sub.address);
        expect(fs.existsSync(expectedPath)).to.be.true;
    });

    itSkipIfRpc(`Deleted sub has no locks in communities directory`, async () => {
        const subFiles = await fs.promises.readdir(path.join(pkc.dataPath!, "communities"));
        const startLockFilename = `${sub.address}.start.lock`;
        const stateLockFilename = `${sub.address}.state.lock`;
        expect(subFiles).to.not.include(startLockFilename);
        expect(subFiles).to.not.include(stateLockFilename);
    });

    it(`Deleting an updating community will stop the community`, async () => {
        const updatingCommunity = await pkc.createCommunity();
        await updatingCommunity.update();
        await updatingCommunity.delete();
        expect(updatingCommunity.state).to.equal("stopped");
    });
});
