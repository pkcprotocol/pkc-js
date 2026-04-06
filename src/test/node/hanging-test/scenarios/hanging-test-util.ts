import type { PKC } from "../../../../pkc/pkc.js";
import { getAvailablePKCConfigsToTestAgainst } from "../../../test-util.js";

/**
 * Arguments supplied to each hanging-test scenario from the test harness.
 * `configCode` maps to one of the entries returned by
 * `getAvailablePKCConfigsToTestAgainst`.
 */
export interface HangingScenarioArgs {
    configCode: string;
}

/**
 * Resolved context after looking up the config and instantiating a PKC
 * instance. Scenarios should call `createScenarioContext` and make sure to
 * `await plebbit.destroy()` in a finally block once their work is done.
 */
export interface HangingScenarioContext {
    plebbit: PKC;
    config: {
        name: string;
        testConfigCode: string;
    };
}

export type HangingScenario = (args: HangingScenarioArgs) => Promise<void>;

export interface HangingScenarioDefinition {
    id: string;
    description: string;
    run: HangingScenario;
}

export function defineHangingScenario(definition: HangingScenarioDefinition): HangingScenarioDefinition {
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

    const normalizedDefinition: HangingScenarioDefinition = {
        id: id.trim(),
        description: description.trim(),
        run
    };

    return normalizedDefinition;
}

export function resolveHangingScenarioModule(moduleNamespace: unknown, moduleId: string): HangingScenarioDefinition {
    const candidate =
        (moduleNamespace as any)?.default ?? (moduleNamespace as any)?.scenario ?? (moduleNamespace as any)?.hangingScenario ?? null;

    if (!candidate) {
        throw new Error(`Hanging scenario module "${moduleId}" does not export a default, "scenario", or "hangingScenario" definition`);
    }

    return defineHangingScenario(candidate as HangingScenarioDefinition);
}

export async function createScenarioContext(configCode: string): Promise<HangingScenarioContext> {
    const configs = getAvailablePKCConfigsToTestAgainst();
    const config = configs.find((candidate) => candidate.testConfigCode === configCode);
    if (!config) {
        const available = configs.map((candidate) => candidate.testConfigCode).join(", ");
        throw new Error(`Unknown PKC config code "${configCode}". Available configs: ${available}`);
    }

    const plebbit = await config.plebbitInstancePromise({ forceMockPubsub: true });
    return {
        plebbit,
        config: {
            name: config.name,
            testConfigCode: config.testConfigCode
        }
    };
}
