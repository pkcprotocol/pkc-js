import { ModQueuePageIpfsSchema, PageIpfsSchema } from "../pages/schema.js";
import type { PageIpfs } from "../pages/types.js";
import { CommentChallengeRequestToEncryptSchema, CommentIpfsSchema, CommentPubsubMessagePublicationSchema, CommentUpdateSchema, CreateCommentOptionsSchema } from "../publications/comment/schema.js";
import type { CommentChallengeRequestToEncryptType, CommentIpfsType, CommentUpdateType } from "../publications/comment/types.js";
import { DecryptedChallengeAnswerSchema, DecryptedChallengeSchema, DecryptedChallengeVerificationSchema } from "../pubsub-messages/schema.js";
import { CreateNewLocalCommunityUserOptionsSchema, CreateRemoteCommunityFunctionArgumentSchema, CreateRpcCommunityFunctionArgumentSchema, CreateCommunityFunctionArgumentsSchema, CommunityEditOptionsSchema, CommunityIpfsSchema } from "../community/schema.js";
import type { CreateNewLocalCommunityUserOptions, RpcRemoteCommunityUpdateEventResultType, CommunityEditOptions, CommunityIpfsType } from "../community/types.js";
import type { DecryptedChallenge, DecryptedChallengeAnswer, DecryptedChallengeVerification } from "../pubsub-messages/types.js";
import { CidStringSchema } from "./schema.js";
import { RpcCommentEventResultSchema, RpcCommentUpdateResultSchema } from "../clients/rpc-client/schema.js";
import { CreatePKCWsServerOptionsSchema, SetNewSettingsPKCWsServerSchema } from "../rpc/src/schema.js";
import type { CreatePKCWsServerOptions } from "../rpc/src/types.js";
import type { CommentModerationChallengeRequestToEncrypt } from "../publications/comment-moderation/types.js";
import { CommentModerationChallengeRequestToEncryptSchema, CommentModerationPubsubMessagePublicationSchema, CreateCommentModerationOptionsSchema } from "../publications/comment-moderation/schema.js";
import type { VoteChallengeRequestToEncryptType } from "../publications/vote/types.js";
import { CreateVoteUserOptionsSchema, VoteChallengeRequestToEncryptSchema, VotePubsubMessagePublicationSchema } from "../publications/vote/schema.js";
import type { CommentEditChallengeRequestToEncryptType } from "../publications/comment-edit/types.js";
import { CommentEditChallengeRequestToEncryptSchema, CommentEditPubsubMessagePublicationSchema, CreateCommentEditOptionsSchema } from "../publications/comment-edit/schema.js";
import { PKCUserOptionsSchema } from "../schema.js";
import { z, type ZodObject } from "zod";
import type { CreateCommunityEditPublicationOptions, CommunityEditChallengeRequestToEncryptType, CommunityEditPubsubMessagePublication } from "../publications/community-edit/types.js";
import { CommunityEditPublicationChallengeRequestToEncryptSchema } from "../publications/community-edit/schema.js";
export declare function parseJsonWithPKCErrorIfFails(x: string): any;
export declare function parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(communityIpfs: z.infer<typeof CommunityIpfsSchema>): CommunityIpfsType;
export declare function parseCommentIpfsSchemaWithPKCErrorIfItFails(commentIpfsJson: z.infer<typeof CommentIpfsSchema>): CommentIpfsType;
export declare function parseCommentUpdateSchemaWithPKCErrorIfItFails(commentUpdateJson: z.infer<typeof CommentUpdateSchema>): CommentUpdateType;
export declare function parsePageIpfsSchemaWithPKCErrorIfItFails(pageIpfsJson: z.infer<typeof PageIpfsSchema>): PageIpfs;
export declare function parseModQueuePageIpfsSchemaWithPKCErrorIfItFails(modQueuePageIpfsJson: z.infer<typeof ModQueuePageIpfsSchema>): {
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
            signature: {
                type: string;
                signature: string;
                publicKey: string;
                signedPropertyNames: string[];
            };
            protocolVersion: string;
            cid: string;
            number?: number | undefined;
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
            postNumber?: number | undefined;
            pendingApproval?: boolean | undefined;
        };
    }[];
    nextCid?: string | undefined;
};
export declare function parseDecryptedChallengeWithPKCErrorIfItFails(decryptedChallengeJson: z.infer<typeof DecryptedChallengeSchema>): DecryptedChallenge;
export declare function parseDecryptedChallengeVerification(decryptedChallengeVerificationJson: z.infer<typeof DecryptedChallengeVerificationSchema>): DecryptedChallengeVerification;
export declare function parseRpcRemoteCommunityUpdateEventWithPKCErrorIfItFails(rpcRemoteCommunity: RpcRemoteCommunityUpdateEventResultType): {
    runtimeFields: {
        [x: string]: unknown;
        updateCid?: string | undefined;
        updatingState?: import("../community/types.js").CommunityUpdatingState | undefined;
        newPublicKey?: string | undefined;
        nameResolved?: boolean | undefined;
    };
    community?: {
        [x: string]: unknown;
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
    } | undefined;
    resetInstance?: boolean | undefined;
};
export declare function parseCidStringSchemaWithPKCErrorIfItFails(cidString: z.infer<typeof CidStringSchema>): string;
export declare function parseRpcCommentUpdateEventWithPKCErrorIfItFails(updateResult: z.input<typeof RpcCommentUpdateResultSchema>): z.infer<typeof RpcCommentUpdateResultSchema>;
export declare function parseRpcCommentEventWithPKCErrorIfItFails(updateResult: z.input<typeof RpcCommentEventResultSchema>): z.infer<typeof RpcCommentEventResultSchema>;
export declare function parseCommunityEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails(args: CommunityEditPubsubMessagePublication): {
    timestamp: number;
    signature: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    };
    protocolVersion: string;
    communityEdit: {
        name?: string | undefined;
        flairs?: Record<string, {
            [x: string]: unknown;
            text: string;
            backgroundColor?: string | undefined;
            textColor?: string | undefined;
            expiresAt?: number | undefined;
        }[]> | undefined;
        title?: string | undefined;
        description?: string | undefined;
        pubsubTopic?: string | undefined;
        rules?: string[] | undefined;
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
        address?: string | undefined;
        settings?: {
            fetchThumbnailUrls?: boolean | undefined;
            fetchThumbnailUrlsProxyUrl?: string | undefined;
            challenges?: {
                path?: string | undefined;
                name?: string | undefined;
                options?: Record<string, string> | undefined;
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
                pendingApproval?: boolean | undefined;
            }[] | undefined;
            maxPendingApprovalCount?: number | undefined;
            purgeDisapprovedCommentsOlderThan?: number | undefined;
        } | undefined;
        roles?: Record<string, {
            [x: string]: unknown;
            role: string;
        } | undefined> | undefined;
    };
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
};
export declare function parseCreateCommunityEditPublicationOptionsSchemaWithPKCErrorIfItFails(args: CreateCommunityEditPublicationOptions): {
    signer: {
        type: "ed25519";
        privateKey: string;
    };
    communityAddress: string;
    communityEdit: {
        name?: string | undefined;
        flairs?: Record<string, {
            [x: string]: unknown;
            text: string;
            backgroundColor?: string | undefined;
            textColor?: string | undefined;
            expiresAt?: number | undefined;
        }[]> | undefined;
        title?: string | undefined;
        description?: string | undefined;
        pubsubTopic?: string | undefined;
        rules?: string[] | undefined;
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
        address?: string | undefined;
        settings?: {
            fetchThumbnailUrls?: boolean | undefined;
            fetchThumbnailUrlsProxyUrl?: string | undefined;
            challenges?: {
                path?: string | undefined;
                name?: string | undefined;
                options?: Record<string, string> | undefined;
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
                pendingApproval?: boolean | undefined;
            }[] | undefined;
            maxPendingApprovalCount?: number | undefined;
            purgeDisapprovedCommentsOlderThan?: number | undefined;
        } | undefined;
        roles?: Record<string, {
            [x: string]: unknown;
            role: string;
        } | undefined> | undefined;
    };
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
    protocolVersion?: string | undefined;
    timestamp?: number | undefined;
    challengeRequest?: {
        challengeAnswers?: string[] | undefined;
        challengeCommentCids?: string[] | undefined;
    } | undefined;
};
export declare function parseDecryptedChallengeAnswerWithPKCErrorIfItFails(decryptedChallengeAnswers: z.infer<typeof DecryptedChallengeAnswerSchema>): DecryptedChallengeAnswer;
export declare function parseCreatePKCWsServerOptionsSchemaWithPKCErrorIfItFails(options: z.infer<typeof CreatePKCWsServerOptionsSchema>): CreatePKCWsServerOptions;
export declare function parseCommentModerationChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt: z.infer<typeof CommentModerationChallengeRequestToEncryptSchema>): CommentModerationChallengeRequestToEncrypt;
export declare function parseCommunityEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt: z.infer<typeof CommunityEditPublicationChallengeRequestToEncryptSchema>): CommunityEditChallengeRequestToEncryptType;
export declare function parseCommunityEditOptionsSchemaWithPKCErrorIfItFails(editOptions: z.infer<typeof CommunityEditOptionsSchema>): CommunityEditOptions;
export declare function parseCommentChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt: z.infer<typeof CommentChallengeRequestToEncryptSchema>): CommentChallengeRequestToEncryptType;
export declare function parseVoteChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt: z.infer<typeof VoteChallengeRequestToEncryptSchema>): VoteChallengeRequestToEncryptType;
export declare function parseCommentEditChallengeRequestToEncryptSchemaWithPKCErrorIfItFails(toEncrypt: z.infer<typeof CommentEditChallengeRequestToEncryptSchema>): CommentEditChallengeRequestToEncryptType;
export declare function parseCreateNewLocalCommunityUserOptionsSchemaWithPKCErrorIfItFails(options: z.infer<typeof CreateNewLocalCommunityUserOptionsSchema>): CreateNewLocalCommunityUserOptions;
export declare function parseSetNewSettingsPKCWsServerSchemaWithPKCErrorIfItFails(settings: z.input<typeof SetNewSettingsPKCWsServerSchema>): z.input<typeof SetNewSettingsPKCWsServerSchema>;
export declare function parseCreateCommentModerationOptionsSchemaWithPKCErrorIfItFails(args: z.infer<typeof CreateCommentModerationOptionsSchema>): {
    signer: {
        type: "ed25519";
        privateKey: string;
    };
    communityAddress: string;
    commentModeration: {
        [x: string]: unknown;
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
        approved?: boolean | undefined;
        removed?: boolean | undefined;
        purged?: boolean | undefined;
        reason?: string | undefined;
        author?: {
            [x: string]: unknown;
            flairs?: {
                [x: string]: unknown;
                text: string;
                backgroundColor?: string | undefined;
                textColor?: string | undefined;
                expiresAt?: number | undefined;
            }[] | undefined;
            banExpiresAt?: number | undefined;
        } | undefined;
    };
    commentCid: string;
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
    protocolVersion?: string | undefined;
    timestamp?: number | undefined;
    challengeRequest?: {
        challengeAnswers?: string[] | undefined;
        challengeCommentCids?: string[] | undefined;
    } | undefined;
};
export declare function parseCommentModerationPubsubMessagePublicationSchemaWithPKCErrorIfItFails(args: z.infer<typeof CommentModerationPubsubMessagePublicationSchema>): {
    timestamp: number;
    signature: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    };
    protocolVersion: string;
    commentCid: string;
    commentModeration: {
        [x: string]: unknown;
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
        approved?: boolean | undefined;
        removed?: boolean | undefined;
        purged?: boolean | undefined;
        reason?: string | undefined;
        author?: {
            [x: string]: unknown;
            flairs?: {
                [x: string]: unknown;
                text: string;
                backgroundColor?: string | undefined;
                textColor?: string | undefined;
                expiresAt?: number | undefined;
            }[] | undefined;
            banExpiresAt?: number | undefined;
        } | undefined;
    };
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
};
export declare function parseCreateRemoteCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(args: any): z.infer<typeof CreateRemoteCommunityFunctionArgumentSchema>;
export declare function parseCreateVoteOptionsSchemaWithPKCErrorIfItFails(args: z.infer<typeof CreateVoteUserOptionsSchema>): {
    signer: {
        type: "ed25519";
        privateKey: string;
    };
    communityAddress: string;
    commentCid: string;
    vote: 0 | 1 | -1;
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
    protocolVersion?: string | undefined;
    timestamp?: number | undefined;
    challengeRequest?: {
        challengeAnswers?: string[] | undefined;
        challengeCommentCids?: string[] | undefined;
    } | undefined;
};
export declare function parseVotePubsubMessagePublicationSchemaWithPKCErrorIfItFails(args: z.infer<typeof VotePubsubMessagePublicationSchema>): {
    timestamp: number;
    signature: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    };
    protocolVersion: string;
    commentCid: string;
    vote: 0 | 1 | -1;
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
};
export declare function parseCreateCommentEditOptionsSchemaWithPKCErrorIfItFails(args: z.infer<typeof CreateCommentEditOptionsSchema>): {
    signer: {
        type: "ed25519";
        privateKey: string;
    };
    communityAddress: string;
    commentCid: string;
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
    protocolVersion?: string | undefined;
    timestamp?: number | undefined;
    challengeRequest?: {
        challengeAnswers?: string[] | undefined;
        challengeCommentCids?: string[] | undefined;
    } | undefined;
    content?: string | undefined;
    deleted?: boolean | undefined;
    flairs?: {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[] | undefined;
    spoiler?: boolean | undefined;
    nsfw?: boolean | undefined;
    reason?: string | undefined;
};
export declare function parseCommentEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails(args: z.infer<typeof CommentEditPubsubMessagePublicationSchema>): {
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
    author?: {
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
    spoiler?: boolean | undefined;
    nsfw?: boolean | undefined;
    reason?: string | undefined;
    content?: string | undefined;
    deleted?: boolean | undefined;
};
export declare function parseCreateCommunityFunctionArgumentsSchemaWithPKCErrorIfItFails(args: z.infer<typeof CreateCommunityFunctionArgumentsSchema>): {
    [x: string]: unknown;
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
} | {
    name?: string | undefined;
    flairs?: Record<string, {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[]> | undefined;
    title?: string | undefined;
    description?: string | undefined;
    pubsubTopic?: string | undefined;
    rules?: string[] | undefined;
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
    settings?: {
        fetchThumbnailUrls?: boolean | undefined;
        fetchThumbnailUrlsProxyUrl?: string | undefined;
        challenges?: {
            path?: string | undefined;
            name?: string | undefined;
            options?: Record<string, string> | undefined;
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
            pendingApproval?: boolean | undefined;
        }[] | undefined;
        maxPendingApprovalCount?: number | undefined;
        purgeDisapprovedCommentsOlderThan?: number | undefined;
    } | undefined;
    signer?: {
        type: "ed25519";
        privateKey: string;
    } | undefined;
    roles?: Record<string, {
        [x: string]: unknown;
        role: string;
    }> | undefined;
} | {
    modQueue?: {
        pageCids: Record<string, string>;
    } | undefined;
    challenges?: {
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
    }[] | undefined;
    signature?: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    } | undefined;
    encryption?: {
        [x: string]: unknown;
        type: string;
        publicKey: string;
    } | undefined;
    name?: string | undefined;
    createdAt?: number | undefined;
    updatedAt?: number | undefined;
    pubsubTopic?: string | undefined;
    statsCid?: string | undefined;
    protocolVersion?: string | undefined;
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
    address?: string | undefined;
    publicKey?: string | undefined;
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
    } | {
        pageCids?: Record<string, string> | undefined;
    } | undefined;
    updateCid?: string | undefined;
};
export declare function parsePKCUserOptionsSchemaWithPKCErrorIfItFails(args: any): z.infer<typeof PKCUserOptionsSchema>;
export declare function parseCreateRpcCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(args: z.infer<typeof CreateRpcCommunityFunctionArgumentSchema>): {
    [x: string]: unknown;
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
} | {
    name?: string | undefined;
    flairs?: Record<string, {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[]> | undefined;
    title?: string | undefined;
    description?: string | undefined;
    pubsubTopic?: string | undefined;
    rules?: string[] | undefined;
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
    settings?: {
        fetchThumbnailUrls?: boolean | undefined;
        fetchThumbnailUrlsProxyUrl?: string | undefined;
        challenges?: {
            path?: string | undefined;
            name?: string | undefined;
            options?: Record<string, string> | undefined;
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
            pendingApproval?: boolean | undefined;
        }[] | undefined;
        maxPendingApprovalCount?: number | undefined;
        purgeDisapprovedCommentsOlderThan?: number | undefined;
    } | undefined;
    signer?: {
        type: "ed25519";
        privateKey: string;
    } | undefined;
    roles?: Record<string, {
        [x: string]: unknown;
        role: string;
    }> | undefined;
} | {
    modQueue?: {
        pageCids: Record<string, string>;
    } | undefined;
    challenges?: {
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
    }[] | undefined;
    signature?: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    } | undefined;
    encryption?: {
        [x: string]: unknown;
        type: string;
        publicKey: string;
    } | undefined;
    name?: string | undefined;
    createdAt?: number | undefined;
    updatedAt?: number | undefined;
    pubsubTopic?: string | undefined;
    statsCid?: string | undefined;
    protocolVersion?: string | undefined;
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
    address?: string | undefined;
    publicKey?: string | undefined;
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
    } | {
        pageCids?: Record<string, string> | undefined;
    } | undefined;
    updateCid?: string | undefined;
};
export declare function parseCommentPubsubMessagePublicationWithPKCErrorIfItFails(args: z.infer<typeof CommentPubsubMessagePublicationSchema>): {
    timestamp: number;
    signature: {
        type: string;
        signature: string;
        publicKey: string;
        signedPropertyNames: string[];
    };
    protocolVersion: string;
    flairs?: {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[] | undefined;
    author?: {
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
};
export declare function parseCreateCommentOptionsSchemaWithPKCErrorIfItFails(args: z.infer<typeof CreateCommentOptionsSchema>): {
    signer: {
        type: "ed25519";
        privateKey: string;
    };
    communityAddress: string;
    flairs?: {
        [x: string]: unknown;
        text: string;
        backgroundColor?: string | undefined;
        textColor?: string | undefined;
        expiresAt?: number | undefined;
    }[] | undefined;
    spoiler?: boolean | undefined;
    nsfw?: boolean | undefined;
    content?: string | undefined;
    title?: string | undefined;
    link?: string | undefined;
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
    communityPublicKey?: string | undefined;
    communityName?: string | undefined;
    protocolVersion?: string | undefined;
    timestamp?: number | undefined;
    challengeRequest?: {
        challengeAnswers?: string[] | undefined;
        challengeCommentCids?: string[] | undefined;
    } | undefined;
};
export declare function parseCommunityAddressWithPKCErrorIfItFails(args: z.infer<typeof CreateCommentOptionsSchema.shape.communityAddress>): string;
export type SchemaRowParserOptions = {
    prefix?: string;
    coerceBooleans?: boolean;
    parseJsonStrings?: boolean;
    loose?: boolean;
    validate?: boolean;
};
type ObjectSchema = ZodObject<any, any>;
export interface SchemaRowParserResult<Schema extends ObjectSchema> {
    data: z.output<Schema>;
    extras: Record<string, unknown>;
}
export declare function createSchemaRowParser<Schema extends ObjectSchema>(schema: Schema, options?: SchemaRowParserOptions): (row: unknown) => SchemaRowParserResult<Schema>;
export {};
