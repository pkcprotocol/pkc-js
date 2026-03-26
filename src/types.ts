import { create as CreateIpfsClient, Options as IpfsHttpClientOptions } from "kubo-rpc-client";
import type Publication from "./publications/publication.js";
import type { PlebbitError } from "./plebbit-error.js";
import type { Plebbit } from "./plebbit/plebbit.js";
import {
    AuthorAvatarNftSchema,
    AuthorPubsubSchema,
    AuthorWithOptionalCommentUpdateSchema,
    CreatePublicationUserOptionsSchema,
    ProtocolVersionSchema
} from "./schema/schema.js";
import { z } from "zod";

import type { DecryptedChallengeRequestPublication } from "./pubsub-messages/types.js";
import { ChainTickerSchema, NameResolverSchema, PlebbitParsedOptionsSchema, PlebbitUserOptionsSchema } from "./schema.js";
import PlebbitRpcClient from "./clients/rpc-client/plebbit-rpc-client.js";
import type { PlebbitWsServerSettingsSerialized } from "./rpc/src/types.js";
import { LRUCache } from "lru-cache";
import type { SubplebbitIpfsType } from "./subplebbit/types.js";
import type { PageIpfs } from "./pages/types.js";
import type { CommentIpfsType } from "./publications/comment/types.js";

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export type ChainTicker = z.infer<typeof ChainTickerSchema>;
export type NameResolver = z.infer<typeof NameResolverSchema>;

export type InputPlebbitOptions = z.input<typeof PlebbitUserOptionsSchema>;
export type ParsedPlebbitOptions = z.output<typeof PlebbitParsedOptionsSchema>;

export type AuthorPubsubType = z.infer<typeof AuthorPubsubSchema>;

export type AuthorTypeWithCommentUpdate = z.infer<typeof AuthorWithOptionalCommentUpdateSchema>;

export type RuntimeAuthorType = AuthorPubsubType & { address: string; publicKey: string };

export type RuntimeAuthorWithCommentUpdateType = AuthorTypeWithCommentUpdate & {
    address: string;
    publicKey: string;
    nameResolved?: boolean;
};

// creating a new local publication
export type CreatePublicationOptions = z.infer<typeof CreatePublicationUserOptionsSchema>;

//*********************
//* "Edit" publications
//*********************

export type Nft = z.infer<typeof AuthorAvatarNftSchema>;

export type AuthorPubsubJsonType = RuntimeAuthorType & { shortAddress: string };

export type AuthorWithOptionalCommentUpdateJson = RuntimeAuthorWithCommentUpdateType & { shortAddress: string };

export type PublicationTypeName = keyof DecryptedChallengeRequestPublication; // Publications published by authors over pubsub, not subplebbits

export type NativeFunctions = {
    fetch: typeof fetch;
};

// Event emitter declaration

export interface PlebbitEvents {
    error: (error: PlebbitError | Error) => void;
    subplebbitschange: (listOfSubplebbits: string[]) => void;
    settingschange: (newSettings: ParsedPlebbitOptions) => void;
}

export interface PlebbitRpcClientEvents {
    statechange: (state: PlebbitRpcClient["state"]) => void;
    error: (error: PlebbitError | Error) => void;
    subplebbitschange: (listOfSubplebbits: string[]) => void;
    settingschange: (newSettings: PlebbitWsServerSettingsSerialized) => void;
}

export interface GenericClientEvents<T extends string> {
    statechange: (state: T) => void;
}

// Plebbit types here

