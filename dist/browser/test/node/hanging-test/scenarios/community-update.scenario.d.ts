/**
 * Template scenario showing the shape expected by the hanging test harness.
 * Replace the placeholder steps with the flow you want to exercise before
 * checking for lingering resources. Make sure any asynchronous work is awaited
 * so the destroy call can flush everything properly.
 */
declare const _default: import("./hanging-test-util.js").HangingScenarioDefinition;
export default _default;
