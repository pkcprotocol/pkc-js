import { getAvailablePlebbitConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { resolveHangingScenarioModule } from "../../../dist/node/test/node/hanging-test/scenarios/hanging-test-util.js";
import { describe, it, beforeAll } from "vitest";
import type { HangingScenarioDefinition } from "../../../dist/node/test/node/hanging-test/scenarios/hanging-test-util.js";

interface ScenarioInfo {
    id: string;
    description: string;
    moduleBaseName: string;
}

interface ScenarioManifestEntry {
    id: string;
    description: string;
    moduleBaseName: string;
}

interface RunHangingScenarioOptions {
    configCode: string;
    timeoutMs: number;
    scenarioModuleBaseName: string;
}

const DESTROY_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.HANGING_TEST_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();
const SCENARIO_MANIFEST_FILENAME = "scenario-manifest.json";
const SCENARIO_DIST_DIR_URL = new URL("../../../dist/node/test/node/hanging-test/scenarios/", import.meta.url);
const SCENARIO_MANIFEST_URL = new URL(SCENARIO_MANIFEST_FILENAME, SCENARIO_DIST_DIR_URL);
const configs = getAvailablePlebbitConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });
const scenarioDefinitions = await loadScenarioDefinitions();

if (!scenarioDefinitions.length) {
    throw new Error("No hanging-test scenarios found. Add *.scenario.ts files under src/test/node/hanging-test/scenarios.");
}

let runHangingScenarioInChildProcess: (opts: RunHangingScenarioOptions) => Promise<void>;

beforeAll(async () => {
    ({ runHangingScenarioInChildProcess } = await import("../../../dist/node/runtime/node/test/helpers/run-hanging-node.js"));
});

// TODO we may need extra method for cleaning up after each sceneario, maybe make sure plebbit is destroyed?

for (const scenario of scenarioDefinitions) {
    describe.sequential(`[Scenario: ${scenario.description}]`, () => {
        for (const config of configs) {
            describe.sequential(`[Config: ${config.name}]`, () => {
                it(`Hanging sceneario: ${scenario.description}. It should not keep the Node process alive - ${config.name}`, async function () {
                    await runHangingScenarioInChildProcess({
                        configCode: config.testConfigCode,
                        timeoutMs: DESTROY_TIMEOUT_MS,
                        scenarioModuleBaseName: scenario.moduleBaseName
                    });
                });
            });
        }
    });
}

async function loadScenarioDefinitions(): Promise<ScenarioInfo[]> {
    const { readdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");

    const scenarioDistDirPath = fileURLToPath(SCENARIO_DIST_DIR_URL);
    const manifestPath = fileURLToPath(SCENARIO_MANIFEST_URL);
    const entries = await readdir(scenarioDistDirPath, { withFileTypes: true });
    const scenarioFiles = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".scenario.js"))
        .map((entry) => entry.name)
        .sort();

    if (!scenarioFiles.length) {
        throw new Error(`No compiled hanging-test scenarios found in ${scenarioDistDirPath}. Did you run "npm run build:node"?`);
    }

    const scenarios: ScenarioInfo[] = [];
    for (const fileName of scenarioFiles) {
        const moduleBaseName = fileName;
        const scenarioModuleUrl = new URL(moduleBaseName, SCENARIO_DIST_DIR_URL);
        const scenarioModule = await import(scenarioModuleUrl.href);
        const definition: HangingScenarioDefinition = resolveHangingScenarioModule(scenarioModule, moduleBaseName);
        scenarios.push({
            id: definition.id,
            description: definition.description,
            moduleBaseName
        });
    }

    ensureUniqueScenarioIds(scenarios);
    await writeScenarioManifest({
        manifestPath,
        distDirPath: scenarioDistDirPath,
        scenarios
    });
    return scenarios;
}

function ensureUniqueScenarioIds(scenarios: ScenarioInfo[]): void {
    const seen = new Set<string>();
    for (const scenario of scenarios) {
        if (typeof scenario.id !== "string" || !scenario.id.trim()) {
            throw new Error("Each scenario must provide a non-empty string id");
        }
        if (seen.has(scenario.id)) {
            throw new Error(`Duplicate hanging-test scenario id detected: "${scenario.id}"`);
        }
        seen.add(scenario.id);
    }
}

async function writeScenarioManifest({
    manifestPath,
    distDirPath,
    scenarios
}: {
    manifestPath: string;
    distDirPath: string;
    scenarios: ScenarioInfo[];
}): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(distDirPath, { recursive: true });
    const manifestPayload: ScenarioManifestEntry[] = scenarios.map(({ id, description, moduleBaseName }) => ({
        id,
        description,
        moduleBaseName
    }));
    await writeFile(manifestPath, JSON.stringify(manifestPayload, null, 2), "utf-8");
}
