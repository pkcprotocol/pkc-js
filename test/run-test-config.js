// Import necessary modules
import { spawn, execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const vitestConfigPath = path.join(projectRoot, "config", "vitest.config.ts");

/**
 * Type check TypeScript test files before running tests.
 * This ensures type errors are caught even though Vitest strips types without checking.
 */
const typeCheckTests = () => {
    const hasTypeScriptTests = fs.readdirSync(__dirname, { recursive: true }).some((file) => String(file).endsWith(".test.ts"));

    if (!hasTypeScriptTests) {
        return; // Skip type checking if no TypeScript test files exist yet
    }

    console.log("Type checking test files...");
    try {
        // Type check test files
        execSync("npx tsc --project test/tsconfig.json", {
            stdio: "inherit",
            cwd: projectRoot
        });
        console.log("Type checking passed.");
    } catch (error) {
        console.error("TypeScript type checking failed!");
        process.exit(1);
    }
};

const DEFAULT_NODE_OPTIONS = [
    "--experimental-specifier-resolution=node",
    "--trace-warnings",
    "--unhandled-rejections=strict",
    "--trace-deprecation"
];

const sendSignalToProcessTree = (childProcess, signal) => {
    if (!childProcess || childProcess.killed) {
        return false;
    }
    if (process.platform !== "win32") {
        try {
            process.kill(-childProcess.pid, signal);
            return true;
        } catch (error) {
            if (error.code !== "ESRCH") {
                console.error(`Failed to send ${signal} to process group ${childProcess.pid}:`, error);
            }
        }
    }
    try {
        childProcess.kill(signal);
        return true;
    } catch (error) {
        if (error.code !== "ESRCH") {
            console.error(`Failed to send ${signal} to process ${childProcess.pid}:`, error);
        }
    }
    return false;
};

const terminateProcessTree = (childProcess, label) => {
    if (!childProcess || childProcess.killed) {
        return;
    }
    sendSignalToProcessTree(childProcess, "SIGTERM");
    setTimeout(() => {
        if (!childProcess.killed) {
            console.warn(`Process ${childProcess.pid} still alive after SIGTERM (${label}); sending SIGKILL.`);
            sendSignalToProcessTree(childProcess, "SIGKILL");
        }
    }, 1000);
};

const applyNodeOptionsToEnv = (targetEnv) => {
    const existing = typeof targetEnv.NODE_OPTIONS === "string" ? targetEnv.NODE_OPTIONS.trim() : "";
    const customOptions = process.env.VITEST_NODE_OPTIONS ? process.env.VITEST_NODE_OPTIONS.split(/\s+/).filter(Boolean) : [];
    const combined = [...customOptions, ...DEFAULT_NODE_OPTIONS, existing].filter(Boolean).join(" ").trim();
    if (combined.length > 0) {
        targetEnv.NODE_OPTIONS = combined;
    }
};

// Add helper function to get browser version
function getBrowserVersion(browserPath, browserName) {
    try {
        const versionOutput = execSync(`"${browserPath}" --version`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"]
        });
        console.log(`${browserName} version: ${versionOutput.trim()}`);
        return versionOutput.trim();
    } catch (error) {
        console.warn(`Could not get ${browserName} version from ${browserPath}: ${error.message}`);
        return "Version check failed";
    }
}

function parseArgs(rawArgs) {
    const options = new Map();
    const positionals = [];

    for (let index = 0; index < rawArgs.length; index += 1) {
        const token = rawArgs[index];
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }

        const key = token.slice(2);
        const nextToken = rawArgs[index + 1];
        const hasValue = typeof nextToken === "string" && !nextToken.startsWith("--");

        if (!options.has(key)) {
            options.set(key, []);
        }

        if (hasValue) {
            options.get(key).push(nextToken);
            index += 1;
        } else {
            options.get(key).push(true);
        }
    }

    return { options, positionals };
}

function getLastOption(options, name) {
    const values = options.get(name);
    if (!values || values.length === 0) {
        return undefined;
    }
    return values[values.length - 1];
}

