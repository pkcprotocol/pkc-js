import { describe, it, beforeAll, afterAll } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import {
    createSubWithNoChallenge,
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { timestamp } from "../../../../dist/node/util.js";
import { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import { signComment } from "../../../../dist/node/signer/signatures.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentPubsubMessagePublication, CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { PseudonymityAliasRow } from "../../../../dist/node/runtime/node/community/db-handler-types.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:concurrent-alias" });

// Issue #399: the alias lookup in prepareCommentWithAnonymity and the alias insert after storeComment are
// separated by awaits (link props, IPFS add-and-provide), so an author's concurrent first publications each
// found no alias and generated their own.

type ConcurrentAliasMode = "per-post" | "per-author";

const PROTOCOL_VERSION = "1.0.0";

interface ConcurrentAliasContext {
    pkc: PKC;
    community: LocalCommunity;
    cleanup: () => Promise<void>;
}

// Type to access the storePublication facade the pseudonymityMode tests call directly
interface LocalCommunityWithStorePublication {
    storePublication: (args: { comment: CommentPubsubMessagePublication }) => Promise<{ cid: string }>;
}

// Tests read the community's sqlite DB and call storePublication on a LocalCommunity, neither of which
// exists on an RPC client.
describeSkipIfRpc("community.features.pseudonymityMode concurrent alias resolution (issue #399)", () => {
    for (const mode of ["per-post", "per-author"] as const) {
        describe.concurrent(`pseudonymityMode="${mode}"`, () => {
            it("concurrent first replies from one author in one post share a single alias (storePublication)", async () => {
                const context = await createStoreOnlyContext(mode);
                try {
                    const store = context.community as unknown as LocalCommunityWithStorePublication;
                    const opSigner = await context.pkc.createSigner();
                    const authorSigner = await context.pkc.createSigner();
                    const post = await store.storePublication({
                        comment: await buildSignedPublication({ signer: opSigner, communityAddress: context.community.address })
                    });

                    const replies = await Promise.all(
                        [0, 1].map(async () =>
                            store.storePublication({
                                comment: await buildSignedPublication({
                                    signer: authorSigner,
                                    communityAddress: context.community.address,
                                    reply: { postCid: post.cid, parentCid: post.cid }
                                })
                            })
                        )
                    );
                    const laterReply = await store.storePublication({
                        comment: await buildSignedPublication({
                            signer: authorSigner,
                            communityAddress: context.community.address,
                            reply: { postCid: post.cid, parentCid: post.cid }
                        })
                    });

                    const aliasKeys = [...replies, laterReply].map((stored) => aliasRowOf(context.community, stored.cid).aliasPrivateKey);
                    expect(new Set(aliasKeys).size).to.equal(1);
                } finally {
                    await context.cleanup();
                }
            });

            it("concurrent first replies published over pubsub share a single author.address", async () => {
                const context = await createStartedContext(mode);
                try {
                    const opSigner = await context.pkc.createSigner();
                    const authorSigner = await context.pkc.createSigner();
                    const post = await publishRandomPost({
                        communityAddress: context.community.address,
                        pkc: context.pkc,
                        postProps: { signer: opSigner }
                    });

                    const replies = await Promise.all(
                        [0, 1].map(() =>
                            publishRandomReply({
                                parentComment: post as CommentIpfsWithCidDefined,
                                pkc: context.pkc,
                                commentProps: { signer: authorSigner }
                            })
                        )
                    );

                    expect(replies[0].author.address).to.be.a("string");
                    expect(replies[0].author.address).to.not.equal(authorSigner.address);
                    expect(replies[1].author.address).to.equal(replies[0].author.address);
                    await Promise.all([post, ...replies].map((comment) => comment.stop()));
                } finally {
                    await context.cleanup();
                }
            });
        });
    }
});

function aliasRowOf(community: LocalCommunity, cid: string): PseudonymityAliasRow {
    const row = community._dbHandler.queryPseudonymityAliasByCommentCid(cid);
    if (!row) throw Error(`No pseudonymity alias row for ${cid}`);
    return row;
}

async function buildSignedPublication({
    signer,
    communityAddress,
    reply
}: {
    signer: SignerWithPublicKeyAddress;
    communityAddress: string;
    reply?: { postCid: string; parentCid: string };
}) {
    const base = {
        signer,
        communityAddress,
        // A fresh community's address is its public key; the store gate (issue #387) requires it signed.
        communityPublicKey: communityAddress,
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        content: `concurrent-alias-${Math.random()}`,
        ...(reply ?? { title: `concurrent-alias-post-${Math.random()}` })
    };
    const signature = await signComment({ comment: base, pkc: {} as PKC, log: testLog });
    const publication = { ...base, signature } as CommentPubsubMessagePublication & { signer?: SignerWithPublicKeyAddress };
    delete publication.signer;
    return publication;
}

async function createStoreOnlyContext(mode: ConcurrentAliasMode): Promise<ConcurrentAliasContext> {
    const pkc = await mockPKC();
    const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    await community.edit({ features: { pseudonymityMode: mode } });
    await community._dbHandler.initDbIfNeeded({ fileMustExist: false });
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    return {
        pkc,
        community,
        cleanup: async () => {
            await community.delete();
            await pkc.destroy();
        }
    };
}

async function createStartedContext(mode: ConcurrentAliasMode): Promise<ConcurrentAliasContext> {
    const pkc = await mockPKC();
    const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    await community.edit({ features: { pseudonymityMode: mode } });
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    return {
        pkc,
        community,
        cleanup: async () => {
            await community.delete();
            await pkc.destroy();
        }
    };
}
