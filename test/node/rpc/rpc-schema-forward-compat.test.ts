import { describe, it, expect } from "vitest";
import {
    parseRpcResolveAuthorNameResult,
    parseRpcFetchCidResult,
    parseRpcSuccessResult,
    parseRpcSubscriptionIdResult,
    parseRpcCidParam,
    parseRpcCommunityIdentifierParam,
    parseRpcAuthorNameParam,
    parseRpcEditCommunityParam,
    parseRpcPublishChallengeAnswersParam,
    parseRpcUnsubscribeParam,
    parseRpcCommunityPageParam,
    parseRpcCommentRepliesPageParam,
    parseRpcFetchCidParam
} from "../../../dist/node/clients/rpc-client/rpc-schema-util.js";

// Forward-compatibility tests: ensure both RPC client result parsers and server param parsers
// tolerate unknown fields. This prevents breakage when a newer server/client sends extra fields.

describe("RPC schema forward compatibility — result parsers (client side)", () => {
    it("parseRpcSuccessResult tolerates unknown fields", () => {
        const result = parseRpcSuccessResult({ success: true, futureField: "ignored" });
        expect(result.success).to.equal(true);
    });

    it("parseRpcSubscriptionIdResult tolerates unknown fields", () => {
        const result = parseRpcSubscriptionIdResult({ subscriptionId: 42, futureField: "ignored" });
        expect(result.subscriptionId).to.equal(42);
    });

    it("parseRpcResolveAuthorNameResult tolerates unknown fields", () => {
        const result = parseRpcResolveAuthorNameResult({ resolvedAuthorName: "12D3Koo...", futureField: "ignored" });
        expect(result.resolvedAuthorName).to.equal("12D3Koo...");
    });

    it("parseRpcResolveAuthorNameResult tolerates null resolvedAuthorName with unknown fields", () => {
        const result = parseRpcResolveAuthorNameResult({ resolvedAuthorName: null, futureField: "ignored" });
        expect(result.resolvedAuthorName).to.be.null;
    });

    it("parseRpcFetchCidResult tolerates unknown fields", () => {
        const result = parseRpcFetchCidResult({ content: "some-content", futureField: "ignored" });
        expect(result.content).to.equal("some-content");
    });
});

describe("RPC schema forward compatibility — param parsers (server side)", () => {
    it("parseRpcCidParam tolerates unknown fields", () => {
        const result = parseRpcCidParam({ cid: "QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm", futureField: 42 });
        expect(result.cid).to.equal("QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm");
    });

    it("parseRpcCommunityIdentifierParam tolerates unknown fields", () => {
        const result = parseRpcCommunityIdentifierParam({
            publicKey: "12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu",
            futureField: 42
        });
        expect(result.publicKey).to.equal("12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu");
    });

    it("parseRpcAuthorNameParam tolerates unknown fields", () => {
        const result = parseRpcAuthorNameParam({ name: "plebbit.bso", futureField: 42 });
        expect(result.name).to.equal("plebbit.bso");
    });

    it("parseRpcEditCommunityParam tolerates unknown fields", () => {
        const result = parseRpcEditCommunityParam({
            publicKey: "12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu",
            editOptions: { title: "test" },
            futureField: 42
        });
        expect(result.publicKey).to.equal("12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu");
    });

    it("parseRpcPublishChallengeAnswersParam tolerates unknown fields", () => {
        const result = parseRpcPublishChallengeAnswersParam({
            subscriptionId: 1,
            challengeAnswers: ["answer1"],
            futureField: 42
        });
        expect(result.subscriptionId).to.equal(1);
        expect(result.challengeAnswers).to.deep.equal(["answer1"]);
    });

    it("parseRpcUnsubscribeParam tolerates unknown fields", () => {
        const result = parseRpcUnsubscribeParam({ subscriptionId: 1, futureField: 42 });
        expect(result.subscriptionId).to.equal(1);
    });

    it("parseRpcCommunityPageParam tolerates unknown fields", () => {
        const result = parseRpcCommunityPageParam({
            cid: "QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm",
            type: "posts",
            pageMaxSize: 50,
            futureField: 42
        });
        expect(result.cid).to.equal("QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm");
    });

    it("parseRpcCommentRepliesPageParam tolerates unknown fields", () => {
        const result = parseRpcCommentRepliesPageParam({
            cid: "QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm",
            commentCid: "QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm",
            pageMaxSize: 50,
            futureField: 42
        });
        expect(result.cid).to.equal("QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm");
    });

    it("parseRpcFetchCidParam tolerates unknown fields", () => {
        const result = parseRpcFetchCidParam({ cid: "QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm", futureField: 42 });
        expect(result.cid).to.equal("QmYHNYAaYK5hm3ZhZFx5W9H6xydKDGimjdgJMrMSdnctEm");
    });
});
