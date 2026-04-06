import { z } from "zod";
import { CID } from "kubo-rpc-client";
import { messages } from "../errors.js";
import * as remeda from "remeda";

// TODO add validation for private key here
export const CreateSignerSchema = z.object({ type: z.enum(["ed25519"]), privateKey: z.string() });

export const SignerWithAddressPublicKeySchema = CreateSignerSchema.extend({
    address: z.string(), // TODO add validation for signer address here
    publicKey: z.string() // TODO add validation for public key here
});

export const SignerWithAddressPublicKeyShortAddressSchema = SignerWithAddressPublicKeySchema.extend({
    shortAddress: z.string().length(12)
});

export const CommunityAddressSchema = z.string().min(1); // TODO add a regex for checking if it's a domain or IPNS address

export const AuthorAddressSchema = z.string().min(1);

export const PKCTimestampSchema = z.number().positive().int(); // Math.round(Date.now() / 1000)

export const ProtocolVersionSchema = z.string().min(1);

export const UserAgentSchema = z.string().min(1); // TODO should use regex to validate

const WalletSchema = z.object({
    address: z.string(),
    timestamp: PKCTimestampSchema,
    signature: z.object({ signature: z.string().min(1), type: z.string().min(1) })
});

const isIpfsCid = (value: string) => {
    try {
        return Boolean(CID.parse(value));
    } catch {
        return false;
    }
};

export const CidStringSchema = z.string().refine((arg) => isIpfsCid(arg), messages.ERR_CID_IS_INVALID); // TODO should change name to CidStringSchema

// '/ipfs/QmeBYYTTmRNmwbcSVw5TpdxsmR26HeNs8P47FYXQZ65NS1' => 'QmeBYYTTmRNmwbcSVw5TpdxsmR26HeNs8P47FYXQZ65NS1'
export const CidPathSchema = z
    .string()
    .transform((arg) => arg.split("/")[2])
    .refine((arg) => isIpfsCid(arg), messages.ERR_CID_IS_INVALID);

const ChainTickerSchema = z.string().min(1); // chain ticker can be anything for now

const AuthorWalletsSchema = z.record(ChainTickerSchema, WalletSchema);

export const AuthorAvatarNftSchema = z.looseObject({
    chainTicker: ChainTickerSchema,
    address: z.string(),
    id: z.string(),
    timestamp: PKCTimestampSchema,
    signature: z.object({ signature: z.string().min(1), type: z.string().min(1) })
});

export const FlairSchema = z.looseObject({
    text: z.string(),
    backgroundColor: z.string().optional(),
    textColor: z.string().optional(),
    expiresAt: PKCTimestampSchema.optional()
});

// When author creates their publication, this is publication.author
export const AuthorPubsubSchema = z
    .object({
        name: z.string().min(1).optional(),
        previousCommentCid: CidStringSchema.optional(),
        displayName: z.string().optional(),
        wallets: AuthorWalletsSchema.optional(),
        avatar: AuthorAvatarNftSchema.optional(),
        flairs: FlairSchema.array().optional()
    })
    .strict();

export const ChallengeAnswerStringSchema = z.string(); // TODO add validation for challenge answer

export const ChallengeAnswersSchema = ChallengeAnswerStringSchema.array().nonempty(); // for example ["1+1=2", "3+3=6"]
export const CreatePublicationUserOptionsSchema = z.object({
    signer: CreateSignerSchema,
    author: AuthorPubsubSchema.partial().loose().optional(),
    communityAddress: CommunityAddressSchema,
    communityPublicKey: z.string().min(1).optional(), // IPNS key of the community; optional in schema for backward compat with old CommentIpfs, but communities mandate it on new incoming publications
    communityName: z.string().min(1).optional(), // domain name of the community, if any
    protocolVersion: ProtocolVersionSchema.optional(),
    timestamp: PKCTimestampSchema.optional(),
    // pubsubMessage field will contain fields to be added to request.encrypted
    challengeRequest: z
        .object({
            challengeAnswers: ChallengeAnswersSchema.optional(),
            challengeCommentCids: CidStringSchema.array().optional()
        })
        .optional()
});

