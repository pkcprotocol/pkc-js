// A publication is driven by handlers nothing awaits: the pubsub handler, the RPC subscription handlers, the
// listeners on a local community. A throw in one is an unhandled rejection, which ends a Node process, and with it
// every publication, community and RPC client the process serves. _guardDetachedHandler turns that throw into the
// end of the one publication: before a verdict it fails it, after one it only reports. This file tests the
// wrapper's contract, that every entry point is wrapped, and the real trigger (a teardown that throws).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { mockRemotePKC, mockPKC, generateMockPost, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import { captureProcessFatalErrors } from "../../helpers/hostile-props.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

const COMMUNITY = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";

// The private surface of Publication this file drives
type Guarded = {
    _guardDetachedHandler: <A extends unknown[]>(entryPoint: string, handler: (...args: A) => unknown) => (...args: A) => Promise<void>;
    _publishEndedBy?: "verification" | "failure" | "stop";
    _clientsManager: { pubsubUnsubscribe?: unknown };
    publishingState: string;
    state: string;
};
const asGuarded = (c: Comment): Guarded => <Guarded>(<unknown>c);

const PUBLICATION_SOURCE = readFileSync(new URL("../../../src/publications/publication.ts", import.meta.url), "utf8");

describe("_guardDetachedHandler: the contract", () => {
    let pkc: PKC;
    let fatal: ReturnType<typeof captureProcessFatalErrors>;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        fatal = captureProcessFatalErrors();
    });
    afterAll(async () => {
        fatal.stop();
        await pkc.destroy();
    });

    const freshPost = async (): Promise<Comment> => <Comment>await generateMockPost({ communityAddress: COMMUNITY, pkc });
    const errorsOf = (post: Comment): (Error & { code?: string; details?: { entryPoint?: string; cause?: unknown } })[] => {
        const errors: (Error & { code?: string; details?: { entryPoint?: string; cause?: unknown } })[] = [];
        post.on("error", (e: Error) => errors.push(e));
        return errors;
    };

    it("passes the arguments through and returns normally when the handler succeeds", async () => {
        const post = await freshPost();
        const seen: unknown[][] = [];
        await asGuarded(post)._guardDetachedHandler("ok", (...args: unknown[]) => seen.push(args))(1, "two");
        expect(seen).toEqual([[1, "two"]]);
    });

    for (const [kind, handler] of <[string, () => unknown][]>[
        [
            "a synchronous throw",
            () => {
                throw new Error("sync boom");
            }
        ],
        [
            "an async rejection",
            async () => {
                throw new Error("async boom");
            }
        ]
    ])
        it(`${kind} before a verdict fails the publication, emits ERR_PUBLICATION_INTERNAL_ERROR with the cause, and does not reject`, async () => {
            const post = await freshPost();
            const errors = errorsOf(post);
            const states: string[] = [];
            post.on("publishingstatechange", (s: string) => states.push(s));

            await expect(asGuarded(post)._guardDetachedHandler("unit-entry", handler)()).resolves.toBeUndefined();

            expect(asGuarded(post).publishingState).toBe("failed");
            expect(states).toContain("failed");
            expect(errors).toHaveLength(1);
            expect(errors[0].code).toBe("ERR_PUBLICATION_INTERNAL_ERROR");
            expect(errors[0].details?.entryPoint).toBe("unit-entry");
            expect((<Error>errors[0].details?.cause).message).toMatch(/boom/);
        });

    it("after a verdict the outcome stands: the error is emitted and the state is not flipped to failed", async () => {
        const post = await freshPost();
        const g = asGuarded(post);
        g._publishEndedBy = "verification";
        g.publishingState = "succeeded";
        const errors = errorsOf(post);
        await g._guardDetachedHandler("late", () => {
            throw new Error("late boom");
        })();
        expect(g.publishingState).toBe("succeeded");
        expect(errors.map((e) => e.code)).toEqual(["ERR_PUBLICATION_INTERNAL_ERROR"]);
    });

    it("a verdict claimed as the end counts even when publishingState has not caught up", async () => {
        const post = await freshPost();
        const g = asGuarded(post);
        g._publishEndedBy = "verification";
        const before = g.publishingState;
        await g._guardDetachedHandler("late", () => {
            throw new Error("late boom");
        })();
        expect(g.publishingState).not.toBe("failed");
        expect(g.publishingState).toBe(before);
    });

    it("after stop() the failure is only logged: nothing is emitted and the state is untouched", async () => {
        const post = await freshPost();
        const g = asGuarded(post);
        g._publishEndedBy = "stop";
        const errors = errorsOf(post);
        const before = g.publishingState;
        await g._guardDetachedHandler("after-stop", () => {
            throw new Error("boom");
        })();
        expect(errors).toEqual([]);
        expect(g.publishingState).toBe(before);
    });

    it("a second failure after a first one ends nothing twice: the first end wins", async () => {
        const post = await freshPost();
        const g = asGuarded(post);
        const errors = errorsOf(post);
        const boom = () => {
            throw new Error("boom");
        };
        await g._guardDetachedHandler("first", boom)();
        await g._guardDetachedHandler("second", boom)();
        expect(g._publishEndedBy).toBe("failure");
        expect(g.publishingState).toBe("failed");
        // the second one is after an end by failure: reported as an error, the state stays failed
        expect(errors.map((e) => e.details?.entryPoint)[0]).toBe("first");
    });

    it("a teardown that throws does not mask the original error and does not escape", async () => {
        const post = await freshPost();
        const g = asGuarded(post);
        g._clientsManager = { pubsubUnsubscribe: "not a function" };
        // a real pubsub-published publication runs this branch of the teardown; make sure it is the one taken
        Object.defineProperty(post, "_community", { value: { pubsubTopic: "topic" }, configurable: true });
        const errors = errorsOf(post);
        await expect(
            g._guardDetachedHandler("teardown", () => {
                throw new Error("original");
            })()
        ).resolves.toBeUndefined();
        expect(errors).toHaveLength(1);
        expect((<Error>errors[0].details?.cause).message).toBe("original");
        expect(g.publishingState).toBe("failed");
    });

    it("RPC verdict: a throwing application listener still unsubscribes from the server and unregisters", async () => {
        const post = await freshPost();
        const g = <Guarded & { _rpcPublishSubscriptionId?: number; _handleRpcChallengeVerification: (v: unknown) => Promise<void> }>(
            (<unknown>post)
        );
        const unsubscribed: number[] = [];
        const pkcBag = <{ _pkcRpcClient?: unknown; _publishingPublications: Set<unknown> }>(<unknown>pkc);
        const previousClient = pkcBag._pkcRpcClient;
        pkcBag._pkcRpcClient = { unsubscribe: async (id: number): Promise<void> => void unsubscribed.push(id) };
        pkcBag._publishingPublications.add(post);
        g._rpcPublishSubscriptionId = 77;
        // the handler that receives the verdict claims the end before it calls this
        (<{ _publishEndedBy?: string }>(<unknown>post))._publishEndedBy = "verification";
        const errors = errorsOf(post);
        post.on("challengeverification", () => {
            throw new Error("application listener throws");
        });
        try {
            await g._guardDetachedHandler("rpc-verdict", () =>
                g._handleRpcChallengeVerification({ challengeRequestId: { toString: () => "r" }, challengeSuccess: false, reason: "x" })
            )();
        } finally {
            pkcBag._pkcRpcClient = previousClient;
        }
        expect(errors.map((e) => e.code)).toContain("ERR_PUBLICATION_INTERNAL_ERROR");
        expect(unsubscribed, "the RPC subscription was never torn down").toEqual([77]);
        expect(pkcBag._publishingPublications.has(post)).toBe(false);
    });

    // A pubsub-published publication whose teardown rejects (the unsubscribe of the client is not a function)
    const withRejectingTeardown = (post: Comment) => {
        const g = asGuarded(post);
        g._clientsManager = { pubsubUnsubscribe: "not a function" };
        Object.defineProperty(post, "_community", { value: { pubsubTopic: "topic" }, configurable: true });
        (<{ _publishEndedBy?: string }>(<unknown>post))._publishEndedBy = "verification"; // the verdict handler claimed the end
        return g;
    };

    it("a throwing verdict listener is the error that is reported, also when the teardown in the finally throws as well", async () => {
        const post = await freshPost();
        const g = <Guarded & { _handleRpcChallengeVerification: (v: unknown) => Promise<void> }>(<unknown>withRejectingTeardown(post));
        // this publication has no RPC client state to write; the point here is the order of the errors
        (<{ _setRpcClientState: () => void }>(<unknown>post))._setRpcClientState = () => {};
        const errors = errorsOf(post);
        post.on("challengeverification", () => {
            throw new Error("application listener throws");
        });
        await g._guardDetachedHandler("rpc-verdict", () =>
            g._handleRpcChallengeVerification({ challengeRequestId: { toString: () => "r" }, challengeSuccess: false, reason: "x" })
        )();
        expect(errors).toHaveLength(1);
        expect((<Error>errors[0].details?.cause).message, "the listener's error was replaced by the teardown's").toBe(
            "application listener throws"
        );
    });

    it("a verdict whose comment does not verify still fails the publication when the teardown throws", async () => {
        const post = await freshPost();
        const g = <Guarded & { _handleRpcChallengeVerification: (v: unknown) => Promise<void> }>(<unknown>withRejectingTeardown(post));
        (<{ _verifyDecryptedChallengeVerificationAndUpdateCommentProps: () => Promise<void> }>(<unknown>post))._verifyDecryptedChallengeVerificationAndUpdateCommentProps =
            async () => {
                throw new Error("the comment does not verify");
            };
        const errors = errorsOf(post);
        await g._guardDetachedHandler("rpc-verdict", () =>
            g._handleRpcChallengeVerification({
                challengeRequestId: { toString: () => "r" },
                challengeSuccess: true,
                comment: {},
                commentUpdate: {}
            })
        )();
        expect(g.publishingState, "the publication stayed in publishing after its verdict was unusable").toBe("failed");
        expect(errors.map((e) => e.message).join("|")).toContain("the comment does not verify");
    });

    it("with no error listener on the publication or the pkc, the wrapper still does not throw", async () => {
        const post = await freshPost();
        const g = asGuarded(post);
        g._publishEndedBy = "verification"; // after a verdict the wrapper uses a plain emit("error")
        expect(post.listenerCount("error")).toBeLessThanOrEqual(1);
        // detach what the instance bubbles to pkc, then fail: emit("error") with nobody listening throws
        const stash = post.listeners("error");
        for (const l of stash) post.off("error", l as (...a: unknown[]) => void);
        const pkcStash = pkc.listeners("error");
        for (const l of pkcStash) pkc.off("error", l as (...a: unknown[]) => void);
        try {
            await expect(
                g._guardDetachedHandler("nobody-listens", () => {
                    throw new Error("boom");
                })()
            ).resolves.toBeUndefined();
        } finally {
            for (const l of pkcStash) pkc.on("error", l as (...a: unknown[]) => void);
            for (const l of stash) post.on("error", l as (...a: unknown[]) => void);
        }
    });

    it("never produced an uncaught exception or an unhandled rejection", () => {
        expect(fatal.errors).toEqual([]);
    });
});

