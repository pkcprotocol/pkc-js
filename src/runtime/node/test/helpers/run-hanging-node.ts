import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

interface RunHangingScenarioInChildProcessOptions {
    configCode: string;
    timeoutMs: number;
    scenarioModuleBaseName: string;
}

const runnerPath = fileURLToPath(new URL("./hanging-runner.js", import.meta.url));

export async function runHangingScenarioInChildProcess({
    configCode,
    timeoutMs,
    scenarioModuleBaseName
}: RunHangingScenarioInChildProcessOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        const waitForCleanupMs = Math.max(1000, timeoutMs);
        const env = {
            ...process.env,
            PKC_CONFIGS: configCode,
            HANGING_RUNNER_WAIT: String(waitForCleanupMs)
        };
        const child = spawn(process.execPath, [runnerPath, "--scenario", scenarioModuleBaseName], {
            env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        child.stdout?.on("data", (data: unknown) => {
            stdout += String(data);
        });

        child.stderr?.on("data", (data: unknown) => {
            stderr += String(data);
        });

        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            const message = [
                `hanging-runner timed out after ${timeoutMs}ms`,
                `scenario: ${scenarioModuleBaseName}`,
                stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
                stderr.trim() ? `stderr:\n${stderr.trim()}` : ""
            ]
                .filter(Boolean)
                .join("\n\n");
            reject(new Error(message));
        }, timeoutMs);

        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            reject(error);
        });

        child.once("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (code === 0) {
                resolve();
                return;
            }
            const message = [
                `hanging-runner exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}`,
                `scenario: ${scenarioModuleBaseName}`,
                stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
                stderr.trim() ? `stderr:\n${stderr.trim()}` : ""
            ]
                .filter(Boolean)
                .join("\n\n");
            reject(new Error(message));
        });
    });
}