function getAllOptions(options, name) {
    const values = options.get(name);
    if (!values) {
        return [];
    }
    return values;
}

function resolveMaybePath(spec) {
    if (!spec || spec === true) {
        return undefined;
    }
    return path.isAbsolute(spec) ? spec : path.resolve(projectRoot, spec);
}

function prepareWriteStream(filePath) {
    if (!filePath) {
        return undefined;
    }
    fs.rmSync(filePath, { force: true });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return fs.createWriteStream(filePath, { flags: "w" });
}

const toPosixPath = (value) => value.split(path.sep).join("/");

function deriveIncludeGlobs(absoluteSpecPaths) {
    const uniqueGlobs = new Set();
    absoluteSpecPaths.forEach((absolutePath) => {
        if (typeof absolutePath !== "string" || absolutePath.length === 0) {
            return;
        }

        const stats = fs.statSync(absolutePath, { throwIfNoEntry: false });
        if (!stats) {
            return;
        }

        const relativePath = path.relative(projectRoot, absolutePath);
        if (relativePath.startsWith("..")) {
            return;
        }

        const posixRelative = toPosixPath(relativePath === "" ? "." : relativePath);
        if (stats.isDirectory()) {
            const trimmed = posixRelative.endsWith("/") ? posixRelative.slice(0, -1) : posixRelative;
            const base = trimmed.length > 0 ? trimmed : ".";
            uniqueGlobs.add(`${base}/**/*.test.{js,ts}`);
            return;
        }

        uniqueGlobs.add(posixRelative);
    });

    return Array.from(uniqueGlobs);
}

const rawArgs = process.argv.slice(2);
const { options, positionals } = parseArgs(rawArgs);

const normalizeBooleanFlag = (flagName) => {
    const values = options.get(flagName);
    if (!values) {
        return;
    }
    const extras = values.filter((value) => value !== true);
    if (extras.length > 0) {
        extras.forEach((extra) => {
            if (typeof extra === "string") {
                positionals.push(extra);
            }
        });
    }
    options.set(flagName, [true]);
};

["parallel"].forEach((flag) => normalizeBooleanFlag(flag));

const environment = getLastOption(options, "environment") ?? "node";
const normalizedEnvironment = environment.toLowerCase();
const isNodeEnvironment = normalizedEnvironment === "node";

const env = { ...process.env };

// Force DEBUG to keep colorized output locally; CI already injects its own settings
if (!env.GITHUB_ACTIONS && env.DEBUG_COLORS === undefined) {
    env.DEBUG_COLORS = "1";
}

let pkcConfigs = getLastOption(options, "pkc-config");
if (typeof pkcConfigs === "string") {
    pkcConfigs = pkcConfigs.trim();
    if (pkcConfigs.length === 0) {
        pkcConfigs = undefined;
    }
}

if (!pkcConfigs) {
    const envConfigs = env.PKC_CONFIGS ? env.PKC_CONFIGS.trim() : "";
    pkcConfigs = envConfigs.length > 0 ? envConfigs : undefined;
}

if (!pkcConfigs && !isNodeEnvironment) {
    console.error("========================================");
    console.error("ERROR: No --pkc-config argument provided!");
    console.error("Usage: node test/run-test-config.js --pkc-config <config1,config2,...> --environment <node|chrome|firefox>");
    console.error("========================================");
    process.exit(1);
}

if (pkcConfigs) {
    env.PKC_CONFIGS = pkcConfigs;
    if (pkcConfigs.includes("remote-pkc-rpc")) {
        env.USE_RPC = "1";
    }
} else {
    delete env.PKC_CONFIGS;
}

// Print the configs before running any tests
console.log("========================================");
if (pkcConfigs) {
    console.log("PKC_CONFIGS set to:", pkcConfigs);
    console.log("Configs array:", pkcConfigs.split(","));
} else {
    console.log("PKC_CONFIGS not provided; continuing without overriding configs.");
}
console.log("========================================");

