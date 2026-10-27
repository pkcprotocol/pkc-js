// verifyCommunityList unit tests (docs/protocol/community-lists.md): reserved fields, unsigned
// signable fields, duplicate entry publicKeys, and signature validity.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { clone, omit } from "remeda";
import Logger from "@pkcprotocol/pkc-logger";
import signers from "../../fixtures/signers.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { mockRemotePKC } from "../../../dist/node/test/test-util.js";
import { _signJson, verifyCommunityList } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { CommunityListIpfsType } from "../../../dist/node/community-list/types.js";
import { buildSignedCommunityListRecord, mockCommunityListEntries } from "./communitylist-test-util.js";

const log = Logger("pkc-js:test:community-list:signatures");

// These tests call verifyCommunityList directly against a locally-constructed PKC instance, with no
// RPC round-trip to exercise, so running them under the RPC config would only repeat the same calls
describeSkipIfRpc("verifyCommunityList", () => {
    let pkc: PKC;
    let validRecord: CommunityListIpfsType;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        validRecord = (await buildSignedCommunityListRecord({ pkc, author: { displayName: "Curator" } })).record;
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("a freshly signed record is valid, both as an object and after a JSON round-trip", async () => {
        expect(await verifyCommunityList({ communityList: validRecord })).to.deep.equal({ valid: true });
        const roundTripped = <CommunityListIpfsType>JSON.parse(JSON.stringify(validRecord));
        expect(await verifyCommunityList({ communityList: roundTripped })).to.deep.equal({ valid: true });
    });

    it("signedPropertyNames cover every wire field except the signature", () => {
        expect([...validRecord.signature.signedPropertyNames].sort()).to.deep.equal(
            ["title", "description", "author", "communities", "timestamp", "protocolVersion"].sort()
        );
    });

    it("rejects a record whose signature bytes are tampered", async () => {
        const tampered = clone(validRecord);
        tampered.signature.signature = tampered.signature.signature.slice(0, -4) + "AAAA";
        expect(await verifyCommunityList({ communityList: tampered })).to.deep.equal({
            valid: false,
            reason: messages.ERR_SIGNATURE_IS_INVALID
        });
    });

    it("rejects a record where a signed field was modified after signing", async () => {
        const tampered = clone(validRecord);
        tampered.title = "modified after signing";
        expect(await verifyCommunityList({ communityList: tampered })).to.deep.equal({
            valid: false,
            reason: messages.ERR_SIGNATURE_IS_INVALID
        });
    });

    it("rejects a record that includes a signable field not in signedPropertyNames (issue #249)", async () => {
        // sign a record without description, then attach one post-signing
        const { record } = await buildSignedCommunityListRecord({ pkc });
        const withUnsigned = <CommunityListIpfsType>{ ...clone(record), description: undefined };
        delete (<Record<string, unknown>>withUnsigned).description;
        withUnsigned.signature = {
            ...withUnsigned.signature,
            signedPropertyNames: withUnsigned.signature.signedPropertyNames.filter((name) => name !== "description")
        };
        // signature is now invalid anyway, but the signable-field check must fire first with its own reason
        (<Record<string, unknown>>withUnsigned).description = "attached after signing";
        const res = await verifyCommunityList({ communityList: withUnsigned });
        expect(res).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_RECORD_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
        });
    });

    it("rejects a record carrying an unknown top-level field that is not in signedPropertyNames", async () => {
        // anyone can attach a field to a curator's signed list and re-add it under a new CID; a list has
        // no second producer allowed to add unsigned fields (unlike a community on CommentIpfs)
        const withUnsignedExtra = <CommunityListIpfsType>{ ...clone(validRecord), links: ["https://attacker.example"] };
        expect(await verifyCommunityList({ communityList: withUnsignedExtra })).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_RECORD_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
        });
    });

    it("accepts a record from a newer publisher that signs an unknown top-level field", async () => {
        const signer = await pkc.createSigner();
        const { record } = await buildSignedCommunityListRecord({ pkc, signer });
        const props = { ...omit(record, ["signature"]), links: ["https://example.com"] };
        const signature = await _signJson([...record.signature.signedPropertyNames, "links"], props, signer, log);
        const fromNewerPublisher = <CommunityListIpfsType>{ ...props, signature };
        expect(await verifyCommunityList({ communityList: fromNewerPublisher })).to.deep.equal({ valid: true });
    });

    it("rejects a record with a reserved runtime field", async () => {
        const withReserved = <CommunityListIpfsType>{ ...clone(validRecord), cid: "QmYbcXBSAWNqNRVsdmx3PFTHk3JfSXJfWQprvWkpRTqoHe" };
        expect(await verifyCommunityList({ communityList: withReserved })).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_RECORD_INCLUDES_RESERVED_FIELD
        });
    });

    it("rejects a record whose author carries a reserved runtime field (e.g. nameResolved)", async () => {
        const withReservedAuthor = clone(validRecord);
        (<Record<string, unknown>>withReservedAuthor.author).nameResolved = true;
        expect(await verifyCommunityList({ communityList: withReservedAuthor })).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_AUTHOR_INCLUDES_RESERVED_FIELD
        });
    });

    it("rejects a record whose entry carries a reserved runtime field (e.g. address)", async () => {
        const withReservedEntry = clone(validRecord);
        (<Record<string, unknown>>withReservedEntry.communities[0]).address = mockCommunityListEntries[0].publicKey;
        expect(await verifyCommunityList({ communityList: withReservedEntry })).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_ENTRY_INCLUDES_RESERVED_FIELD
        });
    });

    it("rejects a validly signed record whose author.name is not a domain (it would become author.address)", async () => {
        // A list has no community vetting it, so verification is the only gate: a non-domain name
        // would let the signer display another key's address as the list author
        const { record } = await buildSignedCommunityListRecord({
            pkc,
            author: { name: signers[1].address },
            skipAuthorValidation: true
        });
        expect(await verifyCommunityList({ communityList: record })).to.deep.equal({
            valid: false,
            reason: messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN
        });
    });

    it("rejects a record with duplicate entry publicKeys", async () => {
        const withDup = clone(validRecord);
        withDup.communities = [withDup.communities[0], clone(withDup.communities[0])];
        expect(await verifyCommunityList({ communityList: withDup })).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_HAS_DUPLICATE_COMMUNITY_PUBLIC_KEY
        });
    });
});
