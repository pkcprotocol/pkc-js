// Heap snapshot analysis for the leak suite (#496), node only.
//
// - countObjectsByConstructor(): live object counts per constructor name, so two snapshots can be
//   diffed to see which types grew (the table the #490 reporter built by hand with the inspector).
// - findRetainerPaths(): the shortest chains of references from a GC root to objects of a given
//   constructor, which is what a failing collection check needs to say *who* keeps an instance alive.
//
// Parses the V8 .heapsnapshot JSON format directly (nodes / edges / strings flat arrays).
import { readFileSync } from "node:fs";
import { writeHeapSnapshot } from "node:v8";

interface ParsedSnapshot {
    nodeFieldCount: number;
    edgeFieldCount: number;
    nodes: number[];
    edges: number[];
    strings: string[];
    nodeTypes: string[];
    edgeTypes: string[];
    typeOffset: number;
    nameOffset: number;
    edgeCountOffset: number;
    edgeTypeOffset: number;
    edgeNameOffset: number;
    edgeToNodeOffset: number;
}

function parseSnapshot(path: string): ParsedSnapshot {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
        snapshot: { meta: { node_fields: string[]; node_types: [string[]]; edge_fields: string[]; edge_types: [string[]] } };
        nodes: number[];
        edges: number[];
        strings: string[];
    };
    const meta = raw.snapshot.meta;
    return {
        nodeFieldCount: meta.node_fields.length,
        edgeFieldCount: meta.edge_fields.length,
        nodes: raw.nodes,
        edges: raw.edges,
        strings: raw.strings,
        nodeTypes: meta.node_types[0],
        edgeTypes: meta.edge_types[0],
        typeOffset: meta.node_fields.indexOf("type"),
        nameOffset: meta.node_fields.indexOf("name"),
        edgeCountOffset: meta.node_fields.indexOf("edge_count"),
        edgeTypeOffset: meta.edge_fields.indexOf("type"),
        edgeNameOffset: meta.edge_fields.indexOf("name_or_index"),
        edgeToNodeOffset: meta.edge_fields.indexOf("to_node")
    };
}

export function takeHeapSnapshot(path: string): string {
    return writeHeapSnapshot(path);
}

function nodeLabel(s: ParsedSnapshot, nodeIndex: number): { type: string; name: string } {
    const base = nodeIndex * s.nodeFieldCount;
    return { type: s.nodeTypes[s.nodes[base + s.typeOffset]], name: s.strings[s.nodes[base + s.nameOffset]] };
}

