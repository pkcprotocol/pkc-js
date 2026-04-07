import { resolveHangingScenarioModule } from "../../../../test/node/hanging-test/scenarios/hanging-test-util.js";
import type { HangingScenarioDefinition } from "../../../../test/node/hanging-test/scenarios/hanging-test-util.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const parsedWaitMs = Number(process.env.HANGING_RUNNER_WAIT);
const WAIT_TIMEOUT_MS = Number.isFinite(parsedWaitMs) && parsedWaitMs > 0 ? parsedWaitMs : DEFAULT_WAIT_TIMEOUT_MS;
const parsedPollMs = Number(process.env.HANGING_RUNNER_POLL);
const WAIT_POLL_MS = Number.isFinite(parsedPollMs) && parsedPollMs > 0 ? parsedPollMs : 25;
const nodeProcess = process as NodeJS.Process & {
    _getActiveHandles: () => unknown[];
    _getActiveRequests: () => unknown[];
};

interface ParsedArgs {
    scenarioModuleBaseName?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {};
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--scenario") {
            parsed.scenarioModuleBaseName = argv[index + 1];
            index += 1;
            continue;
        }
        if (value?.startsWith("--scenario=")) {
            parsed.scenarioModuleBaseName = value.slice("--scenario=".length);
        }
    }
    return parsed;
}

async function run(): Promise<void> {
    try {
        const { scenarioModuleBaseName } = parseArgs(process.argv.slice(2));
        if (!scenarioModuleBaseName) {
            throw new Error('hanging-runner: "--scenario <file>" argument is required');
        }

        const configCodesEnv = process.env.PKC_CONFIGS;
        if (!configCodesEnv) {
            throw new Error("hanging-runner: PKC_CONFIGS environment variable is required");
        }
        const [configCode] = configCodesEnv
            .split(",")
            .map((code) => code.trim())
            .filter(Boolean);
        if (!configCode) {
            throw new Error(`hanging-runner: failed to read config code from PKC_CONFIGS="${configCodesEnv}"`);
        }

        const scenarioModuleUrl = new URL(`../../../../test/node/hanging-test/scenarios/${scenarioModuleBaseName}`, import.meta.url);
        const scenarioModule = await import(scenarioModuleUrl.href);
        const scenarioDefinition: HangingScenarioDefinition = resolveHangingScenarioModule(scenarioModule, scenarioModuleBaseName);

        await scenarioDefinition.run({ configCode });

        const report = await waitForCleanup();
        const hasRemainingHandles = report.remainingHandles > 0;
        const hasRemainingRequests = report.remainingRequests > 0;

        if (hasRemainingHandles || hasRemainingRequests) {
            console.error(JSON.stringify(report, null, 2));
            nodeProcess.exitCode = 1;
        } else {
            console.error(JSON.stringify(report, null, 2));
        }
    } catch (error) {
        console.error("hanging-runner failure:", error);
        process.exitCode = 1;
    }
}

await run();
process.exit();

function collectActiveResources() {
    const isStandardStream = (handle: unknown) => handle === process.stdout || handle === process.stderr || handle === process.stdin;

    const describeHandle = (handle: unknown) => {
        const name = (handle as any)?.constructor?.name;
        if (name === "Timeout") {
            return {
                type: name,
                _idleTimeout: (handle as any)?._idleTimeout,
                _repeat: (handle as any)?._repeat
            };
        }
        if (name === "Socket" || name === "TLSSocket" || name === "Pipe") {
            let addressInfo: Record<string, unknown> | undefined;
            try {
                const address = (handle as any)?.address?.();
                if (address && typeof address === "object") {
                    addressInfo = address;
                }
            } catch {
                // ignore
            }
            const peer = (handle as any)?._peername;
            const fd = (handle as any)?.fd ?? (handle as any)?._handle?.fd;
            const base = {
                type: name,
                destroyed: (handle as any)?.destroyed,
                localAddress: (handle as any)?.localAddress,
                localPort: (handle as any)?.localPort,
                remoteAddress: (handle as any)?.remoteAddress,
                remotePort: (handle as any)?.remotePort,
                peer,
                addressInfo,
                readyState: (handle as any)?.readyState,
                connecting: (handle as any)?.connecting,
                fd
            };
            if (name === "WriteStream" || name === "ReadStream" || name === "Pipe") {
                return { ...base, path: (handle as any)?.path };
            }
            return base;
        }
        return { type: name ?? typeof handle };
    };

    const describeRequest = (request: any) => {
        const name = request?.constructor?.name ?? typeof request;
        if (name === "GetAddrInfoReqWrap") {
            return {
                type: name,
                hostname: request?.hostname,
                family: request?.family
            };
        }
        if (name === "FileHandleCloseReq") {
            return {
                type: name,
                path: request?.path
            };
        }
        return { type: name };
    };

    const nodeProcess = process as NodeJS.Process & {
        _getActiveHandles: () => unknown[];
        _getActiveRequests: () => unknown[];
    };

    const activeHandlesRaw = nodeProcess._getActiveHandles();
    const activeRequestsRaw = nodeProcess._getActiveRequests();

    const filteredHandles = activeHandlesRaw.filter((handle: any) => {
        if (isStandardStream(handle)) return false;
        const name = handle?.constructor?.name;
        const fd = handle?.fd ?? handle?._handle?.fd;
        if ((name === "Socket" || name === "Pipe" || name === "WriteStream" || name === "ReadStream") && (fd === 0 || fd === 1 || fd === 2))
            return false;
        return true;
    });

    const filteredRequests = activeRequestsRaw.filter((request) => {
        const name = request?.constructor?.name ?? typeof request;
        return name !== "GetAddrInfoReqWrap" && name !== "FileHandleCloseReq";
    });

    return {
        message: "Active resources after pkc.destroy()",
        handles: activeHandlesRaw.map(describeHandle),
        requests: activeRequestsRaw.map(describeRequest),
        remainingHandles: filteredHandles.length,
        remainingRequests: filteredRequests.length
    };
}

async function waitForCleanup() {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let report = collectActiveResources();
    while ((report.remainingHandles || report.remainingRequests) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
        report = collectActiveResources();
    }
    const waitedMs = WAIT_TIMEOUT_MS - Math.max(0, deadline - Date.now());
    return { ...report, waitedMs, waitTimeoutMs: WAIT_TIMEOUT_MS };
}
