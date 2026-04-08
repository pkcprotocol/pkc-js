import { getAvailablePKCConfigsToTestAgainst } from "../../../test-util.js";
export function defineHangingScenario(definition) {
    if (!definition || typeof definition !== "object") {
        throw new Error("defineHangingScenario: definition must be an object");
    }
    const { id, description, run } = definition;
    if (typeof id !== "string" || !id.trim()) {
        throw new Error("defineHangingScenario: id is required");
    }
    if (typeof description !== "string" || !description.trim()) {
        throw new Error("defineHangingScenario: description is required");
    }
    if (typeof run !== "function") {
        throw new Error("defineHangingScenario: run must be a function");
    }
    const normalizedDefinition = {
        id: id.trim(),
        description: description.trim(),
        run
    };
    return normalizedDefinition;
}
export function resolveHangingScenarioModule(moduleNamespace, moduleId) {
    const candidate = moduleNamespace?.default ?? moduleNamespace?.scenario ?? moduleNamespace?.hangingScenario ?? null;
    if (!candidate) {
        throw new Error(`Hanging scenario module "${moduleId}" does not export a default, "scenario", or "hangingScenario" definition`);
    }
    return defineHangingScenario(candidate);
}
export async function createScenarioContext(configCode) {
    const configs = getAvailablePKCConfigsToTestAgainst();
    const config = configs.find((candidate) => candidate.testConfigCode === configCode);
    if (!config) {
        const available = configs.map((candidate) => candidate.testConfigCode).join(", ");
        throw new Error(`Unknown PKC config code "${configCode}". Available configs: ${available}`);
    }
    const pkc = await config.pkcInstancePromise({ forceMockPubsub: true });
    return {
        pkc,
        config: {
            name: config.name,
            testConfigCode: config.testConfigCode
        }
    };
}
//# sourceMappingURL=hanging-test-util.js.map