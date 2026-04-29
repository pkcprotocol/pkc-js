import PKCIndex from "../index.js";
import { calculateStringSizeSameAsIpfsAddCidV0, removeUndefinedValuesRecursively, retryKuboIpfsAdd, timestamp } from "../util.js";
import retry from "retry";
import { getCommunityAddressFromRecord } from "../publications/publication-community.js";
import { Comment } from "../publications/comment/comment.js";
import { PKC } from "../pkc/pkc.js";
import Vote from "../publications/vote/vote.js";
import { RemoteCommunity } from "../community/remote-community.js";
import type { InputPKCOptions, NameResolver } from "../types.js";
import assert from "assert";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import Publication from "../publications/publication.js";
import { v4 as uuidv4 } from "uuid";
import { createMockPubsubClient } from "./mock-ipfs-client.js";
import { EventEmitter } from "events";
import Logger from "../logger.js";
import * as remeda from "remeda";
import { LocalCommunity } from "../runtime/node/community/local-community.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import { findUpdatingComment, findUpdatingCommunity } from "../pkc/tracked-instance-registry-util.js";
import type {
    CreateNewLocalCommunityUserOptions,
    LocalCommunityJson,
    CommunityIpfsType,
    CommunityChallengeSetting
} from "../community/types.js";
import type { SignerType } from "../signer/types.js";
import type { CreateVoteOptions } from "../publications/vote/types.js";
import type {
    CommentIpfsWithCidDefined,
    CommentIpfsWithCidPostCidDefined,
    CommentsTableRow,
    CommentWithinRepliesPostsPageJson,
    CreateCommentOptions,
    CommentPubsubMessagePublication,
    CommentOptionsToSign
} from "../publications/comment/types.js";
import pTimeout from "p-timeout";

import {
    signComment,
    _signJson,
    signCommentEdit,
    cleanUpBeforePublishing,
    _signPubsubMsg,
    signChallengeVerification,
    signCommunity
} from "../signer/signatures.js";
import { BasePages, PostsPages, RepliesPages } from "../pages/pages.js";
import {
    findCommentInHierarchicalPageIpfsRecursively,
    findCommentInPageInstance,
    findCommentInPageInstanceRecursively,
    mapPageIpfsCommentToPageJsonComment,
    POST_REPLIES_SORT_TYPES,
    POSTS_SORT_TYPES,
    REPLY_REPLIES_SORT_TYPES,
    TIMEFRAMES_TO_SECONDS
} from "../pages/util.js";
import { importSignerIntoKuboNode } from "../runtime/node/util.js";
import { getIpfsKeyFromPrivateKey, getPeerIdFromPrivateKey, getPKCAddressFromPublicKeySync } from "../signer/util.js";
import { CommentEdit } from "../publications/comment-edit/comment-edit.js";
import type { CreateCommentEditOptions } from "../publications/comment-edit/types.js";
import { Buffer } from "buffer";
import type {
    ChallengeAnswerMessageType,
    ChallengeMessageType,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageType,
    DecryptedChallengeRequest,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeVerificationMessageType,
    PubsubMessage
} from "../pubsub-messages/types.js";
import { encryptEd25519AesGcm, encryptEd25519AesGcmPublicKeyBuffer } from "../signer/encryption.js";
import env from "../version.js";
import type { CommentModerationPubsubMessagePublication } from "../publications/comment-moderation/types.js";
import { CommentModeration } from "../publications/comment-moderation/comment-moderation.js";
import type { PageIpfs, PageTypeJson, PostsPagesTypeIpfs, RepliesPagesTypeIpfs } from "../pages/types.js";
import { PKCError } from "../pkc-error.js";
import { messages } from "../errors.js";
import { MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE } from "../publications/comment/comment-client-manager.js";
import last from "it-last";
import { buildRuntimeAuthor } from "../publications/publication-author.js";

interface MockPKCOptions {
    pkcOptions?: InputPKCOptions;
    forceMockPubsub?: boolean;
    stubStorage?: boolean;
    mockResolve?: boolean;
    remotePKC?: boolean;
}

type MockResolverRecords = Map<string, string | undefined> | Record<string, string | undefined>;

const defaultMockResolverRecords = new Map<string, string>([
    ["plebbit.eth", "12D3KooWNMYPSuNadceoKsJ6oUQcxGcfiAsHNpVTt1RQ1zSrKKpo"],
    ["plebbit.bso", "12D3KooWNMYPSuNadceoKsJ6oUQcxGcfiAsHNpVTt1RQ1zSrKKpo"],
    ["rpc-edit-test.eth", "12D3KooWMZPQsQdYtrakc4D1XtzGXwN1X3DBnAobcCjcPYYXTB6o"],
    ["rpc-edit-test.bso", "12D3KooWMZPQsQdYtrakc4D1XtzGXwN1X3DBnAobcCjcPYYXTB6o"],
    // Resolves to signers[0] — used by key migration tests where record is signed by a different key
    ["migration-test.bso", "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"],
    ["migrating.bso", "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR"],
    // Resolves to signers[3] but record has name "plebbit.bso" — used by name mismatch rejection test
    ["wrong-name.bso", "12D3KooWNMYPSuNadceoKsJ6oUQcxGcfiAsHNpVTt1RQ1zSrKKpo"],
    // Resolves to signers[4] — used by resolver tests where client signs with signers[6] but server resolves to a different key
    ["testgibbreish.bso", "12D3KooWJrsheZoiATwG4Z6EJpNqo1v11wpHLcnMECqa4mneZiho"]
]);

function getMockResolverRecord(records: MockResolverRecords | undefined, name: string): { found: boolean; value: string | undefined } {
    if (records instanceof Map) return { found: records.has(name), value: records.get(name) };
    if (records && Object.prototype.hasOwnProperty.call(records, name)) return { found: true, value: records[name] };
    return { found: false, value: undefined };
}

export function createMockNameResolver({
    records,
    includeDefaultRecords = false,
    key = "mock-resolver",
    provider = "mock",
    canResolve,
    resolveFunction
}: {
    records?: MockResolverRecords;
    includeDefaultRecords?: boolean;
    key?: string;
    provider?: string;
    canResolve?: NameResolver["canResolve"];
    resolveFunction?: NameResolver["resolve"];
} = {}): NameResolver {
    return {
        key,
        canResolve: canResolve || (() => true),
        resolve:
            resolveFunction ||
            (async ({ name }) => {
                console.log(`Attempting to mock resolve address (${name})`);
                const record = getMockResolverRecord(records, name);
                if (record.found) return record.value ? { publicKey: record.value } : undefined;

                const defaultRecord = includeDefaultRecords ? getMockResolverRecord(defaultMockResolverRecords, name) : undefined;
                if (defaultRecord?.found) return defaultRecord.value ? { publicKey: defaultRecord.value } : undefined;
                return undefined;
            }),
        provider
    };
}

export function createPendingApprovalChallenge(overrides: Partial<CommunityChallengeSetting> = {}): CommunityChallengeSetting {
    const { options, exclude, ...rest } = overrides;
    return {
        ...rest,
        name: rest.name ?? "question",
        options: {
            question: "Pending approval password?",
            answer: "pending",
            ...(options ?? {})
        },
        pendingApproval: rest.pendingApproval ?? true,
        exclude: exclude ?? [{ role: ["moderator"] }]
    } as CommunityChallengeSetting;
}

function generateRandomTimestamp(parentTimestamp?: number): number {
    const [lowerLimit, upperLimit] = [typeof parentTimestamp === "number" && parentTimestamp > 2 ? parentTimestamp : 2, timestamp()];

    let randomTimestamp: number = -1;
    while (randomTimestamp === -1) {
        const randomTimeframeIndex = (remeda.keys.strict(TIMEFRAMES_TO_SECONDS).length * Math.random()) << 0;
        const tempTimestamp = lowerLimit + Object.values(TIMEFRAMES_TO_SECONDS)[randomTimeframeIndex];
        if (tempTimestamp >= lowerLimit && tempTimestamp <= upperLimit) randomTimestamp = tempTimestamp;
    }

    return randomTimestamp;
}

export async function generateMockPost({
    communityAddress,
    pkc,
    randomTimestamp = false,
    postProps = {}
}: {
    communityAddress: string;
    pkc: PKC;
    randomTimestamp?: boolean;
    postProps?: Partial<CreateCommentOptions>;
}): Promise<Comment> {
    const postTimestamp = (randomTimestamp && generateRandomTimestamp()) || timestamp();
    const postStartTestTime = Date.now() / 1000 + Math.random();
    const signer = postProps?.signer || (await pkc.createSigner());

    const baseProps = <CreateCommentOptions>{
        communityAddress,
        author: { displayName: `Mock Author - ${postStartTestTime}` },
        title: `Mock Post - ${postStartTestTime}`,
        content: `Mock content - ${postStartTestTime}`,
        signer,
        timestamp: postTimestamp
    };

    const finalPostProps = <CreateCommentOptions>remeda.mergeDeep(baseProps, postProps);
    const post = await pkc.createComment(finalPostProps);

    return post;
}

// TODO rework this
export async function generateMockComment(
    parentPostOrComment: CommentIpfsWithCidDefined,
    pkc: PKC,
    randomTimestamp = false,
    commentProps: Partial<CreateCommentOptions> = {}
): Promise<Comment> {
    const commentTimestamp = (randomTimestamp && generateRandomTimestamp(parentPostOrComment.timestamp)) || timestamp();
    const commentTime = Date.now() / 1000 + Math.random();
    const signer = commentProps?.signer || (await pkc.createSigner());
    const comment: Comment = await pkc.createComment({
        author: { displayName: `Mock Author - ${commentTime}` },
        signer: signer,
        content: `Mock comment - ${commentTime}`,
        parentCid: parentPostOrComment.cid,
        postCid: parentPostOrComment.postCid,
        communityAddress: getCommunityAddressFromRecord(parentPostOrComment as unknown as Record<string, unknown>)!,
        timestamp: commentTimestamp,
        ...commentProps
    });

    return comment;
}

export async function generateMockVote(
    parentPostOrComment: CommentIpfsWithCidDefined,
    vote: -1 | 0 | 1,
    pkc: PKC,
    signer?: SignerType
): Promise<Vote> {
    const voteTime = Date.now() / 1000;
    const commentCid = parentPostOrComment.cid;
    if (typeof commentCid !== "string") throw Error(`generateMockVote: commentCid (${commentCid}) is not a valid CID`);

    signer = signer || (await pkc.createSigner());
    const voteObj = await pkc.createVote({
        author: { displayName: `Mock Author - ${voteTime}` },
        signer: signer,
        commentCid,
        vote,
        communityAddress: getCommunityAddressFromRecord(parentPostOrComment as unknown as Record<string, unknown>)!
    });

    return voteObj;
}

export async function loadAllPages(pageCid: string, pagesInstance: PostsPages | RepliesPages) {
    if (!pageCid) throw Error("Can't load all pages with undefined pageCid");
    let sortedCommentsPage = await pagesInstance.getPage({ cid: pageCid });
    let sortedComments: (typeof sortedCommentsPage)["comments"] = sortedCommentsPage.comments;
    while (sortedCommentsPage.nextCid) {
        sortedCommentsPage = await pagesInstance.getPage({ cid: sortedCommentsPage.nextCid });
        sortedComments = sortedComments.concat(sortedCommentsPage.comments);
    }
    return sortedComments;
}

export async function loadAllPagesBySortName(pageSortName: string, pagesInstance: BasePages) {
    if (!pageSortName) throw Error("Can't load all pages with undefined pageSortName");
    if (Object.keys(pagesInstance.pageCids).length === 0 && pagesInstance.pages && pagesInstance.pages[pageSortName])
        return pagesInstance.pages[pageSortName].comments;
    let sortedCommentsPage =
        (pagesInstance.pages && pagesInstance.pages[pageSortName]) ||
        (await pagesInstance.getPage({ cid: pagesInstance.pageCids[pageSortName] }));
    let sortedComments: (typeof sortedCommentsPage)["comments"] = sortedCommentsPage.comments;
    while (sortedCommentsPage.nextCid) {
        sortedCommentsPage = await pagesInstance.getPage({ cid: sortedCommentsPage.nextCid });
        //@ts-expect-error
        sortedComments = sortedComments.concat(sortedCommentsPage.comments);
    }
    return sortedComments;
}

export async function loadAllUniquePostsUnderCommunity(community: RemoteCommunity) {
    if (Object.keys(community.posts.pageCids).length === 0 && Object.keys(community.posts.pages).length === 0) return [];
    const allCommentsInPreloadedPages = Object.keys(community.posts.pageCids).length === 0 && Object.keys(community.posts.pages).length > 0;
    if (allCommentsInPreloadedPages) {
        const allComments = community.posts.pages.hot?.comments;
        if (!allComments) throw Error("No comments found under community.posts.pages.hot");
        return allComments;
    } else {
        // we have multiple pages, need to load all pages and merge them
        return loadAllPages(community.posts.pageCids.new, community.posts);
    }
}

