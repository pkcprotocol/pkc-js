import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { guardDetached } from "../../../dist/node/detached-guard.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";

describe("guardDetached", () => {
    it("passes the arguments through and does not call onFailure when the handler succeeds", async () => {
        const handler = vi.fn(async (a: number, b: number) => a + b);
        const onFailure = vi.fn();
        await guardDetached({ entryPoint: "ok", handler, onFailure })(1, 2);
        expect(handler).toHaveBeenCalledWith(1, 2);
        expect(onFailure).not.toHaveBeenCalled();
    });

    it("catches a sync throw and hands it to onFailure", () => {
        const boom = new Error("sync boom");
        const onFailure = vi.fn();
        const guarded = guardDetached({
            entryPoint: "sync",
            handler: () => {
                throw boom;
            },
            onFailure
        });
        expect(() => guarded()).not.toThrow();
        expect(onFailure).toHaveBeenCalledExactlyOnceWith(boom);
    });

    it("catches an async rejection and hands it to onFailure", async () => {
        const boom = new Error("async boom");
        const onFailure = vi.fn();
        const guarded = guardDetached({ entryPoint: "async", handler: async () => Promise.reject(boom), onFailure });
        await expect(guarded()).resolves.toBeUndefined();
        expect(onFailure).toHaveBeenCalledExactlyOnceWith(boom);
    });

    it("returns undefined for a sync handler and a promise for an async one", async () => {
        const syncGuarded = guardDetached({ entryPoint: "s", handler: () => 1, onFailure: () => {} });
        const asyncGuarded = guardDetached({ entryPoint: "a", handler: async () => 1, onFailure: () => {} });
        expect(syncGuarded()).toBeUndefined();
        expect(asyncGuarded()).toBeInstanceOf(Promise);
    });

    it("lets an onFailure that throws escape a sync handler", () => {
        const guarded = guardDetached({
            entryPoint: "sync-escape",
            handler: () => {
                throw new Error("first");
            },
            onFailure: () => {
                throw new Error("from onFailure");
            }
        });
        expect(() => guarded()).toThrow("from onFailure");
    });

    it("rejects, and does not swallow, when onFailure throws after an async failure", async () => {
        const guarded = guardDetached({
            entryPoint: "async-escape",
            handler: async () => {
                throw new Error("first");
            },
            onFailure: () => {
                throw new Error("from onFailure");
            }
        });
        await expect(guarded()).rejects.toThrow("from onFailure");
    });

    it("waits for an async onFailure before settling", async () => {
        const order: string[] = [];
        const guarded = guardDetached({
            entryPoint: "async-onfailure",
            handler: async () => {
                throw new Error("x");
            },
            onFailure: async () => {
                await letDetachedWorkSettle(20);
                order.push("onFailure done");
            }
        });
        await guarded();
        order.push("guard settled");
        expect(order).toEqual(["onFailure done", "guard settled"]);
    });

    it("keeps the process alive when used as an event listener and onFailure emits to a listener", async () => {
        const emitter = new EventEmitter();
        emitter.on("error", () => {});
        emitter.on(
            "event",
            guardDetached({
                entryPoint: "listener",
                handler: async () => {
                    throw new Error("in listener");
                },
                onFailure: (error) => emitter.emit("error", error)
            })
        );
        const capture = captureProcessFatalErrors();
        emitter.emit("event");
        await letDetachedWorkSettle(100);
        capture.stop();
        expect(capture.fatals).toEqual([]);
    });

    it("stops the process, as documented, when onFailure emits an error nobody listens to", async () => {
        const emitter = new EventEmitter();
        emitter.on(
            "event",
            guardDetached({
                entryPoint: "listener-no-error-listener",
                handler: async () => {
                    throw new Error("in listener");
                },
                onFailure: (error) => emitter.emit("error", error)
            })
        );
        const capture = captureProcessFatalErrors();
        emitter.emit("event");
        await letDetachedWorkSettle(100);
        capture.stop();
        expect(capture.fatals.map((f) => f.kind)).toContain("unhandledRejection"); // the ERR_UNHANDLED_ERROR of the emit
    });

    it("logs the entry point name and the cause chain", async () => {
        const logged: unknown[][] = [];
        const { default: Logger } = await import("../../../dist/node/logger.js");
        const logger = Logger("pkc-js:detached-guard");
        const spy = vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => void logged.push(args));
        const guarded = guardDetached({
            entryPoint: "myEntryPoint",
            handler: () => {
                throw Object.assign(new Error("outer"), { cause: new Error("inner") });
            },
            onFailure: () => {}
        });
        guarded();
        spy.mockRestore();
        expect(String(logged[0][0])).toContain("myEntryPoint");
        const chain = logged[0][1] as Error[];
        expect(chain.map((e) => e.message)).toEqual(["outer", "inner"]);
    });
});
