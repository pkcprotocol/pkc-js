import { TrackedInstanceRegistry } from "../../../../pkc/tracked-instance-registry.js";
import type { LocalCommunity } from "../local-community.js";

// A global registry on process level to track started communities
export const processStartedCommunities = new TrackedInstanceRegistry<LocalCommunity>();
