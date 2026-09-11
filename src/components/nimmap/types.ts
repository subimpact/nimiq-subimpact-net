import type { SimLink, SimNode } from "@/lib/forceSim"

export type Tier = "free" | "paid"

/** What a tier is allowed to ask of the network, and of the reader's browser. */
export interface TierLimits {
  maxDepth: number
  /** Transactions read per address — one page of `/api/history`. */
  maxTxPerAddress: number
  /** Hard ceiling on nodes; the scan stops adding beyond it. */
  addressCap: number
  /** Concurrent `/api/history` requests. */
  concurrency: number
  exports: boolean
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { maxDepth: 3, maxTxPerAddress: 20, addressCap: 100, concurrency: 4, exports: false },
  paid: { maxDepth: 6, maxTxPerAddress: 50, addressCap: 400, concurrency: 8, exports: true },
}

/**
 * What the worker tells us about a transaction's shape, beyond who paid whom.
 *
 * `fromType`/`toType` are the @nimiq/core `AccountType` of the two ends — 0 basic,
 * 1 vesting, 2 HTLC, 3 the staking contract. `flags` bit 1 marks a signalling
 * transaction. `dataType`/`senderDataType` are the first byte of the recipient's and
 * the sender's data blob, which for the staking contract is the operation itself; see
 * `txKinds.ts` for the table. Every one of them is optional: an older worker, or a node
 * that said nothing, leaves the edge classified as an ordinary transfer.
 */
export interface TxClassification {
  fromType?: number
  toType?: number
  flags?: number
  dataType?: number | null
  senderDataType?: number | null
}

/** One row of `GET /api/history/:address`. Values are luna, timestamps are ms. */
export interface HistoryTx extends TxClassification {
  hash: string
  blockNumber: number
  timestamp: number
  confirmations: number
  size: number
  from: string
  to: string
  value: number
  fee: number
}

export interface HistoryPage {
  data: HistoryTx[]
  pagination?: { nextStartAt: string | null }
}

export interface MapNode {
  /** Compacted address — the identity used everywhere. */
  key: string
  /** Canonically spaced address, for display. */
  address: string
  isSeed: boolean
  /** Hops from the seed. */
  level: number
  totalIn: number
  totalOut: number
  txCount: number
  /** Its history could not be read; the flows shown for it are incomplete. */
  partial: boolean
  /** Its history had more pages than the tier reads. */
  truncated: boolean
  /** Its own history was read, so its counterparties are on the map. */
  expanded: boolean
  /** A system contract — on the map, never expanded. See scan.ts. */
  contract: boolean
}

export interface MapEdge extends TxClassification {
  hash: string
  /** Compacted addresses, matching MapNode.key. */
  from: string
  to: string
  value: number
  fee: number
  timestamp: number
  blockNumber: number
  confirmations: number
}

export interface ScanMeta {
  seed: string
  /** The depth actually asked for. */
  depth: number
  tier: Tier
  limits: TierLimits
  addressCount: number
  edgeCount: number
  /** Addresses whose own history was read. */
  scannedCount: number
  /** Addresses on the map whose history was never read. */
  frontierCount: number
  failedCount: number
  requestCount: number
  reachedAddressCap: boolean
  /** There were addresses left to expand when the depth ran out. */
  reachedDepth: boolean
  stopped: boolean
  elapsedMs: number
  scannedAt: number
}

export interface ScanResult {
  nodes: MapNode[]
  edges: MapEdge[]
  meta: ScanMeta
}

export interface ScanProgress {
  scanned: number
  addresses: number
  txs: number
  level: number
}

export interface MapGraphNode extends SimNode {
  key: string
  address: string
  shortAddress: string
  label: string
  isSeed: boolean
  level: number
  totalIn: number
  totalOut: number
  flow: number
  txCount: number
  partial: boolean
  truncated: boolean
  expanded: boolean
  contract: boolean
  color: string
}

export interface MapGraphEdge extends TxClassification {
  hash: string
  source: MapGraphNode
  target: MapGraphNode
  value: number
  fee: number
  timestamp: number
  blockNumber: number
  confirmations: number
  /** Stroke width, from log(value). */
  width: number
  /** Sideways offset so parallel transfers between one pair stay legible. */
  bow: number
}

/** How the canvas decides an edge's colour. */
export type ColorMode = "type" | "age"

export interface MapModel {
  nodes: MapGraphNode[]
  edges: MapGraphEdge[]
  links: SimLink<MapGraphNode>[]
  seed: MapGraphNode | null
  meta: ScanMeta
  /** Newest and oldest transaction timestamps, for the age ramp. */
  newestTs: number
  oldestTs: number
}

export interface ViewportTransform {
  x: number
  y: number
  scale: number
}
