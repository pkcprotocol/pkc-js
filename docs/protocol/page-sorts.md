# Page Sorts (`settings.pages`)

Which page sorts a community generates, which of them embed in the record, and how a sort is written as a
file or package. Reference for community operators and for page sort package authors. Background on pages
themselves is in [pages.md](pages.md); the design discussion is
[#73](https://github.com/pkcprotocol/pkc-js/issues/73).

## Why

Every reply page is regenerated per comment on every update cycle, and every post page on every publish.
A board like 5chan opens one post sort (`active`) and one reply sort (`old`); an author profile opens `new`
and nothing else. Generating the default nine post sorts and five reply sorts for them is wasted IPFS
blocks, publish time and rotating CIDs. Beyond subsetting, an operator can install a sort pkc-js has never
heard of, such as an `active` variant where replies carrying a configured keyword do not bump the thread.

## Configuration

`settings.pages` mirrors `settings.challenges`: a list of entries per scope, each naming a file by registry
`name` or by `path`, with string options.

```ts
await community.edit({
    settings: {
        ...community.settings,
        pages: {
            posts: [
                {
                    name: "@pkcprotocol/active-page-sort", // an installed package, or a built-in like "hot"
                    options: { noBumpKeywords: "sage" },
                    preloaded: true
                }
            ],
            replies: [{ name: "old", preloaded: true }]
        }
    }
});
```

| Field | Meaning |
|---|---|
| `name` | Key in `PKC.pageSorts`: the built-ins below, plus anything registered through the `pageSorts` PKC option (which shadows built-ins by name) |
| `path` | Path to a page sort file on the filesystem of the process running the community (the RPC server under RPC), like a challenge `path` |
| `options` | `Record<string, string>`, passed to the file unstripped. Lists are comma-separated by package convention |
| `preloaded` | Embed this sort's first page in the record. Default `false` |
| `privateOptions` | Option names withheld from the public `community.pageSorts` |

Rules:

- **Unset `settings.pages`** (or an unset `posts` / `replies` list) generates exactly what an unconfigured
  community always has: `hot, new, active, topHour, topDay, topWeek, topMonth, topYear, topAll` with `hot`
  preloaded, and `new, best, old, newFlat, oldFlat` with `best` preloaded.
- `posts: []` and `replies: []` are legal (a feed-only profile takes no replies).
- The wire key is the file's `sortName`, so `{ name: "top", options: { maxAge: "2w" } }` publishes `top`.
  Two entries resolving to the same `sortName` are rejected.
- No entry `preloaded` means nothing is embedded: `pages: {}` and every sort in `pageCids`. Several
  preloaded entries share the preload size budget equally, and one whose first page does not fit its share
  degrades to `pageCids` while the others still embed. The first preloaded entry in list order is the
  client's default sort.
- `settings` is replaced wholesale on edit, so pass the existing settings along, and an edit that omits
  `pages` unsets it.
- **Any change to `settings.pages` regenerates every CommentUpdate** on the next pass. Reply pages are
  only rebuilt for flagged comments, so without this an untouched comment would keep its old reply sorts
  indefinitely. One full regeneration is the cost of the edit.

### Reserved options

pkc-js reads these off every entry. They are ordinary string options, so a config UI renders them like any
other, and the file still receives them.

| Option | Values | Default |
|---|---|---|
| `maxAge` | A duration: `"36h"`, `"7d"`, `"2w"`, `"1M"`, `"1y"` (units `s m h d w M y`; `M` is 2629746s and `y` 31557600s, the windows `topMonth` / `topYear` have always used) | none |
| `pinnedFirst` | `"true"` / `"false"` | `"true"` |
| `excludeRemovedComments`, `excludeDeletedComments`, `excludeCommentPendingApproval`, `excludeCommentWithApprovedFalse`, `excludeCommentsWithDifferentCommunityAddress` | `"true"` / `"false"` | Per scope, the table in [pages.md, Moderation Visibility](pages.md#moderation-visibility) |

`maxAge` makes any sort a sliding window: "hot in the last 24 hours" is `{ name: "hot", options: { maxAge: "1d" } }`. Windows are relative to generation time; there are no absolute cutoffs. A windowed sort's page membership changes as comments age out even when nothing was posted, so its CID rotates on every rebuild: a post sort is rebuilt at least every 15 minutes, and a reply sort's parent is re-flagged only when a reply actually crosses the boundary. Six windowed sorts are six rotating CIDs, which pulls against the reason to configure fewer sorts.

`pinnedFirst: "true"` puts pinned comments first and lets them bypass both the window and the file's `filter`, so a sticky never ages out. `"false"` treats them as ordinary comments.

### Built-ins

| Name | Scope | Notes |
|---|---|---|
| `hot`, `new`, `old`, `best`, `controversial`, `top` | either | `top` has no window of its own; pair it with `maxAge` |
| `topHour`, `topDay`, `topWeek`, `topMonth`, `topYear`, `topAll` | either | `top` with a fixed `defaultOptions.maxAge` (`topAll` has none) |
| `active` | posts | Newest timestamp among the post and its surviving descendants, computed in SQL |
| `newFlat`, `oldFlat` | replies | Sort the flattened descendant subtree; generated for a post's replies only, ignored for deeper comments |

Configuring `newFlat` under `posts` or `active` under `replies` is a validation error (`ERR_PAGE_SORT_SCOPE_MISMATCH`).

### What is published

When `settings.pages` is set the record carries `community.pageSorts`, keyed by `sortName` per scope, so a
client can tell the built-in `active` from a package that reuses the name and re-sort locally with the
same package when the board fits in one chunk:

```ts
community.pageSorts = {
    posts: { active: { description: "...", publicOptions: { noBumpKeywords: "sage" } } },
    replies: { old: { name: "old", description: "Oldest first" } }
};
```

`name` is the registry key for `name:` entries and absent for `path:` entries. `publicOptions` is every
option the owner set minus `privateOptions`; the scope defaults and the file's own `defaultOptions` are
not published. An unconfigured community publishes no `pageSorts` at all. Older clients parse records
loosely and ignore the field.

## Validation and failure handling

Entries are validated on creation, on every edit (rejecting the whole write) and on start (each invalid
entry is its own `error` event and is skipped, the rest still publishes). Like challenges, the edit and
creation paths aggregate every failure under `ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS`
with one `failures[]` entry per bad sort; a file that does not load at all
(`ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY`) propagates on its own.

| Check | Error code |
|---|---|
| Two entries with the same `sortName` | `ERR_PAGE_SORT_DUPLICATE_SORT_NAME` |
| A sort with a declared `scope` under the other scope | `ERR_PAGE_SORT_SCOPE_MISMATCH` |
| An `options` key that is neither reserved nor declared in `optionInputs` | `ERR_PAGE_SORT_OPTION_NOT_DECLARED_IN_OPTION_INPUTS` |
| A missing option whose `optionInputs` entry is `required` | `ERR_PAGE_SORT_REQUIRED_OPTION_MISSING` |
| A reserved option pkc-js cannot parse | `ERR_PAGE_SORT_INVALID_RESERVED_OPTION` |
| A `privateOptions` name that is not set in `options` | `ERR_PAGE_SORT_PRIVATE_OPTION_NOT_SET` |
| The file's own `validatePageSortSettings` threw | `ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED` |

At generation time a sort whose file throws is skipped: the remaining sorts publish, and every cycle that
generates pages emits `ERR_PAGE_SORT_FAILED_TO_GENERATE` on the community's `error` event for each such
sort (with `sortName` and `scope` in `details`). A throwing preloaded sort drops out of `pages`; if none
survive the record ships `pages: {}`. A change in the set of generated post sort keys between cycles is
logged, not raised: a legitimate edit and a package rename look identical.

## Writing a page sort file

A file default-exports a factory, invoked once per community start and per settings edit with the entry
and the read-only database facade. The returned object is cached and reused by every generation.

```js
export default function ({ pageSortSettings, db }) {
    const keywords = (pageSortSettings.options?.noBumpKeywords ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    return {
        sortName: "active",                    // the wire key; public API of your package, changing it breaks every board using it
        description: "Bump order where replies carrying a configured keyword do not bump",
        scope: "posts",                        // "posts" | "replies" | omitted for either
        flat: false,                           // reply sorts only: score the flattened subtree
        optionInputs: [{ option: "noBumpKeywords", label: "No-bump keywords", description: "Comma-separated" }],
        defaultOptions: {},                    // merged under the entry's options
        filter({ comment, commentUpdate, options, baseTimestamp }) { return true; },
        scoreAll({ comments, db, options, baseTimestamp }) {
            const root = db.exclusionClauses(options, { comment: "p", update: "cu_root", paramPrefix: "root" });
            const desc = db.exclusionClauses(options, { comment: "c", update: "cu", paramPrefix: "desc" });
            const rows = db.prepare(`WITH RECURSIVE descendants AS (
                SELECT p.cid AS post_cid, p.cid AS current_cid, p.timestamp AS ts FROM comments p
                INNER JOIN commentUpdates cu_root ON p.cid = cu_root.cid WHERE p.depth = 0 ${root.sql ? `AND ${root.sql}` : ""}
                UNION ALL
                SELECT d.post_cid, c.cid, c.timestamp FROM comments c INNER JOIN commentUpdates cu ON c.cid = cu.cid
                JOIN descendants d ON c.parentCid = d.current_cid ${desc.sql ? `WHERE ${desc.sql}` : ""}
            ) SELECT post_cid, MAX(ts) AS score FROM descendants GROUP BY post_cid`).all({ ...root.params, ...desc.params });
            const scores = new Map(rows.map((r) => [r.post_cid, r.score]));
            return new Map(comments.map((e) => [e.commentUpdate.cid, scores.get(e.commentUpdate.cid) ?? e.comment.timestamp]));
        },
        validatePageSortSettings({ pageSortSettings }) {}  // throw to reject the entry
    };
}
```

The contract:

- **`scoreAll` is a whole-set function**, called once per generation with every comment that survived the
  filters, returning `Map<cid, number>`; higher scores sort first. It is not a comparator: `active` is
  `MAX(timestamp)` over a post's descendant set, which no per-comment function can express, and a keyword
  no-bump rule is a `WHERE` clause on that aggregate.
- **`filter` runs per comment before `scoreAll`**, on unpinned comments only when `pinnedFirst` is on.
- **Sync only.** Generation runs per comment per cycle; an async signature would invite a network call in
  the community's hot loop. This is a deliberate divergence from `ChallengeFile.getChallenge`.
- `db` is a **read-only** sqlite facade: `prepare(sql)` returns better-sqlite3's `Statement` (so the
  upstream docs apply) and rejects anything that would write with `ERR_PAGE_SORT_DB_WRITE_REJECTED`;
  `exclusionClauses(options, { comment, update, paramPrefix })` returns the `WHERE` fragment and named
  params for the `exclude*` options against your own table aliases, so your SQL and pkc-js cannot drift
  apart on what "removed" means. Use distinct `paramPrefix` values when you splice it twice into one
  statement. The tables are `comments` and `commentUpdates`. The facade lives for the life of the
  community's database handler; do not cache prepared statements across cycles, the underlying connection
  may be reopened.
- pkc-js owns pinned placement, `maxAge`, chunking and page-size budgeting. A file contains no date
  arithmetic and never sees a pinned flag.
- Options are strings. Document how you split a list.
- `optionInputs` is optional but declaring it lets core catch typos in the owner's options; an entry may
  also list the reserved names, they are always accepted.
- The reference implementation of the keyword no-bump sort is
  `test/fixtures/page-sorts/active-no-bump-keyword.js`.

A package is installed to `${dataPath}/page-sorts/` and referenced by `name`; registering a factory under
the `pageSorts` PKC option does the same in-process. A reload of a package applies at the next
generation; a cycle producing some pages from the old version and some from the new is acceptable.

## Client side

- Sorts are discovered from the keys of `posts.pages` / `posts.pageCids` and `replies.pages` /
  `replies.pageCids`; the first key of `pages` is the default.
- A non-preloaded custom sort is unavailable on a board that fits in one chunk (the single-chunk
  shortcut skips it). Re-sorting locally with the package's own scorer is a client-side concern that
  `community.pageSorts` makes possible; pkc-js does not ship it.
- `pinnedFirst: "false"` and multiple preloaded sorts are opt-in; a client that hoists pinned comments by
  sort-name recognition, or assumes one preloaded sort, only misbehaves on boards that opted in.

## Not in scope

- Per-depth reply sorts (see [pages.md, Future Work](pages.md#future-work)).
- Absolute time windows, write access from sort packages, raw database access without the facade.
