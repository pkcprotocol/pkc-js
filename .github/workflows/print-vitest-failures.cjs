const fs = require("fs");
const path = require("path");

const reportDir = path.join(process.cwd(), ".vitest-reports");

if (!fs.existsSync(reportDir)) {
    console.log(`Vitest report directory not found at ${reportDir}`);
    process.exit(0);
}

const reportFiles = fs.readdirSync(reportDir).filter((f) => f.endsWith(".json"));
if (reportFiles.length === 0) {
    console.log(`No JSON report files found in ${reportDir}`);
    process.exit(0);
}

const reports = [];
for (const file of reportFiles) {
    const filePath = path.join(reportDir, file);
    try {
        reports.push({ file, report: JSON.parse(fs.readFileSync(filePath, "utf8")) });
    } catch (error) {
        console.error(`Could not parse ${filePath}:`, error);
    }
}

if (reports.length === 0) {
    console.log("No parseable vitest reports found.");
    process.exit(0);
}

const failedTests = [];
const unhandledErrors = [];
const seenEntries = new Set();

const normalizeMessage = (value) => {
    if (!value) {
        return "";
    }
    if (Array.isArray(value)) {
        return value.filter(Boolean).join("\n");
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "object") {
        const parts = [];
        if (typeof value.message === "string") {
            parts.push(value.message);
        }
        if (typeof value.stack === "string" && value.stack !== value.message) {
            parts.push(value.stack);
        }
        return parts.join("\n");
    }
    return String(value);
};

const trackEntry = (bucket, entry) => {
    const suite = entry.suite || "Unknown suite";
    const test = entry.test || "Unknown test";
    const message = normalizeMessage(entry.message).trim() || "No failure message provided";
    const key = `${entry.kind || "unknown"}::${suite}::${test}::${message}`;
    if (seenEntries.has(key)) {
        return;
    }
    seenEntries.add(key);
    bucket.push({
        suite,
        test,
        message
    });
};

for (const { report } of reports) {
    for (const suite of report.testResults || []) {
        for (const assertion of suite.assertionResults || []) {
            if (assertion.status === "failed") {
                trackEntry(failedTests, {
                    kind: "failed",
                    suite: suite.name,
                    test: assertion.fullName || assertion.title,
                    message: assertion.failureMessages
                });
            }
        }
        const suiteMessage = normalizeMessage(suite.message).trim();
        if (suiteMessage) {
            trackEntry(unhandledErrors, {
                kind: "unhandled",
                suite: suite.name,
                test: "Unhandled error",
                message: suiteMessage
            });
        }
    }

    for (const error of report.unhandledErrors || []) {
        trackEntry(unhandledErrors, {
            kind: "unhandled",
            suite: error.file || error.path || error.suite || "Unhandled errors",
            test: error.testName || error.name || "Unhandled error",
            message: error.stack || error.message || error
        });
    }
}

if (failedTests.length === 0 && unhandledErrors.length === 0) {
    console.log("No failed tests or unhandled errors found in vitest report.");
    process.exit(0);
}

console.log("Failed tests:");
for (const { suite, test, message } of failedTests) {
    console.log(`- ${suite}: ${test}`);
    for (const line of message.split("\n")) {
        console.log(`  ${line}`);
    }
}

if (unhandledErrors.length > 0) {
    console.log("Unhandled errors:");
    for (const { suite, test, message } of unhandledErrors) {
        console.log(`- ${suite}: ${test}`);
        for (const line of message.split("\n")) {
            console.log(`  ${line}`);
        }
    }
}