console.log(`Running tests in ${environment} environment`);

const logPrefix = getLastOption(options, "log-prefix");
const stdoutLogPath =
    resolveMaybePath(getLastOption(options, "stdout-log")) ?? (logPrefix ? resolveMaybePath(`${logPrefix}.stdout.log`) : undefined);
const stderrLogPath =
    resolveMaybePath(getLastOption(options, "stderr-log")) ?? (logPrefix ? resolveMaybePath(`${logPrefix}.stderr.log`) : undefined);

const perTestLogDir = resolveMaybePath(getLastOption(options, "per-test-logs"));
if (perTestLogDir) {
    env.PER_TEST_LOG_DIR = perTestLogDir;
}

if (options.has("mocha-spec")) {
    console.warn("The --mocha-spec flag is deprecated. Pass test paths as positional arguments instead.");
}

const cliSpecArgs = positionals.length > 0 ? positionals : [];
const mochaSpecPaths =
    cliSpecArgs.length > 0 ? cliSpecArgs.map((spec) => resolveMaybePath(spec)).filter(Boolean) : [path.join(__dirname, "node-and-browser")];

if (cliSpecArgs.length > 0) {
    const includeGlobs = deriveIncludeGlobs(mochaSpecPaths);
    if (includeGlobs.length > 0) {
        env.VITEST_INCLUDE_GLOBS = JSON.stringify(includeGlobs);
    } else {
        delete env.VITEST_INCLUDE_GLOBS;
    }
} else {
    delete env.VITEST_INCLUDE_GLOBS;
}

const pickFirstDefined = (...values) => {
    for (const value of values) {
        if (value !== undefined && value !== true && value !== "") {
            return value;
        }
    }
    return undefined;
};

let vitestTimeoutValue = getLastOption(options, "vitest-timeout");
if (vitestTimeoutValue === undefined) {
    vitestTimeoutValue = getLastOption(options, "mocha-timeout");
}
if (vitestTimeoutValue === true) {
    vitestTimeoutValue = undefined;
}
if (vitestTimeoutValue === undefined) {
    vitestTimeoutValue = pickFirstDefined(
        env.VITEST_TIMEOUT,
        env.MOCHA_TIMEOUT,
        env.TEST_NODE_LOCAL_MOCHA_TIMEOUT_MS,
        isNodeEnvironment ? "160000" : undefined
    );
}

const npmLifecycleEvent = env.npm_lifecycle_event || env.NPM_LIFECYCLE_EVENT;
if (vitestTimeoutValue === undefined && npmLifecycleEvent === "test:node:parallel:remote") {
    vitestTimeoutValue = "160000";
}

const waitForStreamFinish = (stream) =>
    new Promise((resolve, reject) => {
        stream.once("finish", resolve);
        stream.once("error", reject);
    });

