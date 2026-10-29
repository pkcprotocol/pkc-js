// Page size limits shared by the community that writes pages and the readers that load them. Dependency-free, so both
// the node page generator and the client page loaders can import it.

const MiB = 1024 * 1024;

// The largest page a community publishes, and the most a reader accepts for one. Pages double in size from 1 MiB until
// they reach this, then stay at it (issue #360): a page is built as one string at about twice its size in heap, and an
// uncapped page past ~512 MiB cannot be built at all.
export const MAX_PAGE_SIZE_BYTES = 32 * MiB;

// A reader allows each nextCid page twice the size of the page before it, up to MAX_PAGE_SIZE_BYTES. Uncapped, the
// allowance on a long chain passes 2^53 (rejected by the RPC page params) and then int64 (rejected by kubo's cat length).
export const nextPageMaxSizeBytes = (pageMaxSizeBytes: number): number => Math.min(pageMaxSizeBytes * 2, MAX_PAGE_SIZE_BYTES);
