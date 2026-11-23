import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    createSubWithNoChallenge,
    generateMockPost,
    mockPKC,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { derivePseudonymityTagSharedKey, computePseudonymityAuthorTag } from "../../../../dist/node/signer/pseudonymity-author-tag.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import type { CommentUpdatesRow } from "../../../../dist/node/publications/comment/types.js";

// Integration for the community-issued pseudonymity author tag (issue #381). Uses LocalCommunity and
// its DB directly, so it cannot run under RPC. See docs/protocol/pseudonymity-author-tag.md.

// Re-derive the tag the way a second device would: from the author's own private key and the key that
// signed the CommentUpdate (community.signer.publicKey).
function reproduceTag(authorPrivateKeyBase64: string, communityPublicKeyBase64: string, cid: string): string {
    const sharedKey = derivePseudonymityTagSharedKey({
        communityPrivateKeyBase64: authorPrivateKeyBase64,
        authorPublicKeyBase64: communityPublicKeyBase64
    });
    return computePseudonymityAuthorTag({ sharedKey, commentCid: cid });
}

async function publishPostAndWaitForTaggedUpdate(
    community: LocalCommunity,
    pkc: PKC,
    signer: SignerWithPublicKeyAddress
): Promise<{ cid: string; storedTag: string | undefined }> {
    const post = await generateMockPost({ communityAddress: community.address, pkc, postProps: { signer } });
    await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    const cid = post.cid!;
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => {
            const stored = community._dbHandler.queryStoredCommentUpdate({ cid }) as CommentUpdatesRow | undefined;
            return typeof stored?.updatedAt === "number";
        }
    });
    const stored = community._dbHandler.queryStoredCommentUpdate({ cid }) as CommentUpdatesRow | undefined;
    return { cid, storedTag: stored?.pseudonymityAuthorTag };
}

describeSkipIfRpc("pseudonymity author tag (issue #381)", () => {
    for (const mode of ["per-post", "per-author"] as const) {
        describe(`pseudonymityMode="${mode}"`, () => {
            let pkc: PKC;
            let community: LocalCommunity;

            beforeAll(async () => {
                pkc = await mockPKC();
                community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
                await community.edit({ features: { pseudonymityMode: mode } });
                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            });

            afterAll(async () => {
                await community?.delete();
                await pkc?.destroy();
            });

            it("an aliased comment's CommentUpdate carries a tag the author's key reproduces", async () => {
                const signer = await pkc.createSigner();
                const { cid, storedTag } = await publishPostAndWaitForTaggedUpdate(community, pkc, signer);

                expect(storedTag, "aliased comment must carry a tag").to.be.a("string");
                expect(storedTag).to.have.lengthOf(22);
                // The community re-signs the CommentUpdate with its own signer; that key is what the author derives against.
                expect(storedTag).to.equal(reproduceTag(signer.privateKey, community.signer.publicKey, cid));
            });

            it("a different account's key does not reproduce the tag", async () => {
                const signer = await pkc.createSigner();
                const otherSigner = await pkc.createSigner();
                const { cid, storedTag } = await publishPostAndWaitForTaggedUpdate(community, pkc, signer);

                expect(storedTag).to.be.a("string");
                expect(storedTag).to.not.equal(reproduceTag(otherSigner.privateKey, community.signer.publicKey, cid));
            });

            it("two comments by the same author have different tags (unlinkable without the key)", async () => {
                const signer = await pkc.createSigner();
                const first = await publishPostAndWaitForTaggedUpdate(community, pkc, signer);
                const second = await publishPostAndWaitForTaggedUpdate(community, pkc, signer);

                expect(first.storedTag).to.be.a("string");
                expect(second.storedTag).to.be.a("string");
                expect(first.storedTag).to.not.equal(second.storedTag);
            });

            it("the tag is exposed on the Comment instance after update()", async () => {
                const signer = await pkc.createSigner();
                const { cid } = await publishPostAndWaitForTaggedUpdate(community, pkc, signer);

                const loaded = await pkc.createComment({ cid, communityAddress: community.address });
                await loaded.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: loaded,
                    predicate: async () => typeof (loaded as Comment).pseudonymityAuthorTag === "string"
                });
                await loaded.stop();
                expect((loaded as Comment).pseudonymityAuthorTag).to.equal(
                    reproduceTag(signer.privateKey, community.signer.publicKey, cid)
                );
            });
        });
    }

    describe("non-pseudonymous board", () => {
        let pkc: PKC;
        let community: LocalCommunity;

        beforeAll(async () => {
            pkc = await mockPKC();
            community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        });

        afterAll(async () => {
            await community?.delete();
            await pkc?.destroy();
        });

        it("no comment carries a tag when the board has no pseudonymityMode", async () => {
            const signer = await pkc.createSigner();
            const { storedTag } = await publishPostAndWaitForTaggedUpdate(community, pkc, signer);
            expect(storedTag).to.be.undefined;
        });
    });
});
