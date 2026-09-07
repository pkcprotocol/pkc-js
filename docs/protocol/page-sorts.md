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
| `active` | posts | Bump order: the newest of the post's own timestamp and its CommentUpdate's `lastReplyTimestamp`, so a client re-sorts by bump order from the page alone |
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

A file default-exports a factory, invoked once per community start and per settings edit with the entry.
The returned object is cached and reused by every generation.

```js
export default function ({ pageSortSettings }) {
    const keywords = (pageSortSettings.options?.noBumpKeywords ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    return {
        sortName: "active",                    // the wire key; public API of your package, changing it breaks every board using it
        description: "Bump order where replies carrying a configured keyword do not bump",
        scope: "posts",                        // "posts" | "replies" | omitted for either
        flat: false,                           // reply sorts only: score the flattened subtree
        requireReplies: true,                  // this sort reads the replies; pkc-js supplies them (see below)
        optionInputs: [{ option: "noBumpKeywords", label: "No-bump keywords", description: "Comma-separated" }],
        defaultOptions: {},                    // merged under the entry's options
        score({ comment, commentUpdate, options, baseTimestamp, replies }) {
            let score = comment.timestamp;
            for (const reply of replies) if (!keywords.includes(reply.comment.content?.trim())) score = Math.max(score, reply.comment.timestamp);
            return score;
        },
        validatePageSortSettings({ pageSortSettings }) {}  // throw to reject the entry
    };
}
```

The contract:

- **One scorer, run in two places.** `score` is a per-comment, synchronous function of what a page entry
  carries: the comment and its CommentUpdate. The community calls it once per comment per generation, and a
  client calls the same function to re-sort a page it holds (see [Client side](#client-side)), which is
  how a client reproduces the community's order. Higher scores sort first. The CommentUpdate arrives with
  its nested `replies` stripped: a file never sees the preloaded reply slice, so it cannot mistake it for
  the reply set.
- **Ties keep the community's order.** Equal scores keep the order the comments were loaded in, which is the
  community's insertion order at generation and the page's order on a client. There is no comparator and
  no secondary key; a file that needs a tie-break folds it into the score.
- **`null` declines.** Returning `null` drops the comment from this sort's pages, on the community and on
  a client, a pinned comment included. It touches nothing else: other sorts, `replyCount`, the
  CommentUpdate. The reserved options decide the base set every sort starts from; a sort may decline from
  it. This is how a package exposes a content filter, an option such as `filterNsfw` applied inside
  `score`, and a client passing the published options reproduces the drop. Any other non-numeric score is
  a bug and fails the sort for the cycle.
- **`requireReplies`.** A sort whose order depends on the replies (bump order with exceptions, most-replied
  first) declares it and receives `replies`: every descendant of the scored comment that survives the
  sort's exclusion options, as one flat, unordered array. A post gets everything under it, a reply on a
  reply page gets its own subtree. Each entry is the lean `PageSortReplyEntry`: the comment's `parentCid`,
  `postCid`, `depth`, `timestamp`, `content`, `title`, `link`, `author`, community address fields, `nsfw`,
  `spoiler` and `flairs`, and the CommentUpdate's `cid`, vote and reply counts, `updatedAt`,
  `lastReplyTimestamp`, `pinned`, `locked`, `removed`, `approved`, `nsfw`, `spoiler`, `flairs` and
  `edit.deleted`. No signature, no nested pages, no media metadata. A page entry is a superset, so a client
  passes the entries it walked as they are. The community loads the set once per generation with one
  unfiltered query (the whole community for a post sort, the post's subtree for a reply sort), every
  `requireReplies` sort filters it with its own exclusion options and slices each comment's subtree from
  it. On a client the caller walks the reply pages and passes the list, or `sortPageComments` throws
  `ERR_PAGE_SORT_REPLIES_REQUIRED`. A file without the flag never receives `replies` and costs nothing
  beyond the entry itself: re-sorting is then a per-entry computation with no reply fetching anywhere,
  which is what every built-in is, `active` included. A reply-dependent sort has no way to know the list is
  complete; a client that walked only part of a thread gets a wrong order, not an error.
- **What a reply-dependent sort costs the community.** `test/benchmarks/page-generation-bench.mjs` seeds
  20k posts with 10 to 100 replies each (1.1M replies) and times post page generation with IPFS stubbed. On
  that board the keyword no-bump sort takes about 16 s and 1 GB of heap per generation against about 2 s
  for the built-in `active`, which reads `lastReplyTimestamp` and loads no replies. The cost is linear in
  the reply count, so a board with a million posts should not configure a reply-dependent post sort; a
  5chan-sized board (a few hundred live threads) does not notice it.

- **Sync only.** Generation runs per comment per cycle; an async signature would invite a network call in
  the community's hot loop. This is a deliberate divergence from `ChallengeFile.getChallenge`.
- pkc-js owns pinned placement, `maxAge`, chunking, page-size budgeting and the exclusions. A file contains
  no date arithmetic, never sees a pinned flag and never decides what "removed" means.
- Options are strings. Document how you split a list.
- `optionInputs` is optional but declaring it lets core catch typos in the owner's options; an entry may
  also list the reserved names, they are always accepted.
- There is no database access. A sort that needs an aggregate the reply list cannot express (an author's
  history, vote timing) is a later iteration of this contract, not a reason to reach for the tables.
- The reference implementation of the keyword no-bump sort is
  `test/fixtures/page-sorts/active-no-bump-keyword.js`; `test/fixtures/page-sorts/keyword-filter.js`
  declines comments, and `test/fixtures/page-sorts/most-replies.js` scores a reply over its own subtree.

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

pkc-js ships the sorter; the package is looked up by name:

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
    communityAddress: community.address,
    replies                                             // only for a file with requireReplies; see below
});
```

- `sortPageComments` applies the reserved options exactly as the community does (the `exclude*` flags,
  `pinnedFirst`, the `maxAge` window against `baseTimestamp`), then the file's `score`, dropping what it
  declines. Pass the `publicOptions` of the sort you want to reproduce; to apply a different sort, pass
  that sort's options (or the community's for a same-scope built-in) and its file.
- To re-sort with a built-in, instantiate it from `PKC.pageSorts` (`hot`, `new`, `active`, `topDay`, ...).
  `top*` windows come from the file's `defaultOptions`, so passing `{}` as options applies them; a community
  that changed a window publishes the change in `publicOptions`. No built-in requires replies: `active`
  reads `commentUpdate.lastReplyTimestamp`, so a bump-order feed on a board that publishes only `hot` is a
  per-entry computation over the `hot` pages, with nothing else fetched.
- **What is the whole set.** A preloaded page with no `pageCids` and no `nextCid` for its key is the
  complete comment set (the single-chunk shortcut); a client holding it can offer every sort it has without
  fetching anything. Any other page is a slice of one sort: re-sorting it gives that slice in another order,
  not the other sort.
- **Deriving a sort the community did not publish** needs the whole set: walk every page of any published
  sort, then re-sort. To bound the walk with a window, walk a base sort that is monotonic in the window's
  key and stop at the cutoff: `new` or `old` for post age, the community's `active` for bump age. `hot` and
  the `top*` sorts are monotonic in neither, so a walk over them cannot stop early. A windowed sort the
  community publishes (`maxAge`) is already the whole set for its window.
- **Applying a reply-dependent package** (`requireReplies`), the community's own or one the UI installed to
  apply to every board it shows, needs the reply set of each comment on the page. The caller walks each
  thread's reply pages into one flat list and passes it as `replies`: a flat reply sort (`newFlat`,
  `oldFlat`, published by default) lists a post's whole subtree in one chain of pages; without one, walk
  the nested sort's pages and every reply's own reply pages recursively, since a nested reply carries its
  own `replies.pages` and `nextCid`. `sortPageComments` applies the exclusions to the list and slices each
  comment's subtree from it, so pass the descendants of every comment on the page together. How many
  threads to walk and when to stop is the UI's policy; pkc-js exports no walker, the worked example is
  `test/node-and-browser/pages/page-sorts-client-test-util.ts`. A file without `requireReplies` needs none
  of this.
- Flat reply pages are one level; `newFlat` and `oldFlat` only need the entry's own timestamp.
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
- Absolute time windows; database access from sort packages (a later iteration, additive to this contract).
