/**
 * Shared formatting for the explorer — the same numbers the rest of the site shows,
 * spelled the same way, so a value reads identically on the pool page, in NimMap and
 * beside a block.
 */

import { edgeKind, edgeKindLabel, type EdgeKind } from "@/components/nimmap/txKinds"
import type { TxClassification } from "@/components/nimmap/types"

export const API_BASE = "https://nimiq-api.subimpact.net"

/**
 * A transaction seen the way the map sees it — classification reads the two ends plus
 * the worker's type bytes, and a transaction IS an edge between its from and its to.
 * One adapter, so explorer chips and NimMap arrows can never disagree.
 */
function asEdge(tx: { from: string; to: string } & TxClassification) {
  return { ...tx, source: { address: tx.from }, target: { address: tx.to } }
}

export function txKind(tx: { from: string; to: string } & TxClassification): EdgeKind {
  return edgeKind(asEdge(tx))
}

export function txKindLabel(tx: { from: string; to: string } & TxClassification): string | null {
  return edgeKindLabel(asEdge(tx))
}

const REQUEST_TIMEOUT_MS = 12000

/** GET the worker with a timeout; every explorer view fetches through this. */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  const onOuterAbort = () => ctrl.abort()
  signal?.addEventListener("abort", onOuterAbort)
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onOuterAbort)
  }
}

/** Luna as NIM, decimals only when they carry information. */
export function formatNim(luna: number, maxDecimals = 2): string {
  return (luna / 1e5).toLocaleString("en-US", { maximumFractionDigits: maxDecimals })
}

export function shortHash(hash: string, lead = 10, tail = 6): string {
  if (hash.length <= lead + tail + 1) return hash
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`
}

/** `NQ27 NCB1 … EXB1` — enough to recognise, short enough for a table cell. */
export function shortAddress(address: string): string {
  const parts = address.split(" ")
  if (parts.length < 3) return address
  return `${parts[0]} ${parts[1]} … ${parts[parts.length - 1]}`
}

/** Compact relative time: 12s / 3m / 2h / 4d ago. */
export function timeAgo(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** The absolute stamp a detail page shows under the relative one. */
export function exactTime(ms: number): string {
  const stamp = new Date(ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  })
  return `${stamp} UTC`
}

/** This page's trailing path segment — the block id or tx hash a detail page renders. */
export function pathSegment(): string {
  if (typeof window === "undefined") return ""
  const parts = window.location.pathname.split("/").filter(Boolean)
  return decodeURIComponent(parts[parts.length - 1] ?? "")
}

/**
 * The id a detail page renders: the trailing path segment, or — when the shell
 * is opened bare (local preview, which cannot rewrite pretty URLs) — `?id=`.
 */
export function detailId(): string {
  const seg = pathSegment()
  if (seg && seg !== "block" && seg !== "tx" && seg !== "explorer" && !seg.endsWith(".html")) {
    return seg
  }
  if (typeof window === "undefined") return ""
  return new URLSearchParams(window.location.search).get("id") ?? ""
}
