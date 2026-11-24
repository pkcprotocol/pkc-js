// Finding 7: the pubsub subscription's onError callback re-subscribes. When the provider (kubo) has gone away, the
// re-subscribe rejects inside that callback, which the pubsub client does not await; the guard reports it as an error. The fake provider below accepts
// one pubsub subscription, kills its connection, and then stops listening, which is what a killed kubo looks like.
import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import PKC from "../../../dist/node/index.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";

async function runWhenTheProviderDiesMidSubscription(withListener: boolean) {
    const sockets = new Set<import("node:net").Socket>();
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" });
        res.flushHeaders();
        // the provider dies right after it acknowledged the subscription
        setTimeout(() => {
            server.close();
            for (const socket of sockets) socket.destroy();
        }, 200);
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const url = `http://127.0.0.1:${(<AddressInfo>server.address()).port}/api/v0`;
    const pkc = await PKC({ dataPath: undefined, httpRoutersOptions: [], pubsubKuboRpcClientsOptions: [url] });
    if (withListener) pkc.on("error", () => {});
    const capture = captureProcessFatalErrors();
    const handler = () => {};
    // the re-subscribe that handlePubsubError issues goes through this method, so its outcome ties the fatal error to it
    const original = pkc._clientsManager.pubsubSubscribeOnProvider.bind(pkc._clientsManager);
    const outcomes: string[] = [];
    pkc._clientsManager.pubsubSubscribeOnProvider = async (...args: Parameters<typeof original>) => {
        const call = outcomes.length + 1;
        try {
            const res = await original(...args);
            outcomes.push(`call ${call} resolved`);
            return res;
        } catch (e) {
            outcomes.push(`call ${call} rejected: ${(e as Error).message}`);
            throw e;
        }
    };
    await pkc._clientsManager
        .pubsubSubscribeOnProvider("some-topic", handler, url)
        .catch((e: unknown) => console.log("initial subscribe rejected", (e as Error).message));
    await letDetachedWorkSettle(4000);
    capture.stop();
    await Promise.race([pkc.destroy().catch(() => {}), letDetachedWorkSettle(5000)]);
    return { resubscribeOutcomes: outcomes, fatals: capture.fatals };
}

describe("a pubsub provider that dies while we are subscribed", () => {
    it("raises no process-fatal error, and delivers the failed re-subscribe as an error, when something listens", async () => {
        const { resubscribeOutcomes, fatals } = await runWhenTheProviderDiesMidSubscription(true);
        // call 1 is the subscription, call 2 the re-subscribe that handlePubsubError issues once the provider is gone
        expect(resubscribeOutcomes).toEqual(["call 1 resolved", "call 2 rejected: fetch failed"]);
        expect(fatals).toEqual([]);
    });

    it("reports the failed re-subscribe as a PKCError, which stops the process only when nothing listens (documented)", async () => {
        const { fatals } = await runWhenTheProviderDiesMidSubscription(false);
        expect(fatals.map((f) => f.code)).toContain("ERR_FAILED_TO_RESUBSCRIBE_TO_PUBSUB_TOPIC_AFTER_ERROR");
    });
});
