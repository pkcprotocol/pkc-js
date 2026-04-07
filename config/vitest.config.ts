// @ts-nocheck - Vitest's type definitions don't include all runtime options
import { mkdirSync } from "node:fs";
import { defineConfig, defineProject } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const sharedTimeoutMs = Number.parseInt(process.env.VITEST_TIMEOUT ?? "120000", 10) || 80000;

const isFirefox = process.env.VITEST_BROWSER === "firefox";
const isGithubActions = Boolean(process.env.GITHUB_ACTIONS);
const vitestReportDir = ".vitest-reports";
const vitestJsonReportPath = `${vitestReportDir}/browser-tests.json`;
const stderrJsonReporterPath = "./config/vitest-stderr-json-reporter.js";
const baseReporters = ["verbose", [stderrJsonReporterPath, { outputFile: vitestJsonReportPath }]] as const;
const sharedReporters = isGithubActions ? [...baseReporters, "github-actions"] : [...baseReporters];

mkdirSync(vitestReportDir, { recursive: true });

const parseIncludeOverride = (): string[] | undefined => {
    const raw = process.env.VITEST_INCLUDE_GLOBS;
    if (!raw) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return undefined;
        }
        const filtered = parsed.map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0);
        return filtered.length > 0 ? filtered : undefined;
    } catch (error) {
        console.warn("Failed to parse VITEST_INCLUDE_GLOBS:", error);
        return undefined;
    }
};

const includeOverride = parseIncludeOverride();
const defaultNodeInclude = [
    "test/node/**/*.test.{js,ts}",
    "test/node-and-browser/**/*.test.{js,ts}",
    "test/challenges/**/*.test.{js,ts}",
    "src/rpc/test/node/**/*.test.{js,ts}",
    "src/rpc/test/node-and-browser/**/*.test.{js,ts}"
];
const defaultBrowserInclude = ["test/*browser/**/*.test.{js,ts}"];
const nodeTestInclude = includeOverride ?? defaultNodeInclude;
const browserTestInclude = includeOverride ?? defaultBrowserInclude;

const playwrightProvider = playwright(
    isFirefox
        ? {}
        : {
              launchOptions: {
                  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-web-security"]
              }
          }
);

const browserProject = defineProject({
    name: "browser",
    test: {
        browser: {
            enabled: true,
            provider: playwrightProvider,
            headless: true,
            screenshotFailures: false,
            instances: [
                {
                    browser: isFirefox ? "firefox" : "chromium"
                }
            ]
        },
        include: browserTestInclude,
        globals: true,
        setupFiles: ["./test/vitest-browser-setup.js"],
        env: {
            PKC_CONFIGS: process.env.PKC_CONFIGS,
            DEBUG: process.env.DEBUG,
            NO_COLOR: process.env.NO_COLOR,
            FORCE_COLOR: process.env.FORCE_COLOR,
            CI: process.env.CI
        },
        passWithNoTests: true,
        reporters: sharedReporters,
        testTimeout: sharedTimeoutMs,
        hookTimeout: sharedTimeoutMs,
        browserStartTimeout: sharedTimeoutMs,
        dangerouslyIgnoreUnhandledErrors: false,
        fileParallelism: false
    },
    define: {
        "process.env.PKC_CONFIGS": JSON.stringify(process.env.PKC_CONFIGS),
        "process.env.DEBUG": JSON.stringify(process.env.DEBUG),
        "globalThis.PKC_CONFIGS": JSON.stringify(process.env.PKC_CONFIGS),
        "window.PKC_CONFIGS": JSON.stringify(process.env.PKC_CONFIGS)
    },
    resolve: {
        alias: [
            {
                find: /^((\.\.\/)+)dist\/node(\/.*)?$/,
                replacement: (_match: string, relativePath: string, _lastSlash: string, subPath: string) => {
                    const path = subPath || "";
                    return `${relativePath}dist/browser${path}`;
                }
            }
        ]
    }
});

const nodeProject = defineProject({
    name: "node",
    test: {
        environment: "node",
        globals: true,
        setupFiles: ["./test/vitest-node-setup.js"],
        include: nodeTestInclude,
        allowOnly: false,
        passWithNoTests: false,
        dangerouslyIgnoreUnhandledErrors: false,
        reporters: sharedReporters,
        fileParallelism: false
    }
});

const getTarget = (): string | undefined => {
    const direct = process.env.VITEST_MODE ?? process.env.VITEST_TARGET;
    return typeof direct === "string" ? direct.toLowerCase() : undefined;
};

export default defineConfig(() => {
    const target = getTarget();
    if (target === "browser") {
        return browserProject;
    }
    return nodeProject;
});
