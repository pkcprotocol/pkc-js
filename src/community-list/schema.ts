import { z } from "zod";
import { keys, omit } from "remeda";
import {
    AuthorPubsubSchema,
    CidStringSchema,
    CreateSignerSchema,
    JsonSignatureSchema,
    PKCTimestampSchema,
    ProtocolVersionSchema
} from "../schema/schema.js";
import { messages } from "../errors.js";

// CommunityList: an immutable, signed IPFS file addressed by CID. Spec: docs/protocol/community-lists.md

// A cap only enforced by honest publishers is not a cap: enforced on publish AND on load
export const MAX_COMMUNITY_LIST_SIZE_BYTES = 2 * 1024 * 1024; // 2mb

export const communityListHasNoDuplicateEntryPublicKeys = (list: { communities: { publicKey: string }[] }) =>
    new Set(list.communities.map((entry) => entry.publicKey)).size === list.communities.length;

// Entry metadata is set by the list curator, NOT the community owner
const communityListEntryShape = {
    publicKey: z.string().min(1), // IPNS public key of the community
    name: z.string().min(1).optional(), // crypto domain (e.g. 'memes.bso')
    title: z.string().optional(),
    description: z.string().optional(),
    languages: z.string().array().optional(),
    locations: z.string().array().optional(),
    features: z.string().array().optional(),
    tags: z.string().array().optional()
};

// Loose on load: a newer publisher may add fields and sign them; a strict schema would drop signed
// props and break signature verification
export const CommunityListEntrySchema = z.looseObject(communityListEntryShape);
export const CreateCommunityListEntrySchema = z.object(communityListEntryShape).strict(); // strict on create

// Strict base is the typing schema (same idiom as CommunityIpfsSchema); loading MUST go through the
// loose variant below so extra signed props are preserved
const communityListIpfsBaseSchema = z
    .object({
        title: z.string().optional(),
        description: z.string().optional(),
        author: AuthorPubsubSchema.loose().optional(),
        communities: CommunityListEntrySchema.array(),
        timestamp: PKCTimestampSchema,
        protocolVersion: ProtocolVersionSchema,
        signature: JsonSignatureSchema
    })
    .strict();

export const CommunityListSignedPropertyNames = keys(omit(communityListIpfsBaseSchema.shape, ["signature"]));

export const CommunityListIpfsSchema = communityListIpfsBaseSchema.refine(
    communityListHasNoDuplicateEntryPublicKeys,
    messages.ERR_COMMUNITY_LIST_HAS_DUPLICATE_COMMUNITY_PUBLIC_KEY
);

// The parse schema for loading records (and validating built records before publish)
export const CommunityListIpfsLooseSchema = communityListIpfsBaseSchema
    .loose()
    .refine(communityListHasNoDuplicateEntryPublicKeys, messages.ERR_COMMUNITY_LIST_HAS_DUPLICATE_COMMUNITY_PUBLIC_KEY);

// Strict on create, loose on load, like every other record type
export const CreateNewCommunityListOptionsSchema = z
    .object({
        signer: CreateSignerSchema,
        title: z.string().optional(),
        description: z.string().optional(),
        author: AuthorPubsubSchema.partial().loose().optional(), // runtime fields are stripped before signing
        communities: CreateCommunityListEntrySchema.array(),
        timestamp: PKCTimestampSchema.optional(), // defaults to now
        protocolVersion: ProtocolVersionSchema.optional()
    })
    .strict()
    .refine(communityListHasNoDuplicateEntryPublicKeys, messages.ERR_COMMUNITY_LIST_HAS_DUPLICATE_COMMUNITY_PUBLIC_KEY);

export const CreateCommunityListWithCidOptionsSchema = z.object({ cid: CidStringSchema }).strict();

export const CreateCommunityListOptionsSchema = z.union([CreateCommunityListWithCidOptionsSchema, CreateNewCommunityListOptionsSchema]);

// Runtime-only instance props: looseness must never let a wire record smuggle these in
export const CommunityListReservedFields = ["cid", "shortCid", "state", "updatingState", "publishingState", "clients", "signer", "raw"];

export const CommunityListEntryReservedFields = ["address", "shortAddress"];