export async function loadAllUniqueCommentsUnderCommentInstance(comment: Comment) {
    if (Object.keys(comment.replies.pageCids).length === 0 && Object.keys(comment.replies.pages).length === 0)
        throw Error("Comment replies instance has no comments under it");
    const allCommentsInPreloadedPages = Object.keys(comment.replies.pageCids).length === 0 && Object.keys(comment.replies.pages).length > 0;
    if (allCommentsInPreloadedPages) {
        const allComments = comment.replies.pages.best?.comments;
        if (!allComments) throw Error("No comments found under comment.replies.pages.best");
        return allComments;
    } else {
        // we have multiple pages, need to load all pages and merge them
        return loadAllPages(comment.replies.pageCids.new, comment.replies);
    }
}

async function _mockCommunityPKC(signer: SignerType[], pkcOptions: InputPKCOptions) {
    const pkc = await mockPKC({ ...pkcOptions, pubsubKuboRpcClientsOptions: ["http://localhost:15002/api/v0"] }, true);

    return pkc;
}

async function _startMathCliCommunity(signer: SignerType, pkc: PKC): Promise<LocalCommunity> {
    const community = <LocalCommunity>await pkc.createCommunity({ signer });

    await community.edit({ settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] } });

    await community.start();
    return community;
}

async function _startEnsCommunity(signers: SignerType[], pkc: PKC): Promise<LocalCommunity> {
    const signer = await pkc.createSigner(signers[3]);
    const community = (await createSubWithNoChallenge({ signer }, pkc)) as LocalCommunity;
    await community.edit({
        roles: {
            [signers[1].address]: { role: "owner" },
            [signers[2].address]: { role: "admin" },
            [signers[3].address]: { role: "moderator" }
        }
    });
    await community.start();
    await community.edit({ address: "plebbit.bso" });
    assert.equal(community.address, "plebbit.bso");
    return community;
}

async function _publishPosts(communityAddress: string, numOfPosts: number, pkc: PKC) {
    return Promise.all(new Array(numOfPosts).fill(null).map(() => publishRandomPost({ communityAddress, pkc })));
}

async function _publishReplies(parentComment: CommentIpfsWithCidDefined, numOfReplies: number, pkc: PKC) {
    return Promise.all(new Array(numOfReplies).fill(null).map(() => publishRandomReply({ parentComment, pkc })));
}

async function _publishVotesOnOneComment(
    comment: Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string },
    votesPerCommentToPublish: number,
    pkc: PKC
) {
    return Promise.all(
        new Array(votesPerCommentToPublish).fill(null).map(() =>
            publishVote({
                commentCid: comment.cid,
                communityAddress: comment.communityAddress,
                vote: Math.random() > 0.5 ? 1 : -1,
                pkc
            })
        )
    );
}

async function _publishVotes(
    comments: (Pick<CommentIpfsWithCidDefined, "cid" | "depth"> & { communityAddress: string })[],
    votesPerCommentToPublish: number,
    pkc: PKC
) {
    const votes: Vote[] = remeda.flattenDeep(
        await Promise.all(comments.map((comment) => _publishVotesOnOneComment(comment, votesPerCommentToPublish, pkc)))
    );

    assert.equal(votes.length, votesPerCommentToPublish * comments.length);
    console.log(`${votes.length} votes for ${comments.length} ${comments[0].depth === 0 ? "posts" : "replies"} have been published`);
    return votes;
}

async function _populateCommunity(
    community: LocalCommunity | RpcLocalCommunity,
    props: {
        signers: SignerType[];
        votesPerCommentToPublish: number;
        numOfCommentsToPublish: number;
        numOfPostsToPublish: number;
    }
) {
    await community.edit({
        roles: {
            [props.signers[1].address]: { role: "owner" },
            [props.signers[2].address]: { role: "admin" },
            [props.signers[3].address]: { role: "moderator" }
        }
    });
    if (props.numOfPostsToPublish === 0) return;
    await new Promise((resolve) => community.once("update", resolve));
    const posts = await _publishPosts(community.address, props.numOfPostsToPublish, community._pkc); // If no comment[] is provided, we publish posts
    console.log(`Have successfully published ${posts.length} posts`);
    const replies = await _publishReplies(<CommentIpfsWithCidDefined>posts[0], props.numOfCommentsToPublish, community._pkc);
    console.log(`Have sucessfully published ${replies.length} replies`);
    const postVotes = await _publishVotes(
        posts as unknown as (Pick<CommentIpfsWithCidDefined, "cid" | "depth"> & { communityAddress: string })[],
        props.votesPerCommentToPublish,
        community._pkc
    );
    console.log(`Have sucessfully published ${postVotes.length} votes on ${posts.length} posts`);

    const repliesVotes = await _publishVotes(
        replies as unknown as (Pick<CommentIpfsWithCidDefined, "cid" | "depth"> & { communityAddress: string })[],
        props.votesPerCommentToPublish,
        community._pkc
    );
    console.log(`Have successfully published ${repliesVotes.length} votes on ${replies.length} replies`);
}

// Sub label -> address
type TestServerSubs = {
    // string will be the address
    onlineSub?: LocalCommunity;
    ensSub: LocalCommunity;
    mainSub: LocalCommunity;
    mathSub: LocalCommunity;
    NoPubsubResponseSub: LocalCommunity;
    mathCliSubWithNoMockedPubsub: LocalCommunity;
    subForPurge: LocalCommunity;
    subForRemove: LocalCommunity;
    subForDelete: LocalCommunity;
    subForChainProviders: LocalCommunity;
    subForEditContent: LocalCommunity;
    subForLocked: LocalCommunity;
};

export async function startOnlineCommunity() {
    const onlinePKC = await createOnlinePKC();

    const onlineCommunity = <LocalCommunity>await onlinePKC.createCommunity(); // Will create a new community that is on the ipfs network

    await onlineCommunity.edit({ settings: { challenges: [{ name: "question", options: { question: "1+1=?", answer: "2" } }] } });

    await onlineCommunity.start();

    await new Promise((resolve) => onlineCommunity.once("update", resolve));
    console.log("Online community is online on address", onlineCommunity.address);

    return onlineCommunity;
}

export async function startCommunities(props: {
    signers: SignerType[];
    noData?: boolean;
    dataPath?: string;
    votesPerCommentToPublish: number;
    numOfCommentsToPublish: number;
    numOfPostsToPublish: number;
    startOnlineSub: boolean;
}): Promise<TestServerSubs> {
    const pkc = await _mockCommunityPKC(props.signers, {
        ...remeda.pick(props, ["noData", "dataPath"]),
        publishInterval: 1000,
        updateInterval: 1000
    });
    const mainCommunity = (await createSubWithNoChallenge({ signer: props.signers[0] }, pkc)) as LocalCommunity; // most publications will be on this community

    // Enable flair features and set allowed flairs for flair tests
    await mainCommunity.edit({
        features: { postFlairs: true },
        flairs: {
            post: [{ text: "Author Flair" }, { text: "Discussion" }, { text: "Updated" }, { text: "Important", backgroundColor: "#ff0000" }]
        }
    });

    await mainCommunity.start();

    const mathSub = await _startMathCliCommunity(props.signers[1], pkc);
    const ensSub = await _startEnsCommunity(props.signers, pkc);
    console.time("populate");

    await _populateCommunity(mainCommunity, props);
    console.timeEnd("populate");

    let onlineSub;
    if (props.startOnlineSub) onlineSub = await startOnlineCommunity();
    console.log("All communities and ipfs nodes have been started. You are ready to run the tests");

    const subWithNoResponse = (await createSubWithNoChallenge({ signer: props.signers[4] }, pkc)) as LocalCommunity;
    await subWithNoResponse.start();

    await new Promise((resolve) => subWithNoResponse.once("update", resolve));
    await subWithNoResponse.stop();

    const pkcNoMockedSub = await mockPKC(
        { kuboRpcClientsOptions: ["http://localhost:15002/api/v0"], pubsubKuboRpcClientsOptions: ["http://localhost:15002/api/v0"] },
        false,
        true,
        true
    );
    const mathCliSubWithNoMockedPubsub = await _startMathCliCommunity(props.signers[5], pkcNoMockedSub);
    await new Promise((resolve) => mathCliSubWithNoMockedPubsub.once("update", resolve));

    const subForPurge = (await createSubWithNoChallenge({ signer: props.signers[6] }, pkc)) as LocalCommunity;
    await subForPurge.edit({
        roles: {
            [props.signers[1].address]: { role: "owner" },
            [props.signers[2].address]: { role: "admin" },
            [props.signers[3].address]: { role: "moderator" }
        }
    });
    await subForPurge.start();
    await new Promise((resolve) => subForPurge.once("update", resolve));

    const subForRemove = (await createSubWithNoChallenge({ signer: props.signers[7] }, pkc)) as LocalCommunity;
    await subForRemove.edit({
        roles: {
            [props.signers[1].address]: { role: "owner" },
            [props.signers[2].address]: { role: "admin" },
            [props.signers[3].address]: { role: "moderator" }
        }
    });
    await subForRemove.start();
    await new Promise((resolve) => subForRemove.once("update", resolve));

    const subForDelete = (await createSubWithNoChallenge({ signer: props.signers[8] }, pkc)) as LocalCommunity;
    await subForDelete.edit({
        roles: {
            [props.signers[1].address]: { role: "owner" },
            [props.signers[2].address]: { role: "admin" },
            [props.signers[3].address]: { role: "moderator" }
        }
    });
    await subForDelete.start();
    await new Promise((resolve) => subForDelete.once("update", resolve));

    const subForChainProviders = (await createSubWithNoChallenge({ signer: props.signers[9] }, pkc)) as LocalCommunity;
    await subForChainProviders.start();
    await new Promise((resolve) => subForChainProviders.once("update", resolve));

    const subForEditContent = (await createSubWithNoChallenge({ signer: props.signers[10] }, pkc)) as LocalCommunity;
    await subForEditContent.edit({
        roles: {
            [props.signers[1].address]: { role: "owner" },
            [props.signers[2].address]: { role: "admin" },
            [props.signers[3].address]: { role: "moderator" }
        }
    });
    await subForEditContent.start();
    await new Promise((resolve) => subForEditContent.once("update", resolve));

    const subForLocked = (await createSubWithNoChallenge({ signer: props.signers[11] }, pkc)) as LocalCommunity;
    await subForLocked.edit({
        roles: {
            [props.signers[1].address]: { role: "owner" },
            [props.signers[2].address]: { role: "admin" },
            [props.signers[3].address]: { role: "moderator" }
        }
    });
    await subForLocked.start();
    await new Promise((resolve) => subForLocked.once("update", resolve));

    return {
        onlineSub: onlineSub,
        mathSub: mathSub,
        ensSub: ensSub,
        mainSub: mainCommunity,
        NoPubsubResponseSub: subWithNoResponse,
        mathCliSubWithNoMockedPubsub: mathCliSubWithNoMockedPubsub,
        subForPurge: subForPurge,
        subForRemove: subForRemove,
        subForDelete: subForDelete,
        subForChainProviders: subForChainProviders,
        subForEditContent: subForEditContent,
        subForLocked: subForLocked
    };
}

export async function fetchTestServerSubs() {
    const res = await fetch("http://localhost:14953");
    const resWithType = <TestServerSubs>await res.json();
    return resWithType;
}

export function mockDefaultOptionsForNodeAndBrowserTests(): Pick<
    InputPKCOptions,
    "pkcRpcClientsOptions" | "kuboRpcClientsOptions" | "ipfsGatewayUrls" | "pubsubKuboRpcClientsOptions" | "httpRoutersOptions"
> {
    const shouldUseRPC = isRpcFlagOn();

    if (shouldUseRPC) return { pkcRpcClientsOptions: ["ws://localhost:39652"], httpRoutersOptions: [] };
    else
        return {
            kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
            pubsubKuboRpcClientsOptions: [
                `http://localhost:15002/api/v0`,
                `http://localhost:42234/api/v0`,
                `http://localhost:42254/api/v0`
            ],
            httpRoutersOptions: []
        };
}
export async function mockPKCV2({ pkcOptions, forceMockPubsub, stubStorage, mockResolve, remotePKC }: MockPKCOptions = {}) {
    if (remotePKC) pkcOptions = { dataPath: undefined, ...pkcOptions };
    const pkc = await mockPKC(pkcOptions, forceMockPubsub, stubStorage, mockResolve);
    return pkc;
}

export async function mockPKC(pkcOptions?: InputPKCOptions, forceMockPubsub = false, stubStorage = true, mockResolve = true) {
    const log = Logger("pkc-js:test-util:mockPKC");
    if (pkcOptions?.pkcRpcClientsOptions && pkcOptions?.kuboRpcClientsOptions)
        throw Error("Can't have both kubo and RPC config. Is this a mistake?");
    if (pkcOptions?.pkcRpcClientsOptions && pkcOptions?.libp2pJsClientsOptions)
        throw Error("Can't have both libp2p and RPC config. Is this a mistake?");

    const mockNameResolvers = mockResolve ? [createMockNameResolver({ includeDefaultRecords: true })] : undefined;
    const pkc = await PKCIndex({
        ...mockDefaultOptionsForNodeAndBrowserTests(),
        resolveAuthorNames: true,
        publishInterval: 1000,
        validatePages: false,
        updateInterval: 500,
        nameResolvers: mockNameResolvers,
        ...pkcOptions
    });

    if (stubStorage) {
        pkc._storage.getItem = async () => undefined;
        pkc._storage.setItem = async () => undefined;
    }

    // TODO should have multiple pubsub providers here to emulate a real browser/mobile environment
    if (!pkcOptions?.pubsubKuboRpcClientsOptions || forceMockPubsub)
        for (const pubsubUrl of remeda.keys.strict(pkc.clients.pubsubKuboRpcClients)) {
            const mockClient = createMockPubsubClient();
            pkc.clients.pubsubKuboRpcClients[pubsubUrl]._client = mockClient;
            pkc.clients.pubsubKuboRpcClients[pubsubUrl].destroy = mockClient.destroy.bind(mockClient);
        }

    pkc.on("error", (e) => {
        log.error("PKC error", e);
    });

    return pkc;
}

