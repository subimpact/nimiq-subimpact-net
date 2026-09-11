/**
 * Scan result → the nodes, edges and springs the canvas draws.
 *
 * The delegation map is hub-and-spoke, so `forceSim` splits its long-range
 * repulsion in two. A money-flow map has no such shape: any address can be a
 * hub, and the seed is simply the one in the middle. So every node here takes
 * part in the exact pairwise repulsion — 400 nodes is 80k pairs a tick, which
 * is cheap — and the seed is pinned at the origin instead of being centred by a
 * force, which keeps the map from sliding around under the reader while the
 * outer levels settle.
 *
 * Seeding is deterministic: a level lands on a ring, and phyllotaxis spreads the
 * members of that ring. The same scan always draws the same map.
 */

import { shortAddress } from "@/lib/nimiq"
import type { SimLink } from "@/lib/forceSim"
import type { MapEdge, MapGraphEdge, MapGraphNode, MapModel, ScanResult } from "./types"

export const SEED_COLOR = "#07c1ff"
export const NODE_COLOR = "#a1a1aa"
export const CONTRACT_COLOR = "#71717a"

const MIN_RADIUS = 6
const MAX_RADIUS = 30
const SEED_MIN_RADIUS = 14
/** Rest length of a flow edge, on top of the two node radii. */
const LINK_GAP = 55
const RING_SPACING = 150
const GOLDEN_ANGLE = 2.399963229728653

const CHARGE_BASE = 1400
const CHARGE_PER_RADIUS = 700

const MIN_EDGE_WIDTH = 0.8
const MAX_EDGE_WIDTH = 5
/** Sideways separation between two transfers drawn between the same pair. */
const BOW_STEP = 13

/**
 * Node size from the money that moved through it.
 *
 * Flow spans ten orders of magnitude on Nimiq — a 1 NIM tip and a 3.4M NIM
 * unstake sit on the same map — so the area is taken from the *logarithm* of the
 * flow and the radius from its square root. A whale reads as roughly four times
 * a minnow rather than a thousand times, which is the only way both stay on
 * screen at once.
 */
function radiusFor(flowNim: number, maxLogFlow: number): number {
  if (maxLogFlow <= 0) return MIN_RADIUS
  const scaled = Math.sqrt(Math.log10(1 + Math.max(0, flowNim)) / maxLogFlow)
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * scaled
}

/** Stroke width from the amount, on the same log scale as the node areas. */
export function edgeWidthFor(valueNim: number): number {
  const width = MIN_EDGE_WIDTH + 0.62 * Math.log10(1 + Math.max(0, valueNim))
  return Math.max(MIN_EDGE_WIDTH, Math.min(MAX_EDGE_WIDTH, width))
}

