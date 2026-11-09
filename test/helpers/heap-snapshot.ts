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

    const targets: number[] = [];
    for (let i = 0; i < nodeCount && targets.length < limit; i++) {
        const { type, name } = nodeLabel(s, i);
        if (type === "object" && name === constructorName) targets.push(i);
    }

    // Node 0 is the synthetic root
    return targets.map((target) => {
        const previous = new Map<number, [number, number]>();
        const queue = [target];
        const seen = new Set([target]);
        let found = -1;
        for (let depth = 0; queue.length && depth < maxDepth * 1000 && found === -1; depth++) {
            const current = queue.shift()!;
            for (const [from, e] of retainers[current]) {
                if (seen.has(from)) continue;
                seen.add(from);
                previous.set(from, [current, e]);
                if (from === 0) {
                    found = from;
                    break;
                }
                queue.push(from);
            }
        }
        if (found === -1) return [`${constructorName}: no path to a GC root`];
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
