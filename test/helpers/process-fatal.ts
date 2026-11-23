// Collects the errors that would have terminated a Node process: an uncaught exception, or an unhandled
// rejection (Node turns it into one by default). Attaching a listener keeps the test process alive, so a
// test can assert on what a production process would have died of. vitest also reports these as unhandled
// errors; this makes the assertion explicit and lets a test run to the end and say which one fired.
export type ProcessFatal = { kind: "uncaughtException" | "unhandledRejection"; message: string; code?: string; stack?: string };

export function captureProcessFatalErrors(): { fatals: ProcessFatal[]; stop: () => void } {
    const fatals: ProcessFatal[] = [];
    const describe = (kind: ProcessFatal["kind"]) => (e: unknown) =>
        fatals.push({
            kind,
            message: e instanceof Error ? e.message : String(e),
            code: typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : undefined,
            stack: e instanceof Error ? e.stack : undefined
        });
    const onException = describe("uncaughtException");
    const onRejection = describe("unhandledRejection");
    process.on("uncaughtException", onException);
    process.on("unhandledRejection", onRejection);
    return {
        fatals,
        stop: () => {
            process.off("uncaughtException", onException);
            process.off("unhandledRejection", onRejection);
        }
    };
}

// Gives detached callbacks (timers, event loop turns, unawaited promises) time to run and, if they are going to,
// to blow up, before the test inspects what was captured.
export async function letDetachedWorkSettle(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
