// A client has to be able to tell an author community apart from an ordinary community by reading its
// record, because owner-only posting has no feature flag and no read-side check: it is challenge
// configuration, and the only thing that makes it legible is that `exclude` is published while `name`,
// `path` and `options` are stripped. See docs/protocol/author-communities.md and challenge-settings.md.
//
// This runs in the browser and touches no network: the point is what a reader can conclude from bytes.
// The producing half, that a real community actually puts these rules on the wire, is asserted in
// test/node/author-community/author-community.test.ts.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { clone } from "remeda";
import signers from "../../fixtures/signers.js";
import newFormatFixture from "../../fixtures/signatures/community/valid_community_ipfs_new_format.json" with { type: "json" };
import { getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails } from "../../../dist/node/schema/schema-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";

const OWNER_ADDRESS = signers[0].address;

// The public half of the challenge settings, i.e. what survives into the signed record. No `name`, no
// `options`: a reader never learns that the challenge behind this is `fail`, only that a non-owner
// posting is not excluded from whatever it is.
const ownerOnlyPublicChallenge = {
    exclude: [
        { role: ["owner"] },
        { publicationType: { reply: true, vote: true, commentEdit: true, commentModeration: true, communityEdit: true } }
    ],
    description: "A challenge that automatically fails with a custom error message.",
    type: "text/plain"
};

function buildProfileRecord(): CommunityIpfsType {
    const record = clone(newFormatFixture) as CommunityIpfsType;
    return <CommunityIpfsType>{
        ...record,
        anchor: { publicKey: OWNER_ADDRESS },
        roles: { [OWNER_ADDRESS]: { role: "owner" } },
        challenges: [ownerOnlyPublicChallenge]
    };
}

// What a client would implement: is this community one where only its owner posts, and who is that?
function readOwnerOnlyPosting(record: CommunityIpfsType): { ownerOnly: boolean; owners: string[] } {
    const ownerOnly = (record.challenges ?? []).some((challenge) => {
        const excludes = challenge.exclude ?? [];
        const ownerIsExcused = excludes.some((exclude) => exclude.role?.includes("owner"));
        const repliesAreExcused = excludes.some((exclude) => exclude.publicationType?.reply === true);
        const postsAreExcused = excludes.some((exclude) => exclude.publicationType?.post === true);
        return ownerIsExcused && repliesAreExcused && !postsAreExcused;
    });
    const owners = Object.entries(record.roles ?? {})
        .filter(([, value]) => value.role === "owner")
        .map(([address]) => address);
    return { ownerOnly, owners };
}

describe.concurrent("author community: the posting restriction is legible from the record alone", () => {
    it("preserves exclude rules through the record parse", () => {
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord());
        expect(parsed.challenges[0].exclude).to.deep.equal(ownerOnlyPublicChallenge.exclude);
    });

    it("lets a reader conclude that only the owner may post, and who the owner is", () => {
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord());
        const { ownerOnly, owners } = readOwnerOnlyPosting(parsed);
        expect(ownerOnly).to.be.true;
        expect(owners).to.deep.equal([OWNER_ADDRESS]);
    });

    it("does not read an ordinary community as owner-only", () => {
        const ordinary = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(clone(newFormatFixture) as CommunityIpfsType);
        expect(readOwnerOnlyPosting(ordinary).ownerOnly).to.be.false;
    });

    // A community that excuses posts as well is not owner-only, it is unrestricted. Without this the
    // reader above would report any community carrying a role exclude as a profile.
    it("does not read a community that also excuses posts as owner-only", () => {
        const record = buildProfileRecord();
        record.challenges[0].exclude!.push({ publicationType: { post: true } });
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(record);
        expect(readOwnerOnlyPosting(parsed).ownerOnly).to.be.false;
    });

    it("carries the anchor claim, so a reader knows the address is the author's identity key", () => {
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord());
        expect(parsed.anchor).to.deep.equal({ publicKey: OWNER_ADDRESS });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`author community: a loaded instance exposes the restriction - ${config.name}`, () => {
        let pkc: PKCType;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it("exposes challenges[].exclude and roles on the community instance", async () => {
            const community = await pkc.createCommunity({ address: OWNER_ADDRESS });
            community.initCommunityIpfsPropsNoMerge(buildProfileRecord());
            expect(community.challenges[0].exclude).to.deep.equal(ownerOnlyPublicChallenge.exclude);
            expect(community.roles?.[OWNER_ADDRESS]).to.deep.equal({ role: "owner" });
        });
    });
});
