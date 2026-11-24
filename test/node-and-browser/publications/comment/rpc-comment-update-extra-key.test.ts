// Issue #572: a CommentUpdate can carry keys CommentUpdateSchema does not know (a challenge's `commentUpdate` extras), signed
// by the community. Every reader parses the record loosely, the RPC comment-update event included: a strict parse here
// would make an RPC client throw ERR_INVALID_RPC_COMMENT_UPDATE_SCHEMA on a record the community published correctly.

import { describe, it, expect } from "vitest";
import { clone } from "remeda";
import { parseRpcCommentUpdateEventWithPKCErrorIfItFails } from "../../../../dist/node/schema/schema-util.js";
import validCommentUpdateFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };

describe("RPC comment update event with a key CommentUpdateSchema does not know (issue #572)", () => {
    it("parses a signed CommentUpdate that carries an extra key", () => {
        const commentUpdate = { ...clone(validCommentUpdateFixture), myExtraKey: { chainId: 1 } };
        const parsed = parseRpcCommentUpdateEventWithPKCErrorIfItFails({ commentUpdate } as never);
        expect((parsed.commentUpdate as Record<string, unknown>).myExtraKey).to.deep.equal({ chainId: 1 });
    });

    it("still rejects a CommentUpdate that is missing a required key", () => {
        const commentUpdate = clone(validCommentUpdateFixture) as Record<string, unknown>;
        delete commentUpdate.upvoteCount;
        expect(() => parseRpcCommentUpdateEventWithPKCErrorIfItFails({ commentUpdate } as never)).to.throw();
    });
});
