import { Comment } from "../publications/comment/comment.js";
import { PKC } from "../pkc/pkc.js";
import Vote from "../publications/vote/vote.js";
import { RemoteCommunity } from "../community/remote-community.js";
import type { InputPKCOptions, NameResolver } from "../types.js";
import Publication from "../publications/publication.js";
import { EventEmitter } from "events";
import { LocalCommunity } from "../runtime/node/community/local-community.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import type { CreateNewLocalCommunityUserOptions, CommunityIpfsType, CommunityChallengeSetting } from "../community/types.js";
import type { SignerType } from "../signer/types.js";
import type { CreateVoteOptions } from "../publications/vote/types.js";
import type { CommentIpfsWithCidDefined, CommentWithinRepliesPostsPageJson, CreateCommentOptions } from "../publications/comment/types.js";
import { BasePages, PostsPages, RepliesPages } from "../pages/pages.js";
import { CommentEdit } from "../publications/comment-edit/comment-edit.js";
import type { CreateCommentEditOptions } from "../publications/comment-edit/types.js";
import type { ChallengeVerificationMessageType, DecryptedChallengeVerificationMessageType, PubsubMessage } from "../pubsub-messages/types.js";
import { CommentModeration } from "../publications/comment-moderation/comment-moderation.js";
import type { PageTypeJson } from "../pages/types.js";
interface MockPKCOptions {
    pkcOptions?: InputPKCOptions;
    forceMockPubsub?: boolean;
    stubStorage?: boolean;
    mockResolve?: boolean;
    remotePKC?: boolean;
}
type MockResolverRecords = Map<string, string | undefined> | Record<string, string | undefined>;
export declare function createMockNameResolver({ records, includeDefaultRecords, key, provider, canResolve, resolveFunction }?: {
    records?: MockResolverRecords;
    includeDefaultRecords?: boolean;
    key?: string;
    provider?: string;
    canResolve?: NameResolver["canResolve"];
    resolveFunction?: NameResolver["resolve"];
}): NameResolver;
export declare function createPendingApprovalChallenge(overrides?: Partial<CommunityChallengeSetting>): CommunityChallengeSetting;
export declare function generateMockPost({ communityAddress, pkc, randomTimestamp, postProps }: {
    communityAddress: string;
    pkc: PKC;
    randomTimestamp?: boolean;
    postProps?: Partial<CreateCommentOptions>;
}): Promise<Comment>;
export declare function generateMockComment(parentPostOrComment: CommentIpfsWithCidDefined, pkc: PKC, randomTimestamp?: boolean, commentProps?: Partial<CreateCommentOptions>): Promise<Comment>;
export declare function generateMockVote(parentPostOrComment: CommentIpfsWithCidDefined, vote: -1 | 0 | 1, pkc: PKC, signer?: SignerType): Promise<Vote>;
export declare function loadAllPages(pageCid: string, pagesInstance: PostsPages | RepliesPages): Promise<CommentWithinRepliesPostsPageJson[]>;
export declare function loadAllPagesBySortName(pageSortName: string, pagesInstance: BasePages): Promise<CommentWithinRepliesPostsPageJson[] | import("../publications/comment/types.js").CommentWithinModQueuePageJson[]>;
export declare function loadAllUniquePostsUnderCommunity(community: RemoteCommunity): Promise<CommentWithinRepliesPostsPageJson[]>;
export declare function loadAllUniqueCommentsUnderCommentInstance(comment: Comment): Promise<CommentWithinRepliesPostsPageJson[]>;
type TestServerSubs = {
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
export declare function startOnlineCommunity(): Promise<LocalCommunity>;
export declare function startCommunities(props: {
    signers: SignerType[];
    noData?: boolean;
    dataPath?: string;
    votesPerCommentToPublish: number;
    numOfCommentsToPublish: number;
    numOfPostsToPublish: number;
    startOnlineSub: boolean;
}): Promise<TestServerSubs>;
export declare function fetchTestServerSubs(): Promise<TestServerSubs>;
export declare function mockDefaultOptionsForNodeAndBrowserTests(): Pick<InputPKCOptions, "pkcRpcClientsOptions" | "kuboRpcClientsOptions" | "ipfsGatewayUrls" | "pubsubKuboRpcClientsOptions" | "httpRoutersOptions">;
export declare function mockPKCV2({ pkcOptions, forceMockPubsub, stubStorage, mockResolve, remotePKC }?: MockPKCOptions): Promise<PKC>;
export declare function mockPKC(pkcOptions?: InputPKCOptions, forceMockPubsub?: boolean, stubStorage?: boolean, mockResolve?: boolean): Promise<PKC>;
export declare function mockRemotePKC(opts?: MockPKCOptions): Promise<PKC>;
export declare function createOnlinePKC(pkcOptions?: InputPKCOptions): Promise<PKC>;
export declare function mockPKCNoDataPathWithOnlyKuboClient(opts?: MockPKCOptions): Promise<PKC>;
export declare function mockPKCNoDataPathWithOnlyKuboClientNoAdd(opts?: MockPKCOptions): Promise<PKC>;
export declare function mockRpcServerPKC(pkcOptions?: InputPKCOptions): Promise<PKC>;
export declare function mockRpcRemotePKC(opts?: MockPKCOptions): Promise<PKC>;
export declare function mockRPCLocalPKC(pkcOptions?: InputPKCOptions): Promise<PKC>;
export declare function mockGatewayPKC(opts?: MockPKCOptions): Promise<PKC>;
export declare function publishRandomReply({ parentComment, pkc, commentProps }: {
    parentComment: CommentIpfsWithCidDefined;
    pkc: PKC;
    commentProps?: Partial<CreateCommentOptions>;
}): Promise<Comment>;
export declare function publishRandomPost({ communityAddress, pkc, postProps }: {
    communityAddress: string;
    pkc: PKC;
    postProps?: Partial<CreateCommentOptions>;
}): Promise<Comment>;
export declare function publishVote({ commentCid, communityAddress, vote, pkc, voteProps }: {
    commentCid: string;
    communityAddress: string;
    vote: 1 | 0 | -1;
    pkc: PKC;
    voteProps?: Partial<CreateVoteOptions>;
}): Promise<Vote>;
export declare function publishWithExpectedResult({ publication, expectedChallengeSuccess, expectedReason }: {
    publication: Publication;
    expectedChallengeSuccess: boolean;
    expectedReason?: string;
}): Promise<void>;
export declare function iterateThroughPageCidToFindComment(commentCid: string, pageCid: string, pages: PostsPages | RepliesPages): Promise<CommentWithinRepliesPostsPageJson | undefined>;
export declare function findCommentInCommunityInstancePagesPreloadedAndPageCids(opts: {
    comment: Required<Pick<CommentIpfsWithCidDefined, "cid"> & {
        communityAddress: string;
    }>;
    community: RemoteCommunity;
}): Promise<CommentWithinRepliesPostsPageJson | undefined>;
export declare function findReplyInParentCommentPagesInstancePreloadedAndPageCids(opts: {
    reply: Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & {
        communityAddress: string;
    }>;
    parentComment: Comment;
}): Promise<CommentWithinRepliesPostsPageJson | undefined>;
export declare function waitTillPostInCommunityInstancePages(post: Required<Pick<CommentIpfsWithCidDefined, "cid"> & {
    communityAddress: string;
}>, community: RemoteCommunity): Promise<void>;
export declare function waitTillPostInCommunityPages(post: Required<Pick<CommentIpfsWithCidDefined, "cid"> & {
    communityAddress: string;
}>, pkc: PKC): Promise<void>;
export declare function iterateThroughPagesToFindCommentInParentPagesInstance(commentCid: string, pages: PostsPages | RepliesPages): Promise<PageTypeJson["comments"][0] | undefined>;
export declare function waitTillReplyInParentPagesInstance(reply: Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & {
    communityAddress: string;
}>, parentComment: Comment): Promise<void>;
export declare function waitTillReplyInParentPages(reply: Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & {
    communityAddress: string;
}>, pkc: PKC): Promise<void>;
export declare function createSubWithNoChallenge(props: CreateNewLocalCommunityUserOptions, pkc: PKC): Promise<LocalCommunity | RpcLocalCommunity>;
export declare function generatePostToAnswerMathQuestion(props: Partial<CreateCommentOptions> & Pick<CreateCommentOptions, "communityAddress">, pkc: PKC): Promise<Comment>;
export declare function isRpcFlagOn(): boolean;
export declare function isRunningInBrowser(): boolean;
export type ResolveWhenConditionIsTrueOptions = {
    toUpdate: EventEmitter;
    predicate: () => Promise<boolean>;
    eventName?: string;
};
export declare function resolveWhenConditionIsTrue(options: ResolveWhenConditionIsTrueOptions): Promise<void>;
export declare function disableValidationOfSignatureBeforePublishing(publication: Publication): Promise<void>;
export declare function overrideCommentInstancePropsAndSign(comment: Comment, props: CreateCommentOptions): Promise<void>;
export declare function overrideCommentEditInstancePropsAndSign(commentEdit: CommentEdit, props: CreateCommentEditOptions): Promise<void>;
export declare function ensurePublicationIsSigned(publication: Publication, community: {
    address: string;
    signer?: {
        address: string;
    };
    encryption: {
        type: string;
        publicKey: string;
    };
    pubsubTopic?: string;
    name?: string;
}): Promise<void>;
export declare function setExtraPropOnCommentAndSign(comment: Comment, extraProps: Object, includeExtraPropInSignedPropertyNames: boolean): Promise<void>;
export declare function setExtraPropOnVoteAndSign(vote: Vote, extraProps: Object, includeExtraPropInSignedPropertyNames: boolean): Promise<void>;
export declare function setExtraPropOnCommentEditAndSign(commentEdit: CommentEdit, extraProps: Object, includeExtraPropInSignedPropertyNames: boolean): Promise<void>;
export declare function setExtraPropOnCommentModerationAndSign(commentModeration: CommentModeration, extraProps: any, includeExtraPropInSignedPropertyNames: boolean): Promise<void>;
export declare function setExtraPropOnChallengeRequestAndSign({ publication, extraProps, includeExtraPropsInRequestSignedPropertyNames }: {
    publication: Publication;
    extraProps: Object;
    includeExtraPropsInRequestSignedPropertyNames: boolean;
}): Promise<void>;
export declare function publishChallengeAnswerMessageWithExtraProps({ publication, challengeAnswers, extraProps, includeExtraPropsInChallengeSignedPropertyNames }: {
    publication: Publication;
    challengeAnswers: string[];
    extraProps: Object;
    includeExtraPropsInChallengeSignedPropertyNames: boolean;
}): Promise<void>;
export declare function publishChallengeMessageWithExtraProps({ publication, pubsubSigner, extraProps, includeExtraPropsInChallengeSignedPropertyNames }: {
    publication: Publication;
    pubsubSigner: SignerType;
    extraProps: Object;
    includeExtraPropsInChallengeSignedPropertyNames: boolean;
}): Promise<void>;
export declare function publishChallengeVerificationMessageWithExtraProps({ publication, pubsubSigner, extraProps, includeExtraPropsInChallengeSignedPropertyNames }: {
    publication: Publication;
    pubsubSigner: SignerType;
    extraProps: Object;
    includeExtraPropsInChallengeSignedPropertyNames: boolean;
}): Promise<void>;
export declare function publishChallengeVerificationMessageWithEncryption(publication: Publication, pubsubSigner: SignerType, toEncrypt: Object, verificationProps?: Partial<ChallengeVerificationMessageType>): Promise<void>;
export declare function addStringToIpfs(content: string): Promise<string>;
export declare function publishOverPubsub(pubsubTopic: string, jsonToPublish: PubsubMessage): Promise<void>;
export declare function mockPKCWithHeliaConfig(opts?: MockPKCOptions): Promise<PKC>;
type PKCTestConfigCode = "remote-kubo-rpc" | "remote-ipfs-gateway" | "remote-pkc-rpc" | "local-kubo-rpc" | "remote-libp2pjs";
type PKCConfigWithName = {
    name: string;
    pkcInstancePromise: (args?: MockPKCOptions) => Promise<PKC>;
    testConfigCode: PKCTestConfigCode;
};
export declare function setPKCConfigs(configs: PKCTestConfigCode[]): void;
export declare function getAvailablePKCConfigsToTestAgainst(opts?: {
    includeOnlyTheseTests?: PKCTestConfigCode[];
    includeAllPossibleConfigOnEnv?: boolean;
}): PKCConfigWithName[];
export declare function createNewIpns(): Promise<{
    signer: import("../signer/index.js").SignerWithPublicKeyAddress;
    publishToIpns: (content: string) => Promise<void>;
    pkc: PKC;
}>;
export declare function publishCommunityRecordWithExtraProp(opts?: {
    includeExtraPropInSignedPropertyNames: boolean;
    extraProps: Object;
}): Promise<{
    communityRecord: any;
    ipnsObj: {
        signer: import("../signer/index.js").SignerWithPublicKeyAddress;
        publishToIpns: (content: string) => Promise<void>;
        pkc: PKC;
    };
}>;
export declare function createMockedCommunityIpns(communityOpts: CreateNewLocalCommunityUserOptions): Promise<{
    communityRecord: {
        challenges: {
            [x: string]: unknown;
            type: string;
            exclude?: {
                [x: string]: unknown;
                community?: {
                    addresses: string[];
                    maxCommentCids: number;
                    postScore?: number | undefined;
                    replyScore?: number | undefined;
                    firstCommentTimestamp?: number | undefined;
                } | undefined;
                postScore?: number | undefined;
                replyScore?: number | undefined;
                postCount?: number | undefined;
                replyCount?: number | undefined;
                firstCommentTimestamp?: number | undefined;
                challenges?: number[] | undefined;
                role?: string[] | undefined;
                address?: string[] | undefined;
                rateLimit?: number | undefined;
                rateLimitChallengeSuccess?: boolean | undefined;
                publicationType?: {
                    [x: string]: unknown;
                    post?: boolean | undefined;
                    reply?: boolean | undefined;
                    vote?: boolean | undefined;
                    commentEdit?: boolean | undefined;
                    commentModeration?: boolean | undefined;
                    communityEdit?: boolean | undefined;
                } | undefined;
            }[] | undefined;
            description?: string | undefined;
            challenge?: string | undefined;
            caseInsensitive?: boolean | undefined;
            pendingApproval?: boolean | undefined;
        }[];
        signature: {
            type: string;
            signature: string;
            publicKey: string;
            signedPropertyNames: string[];
        };
        encryption: {
            [x: string]: unknown;
            type: string;
            publicKey: string;
        };
        createdAt: number;
        updatedAt: number;
        statsCid: string;
        protocolVersion: string;
        posts?: {
            pages: Record<string, {
                comments: {
                    comment: {
                        [x: string]: unknown;
                        timestamp: number;
                        signature: {
                            type: string;
                            signature: string;
                            publicKey: string;
                            signedPropertyNames: string[];
                        };
                        protocolVersion: string;
                        depth: number;
                        flairs?: {
                            [x: string]: unknown;
                            text: string;
                            backgroundColor?: string | undefined;
                            textColor?: string | undefined;
                            expiresAt?: number | undefined;
                        }[] | undefined;
                        communityPublicKey?: string | undefined;
                        communityName?: string | undefined;
                        link?: string | undefined;
                        spoiler?: boolean | undefined;
                        nsfw?: boolean | undefined;
                        content?: string | undefined;
                        title?: string | undefined;
                        linkWidth?: number | undefined;
                        linkHeight?: number | undefined;
                        linkHtmlTagName?: string | undefined;
                        parentCid?: string | undefined;
                        postCid?: string | undefined;
                        quotedCids?: string[] | undefined;
                        author?: {
                            [x: string]: unknown;
                            name?: string | undefined;
                            previousCommentCid?: string | undefined;
                            displayName?: string | undefined;
                            wallets?: Record<string, {
                                address: string;
                                timestamp: number;
                                signature: {
                                    signature: string;
                                    type: string;
                                };
                            }> | undefined;
                            avatar?: {
                                [x: string]: unknown;
                                chainTicker: string;
                                address: string;
                                id: string;
                                timestamp: number;
                                signature: {
                                    signature: string;
                                    type: string;
                                };
                            } | undefined;
                            flairs?: {
                                [x: string]: unknown;
                                text: string;
                                backgroundColor?: string | undefined;
                                textColor?: string | undefined;
                                expiresAt?: number | undefined;
                            }[] | undefined;
                        } | undefined;
                        thumbnailUrl?: string | undefined;
                        thumbnailUrlWidth?: number | undefined;
                        thumbnailUrlHeight?: number | undefined;
                        previousCid?: string | undefined;
                        pseudonymityMode?: "per-post" | "per-reply" | "per-author" | undefined;
                    };
                    commentUpdate: {
                        [x: string]: unknown;
                        cid: string;
                        upvoteCount: number;
                        downvoteCount: number;
                        replyCount: number;
                        updatedAt: number;
                        signature: {
                            type: string;
                            signature: string;
                            publicKey: string;
                            signedPropertyNames: string[];
                        };
                        protocolVersion: string;
                        childCount?: number | undefined;
                        number?: number | undefined;
                        postNumber?: number | undefined;
                        edit?: {
                            [x: string]: unknown;
                            timestamp: number;
                            signature: {
                                type: string;
                                signature: string;
                                publicKey: string;
                                signedPropertyNames: string[];
                            };
                            protocolVersion: string;
                            commentCid: string;
                            flairs?: {
                                [x: string]: unknown;
                                text: string;
                                backgroundColor?: string | undefined;
                                textColor?: string | undefined;
                                expiresAt?: number | undefined;
                            }[] | undefined;
                            communityPublicKey?: string | undefined;
                            communityName?: string | undefined;
                            spoiler?: boolean | undefined;
                            nsfw?: boolean | undefined;
                            reason?: string | undefined;
                            content?: string | undefined;
                            deleted?: boolean | undefined;
                            author?: {
                                [x: string]: unknown;
                                name?: string | undefined;
                                previousCommentCid?: string | undefined;
                                displayName?: string | undefined;
                                wallets?: Record<string, {
                                    address: string;
                                    timestamp: number;
                                    signature: {
                                        signature: string;
                                        type: string;
                                    };
                                }> | undefined;
                                avatar?: {
                                    [x: string]: unknown;
                                    chainTicker: string;
                                    address: string;
                                    id: string;
                                    timestamp: number;
                                    signature: {
                                        signature: string;
                                        type: string;
                                    };
                                } | undefined;
                                flairs?: {
                                    [x: string]: unknown;
                                    text: string;
                                    backgroundColor?: string | undefined;
                                    textColor?: string | undefined;
                                    expiresAt?: number | undefined;
                                }[] | undefined;
                            } | undefined;
                        } | undefined;
                        flairs?: {
                            [x: string]: unknown;
                            text: string;
                            backgroundColor?: string | undefined;
                            textColor?: string | undefined;
                            expiresAt?: number | undefined;
                        }[] | undefined;
                        spoiler?: boolean | undefined;
                        nsfw?: boolean | undefined;
                        pinned?: boolean | undefined;
                        locked?: boolean | undefined;
                        archived?: boolean | undefined;
                        removed?: boolean | undefined;
                        reason?: string | undefined;
                        approved?: boolean | undefined;
                        author?: {
                            [x: string]: unknown;
                            community?: {
                                [x: string]: unknown;
                                postScore: number;
                                replyScore: number;
                                firstCommentTimestamp: number;
                                lastCommentCid: string;
                                banExpiresAt?: number | undefined;
                                flairs?: {
                                    [x: string]: unknown;
                                    text: string;
                                    backgroundColor?: string | undefined;
                                    textColor?: string | undefined;
                                    expiresAt?: number | undefined;
                                }[] | undefined;
                            } | undefined;
                        } | undefined;
                        lastChildCid?: string | undefined;
                        lastReplyTimestamp?: number | undefined;
                        replies?: {
                            pages: Record<string, /*elided*/ any>;
                            pageCids?: Record<string, string> | undefined;
                        } | undefined;
                    };
                }[];
                nextCid?: string | undefined;
            }>;
            pageCids?: Record<string, string> | undefined;
        } | undefined;
        modQueue?: {
            pageCids: Record<string, string>;
        } | undefined;
        name?: string | undefined;
        pubsubTopic?: string | undefined;
        postUpdates?: Record<string, string> | undefined;
        title?: string | undefined;
        description?: string | undefined;
        roles?: Record<string, {
            [x: string]: unknown;
            role: string;
        }> | undefined;
        rules?: string[] | undefined;
        lastPostCid?: string | undefined;
        lastCommentCid?: string | undefined;
        features?: {
            [x: string]: unknown;
            noVideos?: boolean | undefined;
            noSpoilers?: boolean | undefined;
            noImages?: boolean | undefined;
            noVideoReplies?: boolean | undefined;
            noSpoilerReplies?: boolean | undefined;
            noImageReplies?: boolean | undefined;
            noPolls?: boolean | undefined;
            noCrossposts?: boolean | undefined;
            noNestedReplies?: boolean | undefined;
            safeForWork?: boolean | undefined;
            authorFlairs?: boolean | undefined;
            requireAuthorFlairs?: boolean | undefined;
            postFlairs?: boolean | undefined;
            requirePostFlairs?: boolean | undefined;
            noMarkdownImages?: boolean | undefined;
            noMarkdownVideos?: boolean | undefined;
            noMarkdownAudio?: boolean | undefined;
            noAudio?: boolean | undefined;
            noAudioReplies?: boolean | undefined;
            markdownImageReplies?: boolean | undefined;
            markdownVideoReplies?: boolean | undefined;
            noPostUpvotes?: boolean | undefined;
            noReplyUpvotes?: boolean | undefined;
            noPostDownvotes?: boolean | undefined;
            noReplyDownvotes?: boolean | undefined;
            noUpvotes?: boolean | undefined;
            noDownvotes?: boolean | undefined;
            requirePostLink?: boolean | undefined;
            requirePostLinkIsMedia?: boolean | undefined;
            requireReplyLink?: boolean | undefined;
            requireReplyLinkIsMedia?: boolean | undefined;
            pseudonymityMode?: "per-post" | "per-reply" | "per-author" | undefined;
        } | undefined;
        suggested?: {
            [x: string]: unknown;
            primaryColor?: string | undefined;
            secondaryColor?: string | undefined;
            avatarUrl?: string | undefined;
            bannerUrl?: string | undefined;
            backgroundUrl?: string | undefined;
            language?: string | undefined;
        } | undefined;
        flairs?: Record<string, {
            [x: string]: unknown;
            text: string;
            backgroundColor?: string | undefined;
            textColor?: string | undefined;
            expiresAt?: number | undefined;
        }[]> | undefined;
    };
    communityAddress: string;
    ipnsObj: {
        signer: import("../signer/index.js").SignerWithPublicKeyAddress;
        publishToIpns: (content: string) => Promise<void>;
        pkc: PKC;
    };
}>;
export declare function createStaticCommunityRecordForComment(opts?: {
    pkc?: PKC;
    commentOptions?: Partial<CreateCommentOptions & {
        depth?: number;
    }>;
    invalidateCommunitySignature?: boolean;
}): Promise<{
    commentCid: string;
    communityAddress: string;
}>;
export declare function jsonifyCommunityAndRemoveInternalProps(community: RemoteCommunity): Omit<any, "signer" | "state" | "clients" | "settings" | "updatingState" | "startedState" | "editable" | "started">;
export declare function jsonifyLocalCommunityWithNoInternalProps(community: LocalCommunity): Omit<{
    address: string;
    publicKey?: string | undefined;
    shortAddress: string;
    signature?: CommunityIpfsType["signature"] | undefined;
    name?: string | undefined;
    flairs?: Record<string, {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[]> | undefined;
    signer: import("../signer/index.js").SignerWithPublicKeyAddress;
    protocolVersion: CommunityIpfsType["protocolVersion"];
    lastCommentCid?: string | undefined;
    nameResolved?: boolean | undefined;
    state: import("../community/types.js").CommunityState;
    clients: import("../community/community-client-manager.js").CommunityClientsManager["clients"];
    encryption: CommunityIpfsType["encryption"];
    createdAt: CommunityIpfsType["createdAt"];
    updatedAt?: CommunityIpfsType["updatedAt"] | undefined;
    statsCid?: CommunityIpfsType["statsCid"] | undefined;
    title?: string | undefined;
    posts: PostsPages;
    modQueue: import("../pages/pages.js").ModQueuePages;
    challenges: CommunityIpfsType["challenges"];
    description?: string | undefined;
    pubsubTopic?: string | undefined;
    postUpdates?: Record<string, string> | undefined;
    roles?: Record<string, {
        [x: string]: unknown;
        role: string;
    }> | undefined;
    rules?: string[] | undefined;
    lastPostCid?: string | undefined;
    features?: {
        [x: string]: unknown;
        noVideos?: boolean | undefined;
        noSpoilers?: boolean | undefined;
        noImages?: boolean | undefined;
        noVideoReplies?: boolean | undefined;
        noSpoilerReplies?: boolean | undefined;
        noImageReplies?: boolean | undefined;
        noPolls?: boolean | undefined;
        noCrossposts?: boolean | undefined;
        noNestedReplies?: boolean | undefined;
        safeForWork?: boolean | undefined;
        authorFlairs?: boolean | undefined;
        requireAuthorFlairs?: boolean | undefined;
        postFlairs?: boolean | undefined;
        requirePostFlairs?: boolean | undefined;
        noMarkdownImages?: boolean | undefined;
        noMarkdownVideos?: boolean | undefined;
        noMarkdownAudio?: boolean | undefined;
        noAudio?: boolean | undefined;
        noAudioReplies?: boolean | undefined;
        markdownImageReplies?: boolean | undefined;
        markdownVideoReplies?: boolean | undefined;
        noPostUpvotes?: boolean | undefined;
        noReplyUpvotes?: boolean | undefined;
        noPostDownvotes?: boolean | undefined;
        noReplyDownvotes?: boolean | undefined;
        noUpvotes?: boolean | undefined;
        noDownvotes?: boolean | undefined;
        requirePostLink?: boolean | undefined;
        requirePostLinkIsMedia?: boolean | undefined;
        requireReplyLink?: boolean | undefined;
        requireReplyLinkIsMedia?: boolean | undefined;
        pseudonymityMode?: "per-post" | "per-reply" | "per-author" | undefined;
    } | undefined;
    suggested?: {
        [x: string]: unknown;
        primaryColor?: string | undefined;
        secondaryColor?: string | undefined;
        avatarUrl?: string | undefined;
        bannerUrl?: string | undefined;
        backgroundUrl?: string | undefined;
        language?: string | undefined;
    } | undefined;
    settings: import("../community/types.js").RpcLocalCommunityLocalProps["settings"];
    readonly updatingState: RemoteCommunity["updatingState"];
    raw: RpcLocalCommunity["raw"];
    updateCid?: string | undefined;
    startedState: import("../community/types.js").CommunityStartedState;
    editable: Pick<RpcLocalCommunity, keyof import("../community/types.js").CommunityEditOptions>;
    started: boolean;
    ipnsName?: string | undefined;
    ipnsPubsubTopic?: string | undefined;
    ipnsPubsubTopicRoutingCid?: string | undefined;
    pubsubTopicRoutingCid?: string | undefined;
}, "state" | "clients" | "updatingState" | "startedState" | "started">;
export declare function jsonifyCommentAndRemoveInstanceProps(comment: Comment): Omit<any, "state" | "publishingState" | "clients" | "updatingState" | "raw">;
export declare function waitUntilPKCCommunitiesIncludeSubAddress(pkc: PKC, subAddress: string): Promise<void>;
export declare function isPKCFetchingUsingGateways(pkc: PKC): boolean;
export declare function mockRpcServerForTests(pkcWs: any): void;
export declare function disablePreloadPagesOnSub({ community }: {
    community: LocalCommunity;
}): {
    cleanup: () => void;
};
export declare function mockPostToReturnSpecificCommentUpdate(commentToBeMocked: Comment, commentUpdateRecordString: string): void;
export declare function mockPostToFailToLoadFromPostUpdates(postToBeMocked: Comment): void;
export declare function mockPostToHaveCommunityWithNoPostUpdates(postToBeMocked: Comment): void;
export declare function createCommentUpdateWithInvalidSignature(commentCid: string): Promise<{
    cid: string;
    upvoteCount: number;
    downvoteCount: number;
    replyCount: number;
    updatedAt: number;
    signature: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    };
    protocolVersion: string;
    childCount?: number | undefined;
    number?: number | undefined;
    postNumber?: number | undefined;
    edit?: {
        [x: string]: unknown;
        timestamp: number;
        signature: {
            type: string;
            signature: string;
            publicKey: string;
            signedPropertyNames: string[];
        };
        protocolVersion: string;
        commentCid: string;
        flairs?: {
            [x: string]: unknown;
            text: string;
            backgroundColor?: string | undefined;
            textColor?: string | undefined;
            expiresAt?: number | undefined;
        }[] | undefined;
        communityPublicKey?: string | undefined;
        communityName?: string | undefined;
        spoiler?: boolean | undefined;
        nsfw?: boolean | undefined;
        reason?: string | undefined;
        content?: string | undefined;
        deleted?: boolean | undefined;
        author?: {
            [x: string]: unknown;
            name?: string | undefined;
            previousCommentCid?: string | undefined;
            displayName?: string | undefined;
            wallets?: Record<string, {
                address: string;
                timestamp: number;
                signature: {
                    signature: string;
                    type: string;
                };
            }> | undefined;
            avatar?: {
                [x: string]: unknown;
                chainTicker: string;
                address: string;
                id: string;
                timestamp: number;
                signature: {
                    signature: string;
                    type: string;
                };
            } | undefined;
            flairs?: {
                [x: string]: unknown;
                text: string;
                backgroundColor?: string | undefined;
                textColor?: string | undefined;
                expiresAt?: number | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
    flairs?: {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[] | undefined;
    spoiler?: boolean | undefined;
    nsfw?: boolean | undefined;
    pinned?: boolean | undefined;
    locked?: boolean | undefined;
    archived?: boolean | undefined;
    removed?: boolean | undefined;
    reason?: string | undefined;
    approved?: boolean | undefined;
    author?: {
        [x: string]: unknown;
        community?: {
            [x: string]: unknown;
            postScore: number;
            replyScore: number;
            firstCommentTimestamp: number;
            lastCommentCid: string;
            banExpiresAt?: number | undefined;
            flairs?: {
                [x: string]: unknown;
                text: string;
                backgroundColor?: string | undefined;
                textColor?: string | undefined;
                expiresAt?: number | undefined;
            }[] | undefined;
        } | undefined;
    } | undefined;
    lastChildCid?: string | undefined;
    lastReplyTimestamp?: number | undefined;
    replies?: {
        pages: Record<string, {
            comments: {
                comment: {
                    [x: string]: unknown;
                    timestamp: number;
                    signature: {
                        type: string;
                        signature: string;
                        publicKey: string;
                        signedPropertyNames: string[];
                    };
                    protocolVersion: string;
                    depth: number;
                    flairs?: {
                        [x: string]: unknown;
                        text: string;
                        backgroundColor?: string | undefined;
                        textColor?: string | undefined;
                        expiresAt?: number | undefined;
                    }[] | undefined;
                    communityPublicKey?: string | undefined;
                    communityName?: string | undefined;
                    link?: string | undefined;
                    spoiler?: boolean | undefined;
                    nsfw?: boolean | undefined;
                    content?: string | undefined;
                    title?: string | undefined;
                    linkWidth?: number | undefined;
                    linkHeight?: number | undefined;
                    linkHtmlTagName?: string | undefined;
                    parentCid?: string | undefined;
                    postCid?: string | undefined;
                    quotedCids?: string[] | undefined;
                    author?: {
                        [x: string]: unknown;
                        name?: string | undefined;
                        previousCommentCid?: string | undefined;
                        displayName?: string | undefined;
                        wallets?: Record<string, {
                            address: string;
                            timestamp: number;
                            signature: {
                                signature: string;
                                type: string;
                            };
                        }> | undefined;
                        avatar?: {
                            [x: string]: unknown;
                            chainTicker: string;
                            address: string;
                            id: string;
                            timestamp: number;
                            signature: {
                                signature: string;
                                type: string;
                            };
                        } | undefined;
                        flairs?: {
                            [x: string]: unknown;
                            text: string;
                            backgroundColor?: string | undefined;
                            textColor?: string | undefined;
                            expiresAt?: number | undefined;
                        }[] | undefined;
                    } | undefined;
                    thumbnailUrl?: string | undefined;
                    thumbnailUrlWidth?: number | undefined;
                    thumbnailUrlHeight?: number | undefined;
                    previousCid?: string | undefined;
                    pseudonymityMode?: "per-post" | "per-reply" | "per-author" | undefined;
                };
                commentUpdate: {
                    [x: string]: unknown;
                    cid: string;
                    upvoteCount: number;
                    downvoteCount: number;
                    replyCount: number;
                    updatedAt: number;
                    signature: {
                        type: string;
                        signature: string;
                        publicKey: string;
                        signedPropertyNames: string[];
                    };
                    protocolVersion: string;
                    childCount?: number | undefined;
                    number?: number | undefined;
                    postNumber?: number | undefined;
                    edit?: {
                        [x: string]: unknown;
                        timestamp: number;
                        signature: {
                            type: string;
                            signature: string;
                            publicKey: string;
                            signedPropertyNames: string[];
                        };
                        protocolVersion: string;
                        commentCid: string;
                        flairs?: {
                            [x: string]: unknown;
                            text: string;
                            backgroundColor?: string | undefined;
                            textColor?: string | undefined;
                            expiresAt?: number | undefined;
                        }[] | undefined;
                        communityPublicKey?: string | undefined;
                        communityName?: string | undefined;
                        spoiler?: boolean | undefined;
                        nsfw?: boolean | undefined;
                        reason?: string | undefined;
                        content?: string | undefined;
                        deleted?: boolean | undefined;
                        author?: {
                            [x: string]: unknown;
                            name?: string | undefined;
                            previousCommentCid?: string | undefined;
                            displayName?: string | undefined;
                            wallets?: Record<string, {
                                address: string;
                                timestamp: number;
                                signature: {
                                    signature: string;
                                    type: string;
                                };
                            }> | undefined;
                            avatar?: {
                                [x: string]: unknown;
                                chainTicker: string;
                                address: string;
                                id: string;
                                timestamp: number;
                                signature: {
                                    signature: string;
                                    type: string;
                                };
                            } | undefined;
                            flairs?: {
                                [x: string]: unknown;
                                text: string;
                                backgroundColor?: string | undefined;
                                textColor?: string | undefined;
                                expiresAt?: number | undefined;
                            }[] | undefined;
                        } | undefined;
                    } | undefined;
                    flairs?: {
                        [x: string]: unknown;
                        text: string;
                        backgroundColor?: string | undefined;
                        textColor?: string | undefined;
                        expiresAt?: number | undefined;
                    }[] | undefined;
                    spoiler?: boolean | undefined;
                    nsfw?: boolean | undefined;
                    pinned?: boolean | undefined;
                    locked?: boolean | undefined;
                    archived?: boolean | undefined;
                    removed?: boolean | undefined;
                    reason?: string | undefined;
                    approved?: boolean | undefined;
                    author?: {
                        [x: string]: unknown;
                        community?: {
                            [x: string]: unknown;
                            postScore: number;
                            replyScore: number;
                            firstCommentTimestamp: number;
                            lastCommentCid: string;
                            banExpiresAt?: number | undefined;
                            flairs?: {
                                [x: string]: unknown;
                                text: string;
                                backgroundColor?: string | undefined;
                                textColor?: string | undefined;
                                expiresAt?: number | undefined;
                            }[] | undefined;
                        } | undefined;
                    } | undefined;
                    lastChildCid?: string | undefined;
                    lastReplyTimestamp?: number | undefined;
                    replies?: /*elided*/ any | undefined;
                };
            }[];
            nextCid?: string | undefined;
        }>;
        pageCids?: Record<string, string> | undefined;
    } | undefined;
}>;
export declare function mockPKCToTimeoutFetchingCid(pkc: PKC): {
    cleanUp: () => void;
};
export declare function mockCommentToNotUsePagesForUpdates(comment: Comment): void;
export declare function forceLocalSubPagesToAlwaysGenerateMultipleChunks({ community, parentComment, forcedPreloadedPageSizeBytes, parentCommentReplyProps, communityPostsCommentProps }: {
    community: LocalCommunity | RemoteCommunity;
    parentComment?: Comment;
    forcedPreloadedPageSizeBytes?: number;
    parentCommentReplyProps?: Partial<CreateCommentOptions>;
    communityPostsCommentProps?: CreateCommentOptions;
}): Promise<{
    cleanup: () => void;
}>;
export declare function findOrPublishCommentWithDepth({ depth, community, pkc }: {
    depth: number;
    community: RemoteCommunity;
    pkc?: PKC;
}): Promise<Comment>;
export declare function findOrPublishCommentWithDepthWithHttpServerShortcut({ depth, community, pkc }: {
    depth: number;
    community: RemoteCommunity;
    pkc?: PKC;
}): Promise<Comment>;
export declare function publishCommentWithDepth({ depth, community }: {
    depth: number;
    community: RemoteCommunity;
}): Promise<Comment>;
export declare function getCommentWithCommentUpdateProps({ cid, pkc }: {
    cid: string;
    pkc: PKC;
}): Promise<Comment>;
export declare function publishCommentToModQueue({ community, pkc, parentComment, commentProps }: {
    community: RemoteCommunity;
    pkc?: PKC;
    parentComment?: Comment;
    commentProps?: Partial<CreateCommentOptions>;
}): Promise<{
    comment: Comment;
    challengeVerification: DecryptedChallengeVerificationMessageType;
}>;
export declare function publishToModQueueWithDepth({ community, depth, pkc, modCommentProps, commentProps }: {
    community: RemoteCommunity;
    pkc: PKC;
    depth: number;
    modCommentProps?: Partial<CreateCommentOptions>;
    commentProps?: Partial<CreateCommentOptions>;
}): Promise<{
    comment: Comment;
    challengeVerification: unknown;
}>;
export declare function forceCommunityToGenerateAllPostsPages(community: RemoteCommunity, commentProps?: CreateCommentOptions): Promise<void>;
export declare function mockReplyToUseParentPagesForUpdates(reply: Comment): void;
export declare function mockUpdatingCommentResolvingAuthor(comment: Comment, mockFunction: Comment["_clientsManager"]["resolveAuthorNameIfNeeded"]): void;
export declare function getRandomPostCidFromSub(communityAddress: string, pkc: PKC): Promise<string>;
export declare const describeSkipIfRpc: any;
export declare const describeIfRpc: any;
export declare const itSkipIfRpc: any;
export declare const itIfRpc: any;
export declare function mockNameResolvers<T extends {
    name: string;
    provider: string;
}>({ pkc, resolveFunction }: {
    pkc: PKC;
    resolveFunction: (opts: T) => Promise<{
        publicKey: string;
        [key: string]: string;
    } | undefined>;
}): void;
export declare function processAllCommentsRecursively(comments: (Comment | CommentWithinRepliesPostsPageJson)[] | undefined, processor: (comment: Comment | CommentWithinRepliesPostsPageJson) => void): void;
export {};
