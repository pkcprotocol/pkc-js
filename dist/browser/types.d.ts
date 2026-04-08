import { create as CreateIpfsClient, Options as IpfsHttpClientOptions } from "kubo-rpc-client";
import type Publication from "./publications/publication.js";
import type { PKCError } from "./pkc-error.js";
import type { PKC } from "./pkc/pkc.js";
import { AuthorAvatarNftSchema, AuthorPubsubSchema, AuthorWithOptionalCommentUpdateSchema, CreatePublicationUserOptionsSchema, ProtocolVersionSchema } from "./schema/schema.js";
import { z } from "zod";
import type { DecryptedChallengeRequestPublication } from "./pubsub-messages/types.js";
import { ChainTickerSchema, NameResolverSchema, PKCParsedOptionsSchema, PKCUserOptionsSchema } from "./schema.js";
import PKCRpcClient from "./clients/rpc-client/pkc-rpc-client.js";
import type { PKCWsServerSettingsSerialized } from "./rpc/src/types.js";
import { LRUCache } from "lru-cache";
import type { CommunityIpfsType } from "./community/types.js";
import type { PageIpfs } from "./pages/types.js";
import type { CommentIpfsType } from "./publications/comment/types.js";
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export type ChainTicker = z.infer<typeof ChainTickerSchema>;
export type NameResolver = z.infer<typeof NameResolverSchema>;
export type InputPKCOptions = z.input<typeof PKCUserOptionsSchema>;
export type ParsedPKCOptions = z.output<typeof PKCParsedOptionsSchema>;
export type AuthorPubsubType = z.infer<typeof AuthorPubsubSchema>;
export type AuthorTypeWithCommentUpdate = z.infer<typeof AuthorWithOptionalCommentUpdateSchema>;
export type RuntimeAuthorType = AuthorPubsubType & {
    address: string;
    publicKey: string;
};
export type RuntimeAuthorWithCommentUpdateType = AuthorTypeWithCommentUpdate & {
    address: string;
    publicKey: string;
    nameResolved?: boolean;
};
export type CreatePublicationOptions = z.infer<typeof CreatePublicationUserOptionsSchema>;
export type Nft = z.infer<typeof AuthorAvatarNftSchema>;
export type AuthorPubsubJsonType = RuntimeAuthorType & {
    shortAddress: string;
};
export type AuthorWithOptionalCommentUpdateJson = RuntimeAuthorWithCommentUpdateType & {
    shortAddress: string;
};
export type PublicationTypeName = keyof DecryptedChallengeRequestPublication;
export type NativeFunctions = {
    fetch: typeof fetch;
};
export interface PKCEvents {
    error: (error: PKCError | Error) => void;
    communitieschange: (listOfCommunities: string[]) => void;
    settingschange: (newSettings: ParsedPKCOptions) => void;
}
export interface PKCRpcClientEvents {
    statechange: (state: PKCRpcClient["state"]) => void;
    error: (error: PKCError | Error) => void;
    communitieschange: (listOfCommunities: string[]) => void;
    settingschange: (newSettings: PKCWsServerSettingsSerialized) => void;
}
export interface GenericClientEvents<T extends string> {
    statechange: (state: T) => void;
}
export interface IpfsStats {
    totalIn: number;
    totalOut: number;
    rateIn: number;
    rateOut: number;
    succeededIpfsCount: number;
    failedIpfsCount: number;
    succeededIpfsAverageTime: number;
    succeededIpfsMedianTime: number;
    succeededIpnsCount: number;
    failedIpnsCount: number;
    succeededIpnsAverageTime: number;
    succeededIpnsMedianTime: number;
}
export interface IpfsCommunityStats {
    stats: IpfsStats;
    sessionStats: IpfsStats;
}
export interface PubsubStats {
    totalIn: number;
    totalOut: number;
    rateIn: number;
    rateOut: number;
    succeededChallengeRequestMessageCount: number;
    failedChallengeRequestMessageCount: number;
    succeededChallengeRequestMessageAverageTime: number;
    succeededChallengeRequestMessageMedianTime: number;
    succeededChallengeAnswerMessageCount: number;
    failedChallengeAnswerMessageCount: number;
    succeededChallengeAnswerMessageAverageTime: number;
    succeededChallengeAnswerMessageMedianTime: number;
}
export interface PubsubCommunityStats {
    stats: PubsubStats;
    sessionStats: PubsubStats;
}
export interface KuboRpcClient {
    peers: () => ReturnType<KuboRpcClient["_client"]["swarm"]["peers"]>;
    stats?: undefined;
    sessionStats?: undefined;
    communityStats?: undefined;
    _client: ReturnType<typeof CreateIpfsClient>;
    url: string;
    _clientOptions: IpfsHttpClientOptions;
    destroy: () => Promise<void>;
}
export type PubsubSubscriptionHandler = Extract<Parameters<KuboRpcClient["_client"]["pubsub"]["subscribe"]>[1], Function>;
export type IpfsHttpClientPubsubMessage = Parameters<PubsubSubscriptionHandler>["0"];
export interface PubsubClient {
    peers: () => Promise<string[]>;
    stats?: undefined;
    sessionStats?: undefined;
    communityStats?: undefined;
    _client: Pick<KuboRpcClient["_client"], "pubsub">;
    _clientOptions: KuboRpcClient["_clientOptions"];
    url: string;
    destroy: () => Promise<void>;
}
export interface GatewayClient {
    stats?: IpfsStats;
    sessionStats?: IpfsStats;
    communityStats?: {
        [communityAddress: string]: IpfsCommunityStats;
    };
}
export interface StorageInterface {
    init: () => Promise<void>;
    getItem: (key: string) => Promise<any | undefined>;
    setItem: (key: string, value: any) => Promise<void>;
    removeItem: (key: string | string[]) => Promise<boolean>;
    clear: () => Promise<void>;
    destroy: () => Promise<void>;
}
type LRUStorageCacheNames = "pkcjs_lrustorage_postTimestamp" | "pkcjs_lrustorage_commentPostUpdatesParentsPath";
export interface LRUStorageConstructor {
    maxItems: number;
    cacheName: LRUStorageCacheNames | string;
    pkc: Pick<PKC, "dataPath" | "noData">;
}
export interface LRUStorageInterface {
    init: () => Promise<void>;
    getItem: (key: string) => Promise<any | undefined>;
    setItem: (key: string, value: any) => Promise<void>;
    removeItem: (key: string) => Promise<boolean>;
    clear: () => Promise<void>;
    keys: () => Promise<string[]>;
    destroy: () => Promise<void>;
}
type OmitUnderscoreProps<T> = Omit<T, `_${string}`>;
type ExcludeMethods<T> = {
    [K in keyof T as T[K] extends Function ? never : K]: T[K];
};
export type JsonOfClass<T> = ExcludeMethods<OmitUnderscoreProps<T>>;
export type ResultOfFetchingCommunity = {
    community: CommunityIpfsType;
    cid: string;
} | undefined;
export type PKCMemCaches = {
    communityVerificationCache: LRUCache<string, boolean>;
    pageVerificationCache: LRUCache<string, boolean>;
    commentVerificationCache: LRUCache<string, boolean>;
    commentUpdateVerificationCache: LRUCache<string, boolean>;
    commentIpfs: LRUCache<string, CommentIpfsType>;
    communityForPublishing: LRUCache<string, NonNullable<Publication["_community"]>>;
    pageCidToSortTypes: LRUCache<NonNullable<PageIpfs["nextCid"]>, string[]>;
    pagesMaxSize: LRUCache<NonNullable<PageIpfs["nextCid"]>, number>;
    nameResolvedCache: LRUCache<string, boolean>;
};
export {};