export const JsonSignatureSchema = z.object({
    type: z.string().min(1),
    signature: z.string(), // No need to validate here, it will be validated in verify signature function
    publicKey: z.string(),
    signedPropertyNames: z.string().array()
});

// Common stuff here
export const PublicationBaseBeforeSigning = z.object({
    signer: SignerWithAddressPublicKeySchema,
    timestamp: PKCTimestampSchema,
    author: AuthorPubsubSchema.optional(),
    protocolVersion: ProtocolVersionSchema
});

// We need testing if `challengerequest` in LocalCommunity emits the actual publication values including `author.subplebbit` values without anonymization

// `author.subplebbit.lastCommentCid` should be set to comment.timestamp always if `anonMode=per-reply`
// `author.subplebbit.lastCommentCid` should be the last comment the anon author made inside the post if `anonMode=per-post`
// `author.subplebbit.lastCommentCid` should operate regularly for `anonMode=per-author`, that is to say it will be equal to the last comment cid the author made in the subplebbit

// `author.subplebbit.banExpiresAt` should be effective in rejecting publication regardless of anon mode (needs to be tested), but in terms of calculating the field value:
// - `anonMode=per-reply` = it should show `author.subplebbit.banExpiresAt` only if the author got banned on that specific comment, but it should not show on their other comments
// - `anonMode=per-post` = it should show `author.subplebbit.banExpiresAt` only on the author's replies and post inside their post
// - `anonMode=per-author` = it should should `author.subplebbit.banExpiresAt` on all  the author's comments in the sub

// anonMode=per-reply, `author.subplebbit.postScore` should be 0
// anonMode=per-post, `author.subplebbit.postScore` should be total post karma (upvotes - downvotes) of the post if it's published by author
// anonMode=per-author, `author.subplebbit.postScore` it should use the value of total post karma in the subplebbit.

// anonMode=per-reply, `author.subplebbit.replyScore` should be karma of that single reply if it's published by author
// anonMode=per-post, `author.subplebbit.replyScore` should be total replies karma (upvotes - downvotes) of inside the post
// anonMode=per-author, `author.subplebbit.replyScore` it should use the value of total reply karma in the subplebbit.

// anonMode=per-reply, `author.subplebbit.firstCommentTimestamp` should be timestamp of the comment itself
// anonMode=per-post, `author.subplebbit.firstCommentTimestamp` should be first timestamp of the author's comment inside the post
// anonMode=per-author, `author.subplebbit.firstCommentTimestamp` should use the value of timestamp of the first comment by the author in the subplebbit.

// values below are added by the sub, not the author
export const CommunityAuthorSchema = z.looseObject({
    postScore: z.number(), // total post karma in the subplebbit
    replyScore: z.number(), // total reply karma in the subplebbit
    banExpiresAt: PKCTimestampSchema.optional(), // timestamp in second, if defined the author was banned for this comment
    flairs: FlairSchema.array().optional(), // not part of the signature, mod can edit it after comment is published
    firstCommentTimestamp: PKCTimestampSchema, // timestamp of the first comment by the author in the subplebbit, used for account age based challenges
    lastCommentCid: CidStringSchema // last comment by the author in the subplebbit, can be used with author.previousCommentCid to get a recent author comment history in all subplebbits
});
export const CommentAuthorSchema = CommunityAuthorSchema.pick({ banExpiresAt: true, flairs: true });

export const AuthorWithOptionalCommentUpdateSchema = AuthorPubsubSchema.extend({
    subplebbit: CommunityAuthorSchema.optional() // (added by CommentUpdate) up to date author properties specific to the subplebbit it's in
});

export const AuthorReservedFields = remeda.difference(
    [...remeda.keys.strict(AuthorWithOptionalCommentUpdateSchema.shape), "address", "publicKey", "shortAddress", "nameResolved"],
    remeda.keys.strict(AuthorPubsubSchema.shape)
);

// Old CommentIpfs records had author.address — exclude it from the CommentIpfs verification check
export const AuthorCommentIpfsReservedFields = remeda.difference(AuthorReservedFields, ["address"]);
