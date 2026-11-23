// The unit suites call the assignment sites directly, which skips the parse and verification every record
// goes through first. This file asks the real gates what they let through, for the one place the unit suites
// found a reachable-looking problem that depends on them: a hostile name inside `author`, merged into
// comment.author with Object.assign(this.author, ...) (see unknown-props-author.comment.test.ts).
//
// Each gate either rejects the record (safe) or returns it. The parsers return the INPUT record once it
// validates, they do not strip, so a key that survives a parser is a key that reaches the merge.
// A gate that returns a record still carrying a prototype-member name inside `author` is the finding.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mockRemotePKC } from "../../../../dist/node/test/test-util.js";
import { signCommentUpdate, verifyCommentUpdate } from "../../../../dist/node/signer/signatures.js";
import signers from "../../../fixtures/signers.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { CommentUpdateType } from "../../../../dist/node/publications/comment/types.js";
import {
    parseCommentIpfsSchemaWithPKCErrorIfItFails,
    parseCommentUpdateSchemaWithPKCErrorIfItFails
} from "../../../../dist/node/schema/schema-util.js";
import validCommentUpdateFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import validCommentFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import { HOSTILE_VALUE } from "../../../helpers/hostile-props.js";

const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty"];
type Bag = Record<string, unknown>;

// The author object as it would sit in a record parsed off the wire (own "__proto__" through JSON.parse)
const authorWith = (base: Bag, name: string): Bag =>
    <Bag>JSON.parse(JSON.stringify({ ...base, [name]: name === "__proto__" ? { polluted: true } : HOSTILE_VALUE }));

// A gate passes when it throws, or when the hostile name is gone from the record it returns
function survives(gate: () => Bag, name: string): boolean {
    try {
        const out = gate();
        const author = <Bag | undefined>out.author;
        return Boolean(author && Object.prototype.hasOwnProperty.call(author, name));
    } catch {
        return false;
    }
}

describe("hostile names inside author, through the parse gates", () => {
    it("CommentUpdate.author: the CommentUpdate parser does not let a prototype-member name through", () => {
        for (const name of NAMES) {
            const record = { ...validCommentUpdateFixture, author: authorWith({}, name) };
            expect.soft(
                survives(() => <Bag>(<unknown>parseCommentUpdateSchemaWithPKCErrorIfItFails(<never>record)), name),
                `[${name}] survives the CommentUpdate parser`
            ).toBe(false);
        }
    });

    it("CommentIpfs.author: the CommentIpfs parser does not let a prototype-member name through", () => {
        for (const name of NAMES) {
            const record = { ...validCommentFixture, author: authorWith(<Bag>validCommentFixture.author, name) };
            expect.soft(
                survives(() => <Bag>(<unknown>parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>record)), name),
                `[${name}] survives the CommentIpfs parser`
            ).toBe(false);
        }
    });

    // Verification checks that the community signed the record, not what is inside author. A community that signs
    // a hostile author object (a challenge cannot, the validator allows only author.community, but a community
    // that hand-signs can) therefore gets it past verification. The community here is a stand-in carrying only
    // the signer-bound public key the check reads.
    describe("verification", () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await mockRemotePKC();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it("a community-signed CommentUpdate with a prototype-member name in author does not verify", async () => {
            const signer = signers[0];
            const community = { address: signer.address, signature: { publicKey: signer.publicKey }, pubsubTopic: signer.address };
            for (const name of NAMES) {
                const update = <CommentUpdateType>(<unknown>{ ...validCommentUpdateFixture, author: authorWith({}, name) });
                update.signature = await signCommentUpdate({ update, signer });
                let valid: boolean;
                try {
                    valid = (
                        await verifyCommentUpdate({
                            update,
                            resolveAuthorNames: false,
                            clientsManager: pkc._clientsManager,
                            community: <never>community,
                            comment: { cid: update.cid, postCid: <string>(<unknown>undefined), depth: 0, signature: validCommentFixture.signature },
                            validatePages: false,
                            validateUpdateSignature: true
                        })
                    ).valid;
                } catch {
                    valid = false;
                }
                expect.soft(valid, `[${name}] a community-signed record with this author verifies`).toBe(false);
            }
        });
    });

    it("control: a benign author extra still passes the CommentIpfs parser", () => {
        const record = { ...validCommentFixture, author: { ...validCommentFixture.author, extraProp: "1234" } };
        const out = <Bag>(<unknown>parseCommentIpfsSchemaWithPKCErrorIfItFails(<never>record));
        expect((<Bag>out.author).extraProp).toBe("1234");
    });
});
