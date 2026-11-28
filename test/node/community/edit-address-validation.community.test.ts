import { beforeAll, afterAll, it } from "vitest";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import fs from "fs";
import path from "path";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// community.edit({ address }) accepts a domain name or the community's own identity key (which drops the name).
// Anything else must be refused before the rename touches the DB file, the MFS folder or the registry: an edit that
// throws half way leaves a community that can no longer be started (issue #620).

const communityDbPath = (pkc: PKCType, dbName: string) => path.join(pkc.dataPath!, "communities", dbName);

// The DB files that belong to this community: its key, plus whatever address an edit tried to give it
const snapshot = (pkc: PKCType, community: LocalCommunity, candidateDbNames: string[]) => ({
    address: community.address,
    name: community.name,
    publicKey: community.publicKey,
    state: community.state,
    dbFiles: candidateDbNames.filter((dbName) => fs.existsSync(communityDbPath(pkc, dbName)))
});

// Not under RPC: the tests read the DB file names under the PKC's own dataPath, which an RPC client does not have
describeSkipIfRpc("community.edit({ address }) refuses an address that is neither a name nor the community's own key", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        // its own dataPath, so the DB files asserted on are only the ones these tests create
        pkc = await mockPKC({ httpRoutersOptions: [], dataPath: `.tmp/edit-address-validation-${Date.now()}` }, false, false);
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    const notANameOrKey = "nodot";
    const expectedError = { code: "ERR_COMMUNITY_EDIT_ADDRESS_IS_NOT_A_NAME_OR_OWN_KEY" };

    it(`a started community refuses address "${notANameOrKey}" and stays started under its key`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const ownKey = community.address;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        const before = snapshot(pkc, community, [ownKey, notANameOrKey]);
        expect(before).to.include({ state: "started" });
        expect(before.dbFiles).to.deep.equal([ownKey]);

        await expect(community.edit({ address: notANameOrKey })).rejects.toMatchObject(expectedError);

        expect(snapshot(pkc, community, [ownKey, notANameOrKey])).to.deep.equal(before);
        await community.stop();
    });

    it(`a community that is not started refuses address "${notANameOrKey}" and keeps its DB file`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const ownKey = community.address;
        const before = snapshot(pkc, community, [ownKey, notANameOrKey]);
        expect(before.dbFiles).to.deep.equal([ownKey]);

        await expect(community.edit({ address: notANameOrKey })).rejects.toMatchObject(expectedError);

        expect(snapshot(pkc, community, [ownKey, notANameOrKey])).to.deep.equal(before);
        // still startable: nothing was moved
        await community.start();
        await community.stop();
    });

    it("refuses another key as the address: a community cannot take an identity it does not hold the key of", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const ownKey = community.address;
        const foreignKey = (await pkc.createSigner()).address;
        const before = snapshot(pkc, community, [ownKey, foreignKey]);

        await expect(community.edit({ address: foreignKey })).rejects.toMatchObject(expectedError);

        expect(snapshot(pkc, community, [ownKey, foreignKey])).to.deep.equal(before);
    });

    it("still accepts the community's own key as the address", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const ownKey = community.address;

        await community.edit({ address: ownKey });

        expect(community.address).to.equal(ownKey);
        expect(community.name).to.be.undefined;
    });
});