const runNodeTests = () => {
    applyNodeOptionsToEnv(env);
    env.VITEST_MODE = "node";

    const vitestCli = path.join(projectRoot, "node_modules", "vitest", "vitest.mjs");
    const allowOnlyFlag = getLastOption(options, "allowOnly");
    const allowOnlyValue =
        allowOnlyFlag === undefined ? "false" : allowOnlyFlag === true || allowOnlyFlag === "true" ? "true" : String(allowOnlyFlag);
    const vitestArgs = ["run", "--config", vitestConfigPath, "--allowOnly", allowOnlyValue];

    const isParallelMode = options.has("parallel");
    const userProvidedBail = options.has("bail");
    if (userProvidedBail) {
        const bailValue = getLastOption(options, "bail");
        const normalizedBail = bailValue === undefined || bailValue === true ? "1" : String(bailValue);
        vitestArgs.push("--bail", normalizedBail);
    } else if (!isParallelMode) {
        vitestArgs.push("--bail", "1");
    }

    if (isParallelMode) {
        vitestArgs.push("--fileParallelism");
        const jobs = getLastOption(options, "jobs");
        if (jobs !== undefined && jobs !== true) {
            vitestArgs.push("--maxWorkers", String(jobs));
        }
    }

    const reporterOverrides = getAllOptions(options, "reporter");
    if (reporterOverrides.length > 0) {
        reporterOverrides.forEach((reporter) => {
            if (typeof reporter === "string" && reporter.length > 0) {
                vitestArgs.push("--reporter", reporter);
            }
        });
    }

    if (vitestTimeoutValue !== undefined) {
        const timeoutString = String(vitestTimeoutValue);
        vitestArgs.push("--testTimeout", timeoutString, "--hookTimeout", timeoutString, "--teardownTimeout", timeoutString);
    }

    const passWithNoTestsFlag = getLastOption(options, "passWithNoTests");
    if (passWithNoTestsFlag !== undefined) {
        if (passWithNoTestsFlag === true) {
            vitestArgs.push("--passWithNoTests");
        } else {
            vitestArgs.push("--passWithNoTests", String(passWithNoTestsFlag));
        }
    } else if (options.has("no-passWithNoTests")) {
        vitestArgs.push("--no-passWithNoTests");
    } else {
        vitestArgs.push("--passWithNoTests"); // avoid failures when suites intentionally have no tests
    }

    vitestArgs.push(...mochaSpecPaths);

    console.log("Vitest CLI:", vitestCli);
    console.log("Vitest arguments:", vitestArgs.join(" "));
    if (stdoutLogPath || stderrLogPath) {
        console.log("Log capture:", {
            stdout: stdoutLogPath ?? "console only",
            stderr: stderrLogPath ?? "console only"
        });
    }

    const captureStreams = Boolean(stdoutLogPath || stderrLogPath);
    const stdoutStream = stdoutLogPath ? prepareWriteStream(stdoutLogPath) : undefined;
    const stderrStream = stderrLogPath ? prepareWriteStream(stderrLogPath) : undefined;

    const runnerProcess = spawn(process.execPath, [vitestCli, ...vitestArgs], {
        cwd: projectRoot,
        env,
        stdio: captureStreams ? ["ignore", "pipe", "pipe"] : "inherit",
        detached: true
    });

    const forwardSignal = (signal) => {
        if (!runnerProcess.killed) {
            sendSignalToProcessTree(runnerProcess, signal);
        }
    };

    ["SIGINT", "SIGTERM"].forEach((signal) => {
        process.on(signal, () => forwardSignal(signal));
    });
    const handleProcessExit = () => terminateProcessTree(runnerProcess, "wrapper exit");
    process.once("exit", handleProcessExit);

    if (captureStreams) {
        runnerProcess.stdout?.on("data", (chunk) => {
            stdoutStream?.write(chunk);
            process.stdout.write(chunk);
        });
        runnerProcess.stderr?.on("data", (chunk) => {
            stderrStream?.write(chunk);
            process.stderr.write(chunk);
        });
    }

    let exitHandled = false;

    const cleanupAndExit = async (code) => {
        if (exitHandled) {
            return;
        }
        exitHandled = true;

        const closePromises = [];
        if (stdoutStream) {
            stdoutStream.end();
            closePromises.push(waitForStreamFinish(stdoutStream));
        }
        if (stderrStream) {
            stderrStream.end();
            closePromises.push(waitForStreamFinish(stderrStream));
        }
        if (closePromises.length > 0) {
            try {
                await Promise.all(closePromises);
            } catch (streamError) {
                console.error("Failed to finalise log streams:", streamError);
            }
        }

        process.exit(code);
    };

    const finalize = (code) => {
        cleanupAndExit(code).catch((cleanupError) => {
            console.error("Failed during cleanup:", cleanupError);
            process.exit(code);
        });
    };

    const settle = (code, signal, source) => {
        if (exitHandled) {
            return;
        }

        if (signal) {
            console.error(`Vitest exited due to signal ${signal} (${source} event).`);
            finalize(1);
            return;
        }

        finalize(typeof code === "number" ? code : 1);
    };

    runnerProcess.once("error", (error) => {
        console.error("Failed to start Vitest:", error);
        finalize(1);
    });
    runnerProcess.once("exit", (code, signal) => {
        settle(code, signal, "exit");
    });
    runnerProcess.once("close", (code, signal) => settle(code, signal, "close"));
};

