import BaseLogger from "@pkc/pkc-logger";

interface Logger {
    (formatter: any, ...args: any[]): void;
    error: (formatter: any, ...args: any[]) => void;
    trace: (formatter: any, ...args: any[]) => void;
}

function Logger(namespace: string): Logger {
    return BaseLogger(namespace);
}

namespace Logger {
    export const disable = () => BaseLogger.disable();
    export const enable = (namespaces: string) => BaseLogger.enable(namespaces);
    export const enabled = (namespaces: string) => BaseLogger.enabled(namespaces);
}

export default Logger;
