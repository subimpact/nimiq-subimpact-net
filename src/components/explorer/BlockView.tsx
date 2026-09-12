import { useEffect, useState } from "react"
import { EDGE_COLORS } from "@/components/nimmap/txKinds"
import { compactAddress } from "@/lib/nimiq"
import {
  detailId,
  exactTime,
  formatNim,
  getJson,
  shortAddress,
  shortHash,
  timeAgo,
  txKind,
  txKindLabel,
} from "./format"
import type { ExplorerBlock, ExplorerTx } from "./types"

type State = "loading" | "ready" | "missing" | "error"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 font-mono text-sm break-all">{children}</span>
    </div>
  )
}

function TxRow({ tx }: { tx: ExplorerTx }) {
  const kind = txKind(tx)
  return (
    <li className="flex items-center gap-2.5 px-4 py-2 text-xs">
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ backgroundColor: EDGE_COLORS[kind] }}
        title={txKindLabel(tx) ?? kind}
      />
      <a
        href={`/explorer/tx/${tx.hash}`}
        className="font-mono text-primary hover:underline"
        data-explorer-tx={tx.hash}
      >
        {shortHash(tx.hash, 10, 6)}
      </a>
      <span className="hidden min-w-0 flex-1 truncate font-mono text-muted-foreground sm:inline">
        {shortAddress(tx.from)} → {shortAddress(tx.to)}
      </span>
      <span className="ml-auto shrink-0 font-mono tabular-nums text-foreground">
        {formatNim(tx.value)} NIM
      </span>
    </li>
  )
}

/** One block, fetched by the height or hash the URL carries. */
export function BlockView() {
  const [id] = useState(() => detailId())
  const [block, setBlock] = useState<ExplorerBlock | null>(null)
  const [state, setState] = useState<State>("loading")

  useEffect(() => {
    let alive = true
    if (!id) {
      setState("missing")
      return
    }
    getJson<{ block: ExplorerBlock }>(`/api/block/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!alive) return
        setBlock(data.block)
        setState("ready")
      })
      .catch((error: unknown) => {
        if (!alive) return
        setState(error instanceof Error && error.message === "404" ? "missing" : "error")
      })
    return () => {
      alive = false
    }
  }, [id])

  if (state === "loading") {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading block {id}…</p>
  }

  if (state === "missing") {
    return (
      <div className="rounded-xl border border-border px-6 py-10 text-center" data-explorer-missing="">
        <p className="text-sm text-muted-foreground">
          No block <span className="font-mono text-foreground">{id}</span> — beyond the current
          head, or the id is off.
        </p>
        <a href="/explorer/" className="mt-3 inline-block text-sm text-primary hover:underline">
          ← Back to the explorer
        </a>
      </div>
    )
  }

  if (state === "error" || !block) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        The node did not answer. Refresh to try again.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
          Block <span className="font-mono tabular-nums">{block.number.toLocaleString("en-US")}</span>
        </h1>
        <span className="font-mono text-xs text-muted-foreground">
          {timeAgo(block.timestamp)} · {exactTime(block.timestamp)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {block.number > 1 && (
            <a
              href={`/explorer/block/${block.number - 1}`}
              data-explorer-prev=""
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              ← {block.number - 1}
            </a>
          )}
          <a
            href={`/explorer/block/${block.number + 1}`}
            data-explorer-next=""
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {block.number + 1} →
          </a>
        </span>
      </div>

      <section className="rounded-xl border border-border bg-card/30 px-4 py-1" data-explorer-block-detail="">
        <Row label="Hash">{block.hash}</Row>
        <Row label="Parent">
          {block.parentHash ? (
            <a href={`/explorer/block/${block.parentHash}`} className="text-primary hover:underline">
              {block.parentHash}
            </a>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Batch / epoch">
          #{block.batch.toLocaleString("en-US")} · epoch {block.epoch.toLocaleString("en-US")}
        </Row>
        <Row label="Producer">
          {block.producer ? (
            <a
              href={`/graph/?seed=${compactAddress(block.producer)}`}
              className="text-primary hover:underline"
              title={block.producer}
            >
              {block.producer}
            </a>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Size">
          {block.size.toLocaleString("en-US")} bytes · {block.txCount} transaction
          {block.txCount === 1 ? "" : "s"}
        </Row>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card/30">
        <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold tracking-tight">Transactions</h2>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {block.txCount}
          </span>
        </header>
        {block.txCount === 0 ? (
          <p className="px-4 py-6 text-xs text-muted-foreground">No transactions in this block.</p>
        ) : (
          <ul className="divide-y divide-border/60" data-explorer-txs="">
            {block.transactions.map((tx) => (
              <TxRow key={tx.hash} tx={tx} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
