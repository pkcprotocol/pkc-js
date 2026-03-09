import { z } from "zod";
import { parseIpfsRawOptionToIpfsOptions } from "./util.js";
import { UserAgentSchema } from "./schema/schema.js";
import version from "./version.js";
import type { libp2pDefaults } from "helia";
import { createHelia } from "helia";
import type { KuboRpcClientCreateOption } from "./util.js";
import type { ChallengeFileFactoryInput } from "./subplebbit/types.js";

// This file will have misc schemas, as well as Plebbit class schema

export const ChainTickerSchema = z.string().min(1);

export const nonNegativeIntStringSchema = z
    .string()
    .regex(/^\d+$/)
    .refine((val) => parseInt(val) >= 0, {
        message: "Must be a non-negative integer"
    });

export const Uint8ArraySchema = z.custom<Uint8Array<ArrayBufferLike>>(
    (value): value is Uint8Array<ArrayBufferLike> => value instanceof Uint8Array,
    { message: "Expected Uint8Array" }
);

const IpfsGatewayUrlSchema = z.url().startsWith("http", "IPFS gateway URL must start with http:// or https://");

const RpcUrlSchema = z.url().startsWith("ws", "Plebbit RPC URL must start with ws:// or wss://"); // Optional websocket URLs of plebbit RPC servers, required to run a sub from a browser/electron/webview

const KuboRpcCreateClientOptionSchema = z.custom<KuboRpcClientCreateOption>(); // Kubo-rpc-client library will do the validation for us

const DirectoryPathSchema = z.string(); // TODO add validation for path

export const NameResolverSchema = z.object({
    key: z.string().min(1),
    resolve: z.custom<
        (opts: {
            name: string;
            provider: string;
            abortSignal?: AbortSignal;
        }) => Promise<{ publicKey: string; [key: string]: string } | undefined>
    >((val) => typeof val === "function", {
        message: "resolve must be a function"
    }),
    canResolve: z.custom<(opts: { name: string }) => boolean>((val) => typeof val === "function", {
        message: "canResolve must be a function"
    }),
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

export const PlebbitUserOptionBaseSchema = z.object({
    ipfsGatewayUrls: IpfsGatewayUrlSchema.array().optional(),
    kuboRpcClientsOptions: TransformKuboRpcClientOptionsSchema.optional(),
    httpRoutersOptions: z.string().url().startsWith("http", "HTTP router URL must start with http:// or https://").array().optional(),
    pubsubKuboRpcClientsOptions: TransformKuboRpcClientOptionsSchema.optional(),
    plebbitRpcClientsOptions: RpcUrlSchema.array().nonempty().optional(),
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
    validatePages: z.boolean(), // if false, plebbit-js will not validate pages in commentUpdate/Subplebbit/getPage
    userAgent: UserAgentSchema,
    // Options for tests only. Should not be used in production
    publishInterval: z.number().positive(), // in ms, the time to wait for subplebbit instances to publish updates. Default is 20s
    updateInterval: z.number().positive(), // in ms, the time to wait for comment/subplebbit instances to check for updates. Default is 1min
    noData: z.boolean(), // if true, dataPath is ignored, all database and cache data is saved in memory
    challenges: z.record(z.string(), z.custom<ChallengeFileFactoryInput>()).optional() // instance-level challenge registry, shadows built-in challenges by name
});

const defaultPubsubKuboRpcClientsOptions = [
    { url: "https://pubsubprovider.xyz/api/v0" },
    { url: "https://plebpubsub.xyz/api/v0" }
] as const;

const defaultIpfsGatewayUrls = ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"] as const;

export const PlebbitUserOptionsSchema = PlebbitUserOptionBaseSchema.extend({
    // used in await Plebbit({PlebbitOption}), will set defaults here
    ipfsGatewayUrls: PlebbitUserOptionBaseSchema.shape.ipfsGatewayUrls
        .default([...defaultIpfsGatewayUrls])
        .transform((val) => (val === undefined ? [...defaultIpfsGatewayUrls] : val)),
    pubsubKuboRpcClientsOptions: PlebbitUserOptionBaseSchema.shape.pubsubKuboRpcClientsOptions.default([
        ...defaultPubsubKuboRpcClientsOptions
    ]),
    httpRoutersOptions: PlebbitUserOptionBaseSchema.shape.httpRoutersOptions.default([
        "https://peers.pleb.bot",
        "https://routing.lol",
        "https://peers.forumindex.com",
        "https://peers.plebpubsub.xyz"
    ]),
    resolveAuthorNames: PlebbitUserOptionBaseSchema.shape.resolveAuthorNames.default(true),
    publishInterval: PlebbitUserOptionBaseSchema.shape.publishInterval.default(20000),
    updateInterval: PlebbitUserOptionBaseSchema.shape.updateInterval.default(60000),
    noData: PlebbitUserOptionBaseSchema.shape.noData.default(false),
    validatePages: PlebbitUserOptionBaseSchema.shape.validatePages.default(true),
    userAgent: PlebbitUserOptionBaseSchema.shape.userAgent.default(version.USER_AGENT)
}).transform((args) => {
    if (
        JSON.stringify(args.pubsubKuboRpcClientsOptions) === JSON.stringify(defaultPubsubKuboRpcClientsOptions) &&
        args.libp2pJsClientsOptions
    ) {
        return {
            ...args,
            pubsubKuboRpcClientsOptions: [] as z.infer<typeof PlebbitUserOptionBaseSchema.shape.pubsubKuboRpcClientsOptions>
        };
    } else return args;
});

export const PlebbitParsedOptionsSchema = PlebbitUserOptionBaseSchema.extend({
    // used to parse responses from rpc when calling getSettings
    kuboRpcClientsOptions: ParsedKuboRpcClientOptionsSchema.optional(),
    pubsubKuboRpcClientsOptions: ParsedKuboRpcClientOptionsSchema.optional(),
    nameResolvers: NameResolverSchema.array().optional()
}).strict();
