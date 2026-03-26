import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    publishRandomPost,
    publishRandomReply,
    jsonifyCommentAndRemoveInstanceProps,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst,
    publishWithExpectedResult,
    addStringToIpfs,
    findOrPublishCommentWithDepth,
    waitTillReplyInParentPages,
    findReplyInParentCommentPagesInstancePreloadedAndPageCids
} from "../../../../dist/node/test/test-util.js";
import validCommentWithRepliesFixture from "../../../fixtures/signatures/comment/valid_comment_with_replies_raw.json" with { type: "json" };
import { describe, it, beforeAll, afterAll } from "vitest";
import { calculateIpfsCidV0 } from "../../../../dist/node/util.js";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { PageIpfs, PageTypeJson } from "../../../../dist/node/pages/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

// Helper type for the skipped test that uses toJSON
type CommentWithToJSON = Comment & { toJSON: () => unknown };
// Helper type for casting Comment to required fields for test utilities
type CommentWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`plebbit.createComment - Remote (${config.name})`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it.skip(`comment = await createComment(await createComment)`, async () => {
            // For now we're not supporting creating a comment instance from another instance
            const props = {
                content: `test comment = await createComment(await createComment) ${Date.now()}`,
                communityAddress: subplebbitAddress,
                author: {
                    address: signers[4].address,
                    displayName: `Mock Author - comment = await createComment(await createComment)`
                },
                signer: signers[4],
                timestamp: 2345324
            };
            const comment = await plebbit.createComment(props);

            const nestedComment = await plebbit.createComment(comment);

            expect(comment.content).to.equal(props.content);
            expect(comment.communityAddress).to.equal(props.communityAddress);
            expect(comment.author.address).to.equal(props.author.address);
            expect(comment.author.displayName).to.equal(props.author.displayName);
            expect(comment.timestamp).to.equal(props.timestamp);

            expect((comment as CommentWithToJSON).toJSON()).to.deep.equal((nestedComment as CommentWithToJSON).toJSON());
        });

        it(`Can recreate a stringifed local Comment instance before publishing with plebbit.createComment`, async () => {
            const localComment = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const commentClone = await plebbit.createComment(JSON.parse(JSON.stringify(localComment)));
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            const localCommentJson = jsonifyCommentAndRemoveInstanceProps(localComment);

            expect(localCommentJson).to.deep.equal(commentCloneJson);
        });

        it(`normalizes a domain passed via author.address into wire author.name`, async () => {
            const domain = "normalized-author-address.bso";
            const displayName = `Mock Author - ${Date.now()}`;
            const comment = await plebbit.createComment({
                communityAddress: subplebbitAddress,
                author: { address: domain, displayName },
                title: `test title ${Date.now()}`,
                content: `test content ${Date.now()}`,
                signer: signers[6]
            });

            expect(comment.author.address).to.equal(domain);
            expect(comment.author.name).to.equal(domain);
            expect(comment.author.displayName).to.equal(displayName);
            expect(comment.raw.pubsubMessageToPublish!.author).to.deep.equal({
                name: domain,
                displayName
            });
            expect(comment.raw.pubsubMessageToPublish!.author).to.not.have.property("address");
        });

        it(`Can recreate a stringifed local Comment instance after publishing with plebbit.createComment`, async () => {
            const localComment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            expect(localComment.author.subplebbit).to.be.a("object"); // should get it from subplebbit
            const commentClone = await plebbit.createComment(JSON.parse(JSON.stringify(localComment)));
            expect(commentClone.author.subplebbit).to.be.a("object"); // should get it from subplebbit
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            const localCommentJson = jsonifyCommentAndRemoveInstanceProps(localComment);

            expect(localCommentJson).to.deep.equal(commentCloneJson);
        });

        it(`Can recreate a stringified local comment instance after comment.update() with plebbit.createComment`, async () => {
            const localComment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            await localComment.update();
            await resolveWhenConditionIsTrue({ toUpdate: localComment, predicate: async () => typeof localComment.updatedAt === "number" });
            await localComment.stop();
            const commentClone = await plebbit.createComment(JSON.parse(JSON.stringify(localComment)));
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            expect(commentCloneJson.signer).to.be.a("object");
            const localCommentJson = jsonifyCommentAndRemoveInstanceProps(localComment);
            expect(localCommentJson).to.deep.equal(commentCloneJson);
        });

        it(`Can create a Comment instance with subplebbit.posts.pages.hot.comments[0]`, async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const commentFromPage = subplebbit.posts.pages.hot.comments[0];
            const commentClone = await plebbit.createComment(commentFromPage);
            const commentCloneJson = jsonifyCommentAndRemoveInstanceProps(commentClone);
            const commentFromPageJson = jsonifyCommentAndRemoveInstanceProps(commentFromPage as unknown as Comment);

            expect(commentCloneJson).to.deep.equal(commentFromPageJson);
        });

        it(`Creating a comment with only cid and subplebbit address, then passing it to another plebbit.createComment should get us both cid and subplebbitAddress`, async () => {
            const randomCid = await calculateIpfsCidV0("Hello" + Math.random());
            const originalComment = await plebbit.createComment({ cid: randomCid, communityAddress: subplebbitAddress });
            expect(originalComment.cid).to.equal(randomCid);
            expect(originalComment.communityAddress).to.equal(subplebbitAddress);

            const anotherComment = await plebbit.createComment(originalComment);
            expect(anotherComment.cid).to.equal(randomCid);
            expect(anotherComment.communityAddress).to.equal(subplebbitAddress);
        });

        it(`Creating comment instances from all subplebbit.pages comments doesn't mutate props`, async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const pages = subplebbit.posts.pages || {};
            expect(Object.keys(pages).length, "subplebbit.posts.pages should not be empty").to.be.greaterThan(0);
            let testedComments = 0;

            for (const [pageName, page] of Object.entries(pages) as [string, PageTypeJson | undefined][]) {
                if (!page?.comments?.length) continue;

                for (const pageComment of page.comments) {
                    const originalJson = jsonifyCommentAndRemoveInstanceProps(pageComment as unknown as Comment);

                    const commentClone = await plebbit.createComment(pageComment);
                    const commentCloneFromStringified = await plebbit.createComment(JSON.parse(JSON.stringify(pageComment)));
                    const commentCloneFromSpread = await plebbit.createComment({ ...pageComment });
                    const commentCloneFromRaw = await plebbit.createComment({
                        raw: (pageComment as unknown as Comment).raw
                    } as unknown as Parameters<typeof plebbit.createComment>[0]);

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
                    ).to.deep.equal(originalJson);

                    testedComments += 1;
                }
            }

            expect(testedComments).to.be.greaterThan(0);
        });

        it(`Can recreate a Comment instance with replies with plebbit.createComment`, async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const postWithReplyToCloneFromPage = subplebbit.posts.pages.hot.comments.find((comment) => comment.replies);
            expect(postWithReplyToCloneFromPage!.replies).to.be.a("object");
            const commentCloneInstance = await plebbit.createComment(postWithReplyToCloneFromPage!);
            expect(commentCloneInstance.replies).to.be.a("object");
            const commentCloneInstanceJson = jsonifyCommentAndRemoveInstanceProps(commentCloneInstance);
            const commentToCloneFromPageJson = jsonifyCommentAndRemoveInstanceProps(postWithReplyToCloneFromPage as unknown as Comment);
            expect(commentToCloneFromPageJson).to.deep.equal(commentCloneInstanceJson);
        });

        it(`Can recreate a stringified Comment instance with replies with plebbit.createComment`, async () => {
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const postWithReplyToCloneFromPage = subplebbit.posts.pages.hot.comments.find((comment) => comment.replies);
            expect(postWithReplyToCloneFromPage!.replies).to.be.a("object");
            const commentCloneInstance = await plebbit.createComment(JSON.parse(JSON.stringify(postWithReplyToCloneFromPage)));
            expect(commentCloneInstance.replies).to.be.a("object");
            const commentCloneInstanceJson = jsonifyCommentAndRemoveInstanceProps(commentCloneInstance);
            const commentToCloneFromPageJson = jsonifyCommentAndRemoveInstanceProps(postWithReplyToCloneFromPage as unknown as Comment);
            expect(commentCloneInstanceJson).to.deep.equal(commentToCloneFromPageJson);
        });

        it(`Can recreate a stringified Post instance with plebbit.createComment`, async () => {
            const post = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const postFromStringifiedPost = await plebbit.createComment(JSON.parse(JSON.stringify(post)));
            const postJson = jsonifyCommentAndRemoveInstanceProps(post);
            const postFromStringifiedPostJson = jsonifyCommentAndRemoveInstanceProps(postFromStringifiedPost);
            expect(postJson).to.deep.equal(postFromStringifiedPostJson);
        });

        it.sequential("comment instance created with {subplebbitAddress, cid, depth, postCid} prop can call getPage", async () => {
            const post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            expect(post.replies).to.be.a("object");
            await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => post.replyCount >= 1 });
            expect(post.content).to.be.a("string");
            expect(post.replyCount).to.be.at.least(1);
            expect(post.replies.pages.best.comments.length).to.be.at.least(1);

            await post.stop();

            const pageCid = await addStringToIpfs(JSON.stringify({ comments: [post.replies.pages.best["comments"][0].raw] }));
            expect(pageCid).to.be.a("string");

            const postClone = await plebbit.createComment({
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
                communityAddress: subplebbitAddress,
                plebbit: plebbit,
                postProps: { author: { shortAddress: "12345" } }
            });
            expect(comment.author.shortAddress).to.be.a("string").and.not.equal("12345");
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });

            const commentLoaded = await plebbit.getComment({ cid: comment.cid });
            expect(commentLoaded.author.shortAddress).to.be.a("string").and.not.equal("12345");
        });

        it(`Can create a new comment with author.subplebbit and publish it`, async () => {
            // it should delete author.sublebbit before publishing however
            const comment = await generateMockPost({
                communityAddress: subplebbitAddress,
                plebbit: plebbit,
                postProps: { author: { subplebbit: { postScore: 100 } } }
            });
            expect(comment.author.subplebbit).to.be.undefined;
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });

            const commentLoaded = await plebbit.getComment({ cid: comment.cid });
            expect(commentLoaded.author.subplebbit).to.be.undefined;
        });

        it(`Can create comment with {communityAddress: string, cid: string}`, async () => {
            const cid = "QmQ9mK33zshLf4Bj8dVSQimdbyXGgw5QFRoUQpsCqqz6We";
            const comment = await plebbit.createComment({ cid, communityAddress: subplebbitAddress });
            expect(comment.cid).to.equal(cid);
            expect(comment.communityAddress).to.equal(subplebbitAddress);
        });

        it(`Can create a comment with replies.pages`, async () => {
            const comment = await plebbit.createComment(
                validCommentWithRepliesFixture as unknown as Parameters<typeof plebbit.createComment>[0]
            );
            expect(comment.cid).to.equal(validCommentWithRepliesFixture.raw.commentUpdate.cid);
            expect(comment.replies.pages.best.comments.length).to.equal(
                validCommentWithRepliesFixture.raw.commentUpdate.replies.pages.best.comments.length
            );
        });

        it(`Can create a comment with eth and sol wallets`, async () => {
            const fixture = {
                communityAddress: subplebbitAddress,
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

            const comment = await plebbit.createComment(fixture as Parameters<typeof plebbit.createComment>[0]);
            expect(comment.author.address).to.equal(fixture.author.address);
            expect(comment.author.shortAddress).to.equal(fixture.signer.shortAddress);
            expect(comment.author.wallets!.eth!.address).to.equal(fixture.author.wallets.eth.address);
            expect(comment.author.wallets!.sol!.address).to.equal(fixture.author.wallets.sol.address);
            expect(comment.signer!.address).to.equal(fixture.signer.address);
            expect((comment.signer as typeof fixture.signer).shortAddress).to.equal(fixture.signer.shortAddress);
            expect(comment.communityAddress).to.equal(fixture.communityAddress);
        });

        it(`Creating a comment with commentUpdate.approved=false will set pendingApproval=false`, async () => {
            const comment = await plebbit.createComment({
                raw: {
                    comment: validCommentWithRepliesFixture.raw.comment,
                    commentUpdate: { ...validCommentWithRepliesFixture.raw.commentUpdate, approved: false }
                }
            } as unknown as Parameters<typeof plebbit.createComment>[0]);

            expect(comment.approved).to.equal(false);
            expect(comment.pendingApproval).to.equal(false);
        });

        it(`Creating a post that exists in updating subplebbit posts should automatically get CommentIpfs and CommentUpdate from it`, async () => {
            const subplebbit = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await subplebbit.update();
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

            expect(plebbit._updatingSubplebbits[subplebbit.address]).to.be.ok;

            const postCid = subplebbit.posts.pages.hot.comments[0].cid;

            const post = await plebbit.createComment({ cid: postCid });
            expect(post.raw.comment).to.be.ok;
            expect(post.raw.commentUpdate).to.be.ok;
            expect(post.timestamp).to.be.a("number");
            expect(post.updatedAt).to.be.a("number");
            await subplebbit.stop();
        });

        [1, 2, 3, 5, 10].forEach((replyDepth) => {
            it.sequential(
                `Creating a reply with depth ${replyDepth} that exists in updating parent replies preloaded pages should automatically get CommentIpfs and CommentUpdate from it`,
                async () => {
                    // TODO how do you guarantee reply with this depth will be there?

                    const parentComment = await findOrPublishCommentWithDepth({
                        subplebbit: await plebbit.getSubplebbit({ address: subplebbitAddress }),
                        depth: replyDepth - 1
                    });
                    await parentComment.update();
                    await resolveWhenConditionIsTrue({
                        toUpdate: parentComment,
                        predicate: async () => typeof parentComment.updatedAt === "number"
                    });

                    expect(plebbit._updatingComments[parentComment.cid!]).to.be.ok;

                    const reply = await publishRandomReply({ parentComment: parentComment as CommentIpfsWithCidDefined, plebbit: plebbit });

                    await waitTillReplyInParentPages(reply as CommentWithRequiredFields, plebbit);
                    const replyInPage = await findReplyInParentCommentPagesInstancePreloadedAndPageCids({
                        parentComment,
                        reply: reply as CommentWithRequiredFields
                    });

                    await reply.stop();
                    expect(plebbit._updatingComments[parentComment.cid!]).to.be.ok;
                    expect(plebbit._updatingComments[reply.cid!]).to.be.undefined;

                    // we need to include replyInPage forcibly in parent comment replies pages

                    for (const preloadedPages of Object.values(plebbit._updatingComments[parentComment.cid!].replies.pages)) {
                        preloadedPages.comments.push(replyInPage!);
                    }

                    const replyRecreated = await plebbit.createComment({ cid: reply.cid });

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
