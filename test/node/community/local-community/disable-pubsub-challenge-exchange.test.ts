// Test foundations for settings.disablePubsubChallengeExchange (issue #229,
// docs/protocol/author-communities.md read-only mode section).
// Design-only scaffolding: every case is it.todo until the feature is implemented.
// Kind-blind LocalCommunity feature; author-communities (issue #31) inherit it for feed-only profiles.
//
// Client-side behavior lives in test/node-and-browser/community/challenge-exchange-disabled.test.ts.
import { describe, it } from "vitest";

describe("settings.disablePubsubChallengeExchange = true", () => {
    it.todo("publishes a record that omits pubsubTopic");
    it.todo("does not subscribe to the challenge/publication pubsub topic");
    it.todo("stays subscribed to the IPNS-over-pubsub record topic (replication unaffected)");
    it.todo("preserves a custom settings pubsubTopic string across a disable/enable cycle");
    it.todo("never publishes the setting itself (settings stay private, stripped from the record)");
});

describe("settings.disablePubsubChallengeExchange unset or false", () => {
    it.todo("backfills pubsubTopic to the signer address at init (current behavior unchanged)");
    it.todo("publishes the record with an explicit pubsubTopic");
});

describe("no fallback to address as pubsub topic", () => {
    it.todo("publish() against a loaded community without pubsubTopic fails fast with ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED");
    it.todo("the publisher never attempts the community address as a challenge-exchange topic");
    it.todo("the fast-fail error surfaces before any pubsub subscription is attempted");
    it.todo("stopping a disabled community does not throw on the challenge-topic unsubscribe (lifecycle.ts)");
});

// The owner must keep publishing to their own community even with the network path removed.
// publish() takes the local shortcut when the community is in pkc._startedCommunities, and the RPC
// server executes publish() in the process where the community runs, so both hit the same shortcut.
describe("owner publishing while the exchange is disabled", () => {
    it.todo("same-process publish succeeds via the local shortcut (_publishWithLocalCommunity)");
    it.todo("publish through the RPC server succeeds (server-side local shortcut)");
    it.todo("the local shortcut still evaluates configured challenges (network path removed, pipeline kept)");
    it.todo("_validateCommunityFields does not require a pubsubTopic when publishing to a started community");
    it.todo("the challenge and challengeverification the local community emits still verify with no pubsubTopic present");
    it.todo("a Vote, CommentEdit and CommentModeration all publish locally with the exchange disabled");
    it.todo("a remote publisher still fails fast while the owner's local publish succeeds against the same community");
});

describe("toggling at runtime", () => {
    it.todo("enabling the setting unsubscribes from the challenge topic on the next sync-loop iteration without restart");
    it.todo("disabling the setting resubscribes and republishes the record with pubsubTopic present");
    it.todo("the setting round-trips through the settings JSON column after a restart");
});
