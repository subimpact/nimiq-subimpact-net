/**
 * The scan engine: breadth-first over `GET /api/history/:address`.
 *
 * One level at a time, so "depth" means exactly what the controls say it does —
 * depth 1 is the seed and the addresses it traded with, depth 2 adds theirs. An
 * address is expanded once and only once, and only while there is depth left:
 * the nodes discovered on the last level stay on the map as the frontier, which
 * is what the boundary notice under the canvas is counting.
 *
 * Within a level the addresses run through a small worker pool (4 requests for a
 * free scan, 8 for a paid one) rather than all at once — the worker caches each
 * page for 60s and sits on a shared subrequest budget, and a 400-address scan
 * fired in one burst is a denial of service on our own API.
 *
 * Failures are per-address: an address whose history will not load is marked
 * `partial` and the scan carries on. A scan that stopped early — cancelled, or
 * against a cap — still returns everything it found.
 */

import { compactAddress, formatAddress } from "@/lib/nimiq"
import { API_BASE } from "@/lib/nimmapAuth"
import type {
  HistoryPage,
  MapEdge,
  MapNode,
  ScanProgress,
  ScanResult,
  Tier,
  TierLimits,
} from "./types"

/** The staking contract every stake, unstake and reward payout passes through. */
export const STAKING_CONTRACT = "NQ77 0000 0000 0000 0000 0000 0000 0000 0001"

/**
 * Addresses that are on the map but are never expanded.
 *
 * The staking contract is a counterparty of tens of thousands of wallets. Its
 * "recent transactions" are twenty strangers, so expanding it would fill a free
 * scan's whole 100-address budget with addresses that have nothing to do with
 * the seed — the one case where following the money tells you nothing.
 */
const NEVER_EXPAND = new Set([compactAddress(STAKING_CONTRACT)])

const REQUEST_TIMEOUT_MS = 20000

/**
 * Backoff between attempts at one address.
 *
 * The public RPC node behind `/api/history` answers a burst of requests with
 * `request rejected` rather than a queue: a live depth-6 scan measured 79 of 136
 * addresses refused on the first pass, and every one of them answered normally a
 * moment later. The failure is congestion, not a bad address, so it is worth
 * asking again — twice, briefly, and then the address is marked partial.
 */
const RETRY_DELAYS_MS = [400, 1100]

export interface ScanOptions {
  depth: number
  tier: Tier
  limits: TierLimits
  signal?: AbortSignal
  onProgress?: (progress: ScanProgress) => void
  /** Swappable for tests; defaults to the worker's history route. */
  fetchPage?: (address: string, max: number, signal?: AbortSignal) => Promise<HistoryPage>
}