// name should be changed to mockBrowserPKC
export async function mockRemotePKC(opts?: MockPKCOptions) {
    // Mock browser environment
    const pkc = await mockPKCV2({ ...opts, pkcOptions: { dataPath: undefined, ...opts?.pkcOptions } });
    pkc._canCreateNewLocalCommunity = () => false;
    return pkc;
}

export async function createOnlinePKC(pkcOptions?: InputPKCOptions) {
    const pkc = await PKCIndex({
        kuboRpcClientsOptions: ["http://localhost:15003/api/v0"],
        pubsubKuboRpcClientsOptions: ["http://localhost:15003/api/v0"],
        ...pkcOptions
    }); // use online ipfs node
    return pkc;
}

export async function mockPKCNoDataPathWithOnlyKuboClient(opts?: MockPKCOptions) {
    const pkc = await mockPKCV2({
        ...opts,
        pkcOptions: {
            kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
            pkcRpcClientsOptions: undefined,
            dataPath: undefined,
            ...opts?.pkcOptions
        }
    });
    return pkc;
}

export async function mockPKCNoDataPathWithOnlyKuboClientNoAdd(opts?: MockPKCOptions) {
    const pkc = await mockPKCV2({
        ...opts,
        pkcOptions: {
            kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
            pkcRpcClientsOptions: undefined,
            dataPath: undefined,
            ...opts?.pkcOptions
        }
    });

    Object.values(pkc.clients.kuboRpcClients)[0]._client.add = () => {
        throw Error("Add is not supported");
    };
    return pkc;
}

export async function mockRpcServerPKC(pkcOptions?: InputPKCOptions) {
    const pkc = await mockPKCV2({
        pkcOptions: {
            kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
            ...pkcOptions,
            pkcRpcClientsOptions: undefined
        },
        mockResolve: true,
        forceMockPubsub: true,
        remotePKC: false,
        stubStorage: true // we want storage to force new resolve-community-address states
    });
    pkc.removeAllListeners("error"); // for rpc server, we want to test the error handling
    return pkc;
}

export async function mockRpcRemotePKC(opts?: MockPKCOptions) {
    if (!isRpcFlagOn()) throw Error("This function should only be used when the rpc flag is on");
    // This instance will connect to an rpc server that has no local subs
    const pkc = await mockPKCV2({
        ...opts,
        pkcOptions: {
            pkcRpcClientsOptions: ["ws://localhost:39653"],
            dataPath: undefined,
            ...opts?.pkcOptions
        }
    });
    return pkc;
}

export async function mockRPCLocalPKC(pkcOptions?: InputPKCOptions) {
    if (!isRpcFlagOn()) throw Error("This function should only be used when the rpc flag is on");
    // This instance will connect to an rpc server that local subs

    return mockPKC({ pkcRpcClientsOptions: ["ws://localhost:39652"], ...pkcOptions });
}

export async function mockGatewayPKC(opts?: MockPKCOptions) {
    // Keep only pubsub and gateway
    const pkc = await mockPKCV2({
        ...opts,
        pkcOptions: {
            ipfsGatewayUrls: ["http://localhost:18080"],
            pkcRpcClientsOptions: undefined,
            kuboRpcClientsOptions: undefined,
            pubsubKuboRpcClientsOptions: undefined,
            libp2pJsClientsOptions: undefined,
            ...opts?.pkcOptions
        },
        remotePKC: true
    });
    return pkc;
}

export async function publishRandomReply({
    parentComment,
    pkc,
    commentProps
}: {
    parentComment: CommentIpfsWithCidDefined;
    pkc: PKC;
    commentProps?: Partial<CreateCommentOptions>;
}): Promise<Comment> {
    const reply = await generateMockComment(parentComment, pkc, false, {
        content: `Content ${uuidv4()}`,
        ...commentProps
    });
    await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    return reply;
}

export async function publishRandomPost({
    communityAddress,
    pkc,
    postProps
}: {
    communityAddress: string;
    pkc: PKC;
    postProps?: Partial<CreateCommentOptions>;
}) {
    const post = await generateMockPost({
        communityAddress,
        pkc,
        postProps: {
            content: `Random post Content ${uuidv4()}`,
            title: `Random post Title ${uuidv4()}`,
            ...postProps
        }
    });
    await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    return post;
}

export async function publishVote({
    commentCid,
    communityAddress,
    vote,
    pkc,
    voteProps
}: {
    commentCid: string;
    communityAddress: string;
    vote: 1 | 0 | -1;
    pkc: PKC;
    voteProps?: Partial<CreateVoteOptions>;
}) {
    const voteObj = await pkc.createVote({
        commentCid,
        vote,
        communityAddress,
        signer: voteProps?.signer || (await pkc.createSigner()),
        ...voteProps
    });
    await publishWithExpectedResult({ publication: voteObj, expectedChallengeSuccess: true });
    return voteObj;
}

async function _publishWithExpectedResultOnce({
    publication,
    expectedChallengeSuccess,
    expectedReason
}: {
    publication: Publication;
    expectedChallengeSuccess: boolean;
    expectedReason?: string;
}) {
    const emittedErrors: Error[] = [];
    const timeoutMs = 60000;
    const summarizePublication = () =>
        removeUndefinedValuesRecursively({
            type: publication.constructor?.name,
            cid: (publication as any).cid,
            parentCid: (publication as any).parentCid,
            communityAddress: publication.communityAddress,
            signerAddress: (publication as any).signer?.address,
            commentModeration: (publication as any).commentModeration
                ? remeda.pick((publication as any).commentModeration, ["approved", "reason", "spoiler", "nsfw", "pinned", "removed"])
                : undefined
        });

    publication.on("error", (err) => emittedErrors.push(err));
    let cleanupChallengeVerificationListener: (() => void) | undefined;
    const challengeVerificationPromise = new Promise((resolve, reject) => {
        const challengeVerificationListener = (verificationMsg: DecryptedChallengeVerificationMessageType) => {
            if (verificationMsg.challengeSuccess !== expectedChallengeSuccess) {
                const msg = `Expected challengeSuccess to be (${expectedChallengeSuccess}) and got (${
                    verificationMsg.challengeSuccess
                }). Reason (${verificationMsg.reason}): ${JSON.stringify(remeda.omit(verificationMsg, ["encrypted", "signature", "challengeRequestId"]))}`;
                reject(msg);
            } else if (expectedReason && expectedReason !== verificationMsg.reason) {
                const msg = `Expected reason to be (${expectedReason}) and got (${verificationMsg.reason}): ${JSON.stringify(
                    remeda.omit(verificationMsg, ["encrypted", "signature", "challengeRequestId"])
                )}`;
                reject(msg);
            } else resolve(1);
        };
        publication.on("challengeverification", challengeVerificationListener);
        cleanupChallengeVerificationListener = () => {
            if (typeof publication.off === "function") publication.off("challengeverification", challengeVerificationListener);
            else publication.removeListener("challengeverification", challengeVerificationListener);
        };
    });

    const error = new Error("Publication did not receive response");
    //@ts-expect-error
    error.details = {
        publication: summarizePublication(),
        expectedChallengeSuccess,
        expectedReason,
        waitTime: timeoutMs,
        emittedErrorsOnPublicationInstance: emittedErrors
    };

    const validateResponsePromise = pTimeout(challengeVerificationPromise, {
        milliseconds: timeoutMs,
        message: error
    });

    await publication.publish();
    try {
        await validateResponsePromise;
    } catch (error) {
        throw error;
    } finally {
        cleanupChallengeVerificationListener?.();
    }
}

const retriableSubLoadingCodes = new Set([
    "ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P",
    "ERR_GET_COMMUNITY_TIMED_OUT",
    "ERR_FAILED_TO_FETCH_COMMUNITY_FROM_GATEWAYS"
]);

export async function publishWithExpectedResult({
    publication,
    expectedChallengeSuccess,
    expectedReason
}: {
    publication: Publication;
    expectedChallengeSuccess: boolean;
    expectedReason?: string;
}) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            await _publishWithExpectedResultOnce({ publication, expectedChallengeSuccess, expectedReason });
            return;
        } catch (error) {
            const isRetriable = error instanceof PKCError && retriableSubLoadingCodes.has(error.code);
            if (!isRetriable || attempt === maxAttempts) throw error;
            console.log(
                `publishWithExpectedResult: retrying (attempt ${attempt + 1}/${maxAttempts}) after retriable error: ${(error as PKCError).code}`
            );
        }
    }
}

export async function iterateThroughPageCidToFindComment(commentCid: string, pageCid: string, pages: PostsPages | RepliesPages) {
    if (!commentCid) throw Error("Can't find comment with undefined commentCid");
    if (!pageCid) throw Error("Can't find comment with undefined pageCid");
    let currentPageCid: string | undefined = remeda.clone(pageCid);
    while (currentPageCid) {
        const loadedPage = (await pages.getPage({ cid: currentPageCid })) as PageTypeJson;
        const commentInPage = loadedPage.comments.find((c) => c.cid === commentCid);
        if (commentInPage) return commentInPage;
        currentPageCid = loadedPage.nextCid;
    }
    return undefined;
}

export async function findCommentInCommunityInstancePagesPreloadedAndPageCids(opts: {
    comment: Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>;
    community: RemoteCommunity;
}): Promise<CommentWithinRepliesPostsPageJson | undefined> {
    // TODO need to handle, what if the comment is nested deep down the community.posts tree and doesn't appear in preloaded page
    // code below doesn't handle it
    const { community, comment } = opts;
    if (!community) throw Error("Failed to provide opts.community");
    if (!comment) throw Error("Failed to provde opts.comment");
    if (Object.keys(community.posts.pageCids).length === 0 && Object.keys(community.posts.pages).length > 0) {
        // it's a single preloaded page
        const loadedAllHotPagesComments = <CommentWithinRepliesPostsPageJson[]>(
            await loadAllPagesBySortName(Object.keys(community.posts.pages)[0], community.posts)
        );
        const pageIpfs = <PageIpfs>{
            comments: loadedAllHotPagesComments.map((c) => c.raw)
        };
        const postInPage = findCommentInHierarchicalPageIpfsRecursively(pageIpfs, comment.cid);
        if (postInPage) return mapPageIpfsCommentToPageJsonComment(postInPage);
        else return undefined;
    } else if (Object.keys(community.posts?.pageCids).length > 0) {
        const postsNewPageCid = community.posts.pageCids.new;
        const postInPageCid = await iterateThroughPageCidToFindComment(comment.cid, postsNewPageCid, community.posts);
        return postInPageCid;
    } else return undefined;
}

export async function findReplyInParentCommentPagesInstancePreloadedAndPageCids(opts: {
    reply: Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;
    parentComment: Comment;
}): Promise<CommentWithinRepliesPostsPageJson | undefined> {
    const { parentComment, reply } = opts;
    const log = Logger("pkc-js:test-util:waitTillReplyInParentPagesInstance");
    if (reply?.parentCid !== parentComment?.cid) throw Error("You need to provide a reply that's direct child of parentComment");
    log("waiting for reply", reply.cid, "in parent comment", parentComment.cid, "replyCount of parent comment", parentComment.replyCount);

    // Handle intermediate state where both pageCids and pages are empty
    // This happens during early update events before CommentUpdate with replies is received
    if (Object.keys(parentComment.replies.pageCids).length === 0 && Object.keys(parentComment.replies.pages).length === 0) {
        // No pages loaded yet - this is a valid intermediate state, not an error
        return undefined;
    }

    if (Object.keys(parentComment.replies.pageCids).length === 0 && Object.keys(parentComment.replies.pages).length > 0) {
        // it's a single preloaded page
        const loadedAllBestPagesComments = <CommentWithinRepliesPostsPageJson[]>(
            await loadAllPagesBySortName(Object.keys(parentComment.replies.pages)[0], parentComment.replies)
        );
        const pageIpfs = <PageIpfs>{
            comments: loadedAllBestPagesComments.map((c) => c.raw)
        };
        const replyInPage = findCommentInHierarchicalPageIpfsRecursively(pageIpfs, reply.cid);
        if (replyInPage) return mapPageIpfsCommentToPageJsonComment(replyInPage);
        else return undefined;
    } else {
        if (!("new" in parentComment.replies.pageCids)) {
            console.error("no new page", "parentComment.replies.pageCids", parentComment.replies.pageCids);
            return undefined;
        }

        const commentNewPageCid = parentComment.replies.pageCids.new;
        const replyInPage = await iterateThroughPageCidToFindComment(reply.cid, commentNewPageCid, parentComment.replies);
        return replyInPage;
    }
}