const runBrowserTests = () => {
    const vitestBin = path.join(projectRoot, "node_modules", ".bin", "vitest");

    env.VITEST_MODE = "browser";

    let vitestArgs = ["run", "--config", vitestConfigPath];

    const isParallelMode = options.has("parallel");
    if (isParallelMode) {
        vitestArgs.push("--fileParallelism");
        const jobs = getLastOption(options, "jobs");
        if (jobs !== undefined && jobs !== true) {
            vitestArgs.push("--maxWorkers", String(jobs));
        }
    }

    if (environment.toLowerCase().includes("chrome")) {
        env.VITEST_BROWSER = "chromium";
        console.log("Using Playwright's Chromium browser (default)");
    } else if (environment.toLowerCase().includes("firefox")) {
        env.VITEST_BROWSER = "firefox";
        console.log("Using Playwright's Firefox browser");
    }

    const reporterOverrides = getAllOptions(options, "reporter");
    if (reporterOverrides.length > 0) {
        reporterOverrides.forEach((reporter) => {
            if (typeof reporter === "string") {
                vitestArgs.push("--reporter", reporter);
            }
        });
    }

    if (cliSpecArgs.length > 0) {
        vitestArgs.push(...mochaSpecPaths);
    }

    console.log(`Running Vitest with environment: ${environment}`);
    console.log(`Vitest binary: ${vitestBin}`);
    console.log(`Vitest config: ${vitestConfigPath}`);
    console.log(`Vitest args: ${vitestArgs.join(" ")}`);
    console.log(`Environment variables: PKC_CONFIGS=${env.PKC_CONFIGS}, VITEST_BROWSER=${env.VITEST_BROWSER}`);

    const vitestProcess = spawn(vitestBin, vitestArgs, {
        stdio: "inherit",
        env,
        shell: true,
        detached: true
    });

    const terminateBrowserRunner = () => {
        terminateProcessTree(vitestProcess, "browser runner exit");
    };

    ["SIGINT", "SIGTERM"].forEach((signal) => {
        process.on(signal, () => {
            if (!vitestProcess.killed) {
                sendSignalToProcessTree(vitestProcess, signal);
            }
        });
    });
    process.on("exit", terminateBrowserRunner);

    vitestProcess.on("exit", (code) => {
        process.off("exit", terminateBrowserRunner);
        process.exit(code);
    });
};

const ensureTestServerIsRunning = async () => {
    try {
        await fetch("http://localhost:14952", { signal: AbortSignal.timeout(2000) });
    } catch {
        console.error("========================================");
        console.error("ERROR: Test server is not running!");
        console.error("Start it with: npm run test:server:node");
        console.error("========================================");
        process.exit(1);
    }
};

const ensureRpcServerIsRunning = async () => {
    const net = await import("net");
    const isReachable = await new Promise((resolve) => {
        const socket = net.createConnection({ port: 39652 }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
        socket.setTimeout(2000, () => {
            socket.destroy();
            resolve(false);
        });
    });
    if (!isReachable) {
        console.error("========================================");
        console.error("ERROR: RPC WebSocket server is not running on port 39652!");
        console.error("RPC tests require the RPC server. Start it with:");
        console.error("  npm run test:server:node:rpc");
        console.error("========================================");
        process.exit(1);
    }
};

// Ensure test server is reachable before doing anything else
await ensureTestServerIsRunning();

// If running RPC tests, also ensure the RPC WebSocket server is reachable
if (env.USE_RPC === "1") {
    await ensureRpcServerIsRunning();
}

// Type check TypeScript files before running tests
typeCheckTests();

if (isNodeEnvironment) {
    runNodeTests();
} else {
    runBrowserTests();
}
