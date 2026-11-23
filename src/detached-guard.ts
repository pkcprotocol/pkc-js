import Logger from "./logger.js";

// Wraps an entry point that nothing awaits: an event listener, a timer callback, a stream or socket callback. A throw
// or a rejection there is an uncaught exception or an unhandled rejection, which ends a Node process and with it every
// community, comment and RPC client it serves. The wrapper logs the failure, with the entry point's name and the error
// and its causes, and hands it to `onFailure`, where the caller decides what it means for that one entry point: drop a
// frame, end a loop, report an "error" event.
//
// The wrapper itself lets nothing escape except what `onFailure` throws. That is deliberate: `onFailure` usually emits
// an "error" event, and an emit that nobody listens to throws. With no listener the process stops, as documented in the
// README (listen for "error" on the pkc and on every instance). A listener that throws propagates the same way.
//
// Works for a sync handler (a sync throw is caught and the wrapper returns undefined) and for an async handler (the
// returned promise settles after `onFailure` has run, and rejects if `onFailure` throws or rejects). Pure on purpose:
// no import of the runtime, so a schema module can use it without a cycle.
export function guardDetached<Args extends unknown[], Result>({
    entryPoint,
    handler,
    onFailure
}: {
    entryPoint: string;
    handler: (...args: Args) => Result;
    onFailure: (error: unknown) => unknown;
}): (...args: Args) => Result extends PromiseLike<unknown> ? Promise<void> : void {
    const handleFailure = (error: unknown) => {
        Logger("pkc-js:detached-guard").error(`Detached entry point (${entryPoint}) failed`, describeFailure(error));
        return onFailure(error);
    };
    // The conditional return type is the contract: an async handler gives a promise, a sync one gives nothing
    return ((...args: Args) => {
        let result: unknown;
        try {
            result = handler(...args);
        } catch (error) {
            const failureResult = handleFailure(error);
            return isThenable(failureResult) ? Promise.resolve(failureResult).then(() => undefined) : undefined;
        }
        if (!isThenable(result)) return undefined;
        return Promise.resolve(result).then(
            () => undefined,
            async (error: unknown) => {
                await handleFailure(error);
            }
        );
    }) as (...args: Args) => Result extends PromiseLike<unknown> ? Promise<void> : void;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

// The error and its chain of causes, so one log line says what failed and why. Bounded: a cause chain can loop.
function describeFailure(error: unknown): unknown[] {
    const chain: unknown[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== undefined; depth++) {
        chain.push(current);
        current = typeof current === "object" && current !== null ? (current as { cause?: unknown }).cause : undefined;
    }
    return chain;
}