export async function waitTillPostInCommunityInstancePages(
    post: Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
    community: RemoteCommunity
) {
    if (community.state === "stopped") await community.update();
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => Boolean(await findCommentInCommunityInstancePagesPreloadedAndPageCids({ comment: post, community }))
    });
}

export async function waitTillPostInCommunityPages(
    post: Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
    pkc: PKC
) {
    const community = await pkc.createCommunity({ address: post.communityAddress });
    await waitTillPostInCommunityInstancePages(post, community);
    await community.stop();
}

export async function iterateThroughPagesToFindCommentInParentPagesInstance(
    commentCid: string,
    pages: PostsPages | RepliesPages
): Promise<PageTypeJson["comments"][0] | undefined> {
    const preloadedPage = Object.keys(pages.pages)[0];

    const commentInPage = findCommentInPageInstance(pages, commentCid);
    if (commentInPage) return mapPageIpfsCommentToPageJsonComment(commentInPage);

    if (pages.pages[preloadedPage]?.nextCid || pages.pageCids.new) {
        // means we have multiple pages
        return iterateThroughPageCidToFindComment(commentCid, pages.pageCids.new, pages);
    } else return undefined;
}

export async function waitTillReplyInParentPagesInstance(
    reply: Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
    parentComment: Comment
) {
    if (parentComment.state === "stopped") throw Error("Parent comment is stopped, can't wait for reply in parent pages");
    if (!reply.cid) throw Error("reply.cid need to be defined so we can find it in parent pages");
    await resolveWhenConditionIsTrue({
        toUpdate: parentComment,
        predicate: async () => Boolean(await findReplyInParentCommentPagesInstancePreloadedAndPageCids({ reply, parentComment }))
    });
}

export async function waitTillReplyInParentPages(
    reply: Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>,
    pkc: PKC
) {
    const parentComment = await pkc.createComment({ cid: reply.parentCid });
    await parentComment.update();
    await waitTillReplyInParentPagesInstance(reply, parentComment);
    await parentComment.stop();
}

export async function createSubWithNoChallenge(
    props: CreateNewLocalCommunityUserOptions,
    pkc: PKC
): Promise<LocalCommunity | RpcLocalCommunity> {
    const community = <LocalCommunity | RpcLocalCommunity>await pkc.createCommunity(props);
    await community.edit({ settings: { challenges: [] } }); // No challenge
    return community;
}

export async function generatePostToAnswerMathQuestion(props: Partial<CreateCommentOptions> & { communityAddress: string }, pkc: PKC) {
    const mockPost = await generateMockPost({ communityAddress: props.communityAddress, pkc, postProps: props });
    mockPost.removeAllListeners("challenge");
    mockPost.once("challenge", (challengeMessage) => {
        mockPost.publishChallengeAnswers(["2"]);
    });

    return mockPost;
}

export function isRpcFlagOn(): boolean {
    const isPartOfProcessEnv = globalThis?.["process"]?.env?.["USE_RPC"] === "1";
    // const isPartOfKarmaArgs = globalThis?.["__karma__"]?.config?.config?.["USE_RPC"] === "1";
    return isPartOfProcessEnv;
}

export function isRunningInBrowser(): boolean {
    const hasWindow = typeof (globalThis as any)["window"] !== "undefined";
    const hasDocument = typeof (globalThis as any)["window"]?.["document"] !== "undefined";
    const isNodeProcess = typeof globalThis["process"] !== "undefined" && Boolean((globalThis as any)["process"]?.versions?.node);
    const isJsDom =
        typeof (globalThis as any)["navigator"]?.userAgent === "string" && (globalThis as any)["navigator"]!.userAgent.includes("jsdom");

    return hasWindow && hasDocument && !isNodeProcess && !isJsDom;
}

export type ResolveWhenConditionIsTrueOptions = {
    toUpdate: EventEmitter;
    predicate: () => Promise<boolean>;
    eventName?: string;
};

export async function resolveWhenConditionIsTrue(options: ResolveWhenConditionIsTrueOptions) {
    if (!options) {
        throw Error("resolveWhenConditionIsTrue requires an options object");
    }

    const { toUpdate, predicate, eventName = "update" } = options;
    if (!toUpdate) {
        throw Error("resolveWhenConditionIsTrue options.toUpdate is required");
    }

    if (typeof predicate !== "function") {
        throw Error("resolveWhenConditionIsTrue options.predicate must be a function");
    }

    const normalizedEventName = eventName || "update";

    await new Promise<void>((resolve, reject) => {
        const listener = async () => {
            try {
                const conditionStatus = await predicate();
                if (conditionStatus) {
                    toUpdate.removeListener(normalizedEventName, listener);
                    resolve();
                }
            } catch (error) {
                toUpdate.removeListener(normalizedEventName, listener);
                reject(error);
            }
        };
        toUpdate.on(normalizedEventName, listener);
        listener(); // initial check — no await, errors flow through reject()
    });
}

export async function disableValidationOfSignatureBeforePublishing(publication: Publication) {
    //@ts-expect-error
    publication._validateSignatureHook = async () => {};
}

export async function overrideCommentInstancePropsAndSign(comment: Comment, props: CreateCommentOptions) {
    if (!comment.signer) throw Error("Need comment.signer to overwrite the signature");

    // If deferred signing hasn't populated pubsubMessageToPublish yet,
    // modify the unsigned options so publish() will sign with the overridden props
    const unsignedOpts = (comment.raw as { unsignedPublicationOptions?: CreateCommentOptions }).unsignedPublicationOptions;
    if (!comment.raw.pubsubMessageToPublish && unsignedOpts) {
        for (const optionKey of remeda.keys.strict(props)) {
            //@ts-expect-error
            comment[optionKey] = unsignedOpts[optionKey] = props[optionKey];
        }
        disableValidationOfSignatureBeforePublishing(comment);
        return;
    }

    const pubsubPublication = remeda.clone(comment.raw.pubsubMessageToPublish!);

    for (const optionKey of remeda.keys.strict(props)) {
        //@ts-expect-error
        comment[optionKey] = pubsubPublication[optionKey] = props[optionKey];
    }

    comment.signature = pubsubPublication.signature = await signComment({
        comment: removeUndefinedValuesRecursively({
            ...pubsubPublication,
            signer: comment.signer,
            communityAddress: comment.communityAddress
        }),
        pkc: comment._pkc
    });

    comment.raw.pubsubMessageToPublish = pubsubPublication;

    disableValidationOfSignatureBeforePublishing(comment);
}

export async function overrideCommentEditInstancePropsAndSign(commentEdit: CommentEdit, props: CreateCommentEditOptions) {
    if (!commentEdit.signer) throw Error("Need commentEdit.signer to overwrite the signature");
    //@ts-expect-error
    for (const optionKey of Object.keys(props)) commentEdit[optionKey] = props[optionKey];

    commentEdit.signature = await signCommentEdit({
        edit: removeUndefinedValuesRecursively({
            ...commentEdit.raw.pubsubMessageToPublish!,
            signer: commentEdit.signer,
            communityAddress: commentEdit.communityAddress
        }),
        pkc: commentEdit._pkc
    });

    disableValidationOfSignatureBeforePublishing(commentEdit);
}

export async function ensurePublicationIsSigned(
    publication: Publication,
    community: {
        address: string;
        signer?: { address: string };
        encryption: { type: string; publicKey: string };
        pubsubTopic?: string;
        name?: string;
    }
) {
    if (!publication.raw.pubsubMessageToPublish) {
        publication._community = {
            address: community.address,
            publicKey: community.signer?.address ?? community.address,
            name: community.name,
            encryption: community.encryption,
            pubsubTopic: community.pubsubTopic
        };
        await publication._signPublicationWithCommunityFields();
    }
}

export async function setExtraPropOnCommentAndSign(comment: Comment, extraProps: Object, includeExtraPropInSignedPropertyNames: boolean) {
    const log = Logger("pkc-js:test-util:setExtraPropOnVoteAndSign");

    // With deferred signing, the publication may not be signed yet
    if (!comment.raw.pubsubMessageToPublish) {
        await comment._initCommunity();
        await comment._signPublicationWithCommunityFields();
    }

    const publicationWithExtraProp = { ...comment.raw.pubsubMessageToPublish!, ...extraProps };
    if (includeExtraPropInSignedPropertyNames)
        publicationWithExtraProp.signature = await _signJson(
            [...comment.signature.signedPropertyNames, ...remeda.keys.strict(extraProps)],
            cleanUpBeforePublishing(publicationWithExtraProp),
            comment.signer!,
            log
        );

    comment.raw.pubsubMessageToPublish = publicationWithExtraProp;

    disableValidationOfSignatureBeforePublishing(comment);

    Object.assign(comment, publicationWithExtraProp, {
        author: buildRuntimeAuthor({
            author: publicationWithExtraProp.author,
            signaturePublicKey: publicationWithExtraProp.signature.publicKey
        })
    });
}

export async function setExtraPropOnVoteAndSign(vote: Vote, extraProps: Object, includeExtraPropInSignedPropertyNames: boolean) {
    const log = Logger("pkc-js:test-util:setExtraPropOnVoteAndSign");

    // With deferred signing, the publication may not be signed yet
    if (!vote.raw.pubsubMessageToPublish) {
        await vote._initCommunity();
        await vote._signPublicationWithCommunityFields();
    }

    const publicationWithExtraProp = { ...vote.raw.pubsubMessageToPublish!, ...extraProps };
    if (includeExtraPropInSignedPropertyNames)
        publicationWithExtraProp.signature = await _signJson(
            [...vote.signature.signedPropertyNames, ...Object.keys(extraProps)],
            cleanUpBeforePublishing(publicationWithExtraProp),
            vote.signer!,
            log
        );
    vote.raw.pubsubMessageToPublish = publicationWithExtraProp;

    disableValidationOfSignatureBeforePublishing(vote);

    Object.assign(vote, publicationWithExtraProp, {
        author: buildRuntimeAuthor({
            author: publicationWithExtraProp.author,
            signaturePublicKey: publicationWithExtraProp.signature.publicKey
        })
    });
}

export async function setExtraPropOnCommentEditAndSign(
    commentEdit: CommentEdit,
    extraProps: Object,
    includeExtraPropInSignedPropertyNames: boolean
) {
    const log = Logger("pkc-js:test-util:setExtraPropOnCommentEditAndSign");

    // With deferred signing, the publication may not be signed yet
    if (!commentEdit.raw.pubsubMessageToPublish) {
        await commentEdit._initCommunity();
        await commentEdit._signPublicationWithCommunityFields();
    }

    const publicationWithExtraProp = { ...commentEdit.raw.pubsubMessageToPublish!, ...extraProps };
    if (includeExtraPropInSignedPropertyNames)
        publicationWithExtraProp.signature = await _signJson(
            [...commentEdit.signature.signedPropertyNames, ...Object.keys(extraProps)],
            cleanUpBeforePublishing(publicationWithExtraProp),
            commentEdit.signer!,
            log
        );
    commentEdit.raw.pubsubMessageToPublish = publicationWithExtraProp;

    disableValidationOfSignatureBeforePublishing(commentEdit);

    Object.assign(commentEdit, publicationWithExtraProp, {
        author: buildRuntimeAuthor({
            author: publicationWithExtraProp.author,
            signaturePublicKey: publicationWithExtraProp.signature.publicKey
        })
    });
}

export async function setExtraPropOnCommentModerationAndSign(
    commentModeration: CommentModeration,
    extraProps: any,
    includeExtraPropInSignedPropertyNames: boolean
) {
    const log = Logger("pkc-js:test-util:setExtraPropOnCommentModerationAndSign");

    if (!commentModeration.raw.pubsubMessageToPublish) {
        await commentModeration._initCommunity();
        await commentModeration._signPublicationWithCommunityFields();
    }

    const newPubsubPublicationWithExtraProp = <CommentModerationPubsubMessagePublication>(
        remeda.mergeDeep(commentModeration.raw.pubsubMessageToPublish!, extraProps)
    );
    if (includeExtraPropInSignedPropertyNames)
        newPubsubPublicationWithExtraProp.signature = await _signJson(
            [...commentModeration.signature.signedPropertyNames, ...Object.keys(extraProps)],
            cleanUpBeforePublishing(newPubsubPublicationWithExtraProp),
            commentModeration.signer!,
            log
        );
    commentModeration.raw.pubsubMessageToPublish = newPubsubPublicationWithExtraProp;

    disableValidationOfSignatureBeforePublishing(commentModeration);

    Object.assign(commentModeration, newPubsubPublicationWithExtraProp, {
        author: buildRuntimeAuthor({
            author: newPubsubPublicationWithExtraProp.author,
            signaturePublicKey: newPubsubPublicationWithExtraProp.signature.publicKey
        })
    });
}
export async function setExtraPropOnChallengeRequestAndSign({
    publication,
    extraProps,
    includeExtraPropsInRequestSignedPropertyNames
}: {
    publication: Publication;
    extraProps: Object;
    includeExtraPropsInRequestSignedPropertyNames: boolean;
}) {
    const log = Logger("pkc-js:test-util:setExtraPropOnChallengeRequestAndSign");

    //@ts-expect-error
    publication._signAndValidateChallengeRequestBeforePublishing = async (requestWithoutSignature, signer) => {
        const signedPropertyNames = <ChallengeRequestMessageType["signature"]["signedPropertyNames"]>Object.keys(requestWithoutSignature);
        if (includeExtraPropsInRequestSignedPropertyNames) signedPropertyNames.push(...Object.keys(extraProps));
        const requestWithExtraProps = { ...requestWithoutSignature, ...extraProps };
        const signature = await _signPubsubMsg({ signedPropertyNames, msg: requestWithExtraProps, signer, log });
        return { ...requestWithExtraProps, signature };
    };
}

