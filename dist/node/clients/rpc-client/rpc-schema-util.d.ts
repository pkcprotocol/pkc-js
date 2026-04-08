export declare const parseRpcCidParam: (params: unknown) => {
    [x: string]: unknown;
    cid: string;
};
export declare const parseRpcCommunityAddressParam: (params: unknown) => {
    [x: string]: unknown;
    address: string;
};
export declare const parseRpcCommunityLookupParam: (params: unknown) => {
    [x: string]: unknown;
    address?: string | undefined;
    name?: string | undefined;
    publicKey?: string | undefined;
};
export declare const parseRpcAuthorNameParam: (params: unknown) => {
    [x: string]: unknown;
    address: string;
};
export declare const parseRpcCommunityPageParam: (params: unknown) => {
    [x: string]: unknown;
    cid: string;
    communityAddress: string;
    type: "posts" | "modqueue";
    pageMaxSize: number;
};
export declare const parseRpcCommentRepliesPageParam: (params: unknown) => {
    [x: string]: unknown;
    communityAddress: string;
    cid: string;
    pageMaxSize: number;
    commentCid: string;
};
export declare const parseRpcEditCommunityParam: (params: unknown) => {
    address: string;
    editOptions: {
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
};
export declare const parseRpcPublishChallengeAnswersParam: (params: unknown) => {
    subscriptionId: number;
    challengeAnswers: string[];
};
export declare const parseRpcUnsubscribeParam: (params: unknown) => {
    subscriptionId: number;
};
