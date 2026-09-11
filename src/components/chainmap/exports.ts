/**
 * Paid-tier exports. Both are built in the browser from the model already on
 * screen — nothing is sent anywhere to produce them.
 */

import { compactAddress } from "@/lib/nimiq"
import type { MapModel } from "./types"

/** chainmap-NQ08ACT8…-2026-09-11 — sortable, and names what it is a map of. */
export function exportFilename(seed: string, extension: string): string {
  const compact = compactAddress(seed)
  const date = new Date().toISOString().slice(0, 10)
  return `chainmap-${compact.slice(0, 12)}-${date}.${extension}`
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Give the browser a turn to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const CSV_COLUMNS = [
  "from",
  "to",
  "value_luna",
  "value_nim",
  "hash",
  "timestamp_iso",
  "confirmations",
] as const

export function toCsv(model: MapModel): string {
  const rows = [CSV_COLUMNS.join(",")]
  // Newest first — the same order the transaction list under the map uses.
  const edges = [...model.edges].sort((a, b) => b.timestamp - a.timestamp)
  for (const edge of edges) {
    rows.push(
      [
        csvCell(edge.source.address),
        csvCell(edge.target.address),
        edge.value,
        edge.value / 1e5,
        csvCell(edge.hash),
        csvCell(edge.timestamp > 0 ? new Date(edge.timestamp).toISOString() : ""),
        edge.confirmations,
      ].join(","),
    )
  }
  return `${rows.join("\n")}\n`
}

export function downloadCsv(model: MapModel): void {
  const blob = new Blob([toCsv(model)], { type: "text/csv;charset=utf-8" })
  download(blob, exportFilename(model.meta.seed, "csv"))
}

export function downloadPng(blob: Blob, seed: string): void {
  download(blob, exportFilename(seed, "png"))
}