/** Unordered pair key, so A→B and B→A share one spring and one bow stack. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function buildMap(result: ScanResult): MapModel {
  const { nodes: rawNodes, edges: rawEdges, meta } = result

  let maxLogFlow = 0
  for (const node of rawNodes) {
    maxLogFlow = Math.max(maxLogFlow, Math.log10(1 + (node.totalIn + node.totalOut) / 1e5))
  }

  // Ring membership, so a level's nodes are spread over its own circle.
  const levelCounts = new Map<number, number>()

  const nodes: MapGraphNode[] = rawNodes.map((node) => {
    const flow = node.totalIn + node.totalOut
    const radius = node.isSeed
      ? Math.max(SEED_MIN_RADIUS, radiusFor(flow / 1e5, maxLogFlow))
      : radiusFor(flow / 1e5, maxLogFlow)
    const indexInLevel = levelCounts.get(node.level) ?? 0
    levelCounts.set(node.level, indexInLevel + 1)
    const ring = node.level * RING_SPACING
    const angle = indexInLevel * GOLDEN_ANGLE + node.level

    return {
      key: node.key,
      address: node.address,
      shortAddress: shortAddress(node.address),
      label: shortAddress(node.address),
      isSeed: node.isSeed,
      level: node.level,
      totalIn: node.totalIn,
      totalOut: node.totalOut,
      flow,
      txCount: node.txCount,
      partial: node.partial,
      truncated: node.truncated,
      expanded: node.expanded,
      contract: node.contract,
      color: node.isSeed ? SEED_COLOR : node.contract ? CONTRACT_COLOR : NODE_COLOR,
      x: node.isSeed ? 0 : Math.cos(angle) * ring,
      y: node.isSeed ? 0 : Math.sin(angle) * ring,
      vx: 0,
      vy: 0,
      // The seed is the frame of reference: pinned, so the map settles around it
      // instead of drifting with it.
      fx: node.isSeed ? 0 : null,
      fy: node.isSeed ? 0 : null,
      radius,
      charge: -(CHARGE_BASE + radius * CHARGE_PER_RADIUS),
      isHub: true,
    }
  })

  const byKey = new Map(nodes.map((node) => [node.key, node]))

  // Parallel transfers bow apart, so ten payments between one pair read as ten
  // arrows rather than one thick line.
  const pairCounts = new Map<string, number>()
  const ordered = [...rawEdges].sort((a, b) => a.timestamp - b.timestamp || (a.hash < b.hash ? -1 : 1))

  const edges: MapGraphEdge[] = []
  let newestTs = 0
  let oldestTs = Number.POSITIVE_INFINITY

  for (const edge of ordered) {
    const source = byKey.get(edge.from)
    const target = byKey.get(edge.to)
    if (!source || !target || source === target) continue
    const key = pairKey(edge.from, edge.to)
    const index = pairCounts.get(key) ?? 0
    pairCounts.set(key, index + 1)
    if (edge.timestamp > 0) {
      newestTs = Math.max(newestTs, edge.timestamp)
      oldestTs = Math.min(oldestTs, edge.timestamp)
    }
    edges.push({
      hash: edge.hash,
      source,
      target,
      value: edge.value,
      fee: edge.fee,
      timestamp: edge.timestamp,
      blockNumber: edge.blockNumber,
      confirmations: edge.confirmations,
      width: edgeWidthFor(edge.value / 1e5),
      bow: 0,
    })
  }

  // A second pass: the bow of an arrow depends on how many share its pair, which
  // is only known once every edge has been counted.
  const seen = new Map<string, number>()
  for (const edge of edges) {
    const key = pairKey(edge.source.key, edge.target.key)
    const total = pairCounts.get(key) ?? 1
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    edge.bow = total === 1 ? 0 : (index - (total - 1) / 2) * BOW_STEP
  }

  const links: SimLink<MapGraphNode>[] = []
  const linked = new Set<string>()
  for (const edge of edges) {
    const key = pairKey(edge.source.key, edge.target.key)
    if (linked.has(key)) continue
    linked.add(key)
    links.push({
      source: edge.source,
      target: edge.target,
      distance: edge.source.radius + edge.target.radius + LINK_GAP,
    })
  }

  return {
    nodes,
    edges,
    links,
    seed: nodes.find((node) => node.isSeed) ?? null,
    meta,
    newestTs: newestTs || Date.now(),
    oldestTs: Number.isFinite(oldestTs) ? oldestTs : Date.now(),
  }
}

/** Edges in the order a reader would scan them: newest money first. */
export function sortedEdges(model: MapModel): MapGraphEdge[] {
  return [...model.edges].sort((a, b) => b.timestamp - a.timestamp)
}

export function findEdge(model: MapModel, hash: string | null): MapGraphEdge | null {
  if (!hash) return null
  return model.edges.find((edge) => edge.hash === hash) ?? null
}

export function findNode(model: MapModel, key: string | null): MapGraphNode | null {
  if (!key) return null
  return model.nodes.find((node) => node.key === key) ?? null
}
