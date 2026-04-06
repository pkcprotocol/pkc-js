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

// Type for challenge request event with subplebbit edit
type ChallengeRequestWithCommunityEdit = {
    subplebbitEdit: Record<string, unknown>;
};

const subplebbitAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`plebbit.createCommunityEdit - ${config.name}`, async () => {
        let plebbit: PKC;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Can parse edit args with no problems in plebbit.createCommunityEdit`, async () => {
            const description = "New description" + Math.random();
            const signer = await plebbit.createSigner();
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: { description },
                communityAddress: subplebbitAddress,
                signer
            });

            expect(subplebbitEdit.subplebbitEdit.description).to.equal(description);
            expect(subplebbitEdit.communityAddress).to.equal(subplebbitAddress);
            expect(subplebbitEdit.author.address).to.equal(signer.address);
            expect(subplebbitEdit.raw.pubsubMessageToPublish).to.exist;
            expect(subplebbitEdit.toJSONPubsubRequestToEncrypt().subplebbitEdit).to.deep.equal(subplebbitEdit.raw.pubsubMessageToPublish);
        });

        it(`(subplebbitEdit: CommunityEdit) === plebbit.createCommunityEdit(JSON.parse(JSON.stringify(subplebbitEdit)))`, async () => {
            const description = "New description" + Math.random();
            const signer = await plebbit.createSigner();
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: { description },
                communityAddress: subplebbitAddress,
                signer
            });
            const subplebbitEditFromStringifiedCommunityEdit = await plebbit.createCommunityEdit(
                JSON.parse(JSON.stringify(subplebbitEdit))
            );
            const jsonPropsToOmit = ["clients"];

            const subplebbitEditJson = remeda.omit(JSON.parse(JSON.stringify(subplebbitEdit)), jsonPropsToOmit) as Record<string, unknown>;
            const stringifiedCommunityEditJson = remeda.omit(
                JSON.parse(JSON.stringify(subplebbitEditFromStringifiedCommunityEdit)),
                jsonPropsToOmit
            ) as Record<string, unknown>;
            expect(subplebbitEditJson.signer).to.be.a("object").and.to.deep.equal(stringifiedCommunityEditJson.signer); // make sure internal props like signer are copied properly
            expect(subplebbitEditJson).to.deep.equal(stringifiedCommunityEditJson);
        });

        it(`Can publish a CommunityEdit that was created from jsonfied CommunityEdit instance`, async () => {
            const description = "New description" + Math.random();
            const ownerSigner = await plebbit.createSigner(roles[0].signer);
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: { description },
                communityAddress: subplebbitAddress,
                signer: ownerSigner
            });
            const subplebbitEditFromStringifiedCommunityEdit = await plebbit.createCommunityEdit(
                JSON.parse(JSON.stringify(subplebbitEdit))
            );
            expect(subplebbitEdit.signer.address).to.equal(subplebbitEditFromStringifiedCommunityEdit.signer.address);
            const challengeRequestPromise = new Promise<ChallengeRequestWithCommunityEdit>((resolve) =>
                subplebbitEditFromStringifiedCommunityEdit.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({ publication: subplebbitEditFromStringifiedCommunityEdit, expectedChallengeSuccess: true });
            const challengerequest = await challengeRequestPromise;
            expect(challengerequest.subplebbitEdit).to.deep.equal(subplebbitEditFromStringifiedCommunityEdit.raw.pubsubMessageToPublish!);
            expect(subplebbitEditFromStringifiedCommunityEdit.raw.pubsubMessageToPublish).to.exist;
        });
    });

    describe(`Editing a subplebbit remotely as a non admin/owner - ${config.name}`, async () => {
        let plebbit: PKC;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`A moderator publishing a CommunityEdit should fail`, async () => {
            const signer = await plebbit.createSigner(roles[2].signer);
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: { description: "Test desc from " + Math.random() },
                communityAddress: subplebbitAddress,
                signer
            });
            await publishWithExpectedResult({
                publication: subplebbitEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN
            });
        });

        it(`A random author publishing a CommunityEdit should fail`, async () => {
            const signer = await plebbit.createSigner();
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: { description: "Test 12" + Math.random() },
                communityAddress: subplebbitAddress,
                signer
            });
            await publishWithExpectedResult({
                publication: subplebbitEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN
            });
        });
    });

    describe(`Editing a sub remotely as a admin - ${config.name}`, async () => {
        let plebbit: PKC;

        let editProps: Record<string, unknown>;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Admin should not be able to publish CommunityEdit with edit.roles`, async () => {
            const adminSigner = await plebbit.createSigner(roles[1].signer);
            const authorAddress = (await plebbit.createSigner()).address;
            editProps = { description: "Test" + Math.random(), roles: { [authorAddress]: { role: "admin" } } };
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: editProps,
                communityAddress: subplebbitAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({
                publication: subplebbitEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS
            });
        });

        it(`Admin should not be able to publish CommunityEdit with edit.address`, async () => {
            const adminSigner = await plebbit.createSigner(roles[1].signer);
            editProps = { description: "Test" + Math.random(), address: "newaddress.eth" };
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: editProps,
                communityAddress: subplebbitAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({
                publication: subplebbitEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS
            });
        });

        it(`Admin should not be able to modify settings`, async () => {
            const adminSigner = await plebbit.createSigner(roles[1].signer);
            const editProps = { description: "Test" + Math.random(), settings: { fetchThumbnailUrls: true } };
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: editProps,
                communityAddress: subplebbitAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({
                publication: subplebbitEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS
            });
        });

        it(`Admin should be able to modify subplebbit props via CommunityEdit`, async () => {
            const adminSigner = await plebbit.createSigner(roles[1].signer);
            editProps = { description: "Test" + Math.random() };
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: editProps,
                communityAddress: subplebbitAddress,
                signer: adminSigner
            });
            await publishWithExpectedResult({ publication: subplebbitEdit, expectedChallengeSuccess: true });
        });

        it(`Community should publish an update after the admin edits one of its props`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => sub.description === editProps.description });
            await sub.stop();
            expect(sub.description).to.equal(editProps.description);
        });

        it(`Community edit props should be deep merged`);
    });

    describe(`Editing a sub remotely as an owner - ${config.name}`, async () => {
        let plebbit: PKC;

        let newRoleAddress: string;
        let editProps: Record<string, unknown> = {};

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`sub owner should be able to modify address`, async () => {
            const ownerSigner = await plebbit.createSigner(roles[0].signer);
            const sub = await plebbit.getCommunity({ address: subplebbitAddress });
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: { address: sub.address }, // we're not changing the address because it's a sub used by other tests as well. But if the test pass it means {address} was passed over to sub.edit which is enough for our testing
                communityAddress: subplebbitAddress,
                signer: ownerSigner
            });
            await publishWithExpectedResult({ publication: subplebbitEdit, expectedChallengeSuccess: true });
        });
        it(`Sub owner should be able to modify roles`, async () => {
            const ownerSigner = await plebbit.createSigner(roles[0].signer);
            newRoleAddress = (await plebbit.createSigner()).address;
            editProps = { ...editProps, description: "Test" + Math.random(), roles: { [newRoleAddress]: { role: "admin" } } };
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: editProps,
                communityAddress: subplebbitAddress,
                signer: ownerSigner
            });
            await publishWithExpectedResult({ publication: subplebbitEdit, expectedChallengeSuccess: true });
        });

        it(`Owner should not be able to modify settings`, async () => {
            const modSigner = await plebbit.createSigner(roles[0].signer);
            const editProps = { description: "Test" + Math.random(), settings: { fetchThumbnailUrls: true } };
            const subplebbitEdit = await plebbit.createCommunityEdit({
                subplebbitEdit: editProps,
                communityAddress: subplebbitAddress,
                signer: modSigner
            });
            await publishWithExpectedResult({
                publication: subplebbitEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS
            });
        });

        it(`Community should publish an update after the owner edits one of its props`, async () => {
            const sub = await plebbit.createCommunity({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({ toUpdate: sub, predicate: async () => sub.description === editProps.description });
            await sub.stop();
            expect(sub.description).to.equal(editProps.description);
            expect(sub.roles[newRoleAddress].role).to.equal("admin");
            expect(Object.keys(sub.roles).length).to.be.above(1); // should not override other roles
        });

        it(`Community edit props should be deep merged`);
    });
});
