/**
 * Baseline scenario that simply exercises the PKC lifecycle.
 * The scenario itself is responsible for destroying the instance so the test
 * harness can measure whether anything keeps the process or worker alive.
 */
declare const _default: import("./hanging-test-util.js").HangingScenarioDefinition;
export default _default;
