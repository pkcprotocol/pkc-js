import BaseLogger from "@pkcprotocol/pkc-logger";

interface Logger {
    (formatter: any, ...args: any[]): void;
    error: (formatter: any, ...args: any[]) => void;
    trace: (formatter: any, ...args: any[]) => void;
}

// One logger per namespace: BaseLogger builds six debug instances per call (each probing the tty), and the hot paths
// of the community's update cycle ask for a logger per comment (issue #351). Namespaces are static strings, so the
// map stays small; enable/disable still apply, since a debug instance's `enabled` is evaluated on each log call.
const loggers = new Map<string, Logger>();

function Logger(namespace: string): Logger {
    let logger = loggers.get(namespace);
    if (!logger) {
        logger = BaseLogger(namespace);
        loggers.set(namespace, logger);
    }
    return logger;
}

namespace Logger {
    export const disable = () => BaseLogger.disable();
    export const enable = (namespaces: string) => BaseLogger.enable(namespaces);
    export const enabled = (namespaces: string) => BaseLogger.enabled(namespaces);
}

export default Logger;