export async function publishChallengeAnswerMessageWithExtraProps({
    publication,
    challengeAnswers,
    extraProps,
    includeExtraPropsInChallengeSignedPropertyNames
}: {
    publication: Publication;
    challengeAnswers: string[];
    extraProps: Object;
    includeExtraPropsInChallengeSignedPropertyNames: boolean;
}) {
    // we're crafting a challenge answer from scratch here

    const log = Logger("pkc-js:test-util:setExtraPropsOnChallengeAnswerMessageAndSign");
    const signer = Object.values(publication._challengeExchanges)[0].signer;
    if (!signer) throw Error("Signer is undefined for this challenge exchange");
    const encryptedChallengeAnswers = await encryptEd25519AesGcm(
        JSON.stringify({ challengeAnswers }),
        signer.privateKey,
        publication._community!.encryption.publicKey
    );
    const toSignAnswer: Omit<ChallengeAnswerMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEANSWER",
        challengeRequestId: Object.values(publication._challengeExchanges)[0].challengeRequest.challengeRequestId,
        encrypted: encryptedChallengeAnswers,
        userAgent: publication._pkc.userAgent,
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: timestamp()
    });
    const signedPropertyNames = remeda.keys.strict(toSignAnswer);
    //@ts-expect-error
    if (includeExtraPropsInChallengeSignedPropertyNames) signedPropertyNames.push(...Object.keys(extraProps));

    Object.assign(toSignAnswer, extraProps);

    const signature = await _signPubsubMsg({ signedPropertyNames, msg: toSignAnswer, signer, log });

    await publishOverPubsub(publication._community!.pubsubTopic!, { ...toSignAnswer, signature });
}

export async function publishChallengeMessageWithExtraProps({
    publication,
    pubsubSigner,
    extraProps,
    includeExtraPropsInChallengeSignedPropertyNames
}: {
    publication: Publication;
    pubsubSigner: SignerType;
    extraProps: Object;
    includeExtraPropsInChallengeSignedPropertyNames: boolean;
}) {
    const log = Logger("pkc-js:test-util:publishChallengeMessageWithExtraProps");

    const encryptedChallenges = await encryptEd25519AesGcmPublicKeyBuffer(
        deterministicStringify({ challenges: [] })!,
        pubsubSigner.privateKey,
        Object.values(publication._challengeExchanges)[0].challengeRequest.signature.publicKey
    );

    const toSignChallenge: Omit<ChallengeMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGE",
        challengeRequestId: Object.values(publication._challengeExchanges)[0].challengeRequest.challengeRequestId,
        encrypted: encryptedChallenges,
        userAgent: publication._pkc.userAgent,
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: timestamp()
    });
    const signedPropertyNames = remeda.keys.strict(toSignChallenge);
    //@ts-expect-error
    if (includeExtraPropsInChallengeSignedPropertyNames) signedPropertyNames.push(...Object.keys(extraProps));

    Object.assign(toSignChallenge, extraProps);

    const signature = await _signPubsubMsg({
        signedPropertyNames: <ChallengeMessageType["signature"]["signedPropertyNames"]>signedPropertyNames,
        msg: toSignChallenge,
        signer: pubsubSigner,
        log
    });

    await publishOverPubsub(pubsubSigner.address, { ...toSignChallenge, signature });
}

export async function publishChallengeVerificationMessageWithExtraProps({
    publication,
    pubsubSigner,
    extraProps,
    includeExtraPropsInChallengeSignedPropertyNames
}: {
    publication: Publication;
    pubsubSigner: SignerType;
    extraProps: Object;
    includeExtraPropsInChallengeSignedPropertyNames: boolean;
}) {
    const log = Logger("pkc-js:test-util:publishChallengeVerificationMessageWithExtraProps");

    const toSignChallengeVerification: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEVERIFICATION",
        challengeRequestId: Object.values(publication._challengeExchanges)[0].challengeRequest.challengeRequestId,
        challengeSuccess: false,
        reason: "Random reason",
        userAgent: publication._pkc.userAgent,
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: timestamp()
    });
    const signedPropertyNames = remeda.keys.strict(toSignChallengeVerification);
    //@ts-expect-error
    if (includeExtraPropsInChallengeSignedPropertyNames) signedPropertyNames.push(...Object.keys(extraProps));

    Object.assign(toSignChallengeVerification, extraProps);

    const signature = await _signPubsubMsg({
        signedPropertyNames: <ChallengeVerificationMessageType["signature"]["signedPropertyNames"]>signedPropertyNames,
        msg: toSignChallengeVerification,
        signer: pubsubSigner,
        log
    });

    await publishOverPubsub(pubsubSigner.address, { ...toSignChallengeVerification, signature });
}

export async function publishChallengeVerificationMessageWithEncryption(
    publication: Publication,
    pubsubSigner: SignerType,
    toEncrypt: Object,
    verificationProps?: Partial<ChallengeVerificationMessageType>
) {
    const log = Logger("pkc-js:test-util:publishChallengeVerificationMessageWithExtraProps");

    const challengeRequest = Object.values(publication._challengeExchanges)[0].challengeRequest;
    const toSignChallengeVerification: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEVERIFICATION",
        challengeRequestId: challengeRequest.challengeRequestId,
        challengeSuccess: true,
        userAgent: publication._pkc.userAgent,
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: timestamp(),
        ...verificationProps
    });

    const publicKey = Buffer.from(challengeRequest.signature.publicKey).toString("base64");
    const encrypted = await encryptEd25519AesGcm(JSON.stringify(toEncrypt), pubsubSigner.privateKey, publicKey);

    toSignChallengeVerification.encrypted = encrypted;

    const signature = await signChallengeVerification({ challengeVerification: toSignChallengeVerification, signer: pubsubSigner });

    await publishOverPubsub(pubsubSigner.address, { ...toSignChallengeVerification, signature });
}

export async function addStringToIpfs(content: string): Promise<string> {
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
    const ipfsClient = pkc._clientsManager.getDefaultKuboRpcClient();
    const cid = (await retryKuboIpfsAdd({ content, ipfsClient: ipfsClient._client, log: Logger("pkc-js:test-util:addStringToIpfs") })).path;
    await pkc.destroy();
    return cid;
}

export async function publishOverPubsub(pubsubTopic: string, jsonToPublish: PubsubMessage) {
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
    await pkc._clientsManager.pubsubPublish(pubsubTopic, jsonToPublish);
    await pkc.destroy();
}

export async function mockPKCWithHeliaConfig(opts?: MockPKCOptions) {
    const key = "Helia config default for testing(remote)" + String(opts?.forceMockPubsub ? "" : Math.random());
    const forceMockPubsub = typeof opts?.forceMockPubsub === "boolean" ? opts.forceMockPubsub : true;
    const heliaPKC = await mockPKCV2({
        forceMockPubsub,
        ...opts,
        pkcOptions: {
            libp2pJsClientsOptions: [{ key, libp2pOptions: { connectionGater: { denyDialMultiaddr: async () => false } } }],
            pubsubKuboRpcClientsOptions: [],
            kuboRpcClientsOptions: [],
            pkcRpcClientsOptions: undefined,
            httpRoutersOptions: ["http://localhost:20001"], // this http router transmits the addresses of kubo node of test-server.js
            dataPath: undefined,
            ...opts?.pkcOptions
        }
    });

    if (forceMockPubsub) {
        const mockedPubsubClient = createMockPubsubClient();
        const heliaLibp2pJsClient = heliaPKC.clients.libp2pJsClients[Object.keys(heliaPKC.clients.libp2pJsClients)[0]];
        heliaLibp2pJsClient.heliaWithKuboRpcClientFunctions.pubsub = mockedPubsubClient.pubsub; // that should work for publishing/subscribing
        const originalStop = heliaLibp2pJsClient._helia.stop.bind(heliaLibp2pJsClient._helia);
        heliaLibp2pJsClient._helia.stop = async () => {
            await originalStop();
            await mockedPubsubClient.destroy();
        };
    }

    return heliaPKC;
}

type PKCTestConfigCode = "remote-kubo-rpc" | "remote-ipfs-gateway" | "remote-pkc-rpc" | "local-kubo-rpc" | "remote-libp2pjs";

type PKCConfigWithName = {
    name: string;
    pkcInstancePromise: (args?: MockPKCOptions) => Promise<PKC>;
    testConfigCode: PKCTestConfigCode;
};

const testConfigCodeToPKCInstanceWithHumanName: Record<PKCTestConfigCode, PKCConfigWithName> = {
    "remote-kubo-rpc": {
        pkcInstancePromise: (args?: MockPKCOptions) => mockPKCNoDataPathWithOnlyKuboClient(args),
        name: "Kubo Node with no datapath (remote)",
        testConfigCode: "remote-kubo-rpc"
    },
    "remote-ipfs-gateway": {
        pkcInstancePromise: (args?: MockPKCOptions) => mockGatewayPKC(args),
        name: "IPFS Gateway",
        testConfigCode: "remote-ipfs-gateway"
    },
    "remote-pkc-rpc": {
        pkcInstancePromise: (args?: MockPKCOptions) => mockRpcRemotePKC(args),
        name: "PKC RPC Remote",
        testConfigCode: "remote-pkc-rpc"
    },
    "local-kubo-rpc": {
        pkcInstancePromise: (args?: MockPKCOptions) =>
            mockPKCV2({
                ...args,
                pkcOptions: {
                    ...args?.pkcOptions,
                    pkcRpcClientsOptions: undefined,
                    kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                    pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
                    ipfsGatewayUrls: undefined
                }
            }),
        name: "Kubo node with datapath (local)",
        testConfigCode: "local-kubo-rpc"
    },
    "remote-libp2pjs": {
        pkcInstancePromise: (args?: MockPKCOptions) => mockPKCWithHeliaConfig(args),
        name: "Libp2pJS client with no datapath (remote)",
        testConfigCode: "remote-libp2pjs"
    }
};

let pkcConfigs: PKCConfigWithName[] = [];

export function setPKCConfigs(configs: PKCTestConfigCode[]) {
    if (configs.length === 0) throw Error("No configs were provided");

    // Make sure each config exists in the mapper
    for (const config of configs)
        if (!testConfigCodeToPKCInstanceWithHumanName[config])
            throw new Error(
                `Config "${config}" does not exist in the mapper. Available configs are: ${Object.keys(testConfigCodeToPKCInstanceWithHumanName)}`
            );

    pkcConfigs = configs.map((config) => testConfigCodeToPKCInstanceWithHumanName[config]);

    if ((globalThis as any).window) {
        (globalThis as any).window.addEventListener("uncaughtException", (err: any) => {
            console.error("uncaughtException", JSON.stringify(err, ["message", "arguments", "type", "name"]));
        });
        (globalThis as any).window.addEventListener("unhandledrejection", (err: any) => {
            console.error("unhandledRejection", JSON.stringify(err, ["message", "arguments", "type", "name"]));
        });
    } else if (process) {
        process.setMaxListeners(100);
        process.on("uncaughtException", (...err: any[]) => {
            console.error("uncaughtException", ...err);
        });
        process.on("unhandledRejection", (...err: any[]) => {
            console.error("unhandledRejection", ...err);
        });
    }
}

export function getAvailablePKCConfigsToTestAgainst(opts?: {
    includeOnlyTheseTests?: PKCTestConfigCode[];
    includeAllPossibleConfigOnEnv?: boolean;
}): PKCConfigWithName[] {
    if (opts?.includeAllPossibleConfigOnEnv) {
        // "remote-libp2pjs" temporarily disabled — see issue #82 / #74. Config definition is
        // still in testConfigCodeToPKCInstanceWithHumanName so it can be opted into via
        // includeOnlyTheseTests by tests that intentionally probe the libp2pjs path.
        // if node, ["local-kubo-rpc", "remote-kubo-rpc", "remote-ipfs-gateway"], also 'remote-pkc-rpc' if isRpcFlagOn()
        // if browser, ["remote-kubo-rpc", "remote-ipfs-gateway"]
        const isBrowser = isRunningInBrowser();
        const pkcConfigCodes: PKCTestConfigCode[] = isBrowser
            ? ["remote-kubo-rpc", "remote-ipfs-gateway"]
            : ["local-kubo-rpc", "remote-kubo-rpc", "remote-ipfs-gateway"];
        if (!isBrowser && isRpcFlagOn()) pkcConfigCodes.push("remote-pkc-rpc");
        const availableConfigs = remeda.pick(testConfigCodeToPKCInstanceWithHumanName, pkcConfigCodes);
        if (opts.includeOnlyTheseTests?.length) {
            return Object.values(remeda.pick(availableConfigs, opts.includeOnlyTheseTests));
        }
        return Object.values(availableConfigs);
    }
    // Check if configs are passed via environment variable
    const pkcConfigsFromEnv = process?.env?.PKC_CONFIGS;
    if (pkcConfigsFromEnv) {
        const configs = pkcConfigsFromEnv.split(",") as PKCTestConfigCode[];
        // Set the configs if they're coming from the environment variable
        setPKCConfigs(configs);
    }
    //@ts-expect-error
    const pkcConfigsFromWindow = <string | undefined>globalThis["window"]?.["PKC_CONFIGS"];
    if (pkcConfigsFromWindow) {
        const configs = pkcConfigsFromWindow.split(",") as PKCTestConfigCode[];
        // Set the configs if they're coming from the environment variable
        setPKCConfigs(configs);
    }
    if (pkcConfigs.length === 0) throw Error("No remote pkc configs set, " + pkcConfigsFromEnv + " " + pkcConfigsFromWindow);
    if (opts?.includeOnlyTheseTests) {
        opts.includeOnlyTheseTests.forEach((config) => {
            if (!testConfigCodeToPKCInstanceWithHumanName[config])
                throw new Error(
                    `Config "${config}" does not exist in the mapper. Available configs are: ${pkcConfigs.map((c) => c.name).join(", ")}`
                );
        });
        const filteredKeys = remeda.keys
            .strict(testConfigCodeToPKCInstanceWithHumanName)
            .filter(
                (config) =>
                    opts.includeOnlyTheseTests!.includes(config) &&
                    pkcConfigs.find((c) => c.name === testConfigCodeToPKCInstanceWithHumanName[config].name)
            );
        const configs = filteredKeys.map((config) => testConfigCodeToPKCInstanceWithHumanName[config]);
        return configs;
    }
    return pkcConfigs;
}

