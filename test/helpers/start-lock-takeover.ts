import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

// Runs a second process that takes over a community's start lock the way another pkc-js process on the same dataPath
// would: it finds the lock stale and replaces it. In production that happens when the holder's event loop is blocked
// past the 10s stale threshold (a long VACUUM or migration), so its timer cannot refresh the lock. Blocking a test for
// 10s+ is slow, so this process uses the library's 2s minimum stale threshold instead, which the holder's 5s refresh
// interval always exceeds: the takeover is the same, it just comes sooner. Resolves once the lock is taken.
export async function takeOverStartLockFromAnotherProcess({
    dataPath,
    communityAddress
}: {
    dataPath: string;
    communityAddress: string;
}): Promise<{ kill: () => void }> {
    const communityDbPath = path.join(dataPath, "communities", communityAddress);
    const lockfilePath = `${communityDbPath}.start.lock`;
    const script = `
        const lockfile = require("@pkcprotocol/proper-lock-file");
        const [communityDbPath, lockfilePath] = process.argv.slice(1);
        lockfile
            .lock(communityDbPath, { lockfilePath, stale: 2000, retries: { retries: 80, minTimeout: 250, maxTimeout: 250 } })
            .then(() => process.stdout.write("locked\\n"))
            .catch((error) => {
                process.stdout.write("failed " + error.message + "\\n");
                process.exit(1);
            });
        setInterval(() => {}, 1000);
    `;
    const child: ChildProcess = spawn(process.execPath, ["-e", script, communityDbPath, lockfilePath], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "inherit"]
    });
    await new Promise<void>((resolve, reject) => {
        let output = "";
        child.stdout!.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("locked\n")) resolve();
            else if (output.includes("failed")) reject(new Error(`The other process could not take the start lock: ${output.trim()}`));
        });
        child.once("exit", (code) => reject(new Error(`The other process exited with code ${code} before taking the start lock`)));
    });
    return { kill: () => void child.kill() };
}
