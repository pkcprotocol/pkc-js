import { messages } from "../../../../dist/node/errors.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import * as remeda from "remeda";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";

// Type for challenge request event with community edit
type ChallengeRequestWithCommunityEdit = {
    communityEdit: Record<string, unknown>;
};

const communityAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`pkc.createCommunityEdit - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Can parse edit args with no problems in pkc.createCommunityEdit`, async () => {
            const description = "New description" + Math.random();
            const signer = await pkc.createSigner();
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: { description },
                communityAddress: communityAddress,
                signer
            });

            expect(communityEditPub.communityEdit.description).to.equal(description);
            expect(communityEditPub.communityAddress).to.equal(communityAddress);
            expect(communityEditPub.author.address).to.equal(signer.address);
            expect(communityEditPub.raw.pubsubMessageToPublish).to.exist;
            expect(communityEditPub.toJSONPubsubRequestToEncrypt().communityEdit).to.deep.equal(
                communityEditPub.raw.pubsubMessageToPublish
            );
        });

        it(`(communityEdit: CommunityEdit) === pkc.createCommunityEdit(JSON.parse(JSON.stringify(communityEditPub)))`, async () => {
            const description = "New description" + Math.random();
            const signer = await pkc.createSigner();
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: { description },
                communityAddress: communityAddress,
                signer
            });
            const communityEditPubFromStringified = await pkc.createCommunityEdit(JSON.parse(JSON.stringify(communityEditPub)));
            const jsonPropsToOmit = ["clients"];

            const communityEditPubJson = remeda.omit(JSON.parse(JSON.stringify(communityEditPub)), jsonPropsToOmit) as Record<
                string,
                unknown
            >;
            const stringifiedCommunityEditJson = remeda.omit(
                JSON.parse(JSON.stringify(communityEditPubFromStringified)),
                jsonPropsToOmit
            ) as Record<string, unknown>;
            expect(communityEditPubJson.signer).to.be.a("object").and.to.deep.equal(stringifiedCommunityEditJson.signer); // make sure internal props like signer are copied properly
            expect(communityEditPubJson).to.deep.equal(stringifiedCommunityEditJson);
        });

        it(`Can publish a CommunityEdit that was created from jsonfied CommunityEdit instance`, async () => {
            const description = "New description" + Math.random();
            const ownerSigner = await pkc.createSigner(roles[0].signer);
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: { description },
                communityAddress: communityAddress,
                signer: ownerSigner
            });
            const communityEditPubFromStringified = await pkc.createCommunityEdit(JSON.parse(JSON.stringify(communityEditPub)));
            expect(communityEditPub.signer.address).to.equal(communityEditPubFromStringified.signer.address);
            const challengeRequestPromise = new Promise<ChallengeRequestWithCommunityEdit>((resolve) =>
                communityEditPubFromStringified.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({ publication: communityEditPubFromStringified, expectedChallengeSuccess: true });
            const challengerequest = await challengeRequestPromise;
            expect(challengerequest.communityEdit).to.deep.equal(communityEditPubFromStringified.raw.pubsubMessageToPublish!);
            expect(communityEditPubFromStringified.raw.pubsubMessageToPublish).to.exist;
        });
    });

    describe(`Editing a community remotely as a non admin/owner - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`A moderator publishing a CommunityEdit should fail`, async () => {
            const signer = await pkc.createSigner(roles[2].signer);
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: { description: "Test desc from " + Math.random() },
                communityAddress: communityAddress,
                signer
            });
            await publishWithExpectedResult({
                publication: communityEditPub,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN
            });
        });

        it(`A random author publishing a CommunityEdit should fail`, async () => {
            const signer = await pkc.createSigner();
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: { description: "Test 12" + Math.random() },
                communityAddress: communityAddress,
                signer
            });
            await publishWithExpectedResult({
                publication: communityEditPub,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN
            });
        });
    });

    describe(`Editing a sub remotely as a admin - ${config.name}`, async () => {
        let pkc: PKC;

        let editProps: Record<string, unknown>;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Admin should not be able to publish CommunityEdit with edit.roles`, async () => {
            const adminSigner = await pkc.createSigner(roles[1].signer);
            const authorAddress = (await pkc.createSigner()).address;
            editProps = { description: "Test" + Math.random(), roles: { [authorAddress]: { role: "admin" } } };
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: editProps,
                communityAddress: communityAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({
                publication: communityEditPub,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS
            });
        });

        it(`Admin should not be able to publish CommunityEdit with edit.address`, async () => {
            const adminSigner = await pkc.createSigner(roles[1].signer);
            editProps = { description: "Test" + Math.random(), address: "newaddress.eth" };
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: editProps,
                communityAddress: communityAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({
                publication: communityEditPub,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS
            });
        });

        it(`Admin should not be able to modify settings`, async () => {
            const adminSigner = await pkc.createSigner(roles[1].signer);
            const editProps = { description: "Test" + Math.random(), settings: { fetchThumbnailUrls: true } };
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: editProps,
                communityAddress: communityAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({
                publication: communityEditPub,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS
            });
        });

        it(`Admin should be able to modify community props via CommunityEdit`, async () => {
            const adminSigner = await pkc.createSigner(roles[1].signer);
            editProps = { description: "Test" + Math.random() };
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: editProps,
                communityAddress: communityAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({ publication: communityEditPub, expectedChallengeSuccess: true });
        });

        it(`Community should publish an update after the admin edits one of its props`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.description === editProps.description
            });
            await community.stop();
            expect(community.description).to.equal(editProps.description);
        });

        it(`Community edit props should be deep merged`);
    });

    describe(`Editing a sub remotely as an owner - ${config.name}`, async () => {
        let pkc: PKC;

        let newRoleAddress: string;
        let editProps: Record<string, unknown> = {};

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`sub owner should be able to modify address`, async () => {
            const ownerSigner = await pkc.createSigner(roles[0].signer);
            const community = await pkc.getCommunity({ address: communityAddress });
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: { address: community.address }, // we're not changing the address because it's a community used by other tests as well. But if the test pass it means {address} was passed over to community.edit which is enough for our testing
                communityAddress: communityAddress,
                signer: ownerSigner
            });
            await publishWithExpectedResult({ publication: communityEditPub, expectedChallengeSuccess: true });
        });
        it(`Sub owner should be able to modify roles`, async () => {
            const ownerSigner = await pkc.createSigner(roles[0].signer);
            newRoleAddress = (await pkc.createSigner()).address;
            editProps = { ...editProps, description: "Test" + Math.random(), roles: { [newRoleAddress]: { role: "admin" } } };
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: editProps,
                communityAddress: communityAddress,
                signer: ownerSigner
            });
            await publishWithExpectedResult({ publication: communityEditPub, expectedChallengeSuccess: true });
        });

        it(`Owner should not be able to modify settings`, async () => {
            const modSigner = await pkc.createSigner(roles[0].signer);
            const editProps = { description: "Test" + Math.random(), settings: { fetchThumbnailUrls: true } };
            const communityEditPub = await pkc.createCommunityEdit({
                communityEdit: editProps,
                communityAddress: communityAddress,
                signer: modSigner
            });
            await publishWithExpectedResult({
                publication: communityEditPub,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS
            });
        });

        it(`Community should publish an update after the owner edits one of its props`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.description === editProps.description
            });
            await community.stop();
            expect(community.description).to.equal(editProps.description);
            expect(community.roles[newRoleAddress].role).to.equal("admin");
            expect(Object.keys(community.roles).length).to.be.above(1); // should not override other roles
        });

        it(`Community edit props should be deep merged`);
    });
});