export async function fetchHistoryPage(
  address: string,
  max: number,
  signal?: AbortSignal,
): Promise<HistoryPage> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort)
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${API_BASE}/api/history/${encodeURIComponent(compactAddress(address))}?max=${max}`,
      { signal: controller.signal, cache: "no-store" },
    )
    if (!response.ok) throw new Error(`history ${response.status}`)
    return (await response.json()) as HistoryPage
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

/** A classification field, or nothing at all. `null` from the worker means "no data". */
function numberOrUndefined(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined
}

function blankNode(key: string, level: number, isSeed: boolean): MapNode {
  return {
    key,
    address: formatAddress(key),
    isSeed,
    level,
    totalIn: 0,
    totalOut: 0,
    txCount: 0,
    partial: false,
    truncated: false,
    expanded: false,
    contract: NEVER_EXPAND.has(key),
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    signal?.addEventListener("abort", finish)
  })
}

/** Run `task` over `items`, at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await task(item)
    }
  })
  await Promise.all(workers)
}

export async function scanAddress(seedAddress: string, options: ScanOptions): Promise<ScanResult> {
  const { depth, tier, limits, signal, onProgress } = options
  const fetchPage = options.fetchPage ?? fetchHistoryPage
  const startedAt = Date.now()

  const seedKey = compactAddress(seedAddress)
  const nodes = new Map<string, MapNode>([[seedKey, blankNode(seedKey, 0, true)]])
  const edges = new Map<string, MapEdge>()

  let frontier = [seedKey]
  let scannedCount = 0
  let failedCount = 0
  let requestCount = 0
  let reachedAddressCap = false
  let level = 0

  const report = () =>
    onProgress?.({
      scanned: scannedCount,
      addresses: nodes.size,
      txs: edges.size,
      level,
    })

  for (level = 0; level < depth; level++) {
    if (signal?.aborted) break
    const batch = frontier.filter((key) => {
      const node = nodes.get(key)
      return node != null && !node.expanded && !node.contract
    })
    if (batch.length === 0) break
    frontier = []
    const discovered: string[] = []

    await pool(batch, limits.concurrency, async (key) => {
      if (signal?.aborted) return
      const node = nodes.get(key)
      if (!node) return

      let page: HistoryPage | null = null
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (signal?.aborted) return
        requestCount++
        try {
          page = await fetchPage(node.address, limits.maxTxPerAddress, signal)
          break
        } catch (error) {
          if (signal?.aborted) return
          if (attempt === RETRY_DELAYS_MS.length) {
            // An address that will not load after three tries is a hole in the
            // map, not the end of it: mark it and keep going.
            console.debug("nimmap: history failed", key, error)
            node.partial = true
            failedCount++
            scannedCount++
            report()
            return
          }
          await delay(RETRY_DELAYS_MS[attempt], signal)
        }
      }
      if (!page || signal?.aborted) return

      node.expanded = true
      node.truncated = Boolean(page.pagination?.nextStartAt)
      const rows = Array.isArray(page.data) ? page.data : []

      for (const tx of rows) {
        if (!tx || typeof tx.hash !== "string") continue
        const from = compactAddress(tx.from ?? "")
        const to = compactAddress(tx.to ?? "")
        // A transaction to yourself moves nothing across the map.
        if (!from || !to || from === to) continue
        const other = from === key ? to : from
        // The node's own history can only contain transactions it took part in;
        // anything else is a node bug or a bad row.
        if (from !== key && to !== key) continue

        let counterparty = nodes.get(other)
        if (!counterparty) {
          if (nodes.size >= limits.addressCap) {
            // At the cap the edge is dropped too — an arrow to a node that is
            // not drawn would be a line into empty space.
            reachedAddressCap = true
            continue
          }
          counterparty = blankNode(other, node.level + 1, false)
          nodes.set(other, counterparty)
          discovered.push(other)
        }

        if (!edges.has(tx.hash)) {
          const value = Number(tx.value) || 0
          edges.set(tx.hash, {
            hash: tx.hash,
            from,
            to,
            value,
            fee: Number(tx.fee) || 0,
            timestamp: Number(tx.timestamp) || 0,
            blockNumber: Number(tx.blockNumber) || 0,
            confirmations: Number(tx.confirmations) || 0,
            // How the edge will be coloured. A worker that predates these fields —
            // or a node that said nothing — leaves them undefined, and the edge is
            // drawn as an ordinary transfer.
            fromType: numberOrUndefined(tx.fromType),
            toType: numberOrUndefined(tx.toType),
            flags: numberOrUndefined(tx.flags),
            dataType: numberOrUndefined(tx.dataType),
            senderDataType: numberOrUndefined(tx.senderDataType),
          })
          const sender = nodes.get(from)
          const recipient = nodes.get(to)
          if (sender) {
            sender.totalOut += value
            sender.txCount++
          }
          if (recipient) {
            recipient.totalIn += value
            recipient.txCount++
          }
        }
      }

      scannedCount++
      report()
    })

    frontier = discovered
  }

  // What is left unexpanded at the end — the addresses the map stops at.
  const unexpanded = [...nodes.values()].filter((node) => !node.expanded && !node.contract)

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    meta: {
      seed: formatAddress(seedKey),
      depth,
      tier,
      limits,
      addressCount: nodes.size,
      edgeCount: edges.size,
      scannedCount,
      frontierCount: unexpanded.length,
      failedCount,
      requestCount,
      reachedAddressCap,
      reachedDepth: unexpanded.length > 0 && !signal?.aborted,
      stopped: Boolean(signal?.aborted),
      elapsedMs: Date.now() - startedAt,
      scannedAt: Date.now(),
    },
  }
}
