import { beforeAll, afterAll, describe, it } from "vitest";
import { mockPKCV2, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

import path from "path";
import fs from "fs";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe(`community.delete`, async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        pkc = await mockPKCV2({ forceMockPubsub: true, stubStorage: false });

        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Deleted community is not listed in pkc.communities`, async () => {
        const communities = pkc.communities;
        expect(communities).to.include(community.address);
        const recreatedCommunity = await pkc.createCommunity({ address: community.address });
        await recreatedCommunity.delete();
        await resolveWhenConditionIsTrue({
            toUpdate: pkc,
            predicate: async () => !pkc.communities.includes(community.address),
            eventName: "communitieschange"
        });
        const communitiesAfterDeletion = pkc.communities;
        expect(communitiesAfterDeletion).to.not.include(community.address);
    });

    itSkipIfRpc(`Deleted community ipfs keys are not listed in ipfs node`, async () => {
        const ipfsKeys = await pkc._clientsManager.getDefaultKuboRpcClient()!._client.key.list();
        const localCommunity = community as LocalCommunity;
        const communityKeyExists = ipfsKeys.some((key) => key.name === localCommunity.signer?.ipnsKeyName);
        expect(communityKeyExists).to.be.false;
    });

    itSkipIfRpc(`Deleted community db is moved to datapath/communities/deleted`, async () => {
        const expectedPath = path.join(pkc.dataPath!, "communities", "deleted", community.address);
        expect(fs.existsSync(expectedPath)).to.be.true;
    });

    itSkipIfRpc(`Deleted community has no locks in communities directory`, async () => {
        const communityFiles = await fs.promises.readdir(path.join(pkc.dataPath!, "communities"));
        const startLockFilename = `${community.address}.start.lock`;
        const stateLockFilename = `${community.address}.state.lock`;
        expect(communityFiles).to.not.include(startLockFilename);
        expect(communityFiles).to.not.include(stateLockFilename);
    });

    it(`Deleting an updating community will stop the community`, async () => {
        const updatingCommunity = await pkc.createCommunity();
        await updatingCommunity.update();
        await updatingCommunity.delete();
        expect(updatingCommunity.state).to.equal("stopped");
    });
});
