import { beforeAll, afterAll, it, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import {
    createMockNameResolver,
    createSubWithNoChallenge,
    disableValidationOfSignatureBeforePublishing,
    ensurePublicationIsSigned,
    mockPKCV2,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { messages } from "../../../dist/node/errors.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";

import { v4 as uuidV4 } from "uuid";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

type PublicationWithSigner = Publication & { signer?: SignerType };

// Issue #401: a community with a name requires every publication to be signed with that name. A client that reached the
// community by its key reads the name off the record it loaded, and pkc-js does that for a publication created by key.
// Skipped under RPC: the domain only resolves through this PKC's mock name resolver, and the RPC test server strips
// client-supplied nameResolvers in setSettings, so the community could never take the domain address there.
describeSkipIfRpc.sequential("a community with a name requires communityName on every publication (#401)", async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let domainAddress: string;
    let targetPost: Comment;
    let moderatorSigner: SignerType;

    beforeAll(async () => {
        const resolverRecords = new Map<string, string | undefined>();
        pkc = await mockPKCV2({
            stubStorage: false,
            mockResolve: false,
            pkcOptions: { nameResolvers: [createMockNameResolver({ includeDefaultRecords: true, records: resolverRecords })] }
        });
        community = await createSubWithNoChallenge({}, pkc);
        domainAddress = `test-missing-name-${uuidV4()}.bso`;
        resolverRecords.set(domainAddress, community.signer.address);

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        moderatorSigner = await pkc.createSigner();
        const updateCidBeforeName = community.updateCid;
        await community.edit({ address: domainAddress, roles: { [moderatorSigner.address]: { role: "moderator" } } });
        // edit() sets community.name before anything is published, so wait for the record that carries the name:
        // publications created by key re-sign with the name of the record the client loads
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.updateCid !== updateCidBeforeName });

        targetPost = await publishRandomPost({ communityAddress: domainAddress, pkc });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    // Re-sign the publication without communityName, as a client that never set it would
    async function removeCommunityName(publication: PublicationWithSigner) {
        const log = Logger({ namespace: "pkc-js:test:removeCommunityName" });
        if (!publication.signer) throw Error("Expected publication to have a signer");
        await ensurePublicationIsSigned(publication, community);
        const orig = publication.raw.pubsubMessageToPublish!;
        expect(orig.communityName).to.equal(domainAddress);
        const modified = { ...orig } as Record<string, unknown>;
        delete modified.communityName;
        const signedProps = orig.signature.signedPropertyNames.filter((propertyName) => propertyName !== "communityName");
        modified.signature = await _signJson(signedProps, cleanUpBeforePublishing(modified), publication.signer, log);
        publication.raw.pubsubMessageToPublish = modified as typeof orig;
        publication.signature = modified.signature as typeof publication.signature;
        disableValidationOfSignatureBeforePublishing(publication);
    }

    const expectRejectedForMissingName = async (publication: PublicationWithSigner) => {
        await removeCommunityName(publication);
        await publishWithExpectedResult({
            publication,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_MISSING_COMMUNITY_NAME
        });
    };

    it("rejects a comment without communityName", async () => {
        const comment = await pkc.createComment({
            communityAddress: domainAddress,
            title: `No communityName comment ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        await expectRejectedForMissingName(comment);
    });

    it("rejects a vote without communityName", async () => {
        const vote = await pkc.createVote({
            commentCid: targetPost.cid!,
            vote: 1,
            communityAddress: domainAddress,
            signer: await pkc.createSigner()
        });
        await expectRejectedForMissingName(vote);
    });

    it("rejects a commentEdit without communityName", async () => {
        const commentEdit = await pkc.createCommentEdit({
            commentCid: targetPost.cid!,
            content: `No communityName edit ${Date.now()}`,
            communityAddress: domainAddress,
            signer: targetPost.signer
        });
        await expectRejectedForMissingName(commentEdit);
    });

    it("rejects a commentModeration without communityName", async () => {
        const commentModeration = await pkc.createCommentModeration({
            communityAddress: domainAddress,
            commentCid: targetPost.cid!,
            commentModeration: { reason: `No communityName mod ${Date.now()}`, spoiler: true },
            signer: moderatorSigner
        });
        await expectRejectedForMissingName(commentModeration);
    });

    it("rejects a communityEdit without communityName", async () => {
        const communityEdit = await pkc.createCommunityEdit({
            communityAddress: domainAddress,
            communityEdit: { description: `No communityName community edit ${Date.now()}` },
            signer: community.signer as SignerType
        });
        await expectRejectedForMissingName(communityEdit);
    });

    it("a comment created with only the community's key is signed with the community's name at publish", async () => {
        const comment = await pkc.createComment({
            communityAddress: community.signer.address,
            title: `Created by key ${Date.now()}`,
            content: `Content ${Date.now()}`,
            signer: await pkc.createSigner()
        });
        expect(comment.raw.pubsubMessageToPublish?.communityName).to.be.undefined;
        await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
        expect(comment.raw.pubsubMessageToPublish?.communityName).to.equal(domainAddress);
        expect(comment.raw.pubsubMessageToPublish?.signature.signedPropertyNames).to.include("communityName");
    });

    it("a vote created with only the community's key is signed with the community's name at publish", async () => {
        const vote = await pkc.createVote({
            commentCid: targetPost.cid!,
            vote: 1,
            communityAddress: community.signer.address,
            signer: await pkc.createSigner()
        });
        expect(vote.raw.pubsubMessageToPublish?.communityName).to.be.undefined;
        await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
        expect(vote.raw.pubsubMessageToPublish?.communityName).to.equal(domainAddress);
    });
});
