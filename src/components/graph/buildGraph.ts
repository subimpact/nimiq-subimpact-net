import { compactAddress, formatAddress, shortAddress } from "@/lib/nimiq"
import type { Cluster, GraphLink, GraphModel, GraphNode, GraphPayload } from "./types"

/** ImpactZero's validator address — the one node this site highlights. */
export const IMPACT_ADDRESS_KEY = "ACT8T0FE"
export const IMPACT_COLOR = "#07c1ff"

/**
 * Cluster hues, validated for the site's dark surface (#09090b): all eight clear the
 * lightness band, the chroma floor, 3:1 contrast, and the adjacent-pair CVD gate.
 * The site's own cyan is deliberately absent — it belongs to ImpactZero alone.
 *
 * With 52 validators the slots do cycle, which a bar chart must never do. Here hue is
 * a grouping affordance, not the identity channel: every node carries its identity in
 * the canvas label, the hover tooltip, the detail panel, and the validator list.
 */
export const CLUSTER_COLORS = [
  "#d95926", // orange
  "#199e70", // aqua
  "#c98500", // yellow
  "#d55181", // magenta
  "#9085e9", // violet
  "#e66767", // red
  "#008300", // green
  "#3987e5", // blue
]

const VALIDATOR_MAX_RADIUS = 44
const NODE_MIN_RADIUS = 3.4
/** Rest length of a delegation edge, on top of the two node radii. */
const LINK_GAP = 34
/** Seed spacing between hubs; the simulation takes it from here. */
const HUB_SEED_SPACING = 150
const GOLDEN_ANGLE = 2.399963229728653
/**
 * Hub repulsion per unit of cluster footprint. A validator with 400 stakers has to
 * claim far more room than one with three, so charge follows the space the cluster
 * actually needs rather than its stake. Tuned against the live 2,923-node graph:
 * neighbouring clusters settle roughly 1.15× their combined footprint apart.
 */
const HUB_CHARGE_PER_UNIT = 110
const SATELLITE_RING_SPACING = 5.5

/**
 * Disjoint set (union-find) with path compression, ported from the prototype.
 *
 * Delegation already tells us which validator a staker belongs to, so this is not
 * strictly load-bearing today — but deriving clusters from the edges rather than from
 * the field keeps one definition of "cluster" for the canvas, the sidebar, and any
 * future edge that is not a plain staker → validator link.
 */
export class DisjointSet {
  private readonly parent = new Map<string, string>()
  private readonly rank = new Map<string, number>()

  constructor(elements: string[] = []) {
    for (const element of elements) this.makeSet(element)
  }

  makeSet(x: string): void {
    if (this.parent.has(x)) return
    this.parent.set(x, x)
    this.rank.set(x, 0)
  }

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.makeSet(x)
      return x
    }
    let root = x
    while (root !== this.parent.get(root)!) root = this.parent.get(root)!
    let current = x
    while (current !== root) {
      const next = this.parent.get(current)!
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(x: string, y: string): boolean {
    const rootX = this.find(x)
    const rootY = this.find(y)
    if (rootX === rootY) return false
    const rankX = this.rank.get(rootX) ?? 0
    const rankY = this.rank.get(rootY) ?? 0
    if (rankX < rankY) {
      this.parent.set(rootX, rootY)
    } else {
      this.parent.set(rootY, rootX)
      if (rankX === rankY) this.rank.set(rootX, rankX + 1)
    }
    return true
  }

  components(): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    for (const element of this.parent.keys()) {
      const root = this.find(element)
      const group = groups.get(root)
      if (group) group.push(element)
      else groups.set(root, [element])
    }
    return groups
  }
}

export function isImpactAddress(address: string): boolean {
  return compactAddress(address).includes(IMPACT_ADDRESS_KEY)
}

/**
 * One shared √-of-stake scale for hubs and satellites, so a whale staker reads as big
 * as the validator it is nearly the whole of. Nimiq stake is steeply concentrated —
 * the median staker lands on the floor, which is the honest picture.
 */
function radiusFor(balance: number, maxBalance: number): number {
  if (maxBalance <= 0) return NODE_MIN_RADIUS
  const scaled = VALIDATOR_MAX_RADIUS * Math.sqrt(Math.max(0, balance) / maxBalance)
  return Math.max(NODE_MIN_RADIUS, Math.min(VALIDATOR_MAX_RADIUS, scaled))
}

/**
 * Turn the API payload into the nodes, edges and clusters the canvas draws.
 *
 * Colours are assigned once, in validator-address order, and never recomputed: the
 * filters below are purely visual, so narrowing the view never repaints a survivor.
 */
