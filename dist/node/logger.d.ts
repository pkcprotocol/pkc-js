interface Logger {
    (formatter: any, ...args: any[]): void;
    error: (formatter: any, ...args: any[]) => void;
    trace: (formatter: any, ...args: any[]) => void;
}
declare function Logger(namespace: string): Logger;
declare namespace Logger {
    const disable: () => void;
    const enable: (namespaces: string) => void;
    const enabled: (namespaces: string) => boolean;
}
export default Logger;
