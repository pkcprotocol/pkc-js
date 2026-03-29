import signers from "../../fixtures/signers.js";
import { _signJson, cleanUpBeforePublishing } from "../../../dist/node/signer/signatures.js";
import validCommentIpfsFixture from "../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import Logger from "@pkc/pkc-logger";
import type { SignerType } from "../../../dist/node/signer/types.js";

const log = Logger("plebbit-js:test:community-fields");

export const DUMMY_CID = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
export const DUMMY_COMMENT_CID = "QmeaD98zCjbs3h9GSCMixCGxMSJC3vUgW2i9pZoJpwkN7u";

export async function buildSignedRecord({
    baseRecord,
    signer,
    signedPropertyNames,
    overrides
}: {
    baseRecord: Record<string, unknown>;
    signer: SignerType;
    signedPropertyNames: string[];
    overrides?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
    const record = { ...baseRecord, ...overrides };
    delete record.signature;
    const cleaned = cleanUpBeforePublishing(record);
    const signature = await _signJson(signedPropertyNames, cleaned, signer, log);
    return { ...cleaned, signature };
}

/**
 * Build a CommentIpfs record from the fixture with new-format community fields.
 */
export async function buildNewFormatCommentIpfs(opts: { communityPublicKey: string; communityName?: string; signer: SignerType }) {
    const base = { ...validCommentIpfsFixture } as Record<string, unknown>;
    delete base.subplebbitAddress;

    const newSignedPropertyNames = [
        ...validCommentIpfsFixture.signature.signedPropertyNames.filter((k: string) => k !== "subplebbitAddress"),
        "communityPublicKey",
        ...(opts.communityName ? ["communityName"] : [])
    ];

    return buildSignedRecord({
        baseRecord: base,
        signer: opts.signer,
        signedPropertyNames: newSignedPropertyNames,
        overrides: {
            communityPublicKey: opts.communityPublicKey,
            ...(opts.communityName ? { communityName: opts.communityName } : {}),
            author: { address: opts.signer.address, displayName: "Mock Author" }
        }
    });
}

/**
 * Build an old-format CommentIpfs record with subplebbitAddress.
 */
export async function buildOldFormatCommentIpfs(opts: { subplebbitAddress: string; signer: SignerType }) {
    const base = { ...validCommentIpfsFixture } as Record<string, unknown>;
    return buildSignedRecord({
        baseRecord: base,
        signer: opts.signer,
        signedPropertyNames: [...validCommentIpfsFixture.signature.signedPropertyNames],
        overrides: {
            subplebbitAddress: opts.subplebbitAddress,
            author: { address: opts.signer.address, displayName: "Mock Author" }
        }
    });
}

/**
 * Build a CommentPubsubMessage (no depth/previousCid) with new-format community fields.
 */
export async function buildNewFormatCommentPubsubMessage(opts: { communityPublicKey: string; communityName?: string; signer: SignerType }) {
    const base = { ...validCommentIpfsFixture } as Record<string, unknown>;
    delete base.subplebbitAddress;
    delete base.depth;
    delete base.previousCid;

    const newSignedPropertyNames = [
        ...validCommentIpfsFixture.signature.signedPropertyNames.filter((k: string) => k !== "subplebbitAddress"),
        "communityPublicKey",
        ...(opts.communityName ? ["communityName"] : [])
    ];

    return buildSignedRecord({
        baseRecord: base,
        signer: opts.signer,
        signedPropertyNames: newSignedPropertyNames,
        overrides: {
            communityPublicKey: opts.communityPublicKey,
            ...(opts.communityName ? { communityName: opts.communityName } : {}),
            author: { address: opts.signer.address, displayName: "Mock Author" }
        }
    });
}

/**
 * Build a signed pubsub message for a generic publication type.
 */
export async function buildSignedPubsubMessage(opts: {
    signer: SignerType;
    communityPublicKey?: string;
    communityName?: string;
    subplebbitAddress?: string;
    extraSignedPropertyNames: string[];
    extraFields: Record<string, unknown>;
}) {
    const signedPropertyNames: string[] = [
        "author",
        "timestamp",
        "protocolVersion",
        ...opts.extraSignedPropertyNames,
        ...(opts.communityPublicKey ? ["communityPublicKey"] : []),
        ...(opts.communityName ? ["communityName"] : []),
        ...(opts.subplebbitAddress ? ["subplebbitAddress"] : [])
    ];

    return buildSignedRecord({
        baseRecord: {},
        signer: opts.signer,
        signedPropertyNames,
        overrides: {
            author: { address: opts.signer.address },
            timestamp: Math.floor(Date.now() / 1000),
            protocolVersion: "1.0.0",
            ...opts.extraFields,
            ...(opts.communityPublicKey ? { communityPublicKey: opts.communityPublicKey } : {}),
            ...(opts.communityName ? { communityName: opts.communityName } : {}),
            ...(opts.subplebbitAddress ? { subplebbitAddress: opts.subplebbitAddress } : {})
        }
    });
}

export { signers, validCommentIpfsFixture };
