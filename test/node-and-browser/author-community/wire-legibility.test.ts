// What a client can and cannot conclude about an author community by reading its record. Owner-only
// posting has no feature flag and no read-side check: it is challenge configuration, and `exclude` is
// published while `name` and `path` are stripped and `options` stay private unless the owner names them
// in publicOptions. That publishes the exemption structure but not the policy, which is the distinction
// the last test in the first block pins down. See "What a reader can actually tell" in
// docs/protocol/author-communities.md, and challenge-settings.md.
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

const OWNER_ONLY_ERROR = "Only the owner can post to this profile.";

const ownerOnlyExclude = [
    { role: ["owner"] },
    { publicationType: { reply: true, vote: true, commentEdit: true, commentModeration: true, communityEdit: true } }
];

// The public half of the challenge settings, i.e. what survives into the signed record. No `name`, no
// `options`: a reader never learns that the challenge behind this is `fail`, only that a non-owner
// posting is not excluded from whatever it is. publicOptions carries the one option the profile config
// in the doc opts into, which is the strongest hint a profile can put on the wire.
const ownerOnlyPublicChallenge = {
    exclude: ownerOnlyExclude,
    description: "A challenge that automatically fails with a custom error message.",
    type: "text/plain",
    publicOptions: { error: OWNER_ONLY_ERROR }
};

// The same exemption structure in front of an answerable challenge. `name` and `options` are exactly
// what would tell these apart and neither is published, so this is what the limit of wire legibility
// looks like: a community anyone can post to after answering a question.
//
// It publishes the identical publicOptions on purpose. A challenge file declares its own optionInputs,
// so a passable custom challenge may declare an `error` option and publish the same sentence. That is
// why an opted-in option is a hint about intent and never a discriminator of policy.
const answerablePublicChallenge = {
    exclude: ownerOnlyExclude,
    description: "Ask a question, answer it correctly to publish.",
    type: "text/plain",
    publicOptions: { error: OWNER_ONLY_ERROR }
};

// The challenge is cloned rather than aliased: the constants above are shared across a concurrent
// suite, so a record holding one by reference lets a test that mutates its own record corrupt every
// other test's input.
function buildProfileRecord(challenge: Record<string, unknown> = ownerOnlyPublicChallenge): CommunityIpfsType {
    const record = clone(newFormatFixture) as CommunityIpfsType;
    return <CommunityIpfsType>{
        ...record,
        anchor: { publicKey: OWNER_ADDRESS },
        roles: { [OWNER_ADDRESS]: { role: "owner" } },
        challenges: [clone(challenge)]
    };
}

// What a client can actually implement. Note what it is NOT called: the record does not say only the
// owner may post, it says non-owner posts face a challenge nobody else faces. Whether that challenge
// is passable is not on the wire, so this reports the exemption structure and leaves the policy to be
// inferred. See "What a reader can actually tell" in docs/protocol/author-communities.md.
function readPostingExemptions(record: CommunityIpfsType): { nonOwnerPostsAreGated: boolean; owners: string[] } {
    const nonOwnerPostsAreGated = (record.challenges ?? []).some((challenge) => {
        const excludes = challenge.exclude ?? [];
        const ownerIsExcused = excludes.some((exclude) => exclude.role?.includes("owner"));
        const repliesAreExcused = excludes.some((exclude) => exclude.publicationType?.reply === true);
        const postsAreExcused = excludes.some((exclude) => exclude.publicationType?.post === true);
        return ownerIsExcused && repliesAreExcused && !postsAreExcused;
    });
    const owners = Object.entries(record.roles ?? {})
        .filter(([, value]) => value.role === "owner")
        .map(([address]) => address);
    return { nonOwnerPostsAreGated, owners };
}

describe.concurrent("author community: what the posting restriction looks like on the wire", () => {
    it("preserves exclude rules through the record parse", () => {
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord());
        expect(parsed.challenges[0].exclude).to.deep.equal(ownerOnlyPublicChallenge.exclude);
    });

    it("lets a reader see that non-owner posts are gated, and who the owner is", () => {
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord());
        const { nonOwnerPostsAreGated, owners } = readPostingExemptions(parsed);
        expect(nonOwnerPostsAreGated).to.be.true;
        expect(owners).to.deep.equal([OWNER_ADDRESS]);
    });

    it("does not read an ordinary community as gating posts", () => {
        const ordinary = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(clone(newFormatFixture) as CommunityIpfsType);
        expect(readPostingExemptions(ordinary).nonOwnerPostsAreGated).to.be.false;
    });

    // A community that excuses posts as well gates nothing. Without this the reader above would report
    // any community carrying a role exclude as a profile.
    it("does not read a community that also excuses posts as gating them", () => {
        const record = buildProfileRecord();
        record.challenges[0].exclude!.push({ publicationType: { post: true } });
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(record);
        expect(readPostingExemptions(parsed).nonOwnerPostsAreGated).to.be.false;
        // A record must own its challenge. If it aliases the shared constant, this push leaks into
        // every later test in the file and the one below silently compares two corrupted records.
        expect(ownerOnlyPublicChallenge.exclude).to.have.lengthOf(2);
        expect(answerablePublicChallenge.exclude).to.have.lengthOf(2);
    });

    // The limit of wire legibility, and the reason the reader above reports an exemption structure
    // rather than a policy. A community anyone can post to after answering a question publishes the
    // same exclude rules as one that forbids non-owner posts outright, because `name` and `options` are
    // exactly what would tell them apart and both are stripped. Nothing on the wire distinguishes them,
    // so "only the owner posts here" is an inference, never a fact the record attests.
    it("cannot distinguish an unpassable gate from an answerable one", () => {
        const unpassable = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord(ownerOnlyPublicChallenge));
        const answerable = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord(answerablePublicChallenge));

        // Asserted positively first, so this cannot pass by both sides reading as "not gated"
        expect(readPostingExemptions(unpassable).nonOwnerPostsAreGated).to.be.true;
        expect(readPostingExemptions(answerable)).to.deep.equal(readPostingExemptions(unpassable));
        expect(answerable.challenges[0].exclude).to.deep.equal(unpassable.challenges[0].exclude);
        // description is the only field that differs, and it is operator-settable free text
        expect(answerable.challenges[0].description).to.not.equal(unpassable.challenges[0].description);
        expect(answerable.challenges[0]).to.not.have.property("name");
        expect(answerable.challenges[0]).to.not.have.property("options");
        // Even the rejection text the profile opted into publishing is reproducible by the answerable
        // one, so it narrows nothing: both sides carry it and both sides remain what they were.
        expect(answerable.challenges[0].publicOptions).to.deep.equal(unpassable.challenges[0].publicOptions);
    });

    it("carries the anchor claim, so a reader knows the address is the author's identity key", () => {
        const parsed = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(buildProfileRecord());
        expect(parsed.anchor).to.deep.equal({ publicKey: OWNER_ADDRESS });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`author community: a loaded instance exposes the exemption rules - ${config.name}`, () => {
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