export async function createNewIpns() {
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient({});
    const ipfsClient = pkc._clientsManager.getDefaultKuboRpcClient();
    const signer = await pkc.createSigner();
    signer.ipfsKey = new Uint8Array(await getIpfsKeyFromPrivateKey(signer.privateKey));

    await importSignerIntoKuboNode(signer.address, signer.ipfsKey, {
        url: pkc.kuboRpcClientsOptions![0].url!.toString(),
        headers: pkc.kuboRpcClientsOptions![0].headers
    });

    const publishToIpns = async (content: string) => {
        const cid = await addStringToIpfs(content);
        await ipfsClient._client.name.publish(cid, {
            key: signer.address,
            allowOffline: true
        });

        // Verify the IPNS record is resolvable before returning
        // This ensures Kubo's cache is properly synced for RPC tests
        // Wrapped in retry because Kubo can transiently ETIMEDOUT in CI
        const resolvedCid = await new Promise<string>((resolve, reject) => {
            const operation = retry.operation({
                retries: 3,
                factor: 2,
                minTimeout: 2000
            });

            operation.attempt(async (currentAttempt) => {
                try {
                    const result = await last(
                        ipfsClient._client.name.resolve(signer.address, {
                            nocache: false, // Allow cache to be used
                            timeout: 5000 // 5 second timeout for verification
                        })
                    );
                    if (!result) {
                        throw new Error(`Failed to verify IPNS resolution for ${signer.address}`);
                    }
                    resolve(result);
                } catch (error) {
                    if (operation.retry(error as Error)) return;
                    reject(operation.mainError() || error);
                }
            });
        });
    };

    return {
        signer,
        publishToIpns,
        pkc
    };
}

async function getTemplateCommunityRecord(pkc: PKC): Promise<CommunityIpfsType> {
    const community = await pkc.createCommunity({ address: "12D3KooWANwdyPERMQaCgiMnTT1t3Lr4XLFbK1z4ptFVhW2ozg1z" });
    await community.update();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    const result = community.raw.communityIpfs!;
    await community.stop();
    return result;
}

export async function publishCommunityRecordWithExtraProp(opts?: { includeExtraPropInSignedPropertyNames: boolean; extraProps: Object }) {
    const ipnsObj = await createNewIpns();
    const communityRecord = JSON.parse(JSON.stringify(await getTemplateCommunityRecord(ipnsObj.pkc)));
    communityRecord.pubsubTopic = ipnsObj.signer.address;
    delete communityRecord.posts;
    if (opts?.extraProps) Object.assign(communityRecord, opts.extraProps);
    const signedPropertyNames = communityRecord.signature.signedPropertyNames;
    if (opts?.includeExtraPropInSignedPropertyNames) signedPropertyNames.push("extraProp");
    communityRecord.signature = await _signJson(
        signedPropertyNames,
        communityRecord,
        ipnsObj.signer,
        Logger("pkc-js:test-util:publishCommunityRecordWithExtraProp")
    );

    await ipnsObj.publishToIpns(JSON.stringify(communityRecord));

    return { communityRecord, ipnsObj };
}

export async function createMockedCommunityIpns(communityOpts: CreateNewLocalCommunityUserOptions) {
    const ipnsObj = await createNewIpns();
    const communityAddress = ipnsObj.signer.address;
    const communityRecord = <CommunityIpfsType>{
        ...(await getTemplateCommunityRecord(ipnsObj.pkc)),
        posts: undefined,
        pubsubTopic: communityAddress,
        ...communityOpts
    }; // default community, will be using its props
    if (!communityRecord.posts) delete communityRecord.posts;

    communityRecord.signature = await signCommunity({ community: communityRecord, signer: ipnsObj.signer });
    await ipnsObj.publishToIpns(JSON.stringify(communityRecord));

    await ipnsObj.pkc.destroy();

    return { communityRecord, communityAddress, ipnsObj };
}

export async function createStaticCommunityRecordForComment(opts?: {
    pkc?: PKC;
    commentOptions?: Partial<CreateCommentOptions & { depth?: number }>;
    invalidateCommunitySignature?: boolean;
}) {
    const { pkc, commentOptions = {}, invalidateCommunitySignature = false } = opts || {};
    if (commentOptions.parentCid && !commentOptions.postCid) throw Error("postCid must be provided when parentCid is supplied for a reply");

    const ipnsObj = await createNewIpns();
    const communityAddress = ipnsObj.signer.address;
    const commentPKC = pkc || (await mockPKCNoDataPathWithOnlyKuboClient());
    const shouldDestroyCommentPKC = !pkc;
    try {
        const communityRecord = <CommunityIpfsType>{
            ...(await getTemplateCommunityRecord(ipnsObj.pkc)),
            posts: undefined,
            pubsubTopic: communityAddress
        };
        if (!communityRecord.posts) delete communityRecord.posts;
        // Always publish a valid record first so the IPNS key is established for gateway discovery
        communityRecord.signature = await signCommunity({ community: communityRecord, signer: ipnsObj.signer });
        await ipnsObj.publishToIpns(JSON.stringify(communityRecord));

        const commentToPublish = await commentPKC.createComment({
            ...commentOptions,
            signer: commentOptions.signer || (await commentPKC.createSigner()),
            communityAddress: communityAddress,
            title: commentOptions.title ?? `Mock Post - ${Date.now()}`,
            content: commentOptions.content ?? `Mock content - ${Date.now()}`
        });

        const depth = typeof commentOptions.depth === "number" ? commentOptions.depth : commentOptions.parentCid ? 1 : 0;

        if (!commentToPublish.raw.pubsubMessageToPublish) {
            // Directly set _community from in-memory data to avoid fetching from the gateway.
            // This prevents caching the valid community record in dedicatedPKC's memory,
            // which would otherwise cause the subsequent update() to get the cached valid record
            // instead of fetching the (possibly invalid) record from the gateway.
            (commentToPublish as unknown as Record<string, unknown>)["_community"] = {
                address: communityAddress,
                publicKey: getPKCAddressFromPublicKeySync(communityRecord.signature.publicKey),
                encryption: communityRecord.encryption,
                pubsubTopic: communityRecord.pubsubTopic
            };
            await commentToPublish._signPublicationWithCommunityFields();
        }

        const commentIpfs: Record<string, any> = { ...commentToPublish.raw.pubsubMessageToPublish, depth };
        if (commentOptions.parentCid) {
            commentIpfs.parentCid = commentOptions.parentCid;
            commentIpfs.postCid = commentOptions.postCid;
        }

        const commentCid = await addStringToIpfs(JSON.stringify(commentIpfs));

        // Optionally re-publish with invalid signature after comment is already created
        if (invalidateCommunitySignature) {
            communityRecord.updatedAt = (communityRecord.updatedAt || timestamp()) + 1234;
            await ipnsObj.publishToIpns(JSON.stringify(communityRecord));
        }

        return { commentCid, communityAddress: communityAddress };
    } finally {
        await ipnsObj.pkc.destroy();
        if (shouldDestroyCommentPKC) await commentPKC.destroy();
    }
}

function _stripNameResolvedFromPages(pagesContainer: any) {
    if (!pagesContainer?.pages) return;
    for (const page of Object.values(pagesContainer.pages)) {
        if (!page || !(page as any).comments) continue;
        for (const c of (page as any).comments) {
            if (c?.author) delete c.author.nameResolved;
        }
    }
}

export function jsonifyCommunityAndRemoveInternalProps(community: RemoteCommunity) {
    const jsonfied = JSON.parse(JSON.stringify(community));
    delete jsonfied["posts"]["clients"];
    delete jsonfied["modQueue"]["clients"];
    delete jsonfied["raw"]["runtimeFieldsFromRpc"];
    delete jsonfied["raw"]["localCommunity"];
    // Normalize old raw key to new key for backward compat comparison
    if (jsonfied["raw"]["subplebbitIpfs"] && !jsonfied["raw"]["communityIpfs"]) {
        jsonfied["raw"]["communityIpfs"] = jsonfied["raw"]["subplebbitIpfs"];
        delete jsonfied["raw"]["subplebbitIpfs"];
    }
    _stripNameResolvedFromPages(jsonfied["posts"]);
    _stripNameResolvedFromPages(jsonfied["modQueue"]);

    return remeda.omit(jsonfied, ["startedState", "started", "signer", "settings", "editable", "clients", "updatingState", "state"]);
}

export function jsonifyLocalCommunityWithNoInternalProps(community: LocalCommunity) {
    const localJson = <LocalCommunityJson>JSON.parse(JSON.stringify(community));
    //@ts-expect-error
    delete localJson["posts"]["clients"];
    return remeda.omit(localJson, ["startedState", "started", "clients", "state", "updatingState"]);
}

export function jsonifyCommentAndRemoveInstanceProps(comment: Comment) {
    const jsonfied = cleanUpBeforePublishing(JSON.parse(JSON.stringify(comment)));
    if ("replies" in jsonfied) delete jsonfied["replies"]["clients"];
    if ("replies" in jsonfied && remeda.isEmpty(jsonfied.replies)) delete jsonfied["replies"];
    // nameResolved is runtime-only — strip it like jsonifyCommunityAndRemoveInternalProps does
    if (jsonfied.author?.nameResolved !== undefined) delete jsonfied.author.nameResolved;
    _stripNameResolvedFromPages(jsonfied["replies"]);
    return remeda.omit(jsonfied, ["clients", "state", "updatingState", "state", "publishingState", "raw"]);
}

export async function waitUntilPKCCommunitiesIncludeSubAddress(pkc: PKC, subAddress: string) {
    return pkc._awaitCommunitiesToIncludeCommunity(subAddress);
}

export function isPKCFetchingUsingGateways(pkc: PKC): boolean {
    return (
        !pkc._pkcRpcClient && Object.keys(pkc.clients.kuboRpcClients).length === 0 && Object.keys(pkc.clients.libp2pJsClients).length === 0
    );
}

export function mockRpcServerForTests(pkcWs: any) {
    const functionsToBind = [
        "_createCommentModerationInstanceFromPublishCommentModerationParams",
        "_createCommentEditInstanceFromPublishCommentEditParams",
        "_createVoteInstanceFromPublishVoteParams",
        "_createCommentInstanceFromPublishCommentParams",
        "_createCommunityEditInstanceFromPublishCommunityEditParams"
    ];

    // disable validation of signature before publishing
    // reduce threshold for publishing

    for (const funcBind of functionsToBind) {
        const originalFunc = pkcWs[funcBind].bind(pkcWs);
        pkcWs[funcBind] = async (...args: any[]) => {
            const pubInstance = await originalFunc(...args);
            disableValidationOfSignatureBeforePublishing(pubInstance);
            pubInstance._publishToDifferentProviderThresholdSeconds = 5;
            pubInstance._setProviderFailureThresholdSeconds = 10;
            return pubInstance;
        };
    }
}

