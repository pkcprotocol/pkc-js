const trackedAliasHistorySymbol = Symbol("trackedAliasHistory");
function isEthAliasDomain(address) {
    const lower = address.toLowerCase();
    return lower.endsWith(".eth") || lower.endsWith(".bso");
}
function getEquivalentCommunityAliases(address) {
    const lower = address.toLowerCase();
    if (lower.endsWith(".bso"))
        return [address, `${address.slice(0, -4)}.eth`];
    if (lower.endsWith(".eth"))
        return [address, `${address.slice(0, -4)}.bso`];
    return [address];
}
function dedupeAliases(aliases) {
    return [...new Set(aliases.filter((alias) => typeof alias === "string" && alias.length > 0))];
}
function getTrackedAliasHistory(target) {
    const holder = target;
    if (!holder[trackedAliasHistorySymbol]) {
        Object.defineProperty(holder, trackedAliasHistorySymbol, {
            value: new Set(),
            enumerable: false,
            configurable: false,
            writable: false
        });
    }
    return holder[trackedAliasHistorySymbol];
}
function persistAliases(target, aliases) {
    const aliasHistory = getTrackedAliasHistory(target);
    aliases.forEach((alias) => aliasHistory.add(alias));
    return [...aliasHistory];
}
export function getCommunityRegistryAliases(community) {
    const aliases = dedupeAliases([community.address, community.name, community.publicKey, community.signer?.address]);
    return dedupeAliases(aliases.flatMap((alias) => {
        if (isEthAliasDomain(alias))
            return getEquivalentCommunityAliases(alias);
        return [alias];
    }));
}
export function getCommentRegistryAliases(comment) {
    return dedupeAliases([comment.cid]);
}
export function syncCommunityRegistryEntry(registry, community) {
    return registry.track({ value: community, aliases: persistAliases(community, getCommunityRegistryAliases(community)) });
}
export function syncCommentRegistryEntry(registry, comment) {
    return registry.track({ value: comment, aliases: persistAliases(comment, getCommentRegistryAliases(comment)) });
}
export function findCommunityInRegistry(registry, lookup) {
    return registry.findByAliases(getCommunityRegistryAliases(lookup));
}
export function findCommentInRegistry(registry, lookup) {
    return registry.findByAliases(getCommentRegistryAliases(lookup));
}
export function listRegistryValues(registry) {
    return registry.values();
}
export function trackUpdatingCommunity(pkc, community) {
    return syncCommunityRegistryEntry(pkc._updatingCommunities, community);
}
export function trackStartedCommunity(pkc, community) {
    return syncCommunityRegistryEntry(pkc._startedCommunities, community);
}
export function trackUpdatingComment(pkc, comment) {
    return syncCommentRegistryEntry(pkc._updatingComments, comment);
}
export function untrackUpdatingCommunity(pkc, community) {
    pkc._updatingCommunities.untrack(community);
}
export function untrackStartedCommunity(pkc, community) {
    pkc._startedCommunities.untrack(community);
}
export function untrackUpdatingComment(pkc, comment) {
    pkc._updatingComments.untrack(comment);
}
export function refreshTrackedCommunityAliases(pkc, community) {
    if (pkc._updatingCommunities.has(community))
        syncCommunityRegistryEntry(pkc._updatingCommunities, community);
    if (pkc._startedCommunities.has(community))
        syncCommunityRegistryEntry(pkc._startedCommunities, community);
}
export function refreshTrackedCommentAliases(pkc, comment) {
    if (pkc._updatingComments.has(comment))
        syncCommentRegistryEntry(pkc._updatingComments, comment);
}
export function findUpdatingCommunity(pkc, lookup) {
    return findCommunityInRegistry(pkc._updatingCommunities, lookup);
}
export function findStartedCommunity(pkc, lookup) {
    return findCommunityInRegistry(pkc._startedCommunities, lookup);
}
export function findUpdatingComment(pkc, lookup) {
    return findCommentInRegistry(pkc._updatingComments, lookup);
}
export function listUpdatingCommunities(pkc) {
    return listRegistryValues(pkc._updatingCommunities);
}
export function listStartedCommunities(pkc) {
    return listRegistryValues(pkc._startedCommunities);
}
export function listUpdatingComments(pkc) {
    return listRegistryValues(pkc._updatingComments);
}
//# sourceMappingURL=tracked-instance-registry-util.js.map