export function buildGraph(payload: GraphPayload): GraphModel {
  const total = payload.totalActiveStake > 0 ? payload.totalActiveStake : 0

  const colorOf = new Map<string, string>()
  const paletteOrder = payload.validators
    .map((validator) => compactAddress(validator.address))
    .sort()
  let slot = 0
  for (const address of paletteOrder) {
    if (address.includes(IMPACT_ADDRESS_KEY)) {
      colorOf.set(address, IMPACT_COLOR)
      continue
    }
    colorOf.set(address, CLUSTER_COLORS[slot % CLUSTER_COLORS.length])
    slot++
  }

  let maxBalance = 1
  for (const validator of payload.validators) maxBalance = Math.max(maxBalance, validator.balance)
  for (const staker of payload.stakers) maxBalance = Math.max(maxBalance, staker.balance)

  // Staker counts drive how much room each hub claims, so they are needed up front.
  const stakerCounts = new Map<string, number>()
  for (const staker of payload.stakers) {
    const key = compactAddress(staker.validatorAddress)
    stakerCounts.set(key, (stakerCounts.get(key) ?? 0) + 1)
  }

  const nodes: GraphNode[] = []
  const validatorNodes = new Map<string, GraphNode>()

  payload.validators.forEach((validator, index) => {
    const key = compactAddress(validator.address)
    if (validatorNodes.has(key)) return
    const address = formatAddress(validator.address)
    const isImpact = key.includes(IMPACT_ADDRESS_KEY)
    // Phyllotaxis seed: hubs start evenly spread, so the layout settles fast and the
    // same data always produces the same map.
    const seedRadius = HUB_SEED_SPACING * Math.sqrt(index + 0.5)
    const seedAngle = index * GOLDEN_ANGLE
    const radius = radiusFor(validator.balance, maxBalance)
    const footprint =
      radius + LINK_GAP + Math.sqrt(stakerCounts.get(key) ?? 0) * SATELLITE_RING_SPACING
    const node: GraphNode = {
      id: `v:${key}`,
      kind: "validator",
      address,
      shortAddress: shortAddress(address),
      name: validator.name,
      label: validator.name ?? shortAddress(address),
      balance: validator.balance,
      share: total > 0 ? validator.balance / total : 0,
      clusterId: -1,
      color: colorOf.get(key) ?? CLUSTER_COLORS[0],
      isImpact,
      searchKey: `${key} ${(validator.name ?? "").toLowerCase()}`,
      x: Math.cos(seedAngle) * seedRadius,
      y: Math.sin(seedAngle) * seedRadius,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      radius,
      charge: -HUB_CHARGE_PER_UNIT * footprint,
      isHub: true,
    }
    nodes.push(node)
    validatorNodes.set(key, node)
  })

  const links: GraphLink[] = []
  const seenStakers = new Set<string>()

  payload.stakers.forEach((staker, index) => {
    const key = compactAddress(staker.address)
    const validatorKey = compactAddress(staker.validatorAddress)
    const hub = validatorNodes.get(validatorKey)
    // A staker whose validator is missing from the payload has nothing to orbit.
    if (!hub) return
    const id = `s:${key}:${validatorKey}`
    if (seenStakers.has(id)) return
    seenStakers.add(id)

    const address = formatAddress(staker.address)
    const radius = radiusFor(staker.balance, maxBalance)
    // Seed on a ring around the hub: no two satellites start on the same point.
    const seedAngle = index * GOLDEN_ANGLE
    const seedRadius = hub.radius + LINK_GAP + radius + (index % 7) * 6
    const node: GraphNode = {
      id,
      kind: "staker",
      address,
      shortAddress: shortAddress(address),
      label: shortAddress(address),
      balance: staker.balance,
      share: total > 0 ? staker.balance / total : 0,
      clusterId: -1,
      color: hub.color,
      isImpact: hub.isImpact,
      validatorAddress: hub.address,
      searchKey: key,
      x: hub.x + Math.cos(seedAngle) * seedRadius,
      y: hub.y + Math.sin(seedAngle) * seedRadius,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      radius,
      charge: -(20 + radius * 2),
      isHub: false,
      hub,
    }
    nodes.push(node)
    links.push({
      source: node,
      target: hub,
      distance: hub.radius + radius + LINK_GAP,
    })
  })

  return {
    nodes,
    links,
    clusters: buildClusters(nodes, links, total),
    totalActiveStake: payload.totalActiveStake,
    updatedAt: payload.updatedAt,
  }
}

/** Derive clusters from the edges, then label each one by the validator it contains. */
function buildClusters(nodes: GraphNode[], links: GraphLink[], total: number): Cluster[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const set = new DisjointSet(nodes.map((node) => node.id))
  for (const link of links) set.union(link.source.id, link.target.id)

  const clusters: Cluster[] = []
  for (const members of set.components().values()) {
    const memberNodes = members.map((id) => byId.get(id)!).filter(Boolean)
    const validator = memberNodes.find((node) => node.kind === "validator")
    if (!validator) continue

    const stakers = memberNodes.filter((node) => node.kind === "staker")
    clusters.push({
      id: clusters.length,
      color: validator.color,
      validator,
      label: validator.label,
      address: validator.address,
      isImpact: validator.isImpact,
      stakerCount: stakers.length,
      delegatedStake: stakers.reduce((sum, node) => sum + node.balance, 0),
      validatorStake: validator.balance,
      share: total > 0 ? validator.balance / total : 0,
    })
  }

  clusters.sort((a, b) => b.validatorStake - a.validatorStake)

  const clusterOfValidator = new Map<string, number>()
  clusters.forEach((cluster, index) => {
    cluster.id = index
    clusterOfValidator.set(cluster.address, index)
  })
  for (const node of nodes) {
    const address = node.kind === "validator" ? node.address : node.validatorAddress
    node.clusterId = (address ? clusterOfValidator.get(address) : undefined) ?? -1
  }

  return clusters
}
