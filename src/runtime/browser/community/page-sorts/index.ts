// Browser build of src/runtime/node/community/page-sorts/index.ts. Page generation is community-side and needs sqlite,
// so the registry is empty here, same as the challenges stub; PKC.pageSorts still exists so a browser client can
// register a package for client-side re-sorting (a file's `score`, issue #73).
import type { PageSortFileFactoryInput } from "../../../../community/types.js";

const pkcJsPageSorts: Record<string, PageSortFileFactoryInput> = {};
export { pkcJsPageSorts };
