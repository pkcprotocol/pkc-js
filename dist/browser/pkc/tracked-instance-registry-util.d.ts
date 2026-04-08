import type { Comment } from "../publications/comment/comment.js";
import type { LocalCommunity } from "../runtime/browser/community/local-community.js";
import type { RemoteCommunity } from "../community/remote-community.js";
import type { RpcLocalCommunity } from "../community/rpc-local-community.js";
import type { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import type { PKC } from "./pkc.js";
import type { TrackedInstanceRegistry } from "./tracked-instance-registry.js";
type TrackedCommunity = RemoteCommunity | RpcRemoteCommunity | RpcLocalCommunity | LocalCommunity;
type StartedCommunity = LocalCommunity | RpcLocalCommunity;
type CommunityLookup = {
    address?: string;
    name?: string;
    publicKey?: string;
};
type CommunityWithAliases = CommunityLookup & {
    signer?: {
        address?: string;
    } | undefined;
};
type CommentLookup = {
    cid?: string;
};
export declare function getCommunityRegistryAliases(community: CommunityWithAliases): string[];
export declare function getCommentRegistryAliases(comment: CommentLookup): string[];
export declare function syncCommunityRegistryEntry<T extends CommunityWithAliases>(registry: TrackedInstanceRegistry<T>, community: T): T;
export declare function syncCommentRegistryEntry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, comment: T): T;
export declare function findCommunityInRegistry<T extends CommunityWithAliases>(registry: TrackedInstanceRegistry<T>, lookup: CommunityLookup): T | undefined;
export declare function findCommentInRegistry<T extends CommentLookup>(registry: TrackedInstanceRegistry<T>, lookup: CommentLookup): T | undefined;
export declare function listRegistryValues<T extends object>(registry: TrackedInstanceRegistry<T>): T[];
export declare function trackUpdatingCommunity(pkc: PKC, community: TrackedCommunity): TrackedCommunity;
export declare function trackStartedCommunity(pkc: PKC, community: StartedCommunity): StartedCommunity;
export declare function trackUpdatingComment(pkc: PKC, comment: Comment): Comment;
export declare function untrackUpdatingCommunity(pkc: PKC, community: TrackedCommunity): void;
export declare function untrackStartedCommunity(pkc: PKC, community: StartedCommunity): void;
export declare function untrackUpdatingComment(pkc: PKC, comment: Comment): void;
export declare function refreshTrackedCommunityAliases(pkc: PKC, community: TrackedCommunity): void;
export declare function refreshTrackedCommentAliases(pkc: PKC, comment: Comment): void;
export declare function findUpdatingCommunity(pkc: PKC, lookup: CommunityLookup): TrackedCommunity | undefined;
export declare function findStartedCommunity(pkc: PKC, lookup: CommunityLookup): StartedCommunity | undefined;
export declare function findUpdatingComment(pkc: PKC, lookup: CommentLookup): Comment | undefined;
export declare function listUpdatingCommunities(pkc: PKC): TrackedCommunity[];
export declare function listStartedCommunities(pkc: PKC): StartedCommunity[];
export declare function listUpdatingComments(pkc: PKC): Comment[];
export {};
