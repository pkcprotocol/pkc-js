import type { PKC } from "../../../../pkc/pkc.js";
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
 * `await pkc.destroy()` in a finally block once their work is done.
 */
export interface HangingScenarioContext {
    pkc: PKC;
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
export declare function defineHangingScenario(definition: HangingScenarioDefinition): HangingScenarioDefinition;
export declare function resolveHangingScenarioModule(moduleNamespace: unknown, moduleId: string): HangingScenarioDefinition;
export declare function createScenarioContext(configCode: string): Promise<HangingScenarioContext>;
