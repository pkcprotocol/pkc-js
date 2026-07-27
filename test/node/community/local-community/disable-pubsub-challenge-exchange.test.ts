// Test foundations for settings.disablePubsubChallengeExchange (issue #229,
// docs/protocol/author-communities.md read-only mode section).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Kind-blind LocalCommunity feature; author-communities (issue #31) inherit it for feed-only profiles.
import { describe, it } from "vitest";

describe("settings.disablePubsubChallengeExchange = true", () => {
    it.todo("publishes a record that omits pubsubTopic");
    it.todo("does not subscribe to the challenge/publication pubsub topic");
    it.todo("stays subscribed to the IPNS-over-pubsub record topic (replication unaffected)");
    it.todo("preserves a custom settings pubsubTopic string across a disable/enable cycle");
});

describe("settings.disablePubsubChallengeExchange unset or false", () => {
    it.todo("backfills pubsubTopic to the signer address at init (current behavior unchanged)");
    it.todo("publishes the record with an explicit pubsubTopic");
});

describe("no fallback to address as pubsub topic", () => {
    it.todo("publish() against a loaded community without pubsubTopic fails fast with ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED");
    it.todo("the publisher never attempts the community address as a challenge-exchange topic");
    it.todo("the fast-fail error surfaces before any pubsub subscription is attempted");
});

describe("owner publishing while the exchange is disabled", () => {
    it.todo("same-process publish succeeds via the local shortcut (_publishWithLocalCommunity)");
    it.todo("publish through the RPC server succeeds (server-side local shortcut)");
    it.todo("the local shortcut still evaluates configured challenges (network path removed, pipeline kept)");
});

describe("toggling at runtime", () => {
    it.todo("enabling the setting unsubscribes from the challenge topic on the next sync-loop iteration without restart");
    it.todo("disabling the setting resubscribes and republishes the record with pubsubTopic present");
});
