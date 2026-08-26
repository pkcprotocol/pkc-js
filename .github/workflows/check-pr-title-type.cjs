// Fails when a PR title would hide releasable commits from the changelog.
//
// PRs land on master as squash merges, so the PR title becomes the only commit message
// and the individual branch commit types are discarded. release-it generates the changelog
// from that squashed subject, and config/.release-it.json lists the only types it renders.
// A PR full of `fix:` commits titled `chore:` therefore ships a release with empty notes,
// which is how v0.0.77 came out blank despite containing two kubo bug fixes.
//
// Reads the visible types straight out of config/.release-it.json so this check and the
// changelog can never disagree about what counts as releasable.
//
// Runs in two modes:
//   CI:    PR_TITLE=<title> node check-pr-title-type.cjs <file with one commit subject per line>
//   local: node check-pr-title-type.cjs --title "<title>" [--base master]
//          (or `npm run check:pr-title -- --title "<title>"`), which reads the commit subjects
//          from `git log <base>..HEAD` so the check can be run before opening or pushing a PR.

const fs = require("fs");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

const releaseItConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "config", ".release-it.json"), "utf8"));
const presetTypes = releaseItConfig.plugins["@release-it/conventional-changelog"].preset.types;
const visibleTypes = new Set(presetTypes.filter((type) => !type.hidden).map((type) => type.type));

// `type(scope)!: subject`, where the scope and the breaking-change `!` are both optional.
const conventionalSubject = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

const parseSubject = (subject) => {
    const match = conventionalSubject.exec(subject.trim());
    if (!match) return undefined;
    return { type: match[1].toLowerCase(), breaking: Boolean(match[3]) };
};

const { execFileSync } = require("child_process");

const argv = process.argv.slice(2);
const argValue = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
};

const title = argValue("--title") ?? process.env.PR_TITLE;
if (!title) {
    console.error("PR title is not set: pass --title \"<title>\" or set PR_TITLE");
    process.exit(1);
}

const commitsFile = argv.find((arg) => !arg.startsWith("--") && arg !== argValue("--title") && arg !== argValue("--base"));
const readCommitSubjects = () => {
    if (commitsFile) return fs.readFileSync(commitsFile, "utf8");
    const base = argValue("--base") ?? "master";
    return execFileSync("git", ["log", "--format=%s", `${base}..HEAD`], { cwd: repoRoot, encoding: "utf8" });
};

const parsedTitle = parseSubject(title);
if (!parsedTitle) {
    // The commitlint step already reports this with a better message; nothing to add here.
    console.log(`PR title is not a conventional commit, leaving it to commitlint: ${title}`);
    process.exit(0);
}

// A breaking change always gets its own changelog section regardless of type.
if (parsedTitle.breaking) {
    console.log(`PR title is marked breaking, so it is rendered in the changelog whatever its type.`);
    process.exit(0);
}
if (visibleTypes.has(parsedTitle.type)) {
    console.log(`PR title type "${parsedTitle.type}" is rendered in the changelog, nothing to check.`);
    process.exit(0);
}

const hiddenCommits = readCommitSubjects()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((subject) => ({ subject, parsed: parseSubject(subject) }))
    .filter(({ parsed }) => parsed && (parsed.breaking || visibleTypes.has(parsed.type)));

if (hiddenCommits.length === 0) {
    console.log(`No releasable commits in this PR, "${parsedTitle.type}" is the right title type.`);
    process.exit(0);
}

const sorted = [...visibleTypes].sort();
console.error(`PR title: ${title}`);
console.error("");
console.error(
    `This PR contains ${hiddenCommits.length} commit(s) that belong in the changelog, but the title type ` +
        `"${parsedTitle.type}" is not rendered by config/.release-it.json:`
);
console.error("");
for (const { subject } of hiddenCommits) console.error(`  ${subject}`);
console.error("");
console.error(
    `Because the merge is squashed, that title is the only message release-it sees, so these changes ` +
        `would ship in a release with empty notes.`
);
console.error("");
console.error(`Retitle the PR with the type that describes its user-visible effect (one of: ${sorted.join(", ")}),`);
console.error(`or retype the commits above if they turn out not to be user-visible after all.`);
process.exit(1);
