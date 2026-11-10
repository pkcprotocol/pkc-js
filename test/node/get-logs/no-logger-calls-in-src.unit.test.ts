import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Guard for issue #493: every logger under src/ is a child of a pkc instance's root (pkc.logger), so a line is
// captured in that instance's buffer and carries its tags. A `Logger(...)` call from @pkcprotocol/pkc-logger logs
// through the process-default root, which keeps no buffer, so a new one would silently leave pkc.getLogs(). Only test
// code (src/test/ utilities and src/rpc/test/, neither with an instance in scope) may use it. `createLogger(` is
// allowed: it makes a root.
const SRC_DIR = join(process.cwd(), "src");

function listTypeScriptFiles(dir: string): string[] {
    const files: string[] = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "test") continue;
        if (statSync(path).isDirectory()) files.push(...listTypeScriptFiles(path));
        else if (name.endsWith(".ts")) files.push(path);
    }
    return files;
}

describe("no Logger( call from @pkcprotocol/pkc-logger under src/ (#493)", () => {
    it("every non-test file under src/ derives its logger from an owner", () => {
        const offenders: string[] = [];
        for (const file of listTypeScriptFiles(SRC_DIR)) {
            const lines = readFileSync(file, "utf8").split("\n");
            lines.forEach((line, index) => {
                // `Logger(` not preceded by an identifier character or a dot: excludes createLogger( and obj.Logger(
                if (/(?<![\w.$])Logger\(/.test(line)) offenders.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
            });
        }
        expect(offenders, `Logger( calls under src/:\n${offenders.join("\n")}`).to.deep.equal([]);
    });
});