export function countObjectsByConstructor(path: string): Map<string, number> {
    const s = parseSnapshot(path);
    const counts = new Map<string, number>();
    const nodeCount = s.nodes.length / s.nodeFieldCount;
    for (let i = 0; i < nodeCount; i++) {
        const { type, name } = nodeLabel(s, i);
        if (type !== "object" && type !== "closure") continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
}

// Constructors whose count grew by at least minGrowth between two snapshots, largest growth first
export function diffConstructorCounts(before: Map<string, number>, after: Map<string, number>, minGrowth = 1) {
    const rows: { name: string; before: number; after: number; growth: number }[] = [];
    for (const [name, count] of after) {
        const growth = count - (before.get(name) ?? 0);
        if (growth >= minGrowth) rows.push({ name, before: before.get(name) ?? 0, after: count, growth });
    }
    return rows.sort((a, b) => b.growth - a.growth);
}

// Shortest retainer chains (root first) for up to `limit` objects named `constructorName`.
// Weak edges are skipped, since they do not keep anything alive.
export function findRetainerPaths(path: string, constructorName: string, opts?: { limit?: number; maxDepth?: number }): string[][] {
    const s = parseSnapshot(path);
    const limit = opts?.limit ?? 3;
    const maxDepth = opts?.maxDepth ?? 40;
    const nodeCount = s.nodes.length / s.nodeFieldCount;
    const weakType = s.edgeTypes.indexOf("weak");

    // Reverse edges: for every node, the (fromNode, edgeIndex) pairs that point at it
    const firstEdge = new Uint32Array(nodeCount + 1);
    for (let i = 0, e = 0; i < nodeCount; i++) {
        firstEdge[i] = e;
        e += s.nodes[i * s.nodeFieldCount + s.edgeCountOffset] * s.edgeFieldCount;
        firstEdge[i + 1] = e;
    }
    const retainers: Array<Array<[number, number]>> = Array.from({ length: nodeCount }, (): Array<[number, number]> => []);
    for (let from = 0; from < nodeCount; from++) {
        for (let e = firstEdge[from]; e < firstEdge[from + 1]; e += s.edgeFieldCount) {
            if (s.edges[e + s.edgeTypeOffset] === weakType) continue;
            const to = s.edges[e + s.edgeToNodeOffset] / s.nodeFieldCount;
            retainers[to].push([from, e]);
        }
    }

    const edgeLabel = (e: number): string => {
        const type = s.edgeTypes[s.edges[e + s.edgeTypeOffset]];
        const nameOrIndex = s.edges[e + s.edgeNameOffset];
        if (type === "element" || type === "hidden") return `[${nameOrIndex}]`;
        return `.${s.strings[nameOrIndex]}`;
    };

    // A class's prototype object carries the class name too; it is not an instance
    const isPrototypeObject = (node: number) => retainers[node].some(([, e]) => edgeLabel(e) === ".prototype");
    const targets: number[] = [];
    for (let i = 0; i < nodeCount && targets.length < limit; i++) {
        const { type, name } = nodeLabel(s, i);
        if (type === "object" && name === constructorName && !isPrototypeObject(i)) targets.push(i);
    }

    // Node 0 is the synthetic root
    return targets.map((target) => {
        // Level-by-level BFS over the retainer edges, so maxDepth bounds the path length, not the
        // number of nodes visited (a soak heap's frontier easily outgrows any fixed node budget)
        const previous = new Map<number, [number, number]>();
        const seen = new Set([target]);
        let frontier = [target];
        let found = -1;
        for (let depth = 0; frontier.length && depth < maxDepth && found === -1; depth++) {
            const next: number[] = [];
            for (let i = 0; i < frontier.length && found === -1; i++) {
                const current = frontier[i];
                for (const [from, e] of retainers[current]) {
                    if (seen.has(from)) continue;
                    seen.add(from);
                    previous.set(from, [current, e]);
                    if (from === 0) {
                        found = from;
                        break;
                    }
                    next.push(from);
                }
            }
            frontier = next;
        }
        if (found === -1)
            return [
                frontier.length
                    ? `${constructorName}: no GC root within ${maxDepth} retainer hops (search limit reached, the object may still be reachable)`
                    : `${constructorName}: no path to a GC root`
            ];
        const chain: string[] = [];
        let node = found;
        while (node !== target) {
            const [next, e] = previous.get(node)!;
            const { type, name } = nodeLabel(s, next);
            chain.push(`${edgeLabel(e)} -> (${type}) ${name.slice(0, 80)}`);
            node = next;
        }
        return chain;
    });
}

// Objects present in `finalPath` but not in `baselinePath` (V8 node ids are stable across snapshots
// taken in the same process), grouped by a short retainer signature: the edge and owner one and two
// levels up. Answers "what grew, and under what", where a constructor count only says "Object grew".
export function groupNewObjectsByRetainer(baselinePath: string, finalPath: string, opts?: { top?: number }) {
    const baseline = parseSnapshot(baselinePath);
    const readIds = (path: string, s: ParsedSnapshot) => {
        const meta = (JSON.parse(readFileSync(path, "utf8")) as { snapshot: { meta: { node_fields: string[] } } }).snapshot.meta;
        const offset = meta.node_fields.indexOf("id");
        const ids: number[] = [];
        for (let i = 0; i < s.nodes.length; i += s.nodeFieldCount) ids.push(s.nodes[i + offset]);
        return ids;
    };
    const baselineIds = new Set(readIds(baselinePath, baseline));
    const s = parseSnapshot(finalPath);
    const finalIds = readIds(finalPath, s);
    const nodeCount = s.nodes.length / s.nodeFieldCount;
    const weakType = s.edgeTypes.indexOf("weak");

    const firstRetainer = new Int32Array(nodeCount).fill(-1);
    const firstRetainerEdge = new Int32Array(nodeCount).fill(-1);
    for (let from = 0, e = 0; from < nodeCount; from++) {
        const edgeEnd = e + s.nodes[from * s.nodeFieldCount + s.edgeCountOffset] * s.edgeFieldCount;
        for (; e < edgeEnd; e += s.edgeFieldCount) {
            if (s.edges[e + s.edgeTypeOffset] === weakType) continue;
            const to = s.edges[e + s.edgeToNodeOffset] / s.nodeFieldCount;
            if (firstRetainer[to] === -1) {
                firstRetainer[to] = from;
                firstRetainerEdge[to] = e;
            }
        }
    }
    const edgeName = (e: number) => {
        const type = s.edgeTypes[s.edges[e + s.edgeTypeOffset]];
        return type === "element" || type === "hidden" ? "[i]" : `.${s.strings[s.edges[e + s.edgeNameOffset]]}`;
    };
    // Strings and numbers by type only: grouping by content would give every unique string its own row
    const describe = (node: number) => {
        const { type, name } = nodeLabel(s, node);
        if (type === "string" || type === "concatenated string" || type === "sliced string" || type === "number") return `(${type})`;
        return `(${type}) ${name.slice(0, 50)}`;
    };

    const groups = new Map<string, { count: number; selfSize: number }>();
    const selfSizeOffset = (JSON.parse(readFileSync(finalPath, "utf8")) as { snapshot: { meta: { node_fields: string[] } } }).snapshot.meta.node_fields.indexOf(
        "self_size"
    );
    for (let i = 0; i < nodeCount; i++) {
        if (baselineIds.has(finalIds[i])) continue;
        const { type } = nodeLabel(s, i);
        if (!["object", "array", "string", "concatenated string", "sliced string", "number", "closure"].includes(type)) continue;
        const parent = firstRetainer[i];
        const grandParent = parent === -1 ? -1 : firstRetainer[parent];
        const signature = [
            describe(i),
            parent === -1 ? "<no retainer>" : `${edgeName(firstRetainerEdge[i])} of ${describe(parent)}`,
            grandParent === -1 ? "" : `${edgeName(firstRetainerEdge[parent])} of ${describe(grandParent)}`
        ].join("  <-  ");
        const group = groups.get(signature) ?? { count: 0, selfSize: 0 };
        group.count++;
        group.selfSize += s.nodes[i * s.nodeFieldCount + selfSizeOffset];
        groups.set(signature, group);
    }
    return [...groups.entries()]
        .map(([signature, g]) => ({ signature, ...g }))
        .sort((a, b) => b.selfSize - a.selfSize)
        .slice(0, opts?.top ?? 25);
}
