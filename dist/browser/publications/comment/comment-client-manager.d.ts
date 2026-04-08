import { PreResolveNameResolverOptions } from "../../clients/base-client-manager.js";
import type { PageIpfs } from "../../pages/types.js";
import type { CommunityIpfsType } from "../../community/types.js";
import { NameResolverClient } from "../../clients/name-resolver-client.js";
import { Comment } from "./comment.js";
import type { CommentIpfsType, CommentUpdateType } from "./types.js";
import { PKCError } from "../../pkc-error.js";
import Logger from "../../logger.js";
import { PublicationClientsManager } from "../publication-client-manager.js";
import { RemoteCommunity } from "../../community/remote-community.js";
import { CommentIpfsGatewayClient, CommentKuboPubsubClient, CommentKuboRpcClient, CommentLibp2pJsClient, CommentPKCRpcStateClient } from "./comment-clients.js";
import { PKC } from "../../pkc/pkc.js";
type NewCommentUpdate = {
    commentUpdate: CommentUpdateType;
    commentUpdateIpfsPath: NonNullable<Comment["_commentUpdateIpfsPath"]>;
} | undefined;
export declare const MAX_FILE_SIZE_BYTES_FOR_COMMENT_UPDATE: number;
export declare class CommentClientsManager extends PublicationClientsManager {
    clients: {
        ipfsGateways: {
            [ipfsGatewayUrl: string]: CommentIpfsGatewayClient;
        };
        kuboRpcClients: {
            [ipfsClientUrl: string]: CommentKuboRpcClient;
        };
        pubsubKuboRpcClients: {
            [pubsubClientUrl: string]: CommentKuboPubsubClient;
        };
        pkcRpcClients: Record<string, CommentPKCRpcStateClient>;
        libp2pJsClients: {
            [libp2pJsClientKey: string]: CommentLibp2pJsClient;
        };
        nameResolvers: {
            [resolverKey: string]: NameResolverClient;
        };
    };
    private _postForUpdating?;
    private _comment;
    private _parentFirstPageCidsAlreadyLoaded;
    private _fetchingUpdateForReplyUsingPageCidsPromise?;
    constructor(comment: Comment);
    protected _initKuboRpcClients(): void;
    protected _initLibp2pJsClients(): void;
    protected _initPKCRpcClients(): void;
    updateLibp2pJsClientState(newState: CommentLibp2pJsClient["state"], libp2pJsClientKey: string): void;
    updateKuboRpcState(newState: CommentKuboRpcClient["state"], kuboRpcClientUrl: string): void;
    updateGatewayState(newState: CommentIpfsGatewayClient["state"], ipfsGatewayClientUrl: string): void;
    updateKuboRpcPubsubState(newState: CommentKuboPubsubClient["state"], pubsubKuboRpcClientUrl: string): void;
    preResolveNameResolver(opts: PreResolveNameResolverOptions): void;
    _calculatePathForPostCommentUpdate(folderCid: string, postCid: string): string;
    _updateKuboRpcClientOrHeliaState(newState: CommentKuboRpcClient["state"] | CommentLibp2pJsClient["state"], kuboRpcOrHelia: PKC["clients"]["kuboRpcClients"][string] | PKC["clients"]["libp2pJsClients"][string]): void;
    _fetchPostCommentUpdateIpfsP2P(subIpns: CommunityIpfsType, timestampRanges: string[], log: Logger): Promise<NewCommentUpdate>;
    _shouldWeFetchCommentUpdateFromNextTimestamp(err: PKCError | Error): boolean;
    private _throwIfCommentUpdateHasInvalidSignature;
    _fetchPostCommentUpdateFromGateways(subIpns: CommunityIpfsType, timestampRanges: string[], log: Logger): Promise<NewCommentUpdate>;
    _useLoadedCommentUpdateIfNewInfo(loadedCommentUpdate: NonNullable<NewCommentUpdate> | Pick<NonNullable<NewCommentUpdate>, "commentUpdate">, community: Pick<CommunityIpfsType, "signature">, log: Logger): boolean;
    useCommunityPostUpdatesToFetchCommentUpdateForPost(subIpfs: CommunityIpfsType): Promise<void>;
    private _fetchRawCommentCidIpfsP2P;
    private _fetchCommentIpfsFromGateways;
    private _throwIfCommentIpfsIsInvalid;
    _fetchCommentIpfsFromPages(): Promise<void>;
    fetchAndVerifyCommentCid(cid: string): Promise<CommentIpfsType>;
    protected _isPublishing(): boolean;
    _findCommentInPagesOfUpdatingCommentsOrCommunity(opts?: {
        community?: RemoteCommunity;
        post?: Comment;
        parent?: Comment;
    }): PageIpfs["comments"][0] | undefined;
    handleUpdateEventFromCommunity(community: RemoteCommunity): Promise<void>;
    _chooseWhichPagesBasedOnParentAndReplyTimestamp(parentCommentTimestamp: number): "old" | "new";
    usePageCidsOfParentToFetchCommentUpdateForReply(postCommentInstance: Comment): Promise<void>;
    handleErrorEventFromCommunity(error: PKCError | Error): Promise<void>;
    handleIpfsGatewayCommunityState(communityNewGatewayState: RemoteCommunity["clients"]["ipfsGateways"][string]["state"], gatewayUrl: string): void;
    _translateCommunityUpdatingStateToCommentUpdatingState(newCommunityUpdatingState: RemoteCommunity["updatingState"]): void;
    handleUpdatingStateChangeEventFromCommunity(newCommunityUpdatingState: RemoteCommunity["updatingState"]): void;
    handleErrorEventFromPost(error: PKCError | Error): void;
    handleUpdatingStateChangeEventFromPost(newState: Comment["updatingState"]): void;
    _handleIpfsGatewayPostState(newState: Comment["clients"]["ipfsGateways"][string]["state"], gatewayUrl: string): void;
    _handleKuboRpcPostState(newState: Comment["clients"]["kuboRpcClients"][string]["state"], kuboRpcUrl: string): void;
    _handleLibp2pJsClientPostState(newState: Comment["clients"]["libp2pJsClients"][string]["state"], libp2pJsClientKey: string): void;
    _handleNameResolverPostState(newState: Comment["clients"]["nameResolvers"][string]["state"], resolverKey: string): void;
    handleUpdateEventFromPostToFetchReplyCommentUpdate(postInstance: Comment): Promise<void>;
    _createPostInstanceWithStateTranslation(): Promise<CommentClientsManager["_postForUpdating"]>;
    cleanUpUpdatingPostInstance(): Promise<void>;
}
export {};
