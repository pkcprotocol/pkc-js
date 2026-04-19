import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    publishRandomPost,
    publishRandomReply,
    jsonifyCommentAndRemoveInstanceProps,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    publishWithExpectedResult,
    addStringToIpfs,
    findOrPublishCommentWithDepth,
    waitTillReplyInParentPages,
    findReplyInParentCommentPagesInstancePreloadedAndPageCids
} from "../../../../dist/node/test/test-util.js";
import validCommentWithRepliesFixture from "../../../fixtures/signatures/comment/valid_comment_with_replies_raw.json" with { type: "json" };
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { calculateIpfsCidV0 } from "../../../../dist/node/util.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { PageIpfs, PageTypeJson } from "../../../../dist/node/pages/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type Publication from "../../../../dist/node/publications/publication.js";

// Helper type for the skipped test that uses toJSON
type CommentWithToJSON = Comment & { toJSON: () => unknown };
// Helper type for casting Comment to required fields for test utilities
type CommentWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`pkc.createComment - Remote (${config.name})`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.skip(`comment = await createComment(await createComment)`, async () => {
            // For now we're not supporting creating a comment instance from another instance
            const props = {
                content: `test comment = await createComment(await createComment) ${Date.now()}`,
                communityAddress: communityAddress,
                author: {
                    address: signers[4].address,
                    displayName: `Mock Author - comment = await createComment(await createComment)`
                },
                signer: signers[4],
                timestamp: 2345324
            };
            const comment = await pkc.createComment(props);

            const nestedComment = await pkc.createComment(comment);

            expect(comment.content).to.equal(props.content);
            expect(comment.communityAddress).to.equal(props.communityAddress);
            expect(comment.author.address).to.equal(props.author.address);
            expect(comment.author.displayName).to.equal(props.author.displayName);
            expect(comment.timestamp).to.equal(props.timestamp);

            expect((comment as CommentWithToJSON).toJSON()).to.deep.equal((nestedComment as CommentWithToJSON).toJSON());
        });

        it(`Can recreate a stringifed local Comment instance before publishing with pkc.createComment`, async () => {
            const localComment = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            const commentClone = await pkc.createComment(JSON.parse(JSON.stringify(localComment)));
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            const localCommentJson = jsonifyCommentAndRemoveInstanceProps(localComment);

            expect(localCommentJson).to.deep.equal(commentCloneJson);
        });

        it(`normalizes a domain passed via author.address into wire author.name`, async () => {
            const domain = "normalized-author-address.bso";
            const displayName = `Mock Author - ${Date.now()}`;
            const comment = await pkc.createComment({
                communityAddress: communityAddress,
                author: { address: domain, displayName },
                title: `test title ${Date.now()}`,
                content: `test content ${Date.now()}`,
                signer: signers[6]
            });

            expect(comment.author.address).to.equal(domain);
            expect(comment.author.name).to.equal(domain);
            expect(comment.author.displayName).to.equal(displayName);
            const wireAuthor =
                comment.raw.pubsubMessageToPublish?.author ?? (comment.raw as Publication["raw"]).unsignedPublicationOptions!.author;
            expect(wireAuthor).to.deep.equal({
                name: domain,
                displayName
            });
            expect(wireAuthor).to.not.have.property("address");
        });

        it(`Can recreate a stringifed local Comment instance after publishing with pkc.createComment`, async () => {
            const localComment = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            expect(localComment.author.community).to.be.a("object"); // should get it from community
            const commentClone = await pkc.createComment(JSON.parse(JSON.stringify(localComment)));
            expect(commentClone.author.community).to.be.a("object"); // should get it from community
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            const localCommentJson = jsonifyCommentAndRemoveInstanceProps(localComment);

            expect(localCommentJson).to.deep.equal(commentCloneJson);
        });

        it(`Can recreate a stringified local comment instance after comment.update() with pkc.createComment`, async () => {
            const localComment = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await localComment.update();
            await resolveWhenConditionIsTrue({ toUpdate: localComment, predicate: async () => typeof localComment.updatedAt === "number" });
            await localComment.stop();
            const commentClone = await pkc.createComment(JSON.parse(JSON.stringify(localComment)));
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            expect(commentCloneJson.signer).to.be.a("object");
            const localCommentJson = jsonifyCommentAndRemoveInstanceProps(localComment);
            expect(localCommentJson).to.deep.equal(commentCloneJson);
        });

        it(`Can create a Comment instance with community.posts.pages.hot.comments[0]`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const commentFromPage = community.posts.pages.hot.comments[0];
            const commentClone = await pkc.createComment(commentFromPage);
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            const commentFromPageJson = jsonifyCommentAndRemoveInstanceProps(commentFromPage as unknown as Comment);

            expect(commentCloneJson).to.deep.equal(commentFromPageJson);
        });

        it(`Creating a comment with only cid and community address, then passing it to another pkc.createComment should get us both cid and communityAddress`, async () => {
            const randomCid = await calculateIpfsCidV0("Hello" + Math.random());
            const originalComment = await pkc.createComment({ cid: randomCid, communityAddress: communityAddress });
            expect(originalComment.cid).to.equal(randomCid);
            expect(originalComment.communityAddress).to.equal(communityAddress);

            const anotherComment = await pkc.createComment(originalComment);
            expect(anotherComment.cid).to.equal(randomCid);
            expect(anotherComment.communityAddress).to.equal(communityAddress);
        });

        it(`Creating comment instances from all community.pages comments doesn't mutate props`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const pages = community.posts.pages || {};
            expect(Object.keys(pages).length, "community.posts.pages should not be empty").to.be.greaterThan(0);
            let testedComments = 0;

            for (const [pageName, page] of Object.entries(pages) as [string, PageTypeJson | undefined][]) {
                if (!page?.comments?.length) continue;

                for (const pageComment of page.comments) {
                    const originalJson = jsonifyCommentAndRemoveInstanceProps(pageComment as unknown as Comment);
                    const originalJsonFromRaw = JSON.parse(JSON.stringify(originalJson)) as Record<string, unknown>;
                    const originalAuthorFromRaw = originalJsonFromRaw.author;
                    if (
                        typeof originalAuthorFromRaw === "object" &&
                        originalAuthorFromRaw !== null &&
                        "nameResolved" in originalAuthorFromRaw
                    )
                        delete (originalAuthorFromRaw as { nameResolved?: boolean }).nameResolved;

                    const commentClone = await pkc.createComment(pageComment);
                    const commentCloneFromStringified = await pkc.createComment(JSON.parse(JSON.stringify(pageComment)));
                    const commentCloneFromSpread = await pkc.createComment({ ...pageComment });
                    const commentCloneFromRaw = await pkc.createComment({
                        raw: (pageComment as unknown as Comment).raw
                    } as unknown as Parameters<typeof pkc.createComment>[0]);

                    expect(
                        jsonifyCommentAndRemoveInstanceProps(pageComment as unknown as Comment),
                        `comment from ${pageName} page changed after cloning`
                    ).to.deep.equal(originalJson);
                    expect(
                        jsonifyCommentAndRemoveInstanceProps(commentClone),
                        `createComment mutated props for page ${pageName}`
                    ).to.deep.equal(originalJson);
                    expect(
                        jsonifyCommentAndRemoveInstanceProps(commentCloneFromStringified),
                        `JSON.parse(JSON.stringify()) mutated props for page ${pageName}`
                    ).to.deep.equal(originalJson);
                    expect(
                        jsonifyCommentAndRemoveInstanceProps(commentCloneFromSpread),
                        `{...pageComment} mutated props for page ${pageName}`
                    ).to.deep.equal(originalJson);
                    expect(
                        jsonifyCommentAndRemoveInstanceProps(commentCloneFromRaw),
                        `{raw: pageComment.raw} mutated props for page ${pageName}`
                    ).to.deep.equal(originalJsonFromRaw);

                    testedComments += 1;
                }
            }

            expect(testedComments).to.be.greaterThan(0);
        });

        it(`Can recreate a Comment instance with replies with pkc.createComment`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const postWithReplyToCloneFromPage = community.posts.pages.hot.comments.find((comment) => comment.replies);
            expect(postWithReplyToCloneFromPage!.replies).to.be.a("object");
            const commentCloneInstance = await pkc.createComment(postWithReplyToCloneFromPage!);
            expect(commentCloneInstance.replies).to.be.a("object");
            const commentCloneInstanceJson = jsonifyCommentAndRemoveInstanceProps(commentCloneInstance);
            const commentToCloneFromPageJson = jsonifyCommentAndRemoveInstanceProps(postWithReplyToCloneFromPage as unknown as Comment);
            expect(commentToCloneFromPageJson).to.deep.equal(commentCloneInstanceJson);
        });

        it(`Can recreate a stringified Comment instance with replies with pkc.createComment`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const postWithReplyToCloneFromPage = community.posts.pages.hot.comments.find((comment) => comment.replies);
            expect(postWithReplyToCloneFromPage!.replies).to.be.a("object");
            const commentCloneInstance = await pkc.createComment(JSON.parse(JSON.stringify(postWithReplyToCloneFromPage)));
            expect(commentCloneInstance.replies).to.be.a("object");
            const commentCloneInstanceJson = jsonifyCommentAndRemoveInstanceProps(commentCloneInstance);
            const commentToCloneFromPageJson = jsonifyCommentAndRemoveInstanceProps(postWithReplyToCloneFromPage as unknown as Comment);
            expect(commentCloneInstanceJson).to.deep.equal(commentToCloneFromPageJson);
        });

        it(`Can recreate a stringified Post instance with pkc.createComment`, async () => {
            const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            const postFromStringifiedPost = await pkc.createComment(JSON.parse(JSON.stringify(post)));
            const postJson = jsonifyCommentAndRemoveInstanceProps(post);
            const postFromStringifiedPostJson = jsonifyCommentAndRemoveInstanceProps(postFromStringifiedPost);
            expect(postJson).to.deep.equal(postFromStringifiedPostJson);
        });

        it.sequential("comment instance created with {communityAddress, cid, depth, postCid} prop can call getPage", async () => {
            const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            expect(post.replies).to.be.a("object");
            await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => post.replyCount >= 1 });
            expect(post.content).to.be.a("string");
            expect(post.replyCount).to.be.at.least(1);
            expect(post.replies.pages.best.comments.length).to.be.at.least(1);

            await post.stop();

            const pageCid = await addStringToIpfs(JSON.stringify({ comments: [post.replies.pages.best["comments"][0].raw] }));
            expect(pageCid).to.be.a("string");

            const postClone = await pkc.createComment({
                communityAddress: post.communityAddress,
                cid: post.cid,
                depth: post.depth,
                postCid: post.postCid
            });
            expect(postClone.content).to.be.undefined;
            expect(postClone.communityAddress).to.equal(post.communityAddress);
            expect(postClone.cid).to.equal(post.cid);
            expect(postClone.depth).to.equal(post.depth);
            expect(postClone.postCid).to.equal(post.postCid);

            postClone.replies.pageCids.new = pageCid; // mock it to have pageCids
            const page = await postClone.replies.getPage({ cid: pageCid });
            expect(page.comments.length).to.be.equal(1);
        });

        it(`Can create a new comment with author.shortAddress and publish it`, async () => {
            // it should delete author.shortAddress before publishing however
            const comment = await generateMockPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: { author: { shortAddress: "12345" } }
            });
            expect(comment.author.shortAddress).to.be.a("string").and.not.equal("12345");
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });

            const commentLoaded = await pkc.getComment({ cid: comment.cid });
            expect(commentLoaded.author.shortAddress).to.be.a("string").and.not.equal("12345");
        });

        it(`Can create a new comment with author.community and publish it`, async () => {
            // it should delete author.sublebbit before publishing however
            const comment = await generateMockPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: { author: { community: { postScore: 100 } } }
            });
            expect(comment.author.community).to.be.undefined;
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });

            const commentLoaded = await pkc.getComment({ cid: comment.cid });
            expect(commentLoaded.author.community).to.be.undefined;
        });

        it(`Can create comment with {communityAddress: string, cid: string}`, async () => {
            const cid = "QmQ9mK33zshLf4Bj8dVSQimdbyXGgw5QFRoUQpsCqqz6We";
            const comment = await pkc.createComment({ cid, communityAddress: communityAddress });
            expect(comment.cid).to.equal(cid);
            expect(comment.communityAddress).to.equal(communityAddress);
        });

        it(`Can create a comment with replies.pages`, async () => {
            const comment = await pkc.createComment(validCommentWithRepliesFixture as unknown as Parameters<typeof pkc.createComment>[0]);
            expect(comment.cid).to.equal(validCommentWithRepliesFixture.raw.commentUpdate.cid);
            expect(comment.replies.pages.best.comments.length).to.equal(
                validCommentWithRepliesFixture.raw.commentUpdate.replies.pages.best.comments.length
            );
        });

        it(`Can create a comment with eth and sol wallets`, async () => {
            const fixture = {
                communityAddress: communityAddress,
                content: "test comment creation with eth and sol wallets",
                author: {
                    address: "12D3KooWKoXpxTwfnjA5ExuFbeverNKhjKy6a4KesBSh3e6VLaW5",
                    wallets: {
                        eth: {
                            address: "0x37BC48124fDf985DC3983E2e8414606D4a996ED7",
                            timestamp: 1748048717754,
                            signature: {
                                signature:
                                    "0x2812fcfb5001685eb7e7f88bee720b5c761e2e194750265b7d74d69549dd59f05ec6dc2a77afe3b14022a48dd7569f91f2d36701380c953f6769579733843cf61c",
                                type: "eip191"
                            }
                        },
                        sol: {
                            address: "AzAfDLMxbptaq5Ppy4BK5aEsEzvTYNFAub5ffewbSdn9",
                            timestamp: 1748048718136,
                            signature: {
                                signature: "3VfcyEbzrAiK7AowGgJrzjS5Y5amXEXCYhcUgd7RUZQ8uMRQvDPa12VJjMPjt47rnwGE71ZL76h7LT9qFbueZbDx",
                                type: "sol"
                            }
                        }
                    }
                },
                signer: {
                    type: "ed25519",
                    privateKey: "mV8GRU5TGScen7UYZOuNQQ1CKe2G46DCc60moM1yLF4",
                    publicKey: "lF41sWk/JHHdfQSH5VAR55uGZp0/Cv9/xXxwS+vOOVI",
                    address: "12D3KooWKoXpxTwfnjA5ExuFbeverNKhjKy6a4KesBSh3e6VLaW5",
                    shortAddress: "KoXpxTwfnjA5"
                }
            };

            const comment = await pkc.createComment(fixture as Parameters<typeof pkc.createComment>[0]);
            expect(comment.author.address).to.equal(fixture.author.address);
            expect(comment.author.shortAddress).to.equal(fixture.signer.shortAddress);
            expect(comment.author.wallets!.eth!.address).to.equal(fixture.author.wallets.eth.address);
            expect(comment.author.wallets!.sol!.address).to.equal(fixture.author.wallets.sol.address);
            expect(comment.signer!.address).to.equal(fixture.signer.address);
            expect((comment.signer as typeof fixture.signer).shortAddress).to.equal(fixture.signer.shortAddress);
            expect(comment.communityAddress).to.equal(fixture.communityAddress);
        });

        it(`Creating a comment with commentUpdate.approved=false will set pendingApproval=false`, async () => {
            const comment = await pkc.createComment({
                raw: {
                    comment: validCommentWithRepliesFixture.raw.comment,
                    commentUpdate: { ...validCommentWithRepliesFixture.raw.commentUpdate, approved: false }
                }
            } as unknown as Parameters<typeof pkc.createComment>[0]);

            expect(comment.approved).to.equal(false);
            expect(comment.pendingApproval).to.equal(false);
        });

        it(`Creating a post that exists in updating community posts should automatically get CommentIpfs and CommentUpdate from it`, async () => {
            const community = await pkc.createCommunity({ address: communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            expect(pkc._updatingCommunities[community.address]).to.be.ok;

            const postCid = community.posts.pages.hot.comments[0].cid;

            const post = await pkc.createComment({ cid: postCid });
            expect(post.raw.comment).to.be.ok;
            expect(post.raw.commentUpdate).to.be.ok;
            expect(post.timestamp).to.be.a("number");
            expect(post.updatedAt).to.be.a("number");
            await community.stop();
        });

        [1, 2, 3, 5, 10].forEach((replyDepth) => {
            it.sequential(
                `Creating a reply with depth ${replyDepth} that exists in updating parent replies preloaded pages should automatically get CommentIpfs and CommentUpdate from it`,
                async () => {
                    // TODO how do you guarantee reply with this depth will be there?

                    const parentComment = await findOrPublishCommentWithDepth({
                        community: await pkc.getCommunity({ address: communityAddress }),
                        depth: replyDepth - 1
                    });
                    await parentComment.update();
                    await resolveWhenConditionIsTrue({
                        toUpdate: parentComment,
                        predicate: async () => typeof parentComment.updatedAt === "number"
                    });

                    expect(pkc._updatingComments[parentComment.cid!]).to.be.ok;

                    const reply = await publishRandomReply({ parentComment: parentComment as CommentIpfsWithCidDefined, pkc: pkc });

                    await waitTillReplyInParentPages(reply as CommentWithRequiredFields, pkc);
                    const replyInPage = await findReplyInParentCommentPagesInstancePreloadedAndPageCids({
                        parentComment,
                        reply: reply as CommentWithRequiredFields
                    });

                    await reply.stop();
                    expect(pkc._updatingComments[parentComment.cid!]).to.be.ok;
                    expect(pkc._updatingComments[reply.cid!]).to.be.undefined;

                    // we need to include replyInPage forcibly in parent comment replies pages

                    for (const preloadedPages of Object.values(pkc._updatingComments[parentComment.cid!].replies.pages)) {
                        preloadedPages.comments.push(replyInPage!);
                    }

                    const replyRecreated = await pkc.createComment({ cid: reply.cid });

                    expect(replyRecreated.raw.comment).to.be.ok;
                    expect(replyRecreated.raw.commentUpdate).to.be.ok;
                    expect(replyRecreated.timestamp).to.be.a("number");
                    expect(replyRecreated.updatedAt).to.be.a("number");
                    await parentComment.stop();
                }
            );
        });
    });
});
