import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Logger, { createLogger } from "@pkcprotocol/pkc-logger";
import PKC from "../../../dist/node/index.js";
import signers from "../../fixtures/signers.js";
import { getAvailablePKCConfigsToTestAgainst, publishRandomPost } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// pkc.getLogs() reads the instance's root buffer (issue #493). pkc-logger captures a line only when its namespace is
// enabled through `debug`, so the suite enables pkc-js* for its own duration and restores the DEBUG selection the
// worker started with afterwards (vitest injects process.env.DEBUG into the browser build too).
const previousDebugSelection = typeof process !== "undefined" && process.env ? process.env.DEBUG : undefined;
const restoreDebugSelection = () => (previousDebugSelection ? Logger.enable(previousDebugSelection) : Logger.disable());

const communityAddress = signers[0].address;

async function rejectionOf(promise: Promise<unknown>): Promise<PKCError> {
    try {
        await promise;
    } catch (e) {
        return e as PKCError;
    }
    throw Error("expected the promise to reject");
}

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe("pkc.getLogs - " + config.name, () => {
        let pkc: PKCType;

        beforeAll(async () => {
            Logger.enable("pkc-js*");
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
            restoreDebugSelection();
        });

        it("finds a published comment's lines by its cid, and by its signature, with exact key and value matching", async () => {
            const post = await publishRandomPost({ communityAddress, pkc });
            expect(post.cid).to.be.a("string");

            // Under RPC the publish runs on the server; the client's own publish lines (the challenge exchange seen from
            // the client, the verification that assigned the cid) are what this instance's buffer holds.
            const byCid = await pkc.getLogs({ tags: { cid: post.cid } });
            expect(byCid.entries.length).to.be.greaterThan(0);
            for (const entry of byCid.entries) {
                expect(entry.tags.cid).to.equal(post.cid);
                expect(entry.tags.signature).to.equal(post.signature.signature); // both keys stay set for the whole lifetime
                expect(entry.namespace.startsWith("pkc-js:comment")).to.equal(true);
                expect(entry.msg).to.be.a("string");
                expect(entry.seq).to.be.a("number");
                expect(entry.time).to.be.a("number");
            }
            expect(byCid.nextCursor).to.equal(byCid.entries[byCid.entries.length - 1].seq);

            const bySignature = await pkc.getLogs({ tags: { signature: post.signature.signature } });
            expect(bySignature.entries.length).to.be.greaterThanOrEqual(byCid.entries.length); // the lines before the cid was known
            expect(bySignature.entries.every((entry) => entry.tags.signature === post.signature.signature)).to.equal(true);

            // A value under another key does not match: `cid` is not `parentCid`
            const cidUnderWrongKey = await pkc.getLogs({ tags: { parentCid: post.cid } });
            expect(cidUnderWrongKey.entries).to.deep.equal([]);
        });

        it("supports regex, order, limit and cursor on the same buffer", async () => {
            const desc = await pkc.getLogs({ regex: { source: "^pkc-js:comment", flags: "i" }, order: "desc", limit: 2 });
            expect(desc.entries.length).to.equal(2);
            expect(desc.entries[0].seq).to.be.greaterThan(desc.entries[1].seq);
            const next = await pkc.getLogs({
                regex: { source: "^pkc-js:comment", flags: "i" },
                order: "desc",
                limit: 2,
                cursor: desc.nextCursor
            });
            expect(next.entries.every((entry) => entry.seq < desc.entries[1].seq)).to.equal(true);
        });

        it("throws ERR_PKC_NOT_CONNECTED_TO_RPC for an rpcUrl that is not one of pkcRpcClientsOptions, naming the configured urls", async () => {
            const rpcUrl = "ws://127.0.0.1:1/not-configured";
            const error = await rejectionOf(pkc.getLogs({ rpcUrl }));
            expect(error.code).to.equal("ERR_PKC_NOT_CONNECTED_TO_RPC");
            expect(error.details.rpcUrl).to.equal(rpcUrl);
            expect(error.details.pkcRpcClientsOptions).to.deep.equal(pkc.pkcRpcClientsOptions ?? []);
        });

        it("compares rpcUrl as an exact string, without normalization", async () => {
            const configured = pkc.pkcRpcClientsOptions?.[0];
            if (!configured) return; // no RPC client in this config, the exact-match rule has nothing to compare against
            const error = await rejectionOf(pkc.getLogs({ rpcUrl: configured + "/" }));
            expect(error.code).to.equal("ERR_PKC_NOT_CONNECTED_TO_RPC");
        });

        it("throws ERR_INVALID_LOG_QUERY locally for an invalid regex, before anything is scanned", async () => {
            const error = await rejectionOf(pkc.getLogs({ regex: { source: "(" } }));
            expect(error.code).to.equal("ERR_INVALID_LOG_QUERY");
        });

        it("throws ERR_INVALID_LOG_QUERY for an unknown query field or a tag with an empty value", async () => {
            const unknownField = await rejectionOf(pkc.getLogs({ foo: 1 } as never));
            expect(unknownField.code).to.equal("ERR_INVALID_LOG_QUERY");
            const emptyTag = await rejectionOf(pkc.getLogs({ tags: { cid: "" } }));
            expect(emptyTag.code).to.equal("ERR_INVALID_LOG_QUERY");
        });
    });
});

describe("pkcOptions.logger", () => {
    it("rejects instance together with buffer", async () => {
        const error = await rejectionOf(PKC({ httpRoutersOptions: [], logger: { instance: createLogger(), buffer: { maxBytes: 1024 } } }));
        expect(error.code).to.equal("ERR_INVALID_CREATE_PKC_ARGS_SCHEMA");
    });

    it("rejects a logger instance that is not a pkc-logger root", async () => {
        const error = await rejectionOf(PKC({ httpRoutersOptions: [], logger: { instance: {} as never } }));
        expect(error.code).to.equal("ERR_INVALID_CREATE_PKC_ARGS_SCHEMA");
    });
});