export interface IpfsStats {
    totalIn: number; // IPFS stats https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-stats-bw
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

export interface IpfsSubplebbitStats {
    stats: IpfsStats;
    sessionStats: IpfsStats; // session means in the last 1h
}

export interface PubsubStats {
    totalIn: number; // IPFS stats https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-stats-bw
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

export interface PubsubSubplebbitStats {
    stats: PubsubStats;
    sessionStats: PubsubStats; // session means in the last 1h
}

export interface KuboRpcClient {
    peers: () => ReturnType<KuboRpcClient["_client"]["swarm"]["peers"]>; // https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-swarm-peers
    stats?: undefined; // Should be defined, will change later
    sessionStats?: undefined; // Should be defined, will change later
    subplebbitStats?: undefined; // Should be defined, will change later
    _client: ReturnType<typeof CreateIpfsClient>; // Private API, shouldn't be used by consumers
    url: string;
    _clientOptions: IpfsHttpClientOptions;
    destroy: () => Promise<void>;
}

export type PubsubSubscriptionHandler = Extract<Parameters<KuboRpcClient["_client"]["pubsub"]["subscribe"]>[1], Function>;
export type IpfsHttpClientPubsubMessage = Parameters<PubsubSubscriptionHandler>["0"];
export interface PubsubClient {
    peers: () => Promise<string[]>; // IPFS peers https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-pubsub-peers
    stats?: undefined; // Should be defined, will change later
    sessionStats?: undefined; // Should be defined, will change later
    subplebbitStats?: undefined; // Should be defined, will change later
    _client: Pick<KuboRpcClient["_client"], "pubsub">; // Private API, shouldn't be used by consumers
    _clientOptions: KuboRpcClient["_clientOptions"];
    url: string;
    destroy: () => Promise<void>;
}

export interface GatewayClient {
    stats?: IpfsStats; // Should be defined, will change later
    sessionStats?: IpfsStats; // Should be defined, will change later. session means in the last 1h
    subplebbitStats?: { [subplebbitAddress: string]: IpfsSubplebbitStats }; // Should be defined, will change later
}

// Storage interface, will be used to set up storage cache using localforage (for browser) or key-v SQLite (Node)
export interface StorageInterface {
    init: () => Promise<void>;
    getItem: (key: string) => Promise<any | undefined>;
    setItem: (key: string, value: any) => Promise<void>;
    removeItem: (key: string | string[]) => Promise<boolean>;
    clear: () => Promise<void>;
    destroy: () => Promise<void>;
}

type LRUStorageCacheNames = "plebbitjs_lrustorage_postTimestamp" | "plebbitjs_lrustorage_commentPostUpdatesParentsPath";

export interface LRUStorageConstructor {
    maxItems: number; // Will start evicting after this number of items is stored
    cacheName: LRUStorageCacheNames | string; // The cache name will be used as the name of the table in sqlite. For browser it will be used as the name of the local forage instance
    plebbit: Pick<Plebbit, "dataPath" | "noData">;
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

// Util function of types here

type OmitUnderscoreProps<T> = Omit<T, `_${string}`>;
type ExcludeMethods<T> = { [K in keyof T as T[K] extends Function ? never : K]: T[K] };

export type JsonOfClass<T> = ExcludeMethods<OmitUnderscoreProps<T>>;

export type ResultOfFetchingSubplebbit = { subplebbit: SubplebbitIpfsType; cid: string } | undefined;

export type PlebbitMemCaches = {
    subplebbitVerificationCache: LRUCache<string, boolean>;
    pageVerificationCache: LRUCache<string, boolean>;
    commentVerificationCache: LRUCache<string, boolean>;
    commentUpdateVerificationCache: LRUCache<string, boolean>;
    commentIpfs: LRUCache<string, CommentIpfsType>;
    subplebbitForPublishing: LRUCache<string, NonNullable<Publication["_community"]>>;
    pageCidToSortTypes: LRUCache<NonNullable<PageIpfs["nextCid"]>, string[]>; // page cid => sort types
    pagesMaxSize: LRUCache<NonNullable<PageIpfs["nextCid"]>, number>; // page cid => max file size (number of bytes )
    nameResolvedCache: LRUCache<string, boolean>; // key: sha256(domain + signaturePublicKey), value: true|false
};
