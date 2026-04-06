import BaseLogger from "@pkc/pkc-logger";

interface Logger {
    (formatter: any, ...args: any[]): void;
    error: (formatter: any, ...args: any[]) => void;
    trace: (formatter: any, ...args: any[]) => void;
}

const orderedNamespaceReplacements = [
    ["Communitys", "Communities"],
    ["subplebbits", "communities"],
    ["Community", "Community"],
    ["subplebbit", "community"],
    ["PKC", "PKC"],
    ["plebbit", "pkc"]
] as const;

export function normalizeLoggerNamespace(namespace: string): string {
    return orderedNamespaceReplacements.reduce((normalizedNamespace, [from, to]) => normalizedNamespace.replaceAll(from, to), namespace);
}

const normalizeLoggerPatterns = (namespaces: string): string => normalizeLoggerNamespace(namespaces);

function Logger(namespace: string): Logger {
    return BaseLogger(normalizeLoggerNamespace(namespace));
}

namespace Logger {
    export const disable = () => BaseLogger.disable();
    export const enable = (namespaces: string) => BaseLogger.enable(normalizeLoggerPatterns(namespaces));
    export const enabled = (namespaces: string) => BaseLogger.enabled(normalizeLoggerPatterns(namespaces));
}

export default Logger;
