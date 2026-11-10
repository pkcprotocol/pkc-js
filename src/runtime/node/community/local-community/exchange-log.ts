import type { Logger } from "@pkcprotocol/pkc-logger";
import type { LocalCommunity } from "../local-community.js";

// The child a server-side challenge exchange logs through (issue #493). handleChallengeRequest creates it once the
// publication is decrypted, tagged { signature } under the community's { publicKey }, and files it under the
// challengeRequestId with the same ttl as the other exchange caches, so the answer and verification handlers (separate
// pubsub callbacks) and the challenge's getChallenge() log through the same tags. Before the request is decrypted, or
// once the entry expired, the community's own logger is used.
export function challengeExchangeLog(
    community: Pick<LocalCommunity, "_log" | "_challengeExchangeLogs">,
    challengeRequestId: { toString(): string }
): Logger {
    return community._challengeExchangeLogs?.get(challengeRequestId.toString()) ?? community._log;
}