export function disablePreloadPagesOnSub({ community }: { community: LocalCommunity }) {
    if (!(community instanceof LocalCommunity)) throw Error("You need to provide LocalCommunity instance");

    //@ts-expect-error
    const pageGenerator = community._pageGenerator;

    const originalCommunityPostsFunc = pageGenerator.generateCommunityPosts.bind(pageGenerator);
    const originalPostRepliesFunc = pageGenerator.generatePostPages.bind(pageGenerator);
    const originalReplyRepliesFunc = pageGenerator.generateReplyPages.bind(pageGenerator);
    const originalChunkComments = pageGenerator._chunkComments.bind(pageGenerator);

    pageGenerator.generateCommunityPosts = async (preloadedPageSortName, preloadedPageSize) => {
        return originalCommunityPostsFunc(preloadedPageSortName, preloadedPageSize); // should force community to publish to pageCids
    };

    pageGenerator.generatePostPages = async (comment, preloadedPageSortName, preloadedPageSize) => {
        return originalPostRepliesFunc(comment, preloadedPageSortName, preloadedPageSize); // should force community to publish to pageCids
    };

    pageGenerator.generateReplyPages = async (comment, preloadedPageSortName, preloadedPageSize) => {
        return originalReplyRepliesFunc(comment, preloadedPageSortName, preloadedPageSize);
    };

    //@ts-expect-error
    pageGenerator._chunkComments = async (opts: any) => {
        const res = await originalChunkComments(opts);
        return [[], ...res];
    };

    const cleanup = () => {
        pageGenerator.generateCommunityPosts = originalCommunityPostsFunc;
        pageGenerator.generatePostPages = originalPostRepliesFunc;
        pageGenerator.generateReplyPages = originalReplyRepliesFunc;
        pageGenerator._chunkComments = originalChunkComments;
    };

    return { cleanup };
}

export function mockPostToReturnSpecificCommentUpdate(commentToBeMocked: Comment, commentUpdateRecordString: string) {
    const updatingPostComment = findUpdatingComment(commentToBeMocked._pkc, { cid: commentToBeMocked.cid! });
    if (!updatingPostComment) throw Error("Post should be updating before starting to mock");
    if (commentToBeMocked._pkc._pkcRpcClient) throw Error("Can't mock Post to return specific CommentUpdate record when pkc is using RPC");

    delete updatingPostComment.updatedAt;
    delete updatingPostComment.raw.commentUpdate;
    //@ts-expect-error
    delete updatingPostComment._communityForUpdating?.community?.updateCid;
    //@ts-expect-error
    if (updatingPostComment._communityForUpdating?.community?._clientsManager?._updateCidsAlreadyLoaded)
        //@ts-expect-error
        updatingPostComment._communityForUpdating.community._clientsManager._updateCidsAlreadyLoaded = new Set();

    mockCommentToNotUsePagesForUpdates(commentToBeMocked);
    if (isPKCFetchingUsingGateways(updatingPostComment._pkc)) {
        const originalFetch = updatingPostComment._clientsManager.fetchFromMultipleGateways.bind(updatingPostComment._clientsManager);

        updatingPostComment._clientsManager.fetchFromMultipleGateways = async (...args) => {
            const commentUpdateCid = await addStringToIpfs(commentUpdateRecordString);
            if (args[0].recordPKCType === "comment-update")
                return originalFetch({
                    ...args[0],
                    root: commentUpdateCid,
                    path: undefined
                });
            else return originalFetch(...args);
        };
    } else {
        // we're using kubo/helia
        const originalFetch = updatingPostComment._clientsManager._fetchCidP2P.bind(updatingPostComment._clientsManager);
        //@ts-expect-error
        updatingPostComment._clientsManager._fetchCidP2P = (...args) => {
            if (args[0].endsWith("/update")) {
                return commentUpdateRecordString;
            } else return originalFetch(...args);
        };
    }
}

export function mockPostToFailToLoadFromPostUpdates(postToBeMocked: Comment) {
    const updatingPostComment = findUpdatingComment(postToBeMocked._pkc, { cid: postToBeMocked.cid! });
    if (!updatingPostComment) throw Error("Post should be updating before starting to mock");
    if (postToBeMocked._pkc._pkcRpcClient) throw Error("Can't mock Post to to fail loading post from postUpdates when pkc is using RPC");

    mockCommentToNotUsePagesForUpdates(postToBeMocked);
    updatingPostComment._clientsManager._fetchPostCommentUpdateIpfsP2P =
        updatingPostComment._clientsManager._fetchPostCommentUpdateFromGateways = async () => {
            throw new PKCError("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES");
        };
}

export function mockPostToHaveCommunityWithNoPostUpdates(postToBeMocked: Comment) {
    const updatingPostComment = findUpdatingComment(postToBeMocked._pkc, { cid: postToBeMocked.cid! });
    if (!updatingPostComment) throw Error("Post should be updating before starting to mock");
    if (postToBeMocked._pkc._pkcRpcClient) throw Error("Can't mock Post to to fail loading post from postUpdates when pkc is using RPC");

    mockCommentToNotUsePagesForUpdates(postToBeMocked);
    const originalCommunityUpdateHandle = updatingPostComment._clientsManager.handleUpdateEventFromCommunity.bind(
        updatingPostComment._clientsManager
    );
    updatingPostComment._clientsManager.handleUpdateEventFromCommunity = (community: RemoteCommunity) => {
        delete community.postUpdates;
        delete community.raw.communityIpfs!.postUpdates;
        return originalCommunityUpdateHandle(community);
    };
}

export async function createCommentUpdateWithInvalidSignature(commentCid: string) {
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient({});

    const comment = await pkc.getComment({ cid: commentCid });

    await comment.update();

    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });

    const invalidCommentUpdateJson = comment.raw.commentUpdate!;
    await comment.stop();

    invalidCommentUpdateJson.updatedAt += 1234; // Invalidate CommentUpdate signature

    return invalidCommentUpdateJson;
}

export function mockPKCToTimeoutFetchingCid(pkc: PKC) {
    const originalFetch = pkc._clientsManager._fetchCidP2P;
    const restoreFns: Array<() => void> = [];
    for (const ipfsClient of Object.values(pkc.clients.kuboRpcClients)) {
        const originalCat = ipfsClient._client.cat;
        ipfsClient._client.cat = async function* (ipfsPath, options) {
            await new Promise((resolve) => setTimeout(resolve, pkc._timeouts["community-ipfs"] * 2));
            return undefined;
        };
        restoreFns.push(() => {
            ipfsClient._client.cat = originalCat;
        });
    }

    for (const libp2pJsClient of Object.values(pkc.clients.libp2pJsClients)) {
        const originalCat = libp2pJsClient.heliaWithKuboRpcClientFunctions.cat;
        libp2pJsClient.heliaWithKuboRpcClientFunctions.cat = async function* (ipfsPath, options) {
            await new Promise((resolve) => setTimeout(resolve, pkc._timeouts["community-ipfs"] * 2));
            return undefined;
        };
        restoreFns.push(() => {
            libp2pJsClient.heliaWithKuboRpcClientFunctions.cat = originalCat;
        });
    }

    // TODO mock for gateway
    // pkc._clientsManager._fetchCidP2P = async (...args) => {
    //     await new Promise((resolve) => setTimeout(resolve, pkc._timeouts["community-ipfs"] * 2));
    //     return undefined;
    // };

    return {
        cleanUp: () => {
            pkc._clientsManager._fetchCidP2P = originalFetch;
            for (const restore of restoreFns) restore();
        }
    };
}

export function mockCommentToNotUsePagesForUpdates(comment: Comment) {
    const updatingComment = findUpdatingComment(comment._pkc, { cid: comment.cid! });
    if (!updatingComment) throw Error("Comment should be updating before starting to mock");

    if (comment._pkc._pkcRpcClient) throw Error("Can't mock comment  _findCommentInPagesOfUpdatingCommentsCommunity with pkc rpc clients");

    delete updatingComment.raw.commentUpdate;
    delete updatingComment.updatedAt;
    updatingComment._clientsManager._findCommentInPagesOfUpdatingCommentsOrCommunity = () => undefined;
}

const FORCE_COMMUNITY_MIN_POST_CONTENT_BYTES = 30 * 1024;

function ensureLocalCommunityForForcedChunking(
    community?: LocalCommunity | RpcLocalCommunity | RemoteCommunity
): asserts community is LocalCommunity {
    if (!community) throw Error("Local community instance is required to force reply pages to use page cids");
    if (!(community instanceof LocalCommunity)) throw Error("Forcing reply page chunking is only supported when using a LocalCommunity");
}

export async function forceLocalSubPagesToAlwaysGenerateMultipleChunks({
    community,
    parentComment,
    forcedPreloadedPageSizeBytes = 1,
    parentCommentReplyProps,
    communityPostsCommentProps
}: {
    community: LocalCommunity | RemoteCommunity;
    parentComment?: Comment;
    forcedPreloadedPageSizeBytes?: number;
    parentCommentReplyProps?: Partial<CreateCommentOptions>;
    communityPostsCommentProps?: CreateCommentOptions;
}): Promise<{ cleanup: () => void }> {
    if (!parentComment) {
        await forceCommunityToGenerateAllPostsPages(community as RemoteCommunity, communityPostsCommentProps);
        return { cleanup: () => {} };
    }

    ensureLocalCommunityForForcedChunking(community);
    const parentCid = parentComment.cid;
    if (!parentCid) throw Error("parent comment cid is required to force chunking to multiple pages");
    const localCommunity = community as LocalCommunity;
    const communityWithGenerator = localCommunity as LocalCommunity & { [key: string]: unknown };
    const pageGenerator = communityWithGenerator["_pageGenerator"] as
        | {
              generateReplyPages?: (
                  comment: Pick<CommentsTableRow, "cid" | "depth">,
                  preloadedReplyPageSortName: keyof typeof REPLY_REPLIES_SORT_TYPES,
                  preloadedPageSizeBytes: number
              ) => Promise<RepliesPagesTypeIpfs | { singlePreloadedPage: Record<string, PageIpfs> } | undefined>;
              generatePostPages?: (
                  comment: Pick<CommentsTableRow, "cid">,
                  preloadedReplyPageSortName: keyof typeof POST_REPLIES_SORT_TYPES,
                  preloadedPageSizeBytes: number
              ) => Promise<any>;
          }
        | undefined;
    if (!pageGenerator) throw Error("Local community page generator is not initialized");

    const isPost = parentComment.depth === 0;
    const originalGenerateReplyPages = pageGenerator.generateReplyPages;
    const originalGeneratePostPages = pageGenerator.generatePostPages;

    if (isPost) {
        if (typeof originalGeneratePostPages !== "function") throw Error("Page generator post pages function is not available");
        pageGenerator.generatePostPages = (async (comment, preloadedReplyPageSortName, preloadedPageSizeBytes) => {
            const shouldForce = comment?.cid === parentCid;
            const effectivePageSizeBytes = shouldForce
                ? Math.min(preloadedPageSizeBytes, forcedPreloadedPageSizeBytes)
                : preloadedPageSizeBytes;
            return originalGeneratePostPages.call(pageGenerator, comment, preloadedReplyPageSortName, effectivePageSizeBytes);
        }) as typeof pageGenerator.generatePostPages;
    } else {
        if (typeof originalGenerateReplyPages !== "function") throw Error("Page generator reply pages function is not available");
        pageGenerator.generateReplyPages = (async (comment, preloadedReplyPageSortName, preloadedPageSizeBytes) => {
            const shouldForce = comment?.cid === parentCid;
            const effectivePageSizeBytes = shouldForce
                ? Math.min(preloadedPageSizeBytes, forcedPreloadedPageSizeBytes)
                : preloadedPageSizeBytes;
            return originalGenerateReplyPages.call(pageGenerator, comment, preloadedReplyPageSortName, effectivePageSizeBytes);
        }) as typeof pageGenerator.generateReplyPages;
    }

    const cleanup = () => {
        if (isPost && originalGeneratePostPages) pageGenerator.generatePostPages = originalGeneratePostPages;
        if (!isPost && originalGenerateReplyPages) pageGenerator.generateReplyPages = originalGenerateReplyPages;
    };

    try {
        if (Object.keys(parentComment.replies.pageCids).length === 0)
            await ensureParentCommentHasPageCidsForChunking(parentComment, {
                commentProps: parentCommentReplyProps,
                publishWithPKC: localCommunity._pkc
            });
    } catch (err) {
        cleanup();
        throw err;
    }

    return { cleanup };
}

async function ensureParentCommentHasPageCidsForChunking(
    parentComment: Comment,
    options?: { commentProps?: Partial<CreateCommentOptions>; publishWithPKC?: PKC }
) {
    if (!parentComment?.cid) throw Error("parent comment cid should be defined before ensuring page cids");
    const hasPageCids = () => Object.keys(parentComment.replies.pageCids).length > 0;
    if (hasPageCids()) return;

    const { commentProps, publishWithPKC } = options ?? {};

    const MAX_REPLIES_TO_PUBLISH = 5;
    for (let i = 0; i < MAX_REPLIES_TO_PUBLISH && !hasPageCids(); i++) {
        const replyProps: Partial<CreateCommentOptions> = {
            ...commentProps,
            content: commentProps?.content ?? `force pagination reply ${i} ${Date.now()}`
        };
        const publishingPKC = publishWithPKC ?? parentComment._pkc;
        await publishRandomReply({
            parentComment: parentComment as CommentIpfsWithCidDefined,
            pkc: publishingPKC,
            commentProps: replyProps
        });
        await parentComment.update();
        await resolveWhenConditionIsTrue({
            toUpdate: parentComment,
            predicate: async () => hasPageCids()
        });
    }

    if (!hasPageCids()) throw Error(`Failed to force parent comment ${parentComment.cid} to have replies.pageCids`);
}

