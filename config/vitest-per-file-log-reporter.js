import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";

export default class PerFileLogReporter {
    constructor() {
        this.logDir = process.env.PER_TEST_LOG_DIR;
        this.logsByTaskId = new Map(); // taskId -> { stdout: [], stderr: [] }
        this.ctx = undefined;
    }

    onInit(ctx) {
        this.ctx = ctx;
        this.logsByTaskId.clear();
    }

    onUserConsoleLog(log) {
        if (!this.logDir || !log.taskId) return;

        const key = String(log.taskId);
        if (!this.logsByTaskId.has(key)) {
            this.logsByTaskId.set(key, { stdout: [], stderr: [] });
        }
        const entry = this.logsByTaskId.get(key);
        if (log.type === "stderr") {
            entry.stderr.push(log.content);
        } else if (log.type === "stdout") {
            entry.stdout.push(log.content);
        }
    }

    onTestModuleEnd(testModule) {
        if (!this.logDir) return;

        const moduleId = testModule.moduleId;

        // Resolve which taskIds belong to this module
        const stdout = [];
        const stderr = [];
        for (const [taskId, entry] of this.logsByTaskId) {
            const entity = this.ctx.state.getReportedEntityById(taskId);
            if (!entity) continue;
            const mod = entity.type === "module" ? entity : entity.module;
            if (!mod || mod.moduleId !== moduleId) continue;

            stdout.push(...entry.stdout);
            stderr.push(...entry.stderr);
            this.logsByTaskId.delete(taskId);
        }

        if (stdout.length === 0 && stderr.length === 0) return;

        // Preserve directory structure from test/ onward
        // e.g. test/node/pkc/pkc.test.ts -> node/pkc/pkc
        const relPath = relative(this.ctx.config.root, moduleId);
        const testDirIndex = relPath.indexOf("test/");
        const fromTest = testDirIndex !== -1 ? relPath.slice(testDirIndex + "test/".length) : relPath;
        const stem = join(dirname(fromTest), basename(fromTest).replace(/\.(test|spec)\.(js|ts|mjs|mts)$/, ""));

        const stdoutPath = join(this.logDir, `${stem}.stdout.log`);
        const stderrPath = join(this.logDir, `${stem}.stderr.log`);
        mkdirSync(dirname(stdoutPath), { recursive: true });

        if (stdout.length > 0) {
            writeFileSync(stdoutPath, stdout.join("\n"));
        }
        if (stderr.length > 0) {
            writeFileSync(stderrPath, stderr.join("\n"));
        }
    }
}
