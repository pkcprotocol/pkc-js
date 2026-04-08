import { Server as RpcWebsocketsServer } from "rpc-websockets";
import { setPKCJs } from "./lib/pkc-js/index.js";
import type { PKCWsServerClassOptions, JsonRpcSendNotificationOptions, CreatePKCWsServerOptions, PKCRpcServerEvents } from "./types.js";
import { PKC } from "../../pkc/pkc.js";
import WebSocket from "ws";
import Publication from "../../publications/publication.js";
import { LocalCommunity } from "../../runtime/browser/community/local-community.js";
import type { CommentIpfsType } from "../../publications/comment/types.js";
import type { RpcInternalCommunityRecordAfterFirstUpdateType, RpcInternalCommunityRecordBeforeFirstUpdateType } from "../../community/types.js";
import { RpcPublishResult } from "../../publications/types.js";
import { TypedEmitter } from "tiny-typed-emitter";
import type { ModQueuePageIpfs } from "../../pages/types.js";
declare class PKCWsServer extends TypedEmitter<PKCRpcServerEvents> {
    pkc: PKC;
    rpcWebsockets: RpcWebsocketsServer;
    ws: RpcWebsocketsServer["wss"];
    connections: {
        [connectionId: string]: WebSocket;
    };
    subscriptionCleanups: {
        [connectionId: string]: {
            [subscriptionId: number]: () => Promise<void>;
        };
    };
    publishing: {
        [subscriptionId: number]: {
            publication: Publication;
            pkc: PKC;
            connectionId: string;
            timeout?: NodeJS.Timeout;
        };
    };
    private _setSettingsQueue;
    authKey: string | undefined;
    private _trackedCommunityListeners;
    private _getIpFromConnectionRequest;
    private _onSettingsChange;
    private _startedCommunities;
    private _autoStartOnBoot;
    private _rpcStateDb;
    constructor({ port, server, pkc, authKey, startStartedCommunitiesOnStartup }: PKCWsServerClassOptions);
    getStartedCommunity(address: string): Promise<LocalCommunity>;
    private _emitError;
    private _getRpcStateDb;
    private _updateCommunityState;
    private _removeCommunityState;
    _autoStartPreviousCommunities(): Promise<void>;
    private _internalStartCommunity;
    rpcWebsocketsRegister(method: string, callback: Function): void;
    jsonRpcSendNotification({ method, result, subscription, event, connectionId }: JsonRpcSendNotificationOptions): void;
    private _registerPublishing;
    private _clearPublishing;
    private _forceCleanupPublication;
    private _retirePKCIfNeeded;
    _getPKCInstance(): Promise<PKC>;
    getComment(params: any): Promise<CommentIpfsType>;
    getCommunityPage(params: any): Promise<{
        page: {
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
        } | ModQueuePageIpfs;
        runtimeFields: import("../../pages/util.js").PageRuntimeFields;
    }>;
    getCommentPage(params: any): Promise<{
        page: {
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
        };
        runtimeFields: import("../../pages/util.js").PageRuntimeFields;
    }>;
    createCommunity(params: any): Promise<RpcInternalCommunityRecordBeforeFirstUpdateType>;
    private _trackCommunityListener;
    private _untrackCommunityListener;
    _setupStartedEvents(community: LocalCommunity, connectionId: string, subscriptionId: number): void;
    startCommunity(params: any, connectionId: string): Promise<number>;
    stopCommunity(params: any): Promise<boolean>;
    private _postStoppingOrDeleting;
    editCommunity(params: any): Promise<RpcInternalCommunityRecordBeforeFirstUpdateType | RpcInternalCommunityRecordAfterFirstUpdateType>;
    deleteCommunity(params: any): Promise<boolean>;
    communitiesSubscribe(params: any, connectionId: string): Promise<number>;
    fetchCid(params: any): Promise<{
        content: string;
    }>;
    private _serializeSettingsFromPKC;
    settingsSubscribe(params: any, connectionId: string): Promise<number>;
    private _initPKC;
    private _createPKCInstanceFromSetSettings;
    setSettings(params: any): Promise<boolean>;
    commentUpdateSubscribe(params: any, connectionId: string): Promise<number>;
    communityUpdateSubscribe(params: any, connectionId: string): Promise<number>;
    private _bindCommunityUpdateSubscription;
    private _createCommentInstanceFromPublishCommentParams;
    publishComment(params: any, connectionId: string): Promise<RpcPublishResult>;
    private _createVoteInstanceFromPublishVoteParams;
    publishVote(params: any, connectionId: string): Promise<RpcPublishResult>;
    private _createCommunityEditInstanceFromPublishCommunityEditParams;
    publishCommunityEdit(params: any, connectionId: string): Promise<RpcPublishResult>;
    private _createCommentEditInstanceFromPublishCommentEditParams;
    publishCommentEdit(params: any, connectionId: string): Promise<RpcPublishResult>;
    private _createCommentModerationInstanceFromPublishCommentModerationParams;
    publishCommentModeration(params: any, connectionId: string): Promise<RpcPublishResult>;
    publishChallengeAnswers(params: any): Promise<boolean>;
    resolveAuthorName(params: any): Promise<{
        resolvedAddress: string | null;
    }>;
    unsubscribe(params: any, connectionId: string): Promise<boolean>;
    destroy(): Promise<void>;
}
declare const PKCRpc: {
    PKCWsServer: (options: CreatePKCWsServerOptions) => Promise<PKCWsServer>;
    setPKCJs: typeof setPKCJs;
};
export default PKCRpc;
