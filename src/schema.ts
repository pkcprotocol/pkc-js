import { z } from "zod";
import { parseIpfsRawOptionToIpfsOptions } from "./util.js";
import { UserAgentSchema } from "./schema/schema.js";
import version from "./version.js";
import type { libp2pDefaults } from "helia";
import { createHelia } from "helia";
import type { KuboRpcClientCreateOption } from "./util.js";
import type { ChallengeFileFactoryInput } from "./community/types.js";

// This file will have misc schemas, as well as PKC class schema

export const ChainTickerSchema = z.string().min(1);

export { nonNegativeIntStringSchema } from "./schema/schema.js";

export const Uint8ArraySchema = z.custom<Uint8Array<ArrayBufferLike>>(
    (value): value is Uint8Array<ArrayBufferLike> => value instanceof Uint8Array,
    { message: "Expected Uint8Array" }
);

const IpfsGatewayUrlSchema = z.url().startsWith("http", "IPFS gateway URL must start with http:// or https://");

const RpcUrlSchema = z.url().startsWith("ws", "PKC RPC URL must start with ws:// or wss://"); // Optional websocket URLs of PKC RPC servers, required to run a community from a browser/electron/webview

const KuboRpcCreateClientOptionSchema = z.custom<KuboRpcClientCreateOption>(); // Kubo-rpc-client library will do the validation for us

const DirectoryPathSchema = z.string(); // TODO add validation for path

export interface NameResolverInterface {
    key: string;
    provider: string;
    dataPath?: string;
    resolve: (opts: { name: string; abortSignal?: AbortSignal }) => Promise<{ publicKey: string; [key: string]: string } | undefined>;
    canResolve: (opts: { name: string }) => boolean;
    destroy?: () => Promise<void>;
}

// z.custom() preserves the original object (including class instances) — z.object() would strip unknown keys and break class-based resolvers
export const NameResolverSchema = z.custom<NameResolverInterface>(
    (val) => {
        if (val == null || typeof val !== "object") return false;
        const v = val as Record<string, unknown>;
        return (
            typeof v.key === "string" &&
            v.key.length > 0 &&
            typeof v.resolve === "function" &&
            typeof v.canResolve === "function" &&
            typeof v.provider === "string" &&
            v.provider.length > 0 &&
            (v.destroy === undefined || typeof v.destroy === "function")
        );
    },
    {
        message:
            "Invalid name resolver: must have key (string), resolve (function), canResolve (function), provider (string), and optionally destroy (function)"
    }
);

// Serialized variant without function props — for RPC transport where functions can't survive JSON serialization
export const NameResolverSerializedSchema = z.object({
    key: z.string().min(1),
    provider: z.string().min(1),
    dataPath: z.string().optional()
});

const TransformKuboRpcClientOptionsSchema = KuboRpcCreateClientOptionSchema.array().transform((options) =>
    options.map(parseIpfsRawOptionToIpfsOptions)
);

const ParsedKuboRpcClientOptionsSchema = z.custom<z.output<typeof TransformKuboRpcClientOptionsSchema>>();

// I guess {libp2pOptions, heliaOptions, key} for now, this way we can experiment with passing any config to libp2pJsClientOptions. we can test different libp2p transport and stuff like that

type heliaOptions = Parameters<typeof createHelia>[0];
type libp2pOptions = ReturnType<typeof libp2pDefaults>;

export const PKCUserOptionBaseSchema = z.object({
    ipfsGatewayUrls: IpfsGatewayUrlSchema.array().optional(),
    kuboRpcClientsOptions: TransformKuboRpcClientOptionsSchema.optional(),
    httpRoutersOptions: z.string().url().startsWith("http", "HTTP router URL must start with http:// or https://").array().optional(),
    pubsubKuboRpcClientsOptions: TransformKuboRpcClientOptionsSchema.optional(),
    pkcRpcClientsOptions: RpcUrlSchema.array().nonempty().optional(),
    dataPath: DirectoryPathSchema.optional(),
    resolveAuthorNames: z.boolean(),
    nameResolvers: NameResolverSchema.array().optional(),
    libp2pJsClientsOptions: z
        .object({
            key: z.string().min(1),
            libp2pOptions: z.custom<Partial<libp2pOptions>>().default({}),
            heliaOptions: z.custom<Partial<heliaOptions>>().default({})
        })
        .array()
        .max(1, "Only one libp2pJsClientOptions is allowed at the moment")
        .optional(),
    validatePages: z.boolean(), // if false, pkc-js will not validate pages in commentUpdate/Community/getPage
    userAgent: UserAgentSchema,
    // Options for tests only. Should not be used in production
    publishInterval: z.number().positive(), // in ms, the time to wait for community instances to publish updates. Default is 20s
    updateInterval: z.number().positive(), // in ms, the time to wait for comment/community instances to check for updates. Default is 1min
    noData: z.boolean(), // if true, dataPath is ignored, all database and cache data is saved in memory
    challenges: z.record(z.string(), z.custom<ChallengeFileFactoryInput>()).optional() // instance-level challenge registry, shadows built-in challenges by name
});

const defaultPubsubKuboRpcClientsOptions = [
    { url: "https://pubsubprovider.xyz/api/v0" },
    { url: "https://plebpubsub.xyz/api/v0" }
] as const;

const defaultIpfsGatewayUrls = ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"] as const;

export const PKCUserOptionsSchema = PKCUserOptionBaseSchema.extend({
    // used in await PKC({PKCOption}), will set defaults here
    ipfsGatewayUrls: PKCUserOptionBaseSchema.shape.ipfsGatewayUrls
        .default([...defaultIpfsGatewayUrls])
        .transform((val) => (val === undefined ? [...defaultIpfsGatewayUrls] : val)),
    pubsubKuboRpcClientsOptions: PKCUserOptionBaseSchema.shape.pubsubKuboRpcClientsOptions.default([...defaultPubsubKuboRpcClientsOptions]),
    httpRoutersOptions: PKCUserOptionBaseSchema.shape.httpRoutersOptions.default([
        "https://peers.pleb.bot",
        "https://routing.lol",
        "https://peers.forumindex.com",
        "https://peers.plebpubsub.xyz"
    ]),
    resolveAuthorNames: PKCUserOptionBaseSchema.shape.resolveAuthorNames.default(true),
    publishInterval: PKCUserOptionBaseSchema.shape.publishInterval.default(20000),
    updateInterval: PKCUserOptionBaseSchema.shape.updateInterval.default(60000),
    noData: PKCUserOptionBaseSchema.shape.noData.default(false),
    validatePages: PKCUserOptionBaseSchema.shape.validatePages.default(true),
    userAgent: PKCUserOptionBaseSchema.shape.userAgent.default(version.USER_AGENT)
}).transform((args) => {
    if (
        JSON.stringify(args.pubsubKuboRpcClientsOptions) === JSON.stringify(defaultPubsubKuboRpcClientsOptions) &&
        args.libp2pJsClientsOptions
    ) {
        return {
            ...args,
            pubsubKuboRpcClientsOptions: [] as z.infer<typeof PKCUserOptionBaseSchema.shape.pubsubKuboRpcClientsOptions>
        };
    } else return args;
});

export const PKCParsedOptionsSchema = PKCUserOptionBaseSchema.extend({
    // used to parse responses from rpc when calling getSettings
    kuboRpcClientsOptions: ParsedKuboRpcClientOptionsSchema.optional(),
    pubsubKuboRpcClientsOptions: ParsedKuboRpcClientOptionsSchema.optional(),
    nameResolvers: NameResolverSchema.array().optional()
}).strict();
