// verifyCommunityList unit tests (docs/protocol/community-lists.md): reserved fields, unsigned
// signable fields, duplicate entry publicKeys, and signature validity.
// Clients of RPC trust the RPC server's response and don't validate locally, and these tests call
// the verify function directly on a locally-constructed clients manager, so they can't run under RPC
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { clone } from "remeda";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { mockRemotePKC } from "../../../dist/node/test/test-util.js";
import { verifyCommunityList } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { CommunityListIpfsType } from "../../../dist/node/community-list/types.js";
import { buildSignedCommunityListRecord, mockCommunityListEntries } from "./communitylist-test-util.js";

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

    it("rejects a record with duplicate entry publicKeys", async () => {
        const withDup = clone(validRecord);
        withDup.communities = [withDup.communities[0], clone(withDup.communities[0])];
        expect(await verifyCommunityList({ communityList: withDup })).to.deep.equal({
            valid: false,
            reason: messages.ERR_COMMUNITY_LIST_HAS_DUPLICATE_COMMUNITY_PUBLIC_KEY
        });
    });
});
