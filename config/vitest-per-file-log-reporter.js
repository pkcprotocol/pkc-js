import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname, relative, basename } from "node:path";

export default class PerFileLogReporter {
    constructor() {
        this.logDir = process.env.PER_TEST_LOG_DIR;
        this.logsByTaskId = new Map(); // taskId -> { stdout: [], stderr: [] }
        this.ctx = undefined;
        this.installInterruptHandlers();
    }

    installInterruptHandlers() {
        if (!this.logDir) return;
        if (PerFileLogReporter._handlersInstalled) return;
        PerFileLogReporter._handlersInstalled = true;

        const flush = () => {
            try {
                this.flushPendingSync();
            } catch {
                // Swallow — best effort during interrupt
            }
        };
        // prependListener: vitest installs its own SIGINT handler that may
        // call process.exit synchronously; ours must run first so buffered
        // per-test logs reach disk before the process is torn down.
        process.prependListener("SIGINT", flush);
        process.prependListener("SIGTERM", flush);
        process.prependListener("SIGHUP", flush);
        process.on("beforeExit", flush);
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

        this.writeModuleLogs(moduleId, stdout, stderr, /* append */ false);
    }

    onTestRunEnd() {
        this.flushPendingSync();
    }

    flushPendingSync() {
        if (!this.logDir || !this.ctx) return;
        if (this.logsByTaskId.size === 0) return;

        const byModule = new Map();
        for (const [taskId, entry] of this.logsByTaskId) {
            const entity = this.ctx.state.getReportedEntityById(taskId);
            if (!entity) continue;
            const mod = entity.type === "module" ? entity : entity.module;
            if (!mod) continue;
            if (!byModule.has(mod.moduleId)) {
                byModule.set(mod.moduleId, { stdout: [], stderr: [] });
            }
            const agg = byModule.get(mod.moduleId);
            agg.stdout.push(...entry.stdout);
            agg.stderr.push(...entry.stderr);
        }

        for (const [moduleId, agg] of byModule) {
            this.writeModuleLogs(moduleId, agg.stdout, agg.stderr, /* append */ true);
        }
        this.logsByTaskId.clear();
    }

    writeModuleLogs(moduleId, stdout, stderr, append) {
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

        const write = append ? appendFileSync : writeFileSync;
        if (stdout.length > 0) {
            write(stdoutPath, stdout.join("\n"));
        }
        if (stderr.length > 0) {
            write(stderrPath, stderr.join("\n"));
        }
    }
}
