import { resolveHangingScenarioModule } from "../../../../test/node/hanging-test/scenarios/hanging-test-util.js";
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const parsedWaitMs = Number(process.env.HANGING_RUNNER_WAIT);
const WAIT_TIMEOUT_MS = Number.isFinite(parsedWaitMs) && parsedWaitMs > 0 ? parsedWaitMs : DEFAULT_WAIT_TIMEOUT_MS;
const parsedPollMs = Number(process.env.HANGING_RUNNER_POLL);
const WAIT_POLL_MS = Number.isFinite(parsedPollMs) && parsedPollMs > 0 ? parsedPollMs : 25;
const nodeProcess = process;
function parseArgs(argv) {
    const parsed = {};
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
async function run() {
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
        const scenarioDefinition = resolveHangingScenarioModule(scenarioModule, scenarioModuleBaseName);
        await scenarioDefinition.run({ configCode });
        const report = await waitForCleanup();
        const hasRemainingHandles = report.remainingHandles > 0;
        const hasRemainingRequests = report.remainingRequests > 0;
        if (hasRemainingHandles || hasRemainingRequests) {
            console.error(JSON.stringify(report, null, 2));
            nodeProcess.exitCode = 1;
        }
        else {
            console.error(JSON.stringify(report, null, 2));
        }
    }
    catch (error) {
        console.error("hanging-runner failure:", error);
        process.exitCode = 1;
    }
}
await run();
process.exit();
function collectActiveResources() {
    const isStandardStream = (handle) => handle === process.stdout || handle === process.stderr || handle === process.stdin;
    const describeHandle = (handle) => {
        const name = handle?.constructor?.name;
        if (name === "Timeout") {
            return {
                type: name,
                _idleTimeout: handle?._idleTimeout,
                _repeat: handle?._repeat
            };
        }
        if (name === "Socket" || name === "TLSSocket" || name === "Pipe") {
            let addressInfo;
            try {
                const address = handle?.address?.();
                if (address && typeof address === "object") {
                    addressInfo = address;
                }
            }
            catch {
                // ignore
            }
            const peer = handle?._peername;
            const fd = handle?.fd ?? handle?._handle?.fd;
            const base = {
                type: name,
                destroyed: handle?.destroyed,
                localAddress: handle?.localAddress,
                localPort: handle?.localPort,
                remoteAddress: handle?.remoteAddress,
                remotePort: handle?.remotePort,
                peer,
                addressInfo,
                readyState: handle?.readyState,
                connecting: handle?.connecting,
                fd
            };
            if (name === "WriteStream" || name === "ReadStream" || name === "Pipe") {
                return { ...base, path: handle?.path };
            }
            return base;
        }
        return { type: name ?? typeof handle };
    };
    const describeRequest = (request) => {
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
    const nodeProcess = process;
    const activeHandlesRaw = nodeProcess._getActiveHandles();
    const activeRequestsRaw = nodeProcess._getActiveRequests();
    const filteredHandles = activeHandlesRaw.filter((handle) => {
        if (isStandardStream(handle))
            return false;
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
//# sourceMappingURL=hanging-runner.js.map