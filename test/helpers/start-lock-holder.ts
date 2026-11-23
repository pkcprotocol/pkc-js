import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Runs a second process that holds a community's start lock the way another pkc-js process on the same dataPath does:
// through DbHandler.lockCommunityStart on its own connection to the community DB. Resolves once the lock is held.
// Rejects with the error code the other process got when it was refused the lock. With blockEventLoopForMs, that
// process blocks its event loop for that long right after taking the lock, the way a VACUUM or a migration of a large
// DB does: no timer of its runs meanwhile. With forceGc, it runs the garbage collector several times once the lock is
// held, keeping only the reference to the handler that a started community keeps to its own.
export async function holdStartLockInAnotherProcess({
    dataPath,
    communityAddress,
    blockEventLoopForMs = 0,
    forceGc = false
}: {
    dataPath: string;
    communityAddress: string;
    blockEventLoopForMs?: number;
    forceGc?: boolean;
}): Promise<{ process: ChildProcess; kill: () => Promise<void> }> {
    const dbHandlerModuleUrl = pathToFileURL(
        path.join(process.cwd(), "dist", "node", "runtime", "node", "community", "db-handler.js")
    ).href;
    const script = `
        const [dbHandlerModuleUrl, dataPath, address, blockEventLoopForMs] = process.argv.slice(1);
        const { DbHandler } = await import(dbHandlerModuleUrl);
        // DbHandler and the registry log through community._log and pkc._log (issue #493)
        const { default: Logger } = await import("@pkcprotocol/pkc-logger");
        const _log = Logger({ namespace: "pkc-js:test:start-lock-holder" });
        const dbHandler = new DbHandler({ address, _log, _pkc: { dataPath, _log } });
        try {
            await dbHandler.initDbIfNeeded();
            await dbHandler.lockCommunityStart();
            globalThis.dbHandler = dbHandler;
            if (typeof globalThis.gc === "function")
                for (let i = 0; i < 5; i++) {
                    globalThis.gc();
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            process.stdout.write("locked\\n");
            if (Number(blockEventLoopForMs) > 0)
                setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(blockEventLoopForMs)));
        } catch (error) {
            process.stdout.write("failed " + (error.code || error.message) + "\\n");
            process.exit(1);
        }
        setInterval(() => {}, 1000);
    `;
    const child: ChildProcess = spawn(
        process.execPath,
        [
            ...(forceGc ? ["--expose-gc"] : []),
            "--input-type=module",
            "-e",
            script,
            dbHandlerModuleUrl,
            dataPath,
            communityAddress,
            String(blockEventLoopForMs)
        ],
        {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "inherit"]
        }
    );
    const kill = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
    };
    await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("locked\n")) resolve();
        });
        // A refusal is reported once the process is gone, not when it prints it: until then it has the community DB
        // open, and Windows does not let the caller's cleanup delete an open file
        child.once("exit", (code) =>
            reject(
                new Error(
                    output.includes("failed") ? output.trim() : `The other process exited with code ${code} before taking the start lock`
                )
            )
        );
    });
    return { process: child, kill };
}

const START_IN_ANOTHER_PROCESS_TIMEOUT_MS = 120_000;

// Runs a second process that starts the community for real: its own PKC on the same dataPath, createCommunity() and
// start(). Resolves once that process has published the community's first record of this run and stored it. kill() is a SIGKILL, so
// the process gets no chance to stop the community or release anything.
export async function startCommunityInAnotherProcess({
    dataPath,
    communityAddress
}: {
    dataPath: string;
    communityAddress: string;
}): Promise<{ process: ChildProcess; kill: () => Promise<void> }> {
    const testUtilModuleUrl = pathToFileURL(path.join(process.cwd(), "dist", "node", "test", "test-util.js")).href;
    const script = `
        const [testUtilModuleUrl, dataPath, address] = process.argv.slice(1);
        const { mockPKC } = await import(testUtilModuleUrl);
        try {
            const pkc = await mockPKC({ dataPath });
            pkc.on("error", () => {});
            const community = await pkc.createCommunity({ address });
            community.on("error", () => {});
            const updatedAtBefore = community.updatedAt;
            await community.start();
            // Until the record is in the DB, not only on the instance: the publish cycle stores it a call to kubo later,
            // and a process killed in between has published a record its DB does not know
            const storedUpdatedAt = () => community._getDbInternalState()?.updatedAt;
            while (community.updatedAt === updatedAtBefore || storedUpdatedAt() !== community.updatedAt)
                await new Promise((resolve) => setTimeout(resolve, 50));
            globalThis.community = community;
            process.stdout.write("started\\n");
        } catch (error) {
            process.stdout.write("failed " + (error.code || error.message) + "\\n");
            process.exit(1);
        }
    `;
    const child: ChildProcess = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, testUtilModuleUrl, dataPath, communityAddress],
        {
            cwd: process.cwd(),
            stdio: ["ignore", "pipe", "inherit"]
        }
    );
    const kill = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
    };
    // Bounded: a community that starts but never publishes (that process swallows its errors) would leave the caller
    // waiting without the handle it needs to kill the process
    let timedOut = false;
    const notStartedInTime = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
    }, START_IN_ANOTHER_PROCESS_TIMEOUT_MS);
    await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("started\n")) resolve();
        });
        // A refusal is reported once the process is gone, not when it prints it: until then it has the community DB
        // open, and Windows does not let the caller's cleanup delete an open file
        child.once("exit", (code) => {
            const reason = timedOut
                ? `The other process did not publish a record within ${START_IN_ANOTHER_PROCESS_TIMEOUT_MS}ms and was killed`
                : output.includes("failed")
                  ? output.trim()
                  : `The other process exited with code ${code} before starting the community`;
            reject(new Error(reason));
        });
    }).finally(() => clearTimeout(notStartedInTime));
    return { process: child, kill };
}
