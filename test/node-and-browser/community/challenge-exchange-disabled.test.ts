// Test foundations for settings.disablePubsubChallengeExchange (issue #229,
// docs/protocol/author-communities.md read-only mode section).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
//
// Node-side behavior lives in test/node/community/local-community/disable-pubsub-challenge-exchange.test.ts.
// This file covers the CLIENT side, which is why it runs in the browser too: a reader that loads a
// record without pubsubTopic must fail fast instead of timing out, so a UI can disable the reply
// affordance up front. Kind-blind: applies to normal communities and author-communities alike.
import { describe, it } from "vitest";

describe("reading a record with no pubsubTopic", () => {
    it.todo("parses the record fine (pubsubTopic is optional)");
    it.todo("treats absence of pubsubTopic as challenge exchange disabled, not as an address fallback");
    it.todo("exposes the disabled state on the loaded instance so a client can branch before publishing");
});

describe("publishing to a community with the exchange disabled", () => {
    it.todo("publish() fails fast with ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED");
    it.todo("the error surfaces before any pubsub subscription is attempted");
    it.todo("the publisher never falls back to the community address as a challenge-exchange topic");
    it.todo("the same fast-fail applies to Vote, CommentEdit, CommentModeration, and CommunityEdit");
    it.todo("the error is non-retriable (distinct from an unreachable-community timeout)");
});

describe("a read-only author-community (feed-only profile)", () => {
    it.todo("loads and renders its feed with no pubsubTopic, challenges, or encryption present");
    it.todo("a reply attempt fails fast rather than timing out");
    it.todo("cross-posts still flow into the feed (they never involve the challenge topic)");
    it.todo("toggling the exchange back on makes the trio reappear on the next mint");
});
