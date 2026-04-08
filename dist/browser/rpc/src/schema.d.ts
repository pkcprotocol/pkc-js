import { z } from "zod";
import type { Server as HTTPServer } from "http";
import type { Server as HTTPSServer } from "https";
export declare const CreatePKCWsServerOptionsSchema: z.ZodObject<{
    pkcOptions: z.ZodOptional<z.ZodCustom<{
        kuboRpcClientsOptions?: import("../../util.js").KuboRpcClientCreateOption[] | undefined;
        pkcRpcClientsOptions?: string[] | undefined;
        dataPath?: string | undefined;
        nameResolvers?: {
            key: string;
            resolve: (opts: {
                name: string;
                provider: string;
                abortSignal?: AbortSignal;
            }) => Promise<{
                publicKey: string;
                [key: string]: string;
            } | undefined>;
            canResolve: (opts: {
                name: string;
            }) => boolean;
            provider: string;
            dataPath?: string | undefined;
        }[] | undefined;
        libp2pJsClientsOptions?: {
            key: string;
            libp2pOptions?: Partial<import("libp2p").Libp2pInit<import("helia").DefaultLibp2pServices> & {
                start?: boolean;
            } & Required<Pick<import("libp2p").Libp2pOptions<import("helia").DefaultLibp2pServices>, "services">>> | undefined;
            heliaOptions?: Partial<Partial<import("helia").HeliaInit<import("libp2p").Libp2p<import("helia").DefaultLibp2pServices>>> | undefined>;
        }[] | undefined;
        challenges?: Record<string, z.core.$InferInnerFunctionType<z.ZodTuple<readonly [z.ZodObject<{
            challengeSettings: z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    community: z.ZodOptional<z.ZodObject<{
                        addresses: z.ZodArray<z.ZodString>;
                        maxCommentCids: z.ZodNumber;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    postScore: z.ZodOptional<z.ZodNumber>;
                    replyScore: z.ZodOptional<z.ZodNumber>;
                    postCount: z.ZodOptional<z.ZodNumber>;
                    replyCount: z.ZodOptional<z.ZodNumber>;
                    firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                    role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                        owner: "owner";
                        admin: "admin";
                        moderator: "moderator";
                    }>, z.ZodString]>>>;
                    address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    rateLimit: z.ZodOptional<z.ZodNumber>;
                    rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                    publicationType: z.ZodOptional<z.ZodObject<{
                        post: z.ZodOptional<z.ZodBoolean>;
                        reply: z.ZodOptional<z.ZodBoolean>;
                        vote: z.ZodOptional<z.ZodBoolean>;
                        commentEdit: z.ZodOptional<z.ZodBoolean>;
                        commentModeration: z.ZodOptional<z.ZodBoolean>;
                        communityEdit: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>>;
                description: z.ZodOptional<z.ZodString>;
                pendingApproval: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
        }, z.core.$strip>], null>, z.ZodObject<{
            optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                option: z.ZodString;
                label: z.ZodString;
                default: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$loose>>>;
            type: z.ZodString;
            challenge: z.ZodOptional<z.ZodString>;
            caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            description: z.ZodOptional<z.ZodString>;
            getChallenge: z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                challengeSettings: z.ZodObject<{
                    path: z.ZodOptional<z.ZodString>;
                    name: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        community: z.ZodOptional<z.ZodObject<{
                            addresses: z.ZodArray<z.ZodString>;
                            maxCommentCids: z.ZodNumber;
                            postScore: z.ZodOptional<z.ZodNumber>;
                            replyScore: z.ZodOptional<z.ZodNumber>;
                            firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        postCount: z.ZodOptional<z.ZodNumber>;
                        replyCount: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                        role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                            owner: "owner";
                            admin: "admin";
                            moderator: "moderator";
                        }>, z.ZodString]>>>;
                        address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        rateLimit: z.ZodOptional<z.ZodNumber>;
                        rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                        publicationType: z.ZodOptional<z.ZodObject<{
                            post: z.ZodOptional<z.ZodBoolean>;
                            reply: z.ZodOptional<z.ZodBoolean>;
                            vote: z.ZodOptional<z.ZodBoolean>;
                            commentEdit: z.ZodOptional<z.ZodBoolean>;
                            commentModeration: z.ZodOptional<z.ZodBoolean>;
                            communityEdit: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$loose>>;
                    }, z.core.$loose>>>;
                    description: z.ZodOptional<z.ZodString>;
                    pendingApproval: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>;
                challengeRequestMessage: z.ZodCustom<import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor, import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor>;
                challengeIndex: z.ZodNumber;
                community: z.ZodCustom<import("../../runtime/browser/community/local-community.js").LocalCommunity, import("../../runtime/browser/community/local-community.js").LocalCommunity>;
            }, z.core.$strip>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                challenge: z.ZodString;
                verify: z.ZodFunction<z.ZodTuple<readonly [z.ZodLazy<z.ZodString>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                    success: z.ZodLiteral<true>;
                }, z.core.$strip>, z.ZodObject<{
                    success: z.ZodLiteral<false>;
                    error: z.ZodString;
                }, z.core.$strip>]>>>;
                type: z.ZodString;
                caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodUnion<[z.ZodObject<{
                success: z.ZodLiteral<true>;
            }, z.core.$strip>, z.ZodObject<{
                success: z.ZodLiteral<false>;
                error: z.ZodString;
            }, z.core.$strip>]>]>>>;
        }, z.core.$strict>>> | undefined;
        ipfsGatewayUrls?: string[] | undefined;
        pubsubKuboRpcClientsOptions?: import("../../util.js").KuboRpcClientCreateOption[] | undefined;
        httpRoutersOptions?: string[] | undefined;
        resolveAuthorNames?: boolean | undefined;
        publishInterval?: number | undefined;
        updateInterval?: number | undefined;
        noData?: boolean | undefined;
        validatePages?: boolean | undefined;
        userAgent?: string | undefined;
    }, {
        kuboRpcClientsOptions?: import("../../util.js").KuboRpcClientCreateOption[] | undefined;
        pkcRpcClientsOptions?: string[] | undefined;
        dataPath?: string | undefined;
        nameResolvers?: {
            key: string;
            resolve: (opts: {
                name: string;
                provider: string;
                abortSignal?: AbortSignal;
            }) => Promise<{
                publicKey: string;
                [key: string]: string;
            } | undefined>;
            canResolve: (opts: {
                name: string;
            }) => boolean;
            provider: string;
            dataPath?: string | undefined;
        }[] | undefined;
        libp2pJsClientsOptions?: {
            key: string;
            libp2pOptions?: Partial<import("libp2p").Libp2pInit<import("helia").DefaultLibp2pServices> & {
                start?: boolean;
            } & Required<Pick<import("libp2p").Libp2pOptions<import("helia").DefaultLibp2pServices>, "services">>> | undefined;
            heliaOptions?: Partial<Partial<import("helia").HeliaInit<import("libp2p").Libp2p<import("helia").DefaultLibp2pServices>>> | undefined>;
        }[] | undefined;
        challenges?: Record<string, z.core.$InferInnerFunctionType<z.ZodTuple<readonly [z.ZodObject<{
            challengeSettings: z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    community: z.ZodOptional<z.ZodObject<{
                        addresses: z.ZodArray<z.ZodString>;
                        maxCommentCids: z.ZodNumber;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    postScore: z.ZodOptional<z.ZodNumber>;
                    replyScore: z.ZodOptional<z.ZodNumber>;
                    postCount: z.ZodOptional<z.ZodNumber>;
                    replyCount: z.ZodOptional<z.ZodNumber>;
                    firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                    role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                        owner: "owner";
                        admin: "admin";
                        moderator: "moderator";
                    }>, z.ZodString]>>>;
                    address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    rateLimit: z.ZodOptional<z.ZodNumber>;
                    rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                    publicationType: z.ZodOptional<z.ZodObject<{
                        post: z.ZodOptional<z.ZodBoolean>;
                        reply: z.ZodOptional<z.ZodBoolean>;
                        vote: z.ZodOptional<z.ZodBoolean>;
                        commentEdit: z.ZodOptional<z.ZodBoolean>;
                        commentModeration: z.ZodOptional<z.ZodBoolean>;
                        communityEdit: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>>;
                description: z.ZodOptional<z.ZodString>;
                pendingApproval: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
        }, z.core.$strip>], null>, z.ZodObject<{
            optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                option: z.ZodString;
                label: z.ZodString;
                default: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$loose>>>;
            type: z.ZodString;
            challenge: z.ZodOptional<z.ZodString>;
            caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            description: z.ZodOptional<z.ZodString>;
            getChallenge: z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                challengeSettings: z.ZodObject<{
                    path: z.ZodOptional<z.ZodString>;
                    name: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        community: z.ZodOptional<z.ZodObject<{
                            addresses: z.ZodArray<z.ZodString>;
                            maxCommentCids: z.ZodNumber;
                            postScore: z.ZodOptional<z.ZodNumber>;
                            replyScore: z.ZodOptional<z.ZodNumber>;
                            firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        postCount: z.ZodOptional<z.ZodNumber>;
                        replyCount: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                        role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                            owner: "owner";
                            admin: "admin";
                            moderator: "moderator";
                        }>, z.ZodString]>>>;
                        address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        rateLimit: z.ZodOptional<z.ZodNumber>;
                        rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                        publicationType: z.ZodOptional<z.ZodObject<{
                            post: z.ZodOptional<z.ZodBoolean>;
                            reply: z.ZodOptional<z.ZodBoolean>;
                            vote: z.ZodOptional<z.ZodBoolean>;
                            commentEdit: z.ZodOptional<z.ZodBoolean>;
                            commentModeration: z.ZodOptional<z.ZodBoolean>;
                            communityEdit: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$loose>>;
                    }, z.core.$loose>>>;
                    description: z.ZodOptional<z.ZodString>;
                    pendingApproval: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>;
                challengeRequestMessage: z.ZodCustom<import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor, import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor>;
                challengeIndex: z.ZodNumber;
                community: z.ZodCustom<import("../../runtime/browser/community/local-community.js").LocalCommunity, import("../../runtime/browser/community/local-community.js").LocalCommunity>;
            }, z.core.$strip>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                challenge: z.ZodString;
                verify: z.ZodFunction<z.ZodTuple<readonly [z.ZodLazy<z.ZodString>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                    success: z.ZodLiteral<true>;
                }, z.core.$strip>, z.ZodObject<{
                    success: z.ZodLiteral<false>;
                    error: z.ZodString;
                }, z.core.$strip>]>>>;
                type: z.ZodString;
                caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodUnion<[z.ZodObject<{
                success: z.ZodLiteral<true>;
            }, z.core.$strip>, z.ZodObject<{
                success: z.ZodLiteral<false>;
                error: z.ZodString;
            }, z.core.$strip>]>]>>>;
        }, z.core.$strict>>> | undefined;
        ipfsGatewayUrls?: string[] | undefined;
        pubsubKuboRpcClientsOptions?: import("../../util.js").KuboRpcClientCreateOption[] | undefined;
        httpRoutersOptions?: string[] | undefined;
        resolveAuthorNames?: boolean | undefined;
        publishInterval?: number | undefined;
        updateInterval?: number | undefined;
        noData?: boolean | undefined;
        validatePages?: boolean | undefined;
        userAgent?: string | undefined;
    }>>;
    authKey: z.ZodOptional<z.ZodString>;
    startStartedCommunitiesOnStartup: z.ZodOptional<z.ZodBoolean>;
    port: z.ZodOptional<z.ZodNumber>;
    server: z.ZodOptional<z.ZodCustom<HTTPServer<typeof import("http").IncomingMessage, typeof import("http").ServerResponse> | HTTPSServer<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>, HTTPServer<typeof import("http").IncomingMessage, typeof import("http").ServerResponse> | HTTPSServer<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>>>;
}, z.core.$loose>;
export declare const SetNewSettingsPKCWsServerSchema: z.ZodObject<{
    pkcOptions: z.ZodObject<{
        ipfsGatewayUrls: z.ZodOptional<z.ZodArray<z.ZodURL>>;
        kuboRpcClientsOptions: z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodCustom<import("../../util.js").KuboRpcClientCreateOption, import("../../util.js").KuboRpcClientCreateOption>>, z.ZodTransform<import("kubo-rpc-client").Options[], import("../../util.js").KuboRpcClientCreateOption[]>>>;
        httpRoutersOptions: z.ZodOptional<z.ZodArray<z.ZodString>>;
        pubsubKuboRpcClientsOptions: z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodCustom<import("../../util.js").KuboRpcClientCreateOption, import("../../util.js").KuboRpcClientCreateOption>>, z.ZodTransform<import("kubo-rpc-client").Options[], import("../../util.js").KuboRpcClientCreateOption[]>>>;
        pkcRpcClientsOptions: z.ZodOptional<z.ZodArray<z.ZodURL>>;
        dataPath: z.ZodOptional<z.ZodString>;
        resolveAuthorNames: z.ZodBoolean;
        libp2pJsClientsOptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            libp2pOptions: z.ZodDefault<z.ZodCustom<Partial<import("libp2p").Libp2pInit<import("helia").DefaultLibp2pServices> & {
                start?: boolean;
            } & Required<Pick<import("libp2p").Libp2pOptions<import("helia").DefaultLibp2pServices>, "services">>>, Partial<import("libp2p").Libp2pInit<import("helia").DefaultLibp2pServices> & {
                start?: boolean;
            } & Required<Pick<import("libp2p").Libp2pOptions<import("helia").DefaultLibp2pServices>, "services">>>>>;
            heliaOptions: z.ZodDefault<z.ZodCustom<Partial<Partial<import("helia").HeliaInit<import("libp2p").Libp2p<import("helia").DefaultLibp2pServices>>> | undefined>, Partial<Partial<import("helia").HeliaInit<import("libp2p").Libp2p<import("helia").DefaultLibp2pServices>>> | undefined>>>;
        }, z.core.$strip>>>;
        validatePages: z.ZodBoolean;
        userAgent: z.ZodString;
        publishInterval: z.ZodNumber;
        updateInterval: z.ZodNumber;
        noData: z.ZodBoolean;
        challenges: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<z.core.$InferInnerFunctionType<z.ZodTuple<readonly [z.ZodObject<{
            challengeSettings: z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    community: z.ZodOptional<z.ZodObject<{
                        addresses: z.ZodArray<z.ZodString>;
                        maxCommentCids: z.ZodNumber;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    postScore: z.ZodOptional<z.ZodNumber>;
                    replyScore: z.ZodOptional<z.ZodNumber>;
                    postCount: z.ZodOptional<z.ZodNumber>;
                    replyCount: z.ZodOptional<z.ZodNumber>;
                    firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                    role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                        owner: "owner";
                        admin: "admin";
                        moderator: "moderator";
                    }>, z.ZodString]>>>;
                    address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    rateLimit: z.ZodOptional<z.ZodNumber>;
                    rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                    publicationType: z.ZodOptional<z.ZodObject<{
                        post: z.ZodOptional<z.ZodBoolean>;
                        reply: z.ZodOptional<z.ZodBoolean>;
                        vote: z.ZodOptional<z.ZodBoolean>;
                        commentEdit: z.ZodOptional<z.ZodBoolean>;
                        commentModeration: z.ZodOptional<z.ZodBoolean>;
                        communityEdit: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>>;
                description: z.ZodOptional<z.ZodString>;
                pendingApproval: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
        }, z.core.$strip>], null>, z.ZodObject<{
            optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                option: z.ZodString;
                label: z.ZodString;
                default: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$loose>>>;
            type: z.ZodString;
            challenge: z.ZodOptional<z.ZodString>;
            caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            description: z.ZodOptional<z.ZodString>;
            getChallenge: z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                challengeSettings: z.ZodObject<{
                    path: z.ZodOptional<z.ZodString>;
                    name: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        community: z.ZodOptional<z.ZodObject<{
                            addresses: z.ZodArray<z.ZodString>;
                            maxCommentCids: z.ZodNumber;
                            postScore: z.ZodOptional<z.ZodNumber>;
                            replyScore: z.ZodOptional<z.ZodNumber>;
                            firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        postCount: z.ZodOptional<z.ZodNumber>;
                        replyCount: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                        role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                            owner: "owner";
                            admin: "admin";
                            moderator: "moderator";
                        }>, z.ZodString]>>>;
                        address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        rateLimit: z.ZodOptional<z.ZodNumber>;
                        rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                        publicationType: z.ZodOptional<z.ZodObject<{
                            post: z.ZodOptional<z.ZodBoolean>;
                            reply: z.ZodOptional<z.ZodBoolean>;
                            vote: z.ZodOptional<z.ZodBoolean>;
                            commentEdit: z.ZodOptional<z.ZodBoolean>;
                            commentModeration: z.ZodOptional<z.ZodBoolean>;
                            communityEdit: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$loose>>;
                    }, z.core.$loose>>>;
                    description: z.ZodOptional<z.ZodString>;
                    pendingApproval: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>;
                challengeRequestMessage: z.ZodCustom<import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor, import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor>;
                challengeIndex: z.ZodNumber;
                community: z.ZodCustom<import("../../runtime/browser/community/local-community.js").LocalCommunity, import("../../runtime/browser/community/local-community.js").LocalCommunity>;
            }, z.core.$strip>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                challenge: z.ZodString;
                verify: z.ZodFunction<z.ZodTuple<readonly [z.ZodLazy<z.ZodString>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                    success: z.ZodLiteral<true>;
                }, z.core.$strip>, z.ZodObject<{
                    success: z.ZodLiteral<false>;
                    error: z.ZodString;
                }, z.core.$strip>]>>>;
                type: z.ZodString;
                caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodUnion<[z.ZodObject<{
                success: z.ZodLiteral<true>;
            }, z.core.$strip>, z.ZodObject<{
                success: z.ZodLiteral<false>;
                error: z.ZodString;
            }, z.core.$strip>]>]>>>;
        }, z.core.$strict>>, z.core.$InferInnerFunctionType<z.ZodTuple<readonly [z.ZodObject<{
            challengeSettings: z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    community: z.ZodOptional<z.ZodObject<{
                        addresses: z.ZodArray<z.ZodString>;
                        maxCommentCids: z.ZodNumber;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    postScore: z.ZodOptional<z.ZodNumber>;
                    replyScore: z.ZodOptional<z.ZodNumber>;
                    postCount: z.ZodOptional<z.ZodNumber>;
                    replyCount: z.ZodOptional<z.ZodNumber>;
                    firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                    role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                        owner: "owner";
                        admin: "admin";
                        moderator: "moderator";
                    }>, z.ZodString]>>>;
                    address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    rateLimit: z.ZodOptional<z.ZodNumber>;
                    rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                    publicationType: z.ZodOptional<z.ZodObject<{
                        post: z.ZodOptional<z.ZodBoolean>;
                        reply: z.ZodOptional<z.ZodBoolean>;
                        vote: z.ZodOptional<z.ZodBoolean>;
                        commentEdit: z.ZodOptional<z.ZodBoolean>;
                        commentModeration: z.ZodOptional<z.ZodBoolean>;
                        communityEdit: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>>;
                description: z.ZodOptional<z.ZodString>;
                pendingApproval: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
        }, z.core.$strip>], null>, z.ZodObject<{
            optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                option: z.ZodString;
                label: z.ZodString;
                default: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$loose>>>;
            type: z.ZodString;
            challenge: z.ZodOptional<z.ZodString>;
            caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            description: z.ZodOptional<z.ZodString>;
            getChallenge: z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                challengeSettings: z.ZodObject<{
                    path: z.ZodOptional<z.ZodString>;
                    name: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        community: z.ZodOptional<z.ZodObject<{
                            addresses: z.ZodArray<z.ZodString>;
                            maxCommentCids: z.ZodNumber;
                            postScore: z.ZodOptional<z.ZodNumber>;
                            replyScore: z.ZodOptional<z.ZodNumber>;
                            firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        postCount: z.ZodOptional<z.ZodNumber>;
                        replyCount: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                        role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                            owner: "owner";
                            admin: "admin";
                            moderator: "moderator";
                        }>, z.ZodString]>>>;
                        address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        rateLimit: z.ZodOptional<z.ZodNumber>;
                        rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                        publicationType: z.ZodOptional<z.ZodObject<{
                            post: z.ZodOptional<z.ZodBoolean>;
                            reply: z.ZodOptional<z.ZodBoolean>;
                            vote: z.ZodOptional<z.ZodBoolean>;
                            commentEdit: z.ZodOptional<z.ZodBoolean>;
                            commentModeration: z.ZodOptional<z.ZodBoolean>;
                            communityEdit: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$loose>>;
                    }, z.core.$loose>>>;
                    description: z.ZodOptional<z.ZodString>;
                    pendingApproval: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>;
                challengeRequestMessage: z.ZodCustom<import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor, import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor>;
                challengeIndex: z.ZodNumber;
                community: z.ZodCustom<import("../../runtime/browser/community/local-community.js").LocalCommunity, import("../../runtime/browser/community/local-community.js").LocalCommunity>;
            }, z.core.$strip>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                challenge: z.ZodString;
                verify: z.ZodFunction<z.ZodTuple<readonly [z.ZodLazy<z.ZodString>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                    success: z.ZodLiteral<true>;
                }, z.core.$strip>, z.ZodObject<{
                    success: z.ZodLiteral<false>;
                    error: z.ZodString;
                }, z.core.$strip>]>>>;
                type: z.ZodString;
                caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodUnion<[z.ZodObject<{
                success: z.ZodLiteral<true>;
            }, z.core.$strip>, z.ZodObject<{
                success: z.ZodLiteral<false>;
                error: z.ZodString;
            }, z.core.$strip>]>]>>>;
        }, z.core.$strict>>>>>;
        nameResolvers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            provider: z.ZodString;
            dataPath: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$loose>;
}, z.core.$strip>;
export declare const PKCWsServerSettingsSerializedSchema: z.ZodObject<{
    pkcOptions: z.ZodObject<{
        ipfsGatewayUrls: z.ZodOptional<z.ZodArray<z.ZodURL>>;
        httpRoutersOptions: z.ZodOptional<z.ZodArray<z.ZodString>>;
        pkcRpcClientsOptions: z.ZodOptional<z.ZodArray<z.ZodURL>>;
        dataPath: z.ZodOptional<z.ZodString>;
        resolveAuthorNames: z.ZodBoolean;
        libp2pJsClientsOptions: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            libp2pOptions: z.ZodDefault<z.ZodCustom<Partial<import("libp2p").Libp2pInit<import("helia").DefaultLibp2pServices> & {
                start?: boolean;
            } & Required<Pick<import("libp2p").Libp2pOptions<import("helia").DefaultLibp2pServices>, "services">>>, Partial<import("libp2p").Libp2pInit<import("helia").DefaultLibp2pServices> & {
                start?: boolean;
            } & Required<Pick<import("libp2p").Libp2pOptions<import("helia").DefaultLibp2pServices>, "services">>>>>;
            heliaOptions: z.ZodDefault<z.ZodCustom<Partial<Partial<import("helia").HeliaInit<import("libp2p").Libp2p<import("helia").DefaultLibp2pServices>>> | undefined>, Partial<Partial<import("helia").HeliaInit<import("libp2p").Libp2p<import("helia").DefaultLibp2pServices>>> | undefined>>>;
        }, z.core.$strip>>>;
        validatePages: z.ZodBoolean;
        userAgent: z.ZodString;
        publishInterval: z.ZodNumber;
        updateInterval: z.ZodNumber;
        noData: z.ZodBoolean;
        challenges: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodCustom<z.core.$InferInnerFunctionType<z.ZodTuple<readonly [z.ZodObject<{
            challengeSettings: z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    community: z.ZodOptional<z.ZodObject<{
                        addresses: z.ZodArray<z.ZodString>;
                        maxCommentCids: z.ZodNumber;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    postScore: z.ZodOptional<z.ZodNumber>;
                    replyScore: z.ZodOptional<z.ZodNumber>;
                    postCount: z.ZodOptional<z.ZodNumber>;
                    replyCount: z.ZodOptional<z.ZodNumber>;
                    firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                    role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                        owner: "owner";
                        admin: "admin";
                        moderator: "moderator";
                    }>, z.ZodString]>>>;
                    address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    rateLimit: z.ZodOptional<z.ZodNumber>;
                    rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                    publicationType: z.ZodOptional<z.ZodObject<{
                        post: z.ZodOptional<z.ZodBoolean>;
                        reply: z.ZodOptional<z.ZodBoolean>;
                        vote: z.ZodOptional<z.ZodBoolean>;
                        commentEdit: z.ZodOptional<z.ZodBoolean>;
                        commentModeration: z.ZodOptional<z.ZodBoolean>;
                        communityEdit: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>>;
                description: z.ZodOptional<z.ZodString>;
                pendingApproval: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
        }, z.core.$strip>], null>, z.ZodObject<{
            optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                option: z.ZodString;
                label: z.ZodString;
                default: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$loose>>>;
            type: z.ZodString;
            challenge: z.ZodOptional<z.ZodString>;
            caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            description: z.ZodOptional<z.ZodString>;
            getChallenge: z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                challengeSettings: z.ZodObject<{
                    path: z.ZodOptional<z.ZodString>;
                    name: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        community: z.ZodOptional<z.ZodObject<{
                            addresses: z.ZodArray<z.ZodString>;
                            maxCommentCids: z.ZodNumber;
                            postScore: z.ZodOptional<z.ZodNumber>;
                            replyScore: z.ZodOptional<z.ZodNumber>;
                            firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        postCount: z.ZodOptional<z.ZodNumber>;
                        replyCount: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                        role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                            owner: "owner";
                            admin: "admin";
                            moderator: "moderator";
                        }>, z.ZodString]>>>;
                        address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        rateLimit: z.ZodOptional<z.ZodNumber>;
                        rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                        publicationType: z.ZodOptional<z.ZodObject<{
                            post: z.ZodOptional<z.ZodBoolean>;
                            reply: z.ZodOptional<z.ZodBoolean>;
                            vote: z.ZodOptional<z.ZodBoolean>;
                            commentEdit: z.ZodOptional<z.ZodBoolean>;
                            commentModeration: z.ZodOptional<z.ZodBoolean>;
                            communityEdit: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$loose>>;
                    }, z.core.$loose>>>;
                    description: z.ZodOptional<z.ZodString>;
                    pendingApproval: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>;
                challengeRequestMessage: z.ZodCustom<import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor, import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor>;
                challengeIndex: z.ZodNumber;
                community: z.ZodCustom<import("../../runtime/browser/community/local-community.js").LocalCommunity, import("../../runtime/browser/community/local-community.js").LocalCommunity>;
            }, z.core.$strip>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                challenge: z.ZodString;
                verify: z.ZodFunction<z.ZodTuple<readonly [z.ZodLazy<z.ZodString>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                    success: z.ZodLiteral<true>;
                }, z.core.$strip>, z.ZodObject<{
                    success: z.ZodLiteral<false>;
                    error: z.ZodString;
                }, z.core.$strip>]>>>;
                type: z.ZodString;
                caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodUnion<[z.ZodObject<{
                success: z.ZodLiteral<true>;
            }, z.core.$strip>, z.ZodObject<{
                success: z.ZodLiteral<false>;
                error: z.ZodString;
            }, z.core.$strip>]>]>>>;
        }, z.core.$strict>>, z.core.$InferInnerFunctionType<z.ZodTuple<readonly [z.ZodObject<{
            challengeSettings: z.ZodObject<{
                path: z.ZodOptional<z.ZodString>;
                name: z.ZodOptional<z.ZodString>;
                options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                    community: z.ZodOptional<z.ZodObject<{
                        addresses: z.ZodArray<z.ZodString>;
                        maxCommentCids: z.ZodNumber;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    }, z.core.$strict>>;
                    postScore: z.ZodOptional<z.ZodNumber>;
                    replyScore: z.ZodOptional<z.ZodNumber>;
                    postCount: z.ZodOptional<z.ZodNumber>;
                    replyCount: z.ZodOptional<z.ZodNumber>;
                    firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                    challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                    role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                        owner: "owner";
                        admin: "admin";
                        moderator: "moderator";
                    }>, z.ZodString]>>>;
                    address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                    rateLimit: z.ZodOptional<z.ZodNumber>;
                    rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                    publicationType: z.ZodOptional<z.ZodObject<{
                        post: z.ZodOptional<z.ZodBoolean>;
                        reply: z.ZodOptional<z.ZodBoolean>;
                        vote: z.ZodOptional<z.ZodBoolean>;
                        commentEdit: z.ZodOptional<z.ZodBoolean>;
                        commentModeration: z.ZodOptional<z.ZodBoolean>;
                        communityEdit: z.ZodOptional<z.ZodBoolean>;
                    }, z.core.$loose>>;
                }, z.core.$loose>>>;
                description: z.ZodOptional<z.ZodString>;
                pendingApproval: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>;
        }, z.core.$strip>], null>, z.ZodObject<{
            optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
                option: z.ZodString;
                label: z.ZodString;
                default: z.ZodOptional<z.ZodString>;
                description: z.ZodOptional<z.ZodString>;
                placeholder: z.ZodOptional<z.ZodString>;
                required: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$loose>>>;
            type: z.ZodString;
            challenge: z.ZodOptional<z.ZodString>;
            caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            description: z.ZodOptional<z.ZodString>;
            getChallenge: z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                challengeSettings: z.ZodObject<{
                    path: z.ZodOptional<z.ZodString>;
                    name: z.ZodOptional<z.ZodString>;
                    options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
                    exclude: z.ZodOptional<z.ZodArray<z.ZodObject<{
                        community: z.ZodOptional<z.ZodObject<{
                            addresses: z.ZodArray<z.ZodString>;
                            maxCommentCids: z.ZodNumber;
                            postScore: z.ZodOptional<z.ZodNumber>;
                            replyScore: z.ZodOptional<z.ZodNumber>;
                            firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        }, z.core.$strict>>;
                        postScore: z.ZodOptional<z.ZodNumber>;
                        replyScore: z.ZodOptional<z.ZodNumber>;
                        postCount: z.ZodOptional<z.ZodNumber>;
                        replyCount: z.ZodOptional<z.ZodNumber>;
                        firstCommentTimestamp: z.ZodOptional<z.ZodNumber>;
                        challenges: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
                        role: z.ZodOptional<z.ZodArray<z.ZodUnion<[z.ZodEnum<{
                            owner: "owner";
                            admin: "admin";
                            moderator: "moderator";
                        }>, z.ZodString]>>>;
                        address: z.ZodOptional<z.ZodArray<z.ZodString>>;
                        rateLimit: z.ZodOptional<z.ZodNumber>;
                        rateLimitChallengeSuccess: z.ZodOptional<z.ZodBoolean>;
                        publicationType: z.ZodOptional<z.ZodObject<{
                            post: z.ZodOptional<z.ZodBoolean>;
                            reply: z.ZodOptional<z.ZodBoolean>;
                            vote: z.ZodOptional<z.ZodBoolean>;
                            commentEdit: z.ZodOptional<z.ZodBoolean>;
                            commentModeration: z.ZodOptional<z.ZodBoolean>;
                            communityEdit: z.ZodOptional<z.ZodBoolean>;
                        }, z.core.$loose>>;
                    }, z.core.$loose>>>;
                    description: z.ZodOptional<z.ZodString>;
                    pendingApproval: z.ZodOptional<z.ZodBoolean>;
                }, z.core.$strict>;
                challengeRequestMessage: z.ZodCustom<import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor, import("../../pubsub-messages/types.js").DecryptedChallengeRequestMessageTypeWithCommunityAuthor>;
                challengeIndex: z.ZodNumber;
                community: z.ZodCustom<import("../../runtime/browser/community/local-community.js").LocalCommunity, import("../../runtime/browser/community/local-community.js").LocalCommunity>;
            }, z.core.$strip>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                challenge: z.ZodString;
                verify: z.ZodFunction<z.ZodTuple<readonly [z.ZodLazy<z.ZodString>], null>, z.ZodPromise<z.ZodUnion<[z.ZodObject<{
                    success: z.ZodLiteral<true>;
                }, z.core.$strip>, z.ZodObject<{
                    success: z.ZodLiteral<false>;
                    error: z.ZodString;
                }, z.core.$strip>]>>>;
                type: z.ZodString;
                caseInsensitive: z.ZodOptional<z.ZodBoolean>;
            }, z.core.$strict>, z.ZodUnion<[z.ZodObject<{
                success: z.ZodLiteral<true>;
            }, z.core.$strip>, z.ZodObject<{
                success: z.ZodLiteral<false>;
                error: z.ZodString;
            }, z.core.$strip>]>]>>>;
        }, z.core.$strict>>>>>;
        kuboRpcClientsOptions: z.ZodOptional<z.ZodCustom<import("kubo-rpc-client").Options[], import("kubo-rpc-client").Options[]>>;
        pubsubKuboRpcClientsOptions: z.ZodOptional<z.ZodCustom<import("kubo-rpc-client").Options[], import("kubo-rpc-client").Options[]>>;
        nameResolvers: z.ZodOptional<z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            resolve: z.ZodCustom<(opts: {
                name: string;
                provider: string;
                abortSignal?: AbortSignal;
            }) => Promise<{
                publicKey: string;
                [key: string]: string;
            } | undefined>, (opts: {
                name: string;
                provider: string;
                abortSignal?: AbortSignal;
            }) => Promise<{
                publicKey: string;
                [key: string]: string;
            } | undefined>>;
            canResolve: z.ZodCustom<(opts: {
                name: string;
            }) => boolean, (opts: {
                name: string;
            }) => boolean>;
            provider: z.ZodString;
            dataPath: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$loose>;
    challenges: z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        optionInputs: z.ZodOptional<z.ZodArray<z.ZodObject<{
            option: z.ZodString;
            label: z.ZodString;
            default: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
            placeholder: z.ZodOptional<z.ZodString>;
            required: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$loose>>>;
        challenge: z.ZodOptional<z.ZodString>;
        caseInsensitive: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strict>>;
}, z.core.$strip>;
