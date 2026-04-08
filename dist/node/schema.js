import { z } from "zod";
import { parseIpfsRawOptionToIpfsOptions } from "./util.js";
import { UserAgentSchema } from "./schema/schema.js";
import version from "./version.js";
// This file will have misc schemas, as well as PKC class schema
export const ChainTickerSchema = z.string().min(1);
export const nonNegativeIntStringSchema = z
    .string()
    .regex(/^\d+$/)
    .refine((val) => parseInt(val) >= 0, {
    message: "Must be a non-negative integer"
});
export const Uint8ArraySchema = z.custom((value) => value instanceof Uint8Array, { message: "Expected Uint8Array" });
const IpfsGatewayUrlSchema = z.url().startsWith("http", "IPFS gateway URL must start with http:// or https://");
const RpcUrlSchema = z.url().startsWith("ws", "PKC RPC URL must start with ws:// or wss://"); // Optional websocket URLs of PKC RPC servers, required to run a community from a browser/electron/webview
const KuboRpcCreateClientOptionSchema = z.custom(); // Kubo-rpc-client library will do the validation for us
const DirectoryPathSchema = z.string(); // TODO add validation for path
export const NameResolverSchema = z.object({
    key: z.string().min(1),
    resolve: z.custom((val) => typeof val === "function", {
        message: "resolve must be a function"
    }),
    canResolve: z.custom((val) => typeof val === "function", {
        message: "canResolve must be a function"
    }),
    provider: z.string().min(1),
    dataPath: z.string().optional() // Optional filesystem path for persistent cache storage. Resolvers can use this to store cached resolution results across restarts.
});
// Serialized variant without function props — for RPC transport where functions can't survive JSON serialization
export const NameResolverSerializedSchema = NameResolverSchema.omit({ resolve: true, canResolve: true });
const TransformKuboRpcClientOptionsSchema = KuboRpcCreateClientOptionSchema.array().transform((options) => options.map(parseIpfsRawOptionToIpfsOptions));
const ParsedKuboRpcClientOptionsSchema = z.custom();
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
        libp2pOptions: z.custom().default({}),
        heliaOptions: z.custom().default({})
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
    challenges: z.record(z.string(), z.custom()).optional() // instance-level challenge registry, shadows built-in challenges by name
});
const defaultPubsubKuboRpcClientsOptions = [
    { url: "https://pubsubprovider.xyz/api/v0" },
    { url: "https://plebpubsub.xyz/api/v0" }
];
const defaultIpfsGatewayUrls = ["https://ipfsgateway.xyz", "https://gateway.plebpubsub.xyz", "https://gateway.forumindex.com"];
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
    if (JSON.stringify(args.pubsubKuboRpcClientsOptions) === JSON.stringify(defaultPubsubKuboRpcClientsOptions) &&
        args.libp2pJsClientsOptions) {
        return {
            ...args,
            pubsubKuboRpcClientsOptions: []
        };
    }
    else
        return args;
});
export const PKCParsedOptionsSchema = PKCUserOptionBaseSchema.extend({
    // used to parse responses from rpc when calling getSettings
    kuboRpcClientsOptions: ParsedKuboRpcClientOptionsSchema.optional(),
    pubsubKuboRpcClientsOptions: ParsedKuboRpcClientOptionsSchema.optional(),
    nameResolvers: NameResolverSchema.array().optional()
}).strict();
//# sourceMappingURL=schema.js.map