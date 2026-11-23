// The RPC client reads a comment the same way a direct client does: the RPC server relays the records and the
// client runs _initIpfsProps and _initCommentUpdate on them (the server also sends runtimeFields, which are
// built from fixed fields and never from record keys). This is the one end-to-end check that a poisoned
// record, hosted inside the RPC server and read by an RPC client, reaches those sinks.
//
// The RPC server is hosted by this test, in-process, on a port the OS picks (helpers/rpc-server-harness.ts),
// so it always runs this checkout's build and a crash caused by a poisoned record lands in this worker with
// a stack trace instead of taking down the shared test server. It still needs the test server for kubo and
// the mock pubsub, but not its RPC server. The community is created through an RPC client, so it lives in
// this server. The challenge-supplied CommentUpdate extras are not repeated here: that needs an in-process
// challenge factory, and the sink is the same one the other file covers.
//
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import PKC from "../../../dist/node/index.js";
import { mockRpcServerPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { createInProcessRpcServer, uniqueTmpDataPath } from "../../helpers/rpc-server-harness.js";
import type { PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { publishPoisonedComment } from "../../helpers/poisoned-publish.js";
import { HOSTILE_VALUE, captureProcessFatalErrors, objectPrototypeIsClean, stopOutcome } from "../../helpers/hostile-props.js";
import type { PublishedComment } from "../../helpers/poisoned-publish.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

type Bag = Record<string, unknown>;
const asBag = (x: object): Bag => <Bag>(<unknown>x);
const BENIGN = "extraProp";
// A community refuses every name but BENIGN (see unknown-props-e2e.comment.test.ts); the colliding names are still
// published, to prove the refusal holds when the community lives in an RPC server and the publisher is an RPC client.
// The RPC reader paths below therefore load the benign comment; the reader-side handling of a record that got past
// an older community is covered by the unit suites.
const NAMES = [BENIGN, "update", "stop", "_clientsManager", "_wasPublishCalled", "constructor", "toString"];

describe("unknown props that collide with an instance member, over RPC", () => {
    let serverPKC: PKCType;
    let rpcServer: PKCWsServerType;
    let author: PKCType;
    let reader: PKCType;
    let community: Awaited<ReturnType<typeof createSubWithNoChallenge>>;
    const published: PublishedComment[] = [];
    const fatal = captureProcessFatalErrors();
    let fatalAfterPublishing = 0; // errors raised by the publishes, kept apart from what readers cause

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("unknown-props-rpc") });
        serverPKC.on("error", () => {});
        let rpcUrl: string;
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "unknown-props-rpc" }));
        const rpcClient = async () => {
            const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            client.on("error", () => {});
            return client;
        };
        author = await rpcClient();
        reader = await rpcClient();
        community = await createSubWithNoChallenge({}, author);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        for (const name of NAMES) published.push(await publishPoisonedComment({ pkc: author, communityAddress: community.address, name }));
        // let any teardown rejection from the last publish land before the reader phase starts
        await new Promise((resolve) => setTimeout(resolve, 3000));
        fatalAfterPublishing = fatal.errors.length;
    }, 600_000);

    afterAll(async () => {
        fatal.stop();
        await community?.delete();
        await reader?.destroy();
        await author?.destroy();
        await rpcServer?.destroy(); // destroys serverPKC too
    });

    it("the RPC-hosted community refuses every colliding name and accepts the benign one", () => {
        for (const p of published) expect.soft(p.accepted, `[${p.name}] accepted (reason: ${p.reason})`).toBe(p.name === BENIGN);
    });

    it("the poisoned publishes raise nothing that would terminate the RPC server's process", () => {
        // the server runs in this process, so what ends it here is what ended the shared test server in the first run
        expect(fatal.errors.slice(0, fatalAfterPublishing).join(" | ")).toBe("");
    });

    it("an RPC reader that loads the post by cid keeps a working instance", async () => {
        expect(
            published.filter((x) => x.accepted && x.cid).map((x) => x.name),
            "the comments the reader loads"
        ).toEqual([BENIGN]);
        for (const p of published) {
            if (!p.accepted || !p.cid) continue;
            const readerComment = <Comment>await reader.createComment({ cid: p.cid });
            try {
                await readerComment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: readerComment,
                    predicate: async () => typeof readerComment.updatedAt === "number"
                });
            } catch (e) {
                expect.soft((<Error>e).message, `[${p.name}] reader failed to load the comment`).toBe("loaded");
            }
            expect.soft(typeof readerComment.update, `[${p.name}] update must stay a function`).toBe("function");
            expect.soft(typeof readerComment.stop, `[${p.name}] stop must stay a function`).toBe("function");
            expect.soft(await stopOutcome(readerComment), `[${p.name}] stop() must not throw`).toBeUndefined();
            if (p.name === BENIGN) expect.soft(asBag(readerComment)[BENIGN], "the benign extra prop is still readable").toBe(HOSTILE_VALUE);
            expect.soft(objectPrototypeIsClean(), `[${p.name}] Object.prototype polluted`).toBe(true);
        }
    }, 600_000);

    it("an RPC reader that builds the post from a page entry keeps a working instance", async () => {
        const remoteCommunity = await reader.createCommunity({ address: community.address });
        await remoteCommunity.update();
        const filledFromPages = async (cid: string) => Boolean((<Comment>await reader.createComment({ cid })).raw.comment);
        await Promise.race([
            resolveWhenConditionIsTrue({
                toUpdate: remoteCommunity,
                predicate: async () => {
                    if (typeof remoteCommunity.updatedAt !== "number") return false;
                    for (const p of published.filter((x) => x.accepted && x.cid)) if (!(await filledFromPages(p.cid!))) return false;
                    return true;
                }
            }),
            new Promise((resolve) => setTimeout(resolve, 60_000))
        ]);
        for (const p of published.filter((x) => x.accepted && x.cid)) {
            const comment = <Comment>await reader.createComment({ cid: p.cid! });
            expect.soft(comment.raw.comment, `[${p.name}] built from the page entry`).toBeDefined();
            expect.soft(typeof comment.update, `[${p.name}] update must stay a function`).toBe("function");
            expect.soft(typeof comment.stop, `[${p.name}] stop must stay a function`).toBe("function");
            expect.soft(await stopOutcome(comment), `[${p.name}] stop() must not throw`).toBeUndefined();
        }
        await remoteCommunity.stop();
    }, 600_000);

    it("readers loading the poisoned comments raise nothing that would terminate the RPC server's process", () => {
        // the server holds its own instance of every comment a client loads through it; this is the load-side
        // question, apart from the publish-side one above
        expect(fatal.errors.slice(fatalAfterPublishing).join(" | ")).toBe("");
    });

    it("the author's own instance survives the verdict on its poisoned comment", async () => {
        for (const p of published) {
            expect.soft(typeof p.publisher.update, `[${p.name}] publisher's update must stay a function`).toBe("function");
            expect.soft(typeof p.publisher.stop, `[${p.name}] publisher's stop must stay a function`).toBe("function");
            // A refusal reaches an RPC publisher as an error event. What must never happen is the guard firing: that
            // would mean a handler threw on the refusal
            const codes = p.publisherErrors.map((e) => (<{ code?: string }>e).code ?? e.message);
            if (p.name === BENIGN) expect.soft(codes, `[${p.name}] publisher emitted errors`).toEqual([]);
            else
                expect
                    .soft(codes, `[${p.name}] a handler threw while handling the refusal`)
                    .not.toContain("ERR_PUBLICATION_INTERNAL_ERROR");
            expect.soft(await stopOutcome(p.publisher), `[${p.name}] publisher's stop() must not throw`).toBeUndefined();
        }
    });
});
