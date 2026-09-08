// Browser build of src/runtime/node/community/page-sorts/index.ts. Page generation is community-side and needs sqlite,
// so the registry is empty here, same as the challenges stub. A browser client that wants to re-sort a page installs
// the package itself and calls its `score` (docs/protocol/page-sorts.md, "Client side"), it does not go through here.
import type { PageSortFileFactoryInput } from "../../../../community/types.js";

const pkcJsPageSorts: Record<string, PageSortFileFactoryInput> = {};
export { pkcJsPageSorts };
