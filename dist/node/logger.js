import BaseLogger from "@pkc/pkc-logger";
function Logger(namespace) {
    return BaseLogger(namespace);
}
(function (Logger) {
    Logger.disable = () => BaseLogger.disable();
    Logger.enable = (namespaces) => BaseLogger.enable(namespaces);
    Logger.enabled = (namespaces) => BaseLogger.enabled(namespaces);
})(Logger || (Logger = {}));
export default Logger;
//# sourceMappingURL=logger.js.map