// A publication entry point added later without the wrapper brings the problem back. These read the source,
// which is the only place the wiring is visible: the handlers are private and bound at publish time.
describe("every detached entry point of a publication is wrapped", () => {
    it("the pubsub handler is wrapped where it is bound", () => {
        expect(PUBLICATION_SOURCE).toMatch(/this\._handleChallengeExchange = this\._guardDetachedHandler\(/);
    });

    it("every RPC subscription handler is only ever registered through the wrapper", () => {
        const handlers = [...PUBLICATION_SOURCE.matchAll(/private (?:async )?(_handleIncoming\w+FromRpc)\(/g)].map((m) => m[1]);
        expect(handlers.length).toBeGreaterThanOrEqual(7);
        for (const name of handlers) {
            const registrations = [...PUBLICATION_SOURCE.matchAll(new RegExp(`this\\.${name}\\.bind\\(this\\)`, "g"))];
            expect(registrations.length, `${name} is registered`).toBeGreaterThan(0);
            for (const m of registrations) {
                const before = PUBLICATION_SOURCE.slice(Math.max(0, m.index! - 160), m.index!);
                expect(before, `${name} is registered through _guardDetachedHandler`).toMatch(/_guardDetachedHandler\(\s*"[^"]+",\s*$/);
            }
        }
    });

    it("every listener put on a local community is a guarded one", () => {
        const registrations = [...PUBLICATION_SOURCE.matchAll(/community\.on\("(\w+)", (\w+)\)/g)];
        expect(registrations.length).toBeGreaterThanOrEqual(2);
        for (const [, event, variable] of registrations)
            expect(PUBLICATION_SOURCE, `the ${event} listener ${variable} is created by _guardDetachedHandler`).toMatch(
                new RegExp(`const ${variable} = this\\._guardDetachedHandler\\(`)
            );
    });

    it("no bare async listener, timer or fire-and-forget promise is added to the publication", () => {
        const offenders = [
            ...PUBLICATION_SOURCE.matchAll(
                /^.*(\.on\("\w+",\s*async|setTimeout\(\s*async|setInterval\(|void this\._\w+\(|^\s*this\._\w+\(\)\.then\().*$/gm
            )
        ]
            .map((m) => m[0].trim())
            // _unregisterFromPkcOncePublishWorkSettles / refresh chains are void by design and cannot throw
            .filter((line) => !/_unregisterFromPkc|refresh\.finally|_endPublicationAfterDetachedFailure/.test(line));
        expect(offenders).toEqual([]);
    });
});

// The real trigger: the publisher's teardown throws (the uncaught TypeError that ended the shared test server).
// A community and a publisher on separate throwaway PKCs, nothing published to a shared community.
// These two drive the client's own pubsub teardown (`_clientsManager.pubsubUnsubscribe`) while publishing to a community. Under RPC
// the publisher goes through the RPC server and the client never subscribes to pubsub itself, so there is no client teardown to
// break or count; the RPC end of the publish is covered by the RPC verdict tests above.
describeSkipIfRpc("a publisher whose teardown throws, publishing to a real throwaway community", () => {
    let pkc: PKC;
    let communityPKC: PKC;
    let communityAddress: string;
    let fatal: ReturnType<typeof captureProcessFatalErrors>;

    beforeAll(async () => {
        communityPKC = await mockPKC();
        const community = await createSubWithNoChallenge({}, communityPKC);
        await community.start();
        communityAddress = community.address;
        pkc = await mockRemotePKC();
        fatal = captureProcessFatalErrors();
    }, 120_000);
    afterAll(async () => {
        fatal.stop();
        await pkc.destroy();
        await communityPKC.destroy();
    });

    it("raises nothing fatal, and the publication ends with a verdict or an error instead of hanging", async () => {
        const post = <Comment>await generateMockPost({ communityAddress, pkc });
        const g = asGuarded(post);
        let teardownCalls = 0;
        g._clientsManager = new Proxy(g._clientsManager, {
            get(target, prop, receiver) {
                if (prop === "pubsubUnsubscribe")
                    return () => {
                        teardownCalls++;
                        throw new TypeError("this._clientsManager.pubsubUnsubscribe is not a function");
                    };
                return Reflect.get(target, prop, receiver);
            }
        });
        const outcome = new Promise<string>((resolve) => {
            post.once("challengeverification", () => resolve("verdict"));
            post.on("error", (e: Error & { code?: string }) => resolve(`error:${e.code}`));
        });
        const startedAt = Date.now();
        await post.publish();
        const settled = await Promise.race([outcome, new Promise<string>((r) => setTimeout(() => r("hung"), 60_000))]);
        console.log(`[guard-real-trigger] settled=${settled} after ${Date.now() - startedAt}ms, teardownCalls=${teardownCalls}`);
        // the failure of a detached handler surfaces a moment after the event that triggered it
        await new Promise((r) => setTimeout(r, 5_000));

        expect(fatal.errors).toEqual([]);
        expect(teardownCalls, "the injected teardown failure was never exercised").toBeGreaterThan(0);
        // the verdict reached the publisher, or the publisher was told the publication failed
        expect(["verdict", "error:ERR_PUBLICATION_INTERNAL_ERROR"]).toContain(settled);
    }, 120_000);
});

// A listener of the application throws while the verdict is being emitted. The verdict is already the end of the
// publish, so the guard only reports; the teardown that follows the emit must still happen.
// These two drive the client's own pubsub teardown (`_clientsManager.pubsubUnsubscribe`) while publishing to a community. Under RPC
// the publisher goes through the RPC server and the client never subscribes to pubsub itself, so there is no client teardown to
// break or count; the RPC end of the publish is covered by the RPC verdict tests above.
describeSkipIfRpc("a throwing application listener on the verdict, publishing to a real throwaway community", () => {
    let pkc: PKC;
    let communityPKC: PKC;
    let communityAddress: string;
    let fatal: ReturnType<typeof captureProcessFatalErrors>;

    beforeAll(async () => {
        communityPKC = await mockPKC();
        const community = await createSubWithNoChallenge({}, communityPKC);
        await community.start();
        communityAddress = community.address;
        pkc = await mockRemotePKC();
        fatal = captureProcessFatalErrors();
    }, 120_000);
    afterAll(async () => {
        fatal.stop();
        await pkc.destroy();
        await communityPKC.destroy();
    });

    it("still unsubscribes and unregisters the publication", async () => {
        const post = <Comment>await generateMockPost({ communityAddress, pkc });
        const g = <Guarded & { _community?: { pubsubTopic?: string } }>(<unknown>post);
        let unsubscribeCalls = 0;
        g._clientsManager = new Proxy(g._clientsManager, {
            get(target, prop, receiver) {
                if (prop === "pubsubUnsubscribe")
                    return (...args: unknown[]) => {
                        unsubscribeCalls++;
                        return (<(...a: unknown[]) => unknown>Reflect.get(target, prop, receiver)).apply(target, args);
                    };
                return Reflect.get(target, prop, receiver);
            }
        });
        const errors: (Error & { code?: string })[] = [];
        post.on("error", (e: Error) => errors.push(e));
        post.on("challengeverification", () => {
            throw new Error("application listener throws");
        });
        await post.publish();
        await new Promise((r) => setTimeout(r, 70_000));
        const registered = (<{ _publishingPublications: Set<unknown> }>(<unknown>pkc))._publishingPublications.has(post);

        expect(fatal.errors).toEqual([]);
        expect(errors.map((e) => e.code)).toContain("ERR_PUBLICATION_INTERNAL_ERROR");
        expect(unsubscribeCalls, "the pubsub subscription was never torn down").toBeGreaterThan(0);
        expect(registered, "the publication stayed registered on the pkc").toBe(false);
    }, 150_000);
});