export async function findOrPublishCommentWithDepth({
    depth,
    community,
    pkc
}: {
    depth: number;
    community: RemoteCommunity;
    pkc?: PKC;
}): Promise<Comment> {
    const pkcWithDefault = pkc || community._pkc;
    let commentFromPreloadedPages: PageTypeJson["comments"][0] | undefined;
    if (community.posts.pages.hot) {
        processAllCommentsRecursively(community.posts.pages.hot.comments, (comment) => {
            if (comment.depth === depth) {
                commentFromPreloadedPages = comment as PageTypeJson["comments"][0];
            }
        });
    }

    if (commentFromPreloadedPages) return pkcWithDefault.createComment(commentFromPreloadedPages);

    let curComment: Comment;
    let closestCommentFromHot: PageTypeJson["comments"][0] | undefined;

    if (community.posts.pages.hot) {
        let maxDepthFound = -1;
        processAllCommentsRecursively(community.posts.pages.hot.comments, (comment) => {
            const commentDepth = comment.depth ?? 0;
            if (commentDepth <= depth && commentDepth > maxDepthFound) {
                maxDepthFound = commentDepth;
                closestCommentFromHot = comment as PageTypeJson["comments"][0];
            }
        });
    }

    if (closestCommentFromHot) {
        curComment = await pkcWithDefault.createComment(closestCommentFromHot);
    } else {
        curComment = await publishRandomPost({ communityAddress: community.address, pkc: pkcWithDefault });
    }

    if (curComment.depth === depth) return curComment;

    while (curComment.depth! < depth) {
        curComment = await publishRandomReply({ parentComment: curComment as CommentIpfsWithCidDefined, pkc: pkcWithDefault });
        if (curComment.depth === depth) return curComment;
    }
    throw Error("Failed to find or publish comment with depth");
}

export async function findOrPublishCommentWithDepthWithHttpServerShortcut({
    depth,
    community,
    pkc
}: {
    depth: number;
    community: RemoteCommunity;
    pkc?: PKC;
}): Promise<Comment> {
    const pkcWithDefault = pkc || community._pkc;

    const queryUrl = `http://localhost:14953/find-comment-with-depth?subAddress=${community.address}&commentDepth=${depth}`;

    const commentWithSameDepthOrClosest: CommentsTableRow = <any>await (await fetch(queryUrl)).json();

    if (commentWithSameDepthOrClosest.depth === depth) {
        return pkcWithDefault.createComment(commentWithSameDepthOrClosest);
    }

    let curComment = await publishRandomReply({ parentComment: commentWithSameDepthOrClosest, pkc: pkcWithDefault });
    while (curComment.depth! < depth) {
        curComment = await publishRandomReply({ parentComment: curComment as CommentIpfsWithCidDefined, pkc: pkcWithDefault });
        if (curComment.depth === depth) return curComment;
    }
    throw Error("Failed to find or publish comment with depth");
}

export async function publishCommentWithDepth({ depth, community }: { depth: number; community: RemoteCommunity }): Promise<Comment> {
    if (depth === 0) {
        return publishRandomPost({ communityAddress: community.address, pkc: community._pkc });
    } else {
        const parentComment = await publishCommentWithDepth({ depth: depth - 1, community });
        let curComment = await publishRandomReply({
            parentComment: parentComment as CommentIpfsWithCidDefined,
            pkc: community._pkc
        });
        if (curComment.depth === depth) return curComment;
        while (curComment.depth! < depth) {
            curComment = await publishRandomReply({ parentComment: curComment as CommentIpfsWithCidDefined, pkc: community._pkc });
            if (curComment.depth === depth) return curComment;
        }
        throw Error("Failed to publish comment with depth");
    }
}

export async function getCommentWithCommentUpdateProps({ cid, pkc }: { cid: string; pkc: PKC }) {
    const comment = await pkc.createComment({ cid });
    await comment.update();
    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => Boolean(comment.updatedAt) });
    return comment;
}

export async function publishCommentToModQueue({
    community,
    pkc,
    parentComment,
    commentProps
}: {
    community: RemoteCommunity;
    pkc?: PKC;
    parentComment?: Comment;
    commentProps?: Partial<CreateCommentOptions>;
}): Promise<{ comment: Comment; challengeVerification: DecryptedChallengeVerificationMessageType }> {
    if (!commentProps?.challengeRequest?.challengeAnswers)
        throw Error("You need to challengeRequest.challengeAnswers to pass the challenge and get to pending approval");

    const remotePKC = pkc || (await mockGatewayPKC({ forceMockPubsub: true, remotePKC: true })); // this pkc is not connected to kubo rpc client of community
    const pendingComment = parentComment
        ? await generateMockComment(parentComment as CommentIpfsWithCidDefined, remotePKC, false, {
              content: "Pending reply" + " " + Math.random(),
              ...commentProps
          })
        : await generateMockPost({
              communityAddress: community.address,
              pkc: remotePKC,
              postProps: {
                  content: "Pending post" + " " + Math.random(),
                  ...commentProps
              }
          });

    pendingComment.once("challenge", async () => {
        throw Error("Should not received challenge with challengeRequest props");
    });

    const challengeVerificationPromise = new Promise((resolve) =>
        pendingComment.once("challengeverification", resolve)
    ) as Promise<DecryptedChallengeVerificationMessageType>;

    await publishWithExpectedResult({ publication: pendingComment, expectedChallengeSuccess: true }); // a pending approval is technically challengeSucess = true

    if (!pendingComment.pendingApproval) throw Error("The comment did not go to pending approval");

    return { comment: pendingComment, challengeVerification: await challengeVerificationPromise };
}

export async function publishToModQueueWithDepth({
    community,
    depth,
    pkc,
    modCommentProps,
    commentProps
}: {
    community: RemoteCommunity;
    pkc: PKC;
    depth: number;
    modCommentProps?: Partial<CreateCommentOptions>;
    commentProps?: Partial<CreateCommentOptions>;
}) {
    if (!commentProps?.challengeRequest?.challengeAnswers)
        throw Error("You need to challengeRequest.challengeAnswers to pass the challenge and get to pending approval");
    if (depth === 0) return publishCommentToModQueue({ community, pkc, commentProps });
    else {
        // we assume mod can publish comments without mod queue
        const remotePKC = pkc || community._pkc;
        const commentsPublishedByMod = [
            await publishRandomPost({ communityAddress: community.address, pkc: remotePKC, postProps: modCommentProps })
        ];
        for (let i = 1; i < depth; i++) {
            commentsPublishedByMod.push(
                await publishRandomReply({
                    parentComment: commentsPublishedByMod[i - 1] as CommentIpfsWithCidDefined,
                    pkc: remotePKC,
                    commentProps: modCommentProps
                })
            );
        }
        // we have created a tree of comments and now we can publish the pending comment underneath it
        const pendingReply = await generateMockComment(
            commentsPublishedByMod[commentsPublishedByMod.length - 1] as CommentIpfsWithCidDefined,
            remotePKC,
            false,
            {
                content: "Pending reply" + " " + Math.random(),
                ...commentProps
            }
        );

        pendingReply.once("challenge", () => {
            throw Error("Should not received challenge with challengeRequest props");
        });

        const challengeVerificationPromise = new Promise((resolve) => pendingReply.once("challengeverification", resolve));

        await publishWithExpectedResult({ publication: pendingReply, expectedChallengeSuccess: true }); // a pending approval is technically challengeSucess = true

        if (!pendingReply.pendingApproval) throw Error("The reply did not go to pending approval");
        return { comment: pendingReply, challengeVerification: await challengeVerificationPromise };
    }
}

// This may not be needed
export async function forceCommunityToGenerateAllPostsPages(community: RemoteCommunity, commentProps?: CreateCommentOptions) {
    // max comment size is 40kb = 40000
    const rawCommunityRecord = community.raw.communityIpfs;
    if (!rawCommunityRecord) throw Error("Community should be updating before forcing to generate all pages");

    community.setMaxListeners(100);
    if (Object.keys(community.posts.pageCids).length > 0) return;
    const curRecordSize = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify(rawCommunityRecord));

    const maxCommentSize = 30000;
    const defaultContent = "x".repeat(FORCE_COMMUNITY_MIN_POST_CONTENT_BYTES); // 30kb
    const paddedContent =
        typeof commentProps?.content === "string"
            ? commentProps.content.padEnd(FORCE_COMMUNITY_MIN_POST_CONTENT_BYTES, "x")
            : defaultContent;
    const estimatedCommentSize = Math.max(maxCommentSize, Buffer.byteLength(paddedContent, "utf8"));
    const adjustedCommentProps = { ...commentProps, content: paddedContent };
    const numOfCommentsToPublish = Math.round((1024 * 1024 - curRecordSize) / estimatedCommentSize) + 1;

    let lastPublishedPost: Comment = await publishRandomPost({
        communityAddress: community.address,
        pkc: community._pkc,
        postProps: adjustedCommentProps
    });
    await Promise.all(
        new Array(numOfCommentsToPublish).fill(null).map(async () => {
            const post = await publishRandomPost({
                communityAddress: community.address,
                pkc: community._pkc,
                postProps: adjustedCommentProps
            });
            lastPublishedPost = post;
        })
    );

    await waitTillPostInCommunityPages(
        lastPublishedPost as unknown as Required<Pick<CommentIpfsWithCidDefined, "cid"> & { communityAddress: string }>,
        community._pkc
    );
    const newCommunity = await community._pkc.createCommunity({ address: community.address });
    await newCommunity.update();
    await resolveWhenConditionIsTrue({ toUpdate: newCommunity, predicate: async () => typeof newCommunity.updatedAt === "number" });
    if (Object.keys(newCommunity.posts.pageCids).length === 0) throw Error("Failed to force the community to load all pages");
    await newCommunity.stop();
}

export function mockReplyToUseParentPagesForUpdates(reply: Comment) {
    const updatingComment = findUpdatingComment(reply._pkc, { cid: reply.cid! });
    if (!updatingComment) throw Error("Reply should be updating before starting to mock");
    if (updatingComment.depth === 0) throw Error("Should not call this function on a post");
    delete updatingComment.raw.commentUpdate;
    delete updatingComment.updatedAt;

    mockCommentToNotUsePagesForUpdates(reply);

    const originalFunc = updatingComment._clientsManager.handleUpdateEventFromPostToFetchReplyCommentUpdate.bind(
        updatingComment._clientsManager
    );

    updatingComment._clientsManager.handleUpdateEventFromPostToFetchReplyCommentUpdate = (postInstance) => {
        // this should stop pkc-js from assuming the post replies is a single preloaded page
        const updatingCommunityInstance = findUpdatingCommunity(reply._pkc, {
            publicKey: postInstance.communityPublicKey,
            name: postInstance.communityName
        });
        const updatingParentInstance = findUpdatingComment(reply._pkc, { cid: reply.parentCid! });

        if (postInstance.replies.pages)
            Object.keys(postInstance.replies.pages).forEach((preloadedPageKey) => {
                if (postInstance.replies.pages[preloadedPageKey]?.comments) postInstance.replies.pages[preloadedPageKey]!.comments = [];
            });

        if (updatingCommunityInstance?.posts.pages)
            Object.keys(updatingCommunityInstance.posts.pages).forEach((preloadedPageKey) => {
                if (updatingCommunityInstance.posts.pages[preloadedPageKey]?.comments)
                    updatingCommunityInstance.posts.pages[preloadedPageKey].comments = [];
            });

        if (updatingParentInstance?.replies?.pages)
            Object.keys(updatingParentInstance.replies.pages).forEach((preloadedPageKey) => {
                if (updatingParentInstance.replies.pages[preloadedPageKey]?.comments)
                    updatingParentInstance.replies.pages[preloadedPageKey].comments = [];
            });
        return originalFunc(postInstance);
    };
}

export function mockUpdatingCommentResolvingAuthor(
    comment: Comment,
    mockFunction: Comment["_clientsManager"]["resolveAuthorNameIfNeeded"]
) {
    const updatingComment = findUpdatingComment(comment._pkc, { cid: comment.cid! });
    if (!updatingComment) throw Error("Comment should be updating before starting to mock");

    if (comment._pkc._pkcRpcClient) throw Error("Can't mock cache with pkc rpc clients");
    updatingComment._clientsManager.resolveAuthorNameIfNeeded = mockFunction;
}

export async function getRandomPostCidFromSub(communityAddress: string, pkc: PKC) {
    const community = await pkc.createCommunity({ address: communityAddress });
    await community.update();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    const lastPostCid = community.lastPostCid;
    await community.stop();
    if (!lastPostCid) throw Error("Community should have a last post cid");
    return lastPostCid;
}

export function mockNameResolvers<T extends { name: string }>({
    pkc,
    resolveFunction
}: {
    pkc: PKC;
    resolveFunction: (opts: T) => Promise<{ publicKey: string; [key: string]: string } | undefined>;
}) {
    if (pkc._pkcRpcClient) throw Error("Can't mock name resolvers with pkc rpc clients");
    pkc.nameResolvers = [createMockNameResolver({ resolveFunction: (opts) => resolveFunction(opts as T) })];
}

export function processAllCommentsRecursively(
    comments: (Comment | CommentWithinRepliesPostsPageJson)[] | undefined,
    processor: (comment: Comment | CommentWithinRepliesPostsPageJson) => void
): void {
    if (!comments || comments.length === 0) return;

    comments.forEach((comment) => processor(comment));

    for (const comment of comments)
        if (comment.replies?.pages?.best?.comments) processAllCommentsRecursively(comment.replies.pages.best.comments, processor);
}
