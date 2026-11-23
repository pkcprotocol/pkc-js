// Finds the places in src/ where an async function is handed to something that never awaits it, so a rejection of it
// is an unhandled rejection that ends a Node process: an async event listener, an async timer callback, a floating
// `void promise` with no catch. It uses the type checker, because most handlers are named methods (`.on("x", this.handler.bind(this))`),
// not inline arrows. A callback wrapped in guardDetached (src/detached-guard.ts), or in Publication's own
// _guardDetachedHandler, is guarded. Used by test/node/detached-entry-points.test.ts.
import ts from "typescript";
import path from "node:path";

export type DetachedSite = { key: string; file: string; line: number; kind: string; text: string };

const LISTENER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);
const TIMER_FUNCTIONS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "scheduleMacrotask"]);
const GUARDS = new Set(["guardDetached", "_guardDetachedHandler"]);
// Keys under which an object keeps an event listener that is registered later (`statechange: async (state) => ...`)
const LISTENER_PROPERTY_NAMES = new Set(["statechange", "updatingstatechange", "startedstatechange", "update", "error", "runtimeupdate"]);

export function findUnguardedDetachedEntryPoints(repoRoot: string): DetachedSite[] {
    const configPath = path.join(repoRoot, "config/tsconfig.json");
    const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    if (!config) throw new Error("Could not read config/tsconfig.json");
    const program = ts.createProgram(config.fileNames, config.options);
    const checker = program.getTypeChecker();
    const sites: DetachedSite[] = [];
    const srcRoot = path.join(repoRoot, "src") + path.sep;

    const isPromiseLike = (type: ts.Type): boolean => {
        const awaited = checker.getAwaitedType(type);
        return awaited !== undefined && awaited !== type;
    };
    const returnsPromise = (node: ts.Expression): boolean => {
        const type = checker.getTypeAtLocation(node);
        return type.getCallSignatures().some((signature) => isPromiseLike(checker.getReturnTypeOfSignature(signature)));
    };
    const isGuarded = (node: ts.Expression): boolean => {
        let current: ts.Expression = node;
        while (ts.isParenthesizedExpression(current)) current = current.expression;
        // `const listener = guardDetached(...); emitter.on("x", listener)`: guarded where it is defined
        if (ts.isIdentifier(current)) {
            const declaration = checker.getSymbolAtLocation(current)?.valueDeclaration;
            if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) return isGuarded(declaration.initializer);
            return false;
        }
        if (!ts.isCallExpression(current)) return false;
        const callee = current.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        return GUARDS.has(name);
    };
    const enclosingName = (node: ts.Node): string => {
        for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
            if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.getText();
            if (ts.isPropertyDeclaration(current) && current.name) return current.name.getText();
            if (ts.isClassDeclaration(current) && current.name) return `class ${current.name.text}`;
        }
        return "<module>";
    };
    const counters = new Map<string, number>();
    const record = (sourceFile: ts.SourceFile, node: ts.Node, kind: string, text: string) => {
        const file = path.relative(repoRoot, sourceFile.fileName);
        const base = `${file}::${enclosingName(node)}::${kind}`;
        const ordinal = (counters.get(base) ?? 0) + 1;
        counters.set(base, ordinal);
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        sites.push({ key: `${base}#${ordinal}`, file, line: line + 1, kind, text: text.replace(/\s+/g, " ").slice(0, 100) });
    };

    for (const sourceFile of program.getSourceFiles()) {
        if (!sourceFile.fileName.startsWith(srcRoot) || sourceFile.isDeclarationFile) continue;
        const relative = path.relative(srcRoot, sourceFile.fileName);
        if (relative.startsWith("test" + path.sep) || relative.startsWith(path.join("rpc", "test"))) continue;
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
                const isListener = ts.isPropertyAccessExpression(callee) && LISTENER_METHODS.has(calleeName);
                const isTimer = TIMER_FUNCTIONS.has(calleeName);
                if (isListener || isTimer)
                    for (const argument of node.arguments)
                        if (!isGuarded(argument) && returnsPromise(argument))
                            record(sourceFile, node, isListener ? `${calleeName} listener` : `${calleeName} callback`, argument.getText());
            }
            // `{ statechange: async (state) => ... }`: a handler stored in an object and registered later through a field whose
            // declared type says `=> void`, which hides that it is async from the checks above. Flagged where it is written.
            if (
                ts.isPropertyAssignment(node) &&
                LISTENER_PROPERTY_NAMES.has(node.name.getText()) &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
                node.initializer.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
                !(ts.isCallExpression(node.parent?.parent) && isGuarded(node.parent.parent))
            )
                record(sourceFile, node, "async property handler", node.getText());
            // `void somePromise` that is not `.catch(...)`ed: nothing observes its rejection
            if (ts.isVoidExpression(node)) {
                const operand = node.expression;
                const settledByCatch =
                    ts.isCallExpression(operand) && ts.isPropertyAccessExpression(operand.expression) && operand.expression.name.text === "catch";
                if (!settledByCatch && isPromiseLike(checker.getTypeAtLocation(operand))) record(sourceFile, node, "void promise", operand.getText());
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    return sites;
}
