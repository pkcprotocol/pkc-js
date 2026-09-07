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
| `privateOptions` | Option names withheld from the public `community.pageSorts`. Package options only: a reserved option describes what the page contains and is always published (`ERR_PAGE_SORT_RESERVED_OPTION_CANNOT_BE_PRIVATE`) |

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
- **Single-chunk shortcut.** When every preloaded sort fits in one page, only those pages are published
  and no other sort is generated, provided the embedded pages hold the whole comment set: a client holding
  every comment rebuilds any other sort locally (see [Client side](#client-side)). A preloaded sort whose
  window or filter dropped comments cannot stand in for the others, so next to other sorts it takes the
  full path: it embeds, everything else goes to `pageCids`. Alone, a windowed preloaded sort still ships as
  the one embedded page, there is nothing else to generate.
- A flat reply sort (`newFlat`, `oldFlat`, or a package with `flat: true`) may be preloaded. Its page is
  one level: every descendant of the post is an entry of the array and no entry carries nested `replies`.
  The CommentUpdate verifier checks such a page against the post (`postCid`) rather than as direct
  replies, the rule fetched flat pages have always had.
- `settings` is replaced wholesale on edit, so pass the existing settings along, and an edit that omits
  `pages` unsets it.
- **Any change to `settings.pages` regenerates every CommentUpdate** on the next pass. Reply pages are
  only rebuilt for flagged comments, so without this an untouched comment would keep its old reply sorts
  indefinitely. One full regeneration is the cost of the edit.

### Reserved options

pkc-js reads these off every entry. They are ordinary string options, so a config UI renders them like any
other, and the file still receives them. Every sort runs with a full set of them: the scope default, then
the file's `defaultOptions`, then the entry's `options`. That merged set is what `community.pageSorts`
publishes per sort, so a client never needs to know the defaults below.

| Option | Values | Default |
|---|---|---|
| `maxAge` | A duration: `"36h"`, `"7d"`, `"2w"`, `"1M"`, `"1y"` (units `s m h d w M y`; `M` is 2629746s and `y` 31557600s, the windows `topMonth` / `topYear` have always used) | none |
| `pinnedFirst` | `"true"` / `"false"` | `"true"` |
| `excludeRemovedComments`, `excludeDeletedComments`, `excludeCommentPendingApproval`, `excludeCommentWithApprovedFalse`, `excludeCommentsWithDifferentCommunityAddress` | `"true"` / `"false"` | Per scope, the table in [pages.md, Moderation Visibility](pages.md#moderation-visibility): `posts` excludes all five, `replies` excludes only pending-approval and other-community comments |

Reserved options cannot be listed in `privateOptions`: a client re-sorting a page must know how its set was
filtered.

`maxAge` makes any sort a sliding window: "hot in the last 24 hours" is `{ name: "hot", options: { maxAge: "1d" } }`. Windows are relative to generation time; there are no absolute cutoffs. A windowed sort's page membership changes as comments age out even when nothing was posted, so its CID rotates on every rebuild: a post sort is rebuilt at least every 15 minutes, and a reply sort's parent is re-flagged only when a reply actually crosses the boundary. Six windowed sorts are six rotating CIDs, which pulls against the reason to configure fewer sorts.

`pinnedFirst: "true"` puts pinned comments first and lets them bypass the window, so a sticky never ages out. `"false"` treats them as ordinary comments.

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
same package (see [Client side](#client-side)):

```ts
community.pageSorts = {
    posts: {
        active: {
            name: "@pkcprotocol/active-page-sort",
            description: "Bump order where replies carrying a configured keyword do not bump",
            publicOptions: {
                noBumpKeywords: "sage",
                pinnedFirst: "true",
                excludeRemovedComments: "true",
                excludeDeletedComments: "true",
                excludeCommentPendingApproval: "true",
                excludeCommentWithApprovedFalse: "true",
                excludeCommentsWithDifferentCommunityAddress: "true"
            }
        }
    },
    replies: { old: { name: "old", description: "Oldest first", publicOptions: { pinnedFirst: "true", /* ... */ } } }
};
```

`name` is the registry key for `name:` entries and absent for `path:` entries. `publicOptions` is the
full option set the sort runs with, the merge described under [Reserved options](#reserved-options), minus
`privateOptions`: exactly what a client passes back to the package to reproduce the community's order. It
is the same object on the owner's instance and in the record. An unconfigured community publishes no
`pageSorts` at all. Older clients parse records loosely and ignore the field.

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
| A reserved option in `privateOptions` | `ERR_PAGE_SORT_RESERVED_OPTION_CANNOT_BE_PRIVATE` |
| The file's own `validatePageSortSettings` threw | `ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED` |

At generation time a sort whose file throws is skipped: the remaining sorts publish, and every cycle that
generates pages emits `ERR_PAGE_SORT_FAILED_TO_GENERATE` on the community's `error` event for each such
sort (with `sortName` and `scope` in `details`). A throwing preloaded sort drops out of `pages`; if none
survive the record ships `pages: {}`, and if every configured sort throws the record ships without that
scope's pages, with one error event per sort telling the host why. Only the sort file's own code is
treated this way: an error while pkc-js loads the comment set (a busy sqlite, a malformed row) aborts the
cycle, the last good record stays published and the next cycle retries.

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
        score({ comment, commentUpdate, options, baseTimestamp }) {   // per comment, no database: what clients run
            let score = comment.timestamp;
            const walk = (entry) => {
                for (const page of Object.values(entry.commentUpdate.replies?.pages ?? {}))
                    for (const child of page.comments) {
                        if (!keywords.includes(child.comment.content?.trim())) score = Math.max(score, child.comment.timestamp);
                        walk(child);
                    }
            };
            walk({ comment, commentUpdate });
            return score;
        },
        scoreAll({ comments, db, options, baseTimestamp }) {           // whole set, over SQL: what the community runs
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

- **Two scoring functions, for two places.** `scoreAll` is a whole-set function, called once per
  generation with every comment that survived the window, returning `Map<cid, number>`; it receives the
  database facade, so `active` can be `MAX(timestamp)` over every descendant in the table, which no
  per-comment function can express there. `score` is a per-comment function over what a page entry
  carries: the comment, its CommentUpdate and the preloaded reply pages nested under it. It is what a
  client runs to re-sort a page, since a client has no database, and what the community runs when a file
  has no `scoreAll`. Higher scores sort first in both. A file needs at least one; a file that wants
  clients to reproduce its order provides `score`, and keeps the two consistent over what a page carries.
  The pure built-ins (`hot`, `new`, `old`, `best`, `top*`, `controversial`, the flat variants) provide
  `score` only; `active` provides `scoreAll` only and therefore cannot be re-applied on a client.
- Neither is a comparator, and neither filters: membership is decided by the reserved options, which
  pkc-js applies identically on the community and on clients.
- **Sync only.** Generation runs per comment per cycle; an async signature would invite a network call in
  the community's hot loop. This is a deliberate divergence from `ChallengeFile.getChallenge`.
- `db` is a **read-only** sqlite facade: `prepare(sql)` returns better-sqlite3's `Statement` (so the
  upstream docs apply) and rejects anything that would write with `ERR_PAGE_SORT_DB_WRITE_REJECTED`;
  `exclusionClauses(options, { comment, update, paramPrefix })` returns the `WHERE` fragment and named
  params for the `exclude*` options against your own table aliases, so your SQL and pkc-js cannot drift
  apart on what "removed" means. Use distinct `paramPrefix` values when you splice it twice into one
  statement. The tables are `comments` and `commentUpdates`. The facade lives for the life of the
  community's database handler; do not cache prepared statements across cycles, the underlying connection
  may be reopened. Preparing a statement in the factory closure is fine: outside a community (the RPC
  settings listing, a client instantiating the file) the facade returns a statement whose execution throws,
  so construction still succeeds.
- pkc-js owns pinned placement, `maxAge`, chunking and page-size budgeting. A file contains no date
  arithmetic and never sees a pinned flag.
- Options are strings. Document how you split a list.
- `optionInputs` is optional but declaring it lets core catch typos in the owner's options; an entry may
  also list the reserved names, they are always accepted.
- The reference implementation of the keyword no-bump sort is
  `test/fixtures/page-sorts/active-no-bump-keyword.js`.

Registering a factory under the `pageSorts` PKC option (or on `PKC.pageSorts`) makes it available by
`name`; a `path` entry loads a file directly. Installing packages to `${dataPath}/page-sorts/` through
`bitsocial page-sort install` is bitsocial-cli work that builds on the same registry. A reload applies at
the next generation; a cycle producing some pages from the old version and some from the new is acceptable.

## Client side

How a UI library (bitsocial-react-hooks, 5chan, any consumer of `community.posts` / `comment.replies`)
integrates with configurable sorts. Nothing here needs a community database; everything runs in the browser.

### Discovering sorts

- The sorts a community offers are the keys of `posts.pages` and `posts.pageCids` (and `replies.*` on a
  comment). Any string is a legal key now, not only the built-in names: a package publishes under its own
  `sortName`, and a community may publish `controversial` for posts or a windowed `top`. The client state
  objects (`community.posts.clients.*`) are created for every key found in `pageCids`, on every transport.
- The first key of `pages` is the community's default sort. A key in `pages` is embedded (no fetch); a key
  only in `pageCids` is fetched with `getPage`, as before.
- `community.pageSorts[scope][sortName]` says what each key is: `name` is the package the community named
  in `settings.pages` (absent for a file loaded by `path`), `description` is the file's, `publicOptions`
  is the full option set the sort ran with. A community without `settings.pages` has no `pageSorts`;
  treat its keys as the built-ins they have always been.
- `pinnedFirst: "false"` and multiple preloaded sorts are opt-in; a client that hoists pinned comments by
  sort-name recognition, or assumes one preloaded sort, only misbehaves on boards that opted in. Read
  `publicOptions.pinnedFirst` instead of guessing.

### Re-sorting a page locally

When the embedded page holds the whole comment set (the single-chunk shortcut: `pageCids` is absent), a
client can offer every sort it has without fetching anything, and can reproduce the community's own order
after a local change. pkc-js ships the sorter; the package is looked up by name:

```ts
import PKC, { sortPageComments, instantiatePageSortFile } from "@pkcprotocol/pkc-js";
import activePageSort from "@pkcprotocol/active-page-sort";

const pkc = await PKC({ pageSorts: { "@pkcprotocol/active-page-sort": activePageSort } }); // what the community names

const sortName = Object.keys(community.posts.pages)[0]; // the community's default
const published = community.pageSorts?.posts?.[sortName]; // undefined on an unconfigured community
const factory = (published?.name && pkc.settings.pageSorts?.[published.name]) ?? PKC.pageSorts[published?.name ?? sortName];
const file = instantiatePageSortFile({ factory, pageSortSettings: { name: published?.name ?? sortName, options: published?.publicOptions } });

const ordered = sortPageComments({
    comments: community.posts.pages[sortName].comments, // parsed page comments, or the wire entries; same shape back
    file,
    options: published?.publicOptions ?? {},           // the merged reserved options: this is the filter the community applied
    baseTimestamp: Math.round(Date.now() / 1000),
    communityAddress: community.address
});
```

- `sortPageComments` applies the reserved options exactly as the community does (the `exclude*` flags,
  `pinnedFirst`, the `maxAge` window against `baseTimestamp`) and then the file's `score`. Pass the
  `publicOptions` of the sort you want to reproduce; to apply a different sort, pass that sort's options
  (or the community's for a same-scope built-in) and its file.
- To re-sort with a built-in, instantiate it from `PKC.pageSorts` (`hot`, `new`, `topDay`, ...). `top*`
  windows come from the file's `defaultOptions`, so passing `{}` as options applies them; a community that
  changed a window publishes the change in `publicOptions`.
- A package whose file has only `scoreAll` cannot run on a client:
  `ERR_PAGE_SORT_FILE_HAS_NO_CLIENT_SCORER`. The built-in `active` is one; a bump-order UI on an
  unconfigured community keeps using the community's `active` page.
- A page that is not the whole set (a `pageCids` page, or an embedded page next to `pageCids`) is only a
  slice of one sort: re-sorting it gives that slice in another order, not the other sort. Fetch the other
  sort's `pageCids` instead.
- Flat reply pages are one level; `score` on a flat entry sees no nested replies. `newFlat` and `oldFlat`
  only need the entry's own timestamp.
- `community.pageSorts[].name` is untrusted data: look it up in your own registry, never import from it.

### Configuring sorts from a UI

`settings.pages` is edited like `settings.challenges`; over RPC the server's registry is listed in
`pkc.clients.pkcRpcClients[url].settings.pageSorts` (each file minus its functions, so `optionInputs`,
`description`, `scope`, `flat` and `defaultOptions` are there to render a form), and an entry naming a sort
the server does not have is rejected client-side with `ERR_RPC_CLIENT_PAGE_SORT_NAME_NOT_AVAILABLE_ON_SERVER`
before the round trip. Send the reserved options like any other option; withhold package secrets with
`privateOptions`, never a reserved option.

## Not in scope

- Per-depth reply sorts (see [pages.md, Future Work](pages.md#future-work)).
- Absolute time windows, write access from sort packages, raw database access without the facade.
