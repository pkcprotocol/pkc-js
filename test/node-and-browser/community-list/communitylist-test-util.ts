// Shared helpers for CommunityList tests (docs/protocol/community-lists.md). Not a test file.
import signers from "../../fixtures/signers.js";
import { createSigner, type SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";
import Logger from "@pkcprotocol/pkc-logger";
import { _signJson, cleanUpBeforePublishing, signCommunityList } from "../../../dist/node/signer/signatures.js";
import { CommunityListSignedPropertyNames } from "../../../dist/node/community-list/schema.js";
import { timestamp } from "../../../dist/node/util.js";
import env from "../../../dist/node/version.js";
import { addStringToIpfs } from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { CommunityListEntryType, CommunityListIpfsType } from "../../../dist/node/community-list/types.js";
import type { AuthorPubsubType } from "../../../dist/node/types.js";
import type { JsonSignature } from "../../../dist/node/signer/types.js";

const log = Logger("pkc-js:test:community-list");

export const mockCommunityListEntries: CommunityListEntryType[] = [
    { publicKey: signers[0].address, title: "Test community 0", tags: ["test", "mock"], languages: ["en"] },
    { publicKey: signers[1].address, name: "memes.bso", description: "Second test community" }
];

export async function buildSignedCommunityListRecord({
    pkc,
    signer,
    author,
    communities,
    title,
    description,
    skipAuthorValidation
}: {
    pkc: PKC;
    signer?: SignerWithPublicKeyAddress;
    author?: AuthorPubsubType;
    communities?: CommunityListEntryType[];
    title?: string;
    description?: string;
    // Sign with _signJson directly, bypassing signCommunityList's sign-time author.name check, to
    // build the records an attacker could publish without going through pkc-js
    skipAuthorValidation?: boolean;
}): Promise<{ record: CommunityListIpfsType; signer: SignerWithPublicKeyAddress }> {
    const finalSigner = signer ?? (await createSigner());
    const props = cleanUpBeforePublishing({
        title: title ?? "Mock community list",
        description: description ?? "A mock list of communities used in tests",
        author,
        communities: communities ?? mockCommunityListEntries,
        timestamp: timestamp(),
        protocolVersion: env.PROTOCOL_VERSION
    });
    const signature = skipAuthorValidation
        ? await _signJson(<JsonSignature["signedPropertyNames"]>CommunityListSignedPropertyNames, props, finalSigner, log)
        : await signCommunityList({ communityList: props, signer: finalSigner, pkc });
    return { record: <CommunityListIpfsType>{ ...props, signature }, signer: finalSigner };
}

export async function addCommunityListRecordToIpfs(record: CommunityListIpfsType | Record<string, unknown>): Promise<string> {
    return addStringToIpfs(JSON.stringify(record));
}
