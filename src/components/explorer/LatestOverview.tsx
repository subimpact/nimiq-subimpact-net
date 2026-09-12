import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { EDGE_COLORS } from "@/components/nimmap/txKinds"
import { compactAddress } from "@/lib/nimiq"
import { formatNim, getJson, shortAddress, shortHash, timeAgo, txKind, txKindLabel } from "./format"
import type { BlocksPayload, ExplorerBlock, ExplorerTx } from "./types"

const REFRESH_MS = 20000
const LIMIT = 15

function KindDot({ tx }: { tx: ExplorerTx }) {
  const kind = txKind(tx)
  return (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: EDGE_COLORS[kind] }}
      title={txKindLabel(tx) ?? kind}
    />
  )
}

function Panel({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card/30">
      <header className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          last {count}
        </span>
      </header>
      {children}
    </section>
  )
}

/**
 * The hub's two live columns: newest blocks and the transactions inside them, off one
 * `/api/blocks` poll. The worker caches for 20s, so the interval matches it — every
 * tick is a fresh answer, never a repeated one.
 */
export function LatestOverview() {
  const [payload, setPayload] = useState<BlocksPayload | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let alive = true
    const ctrl = new AbortController()
    async function load() {
      try {
        const data = await getJson<BlocksPayload>(`/api/blocks?limit=${LIMIT}`, ctrl.signal)
        if (!alive) return
        setPayload(data)
        setStale(false)
      } catch {
        if (alive) setStale(true)
      }
    }
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      ctrl.abort()
      clearInterval(timer)
    }
  }, [])

  const blocks: ExplorerBlock[] = payload?.blocks ?? []
  const txs: ExplorerTx[] = blocks.flatMap((block) => block.transactions).slice(0, LIMIT)
  const head = payload?.height

  if (!payload) {
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((panel) => (
          <div key={panel} className="space-y-3 rounded-xl border border-border p-4">
            <Skeleton className="h-5 w-36" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="font-mono text-xs tabular-nums text-muted-foreground" data-explorer-headline="">
        Chain head{" "}
        <span className="text-foreground">#{head?.toLocaleString("en-US")}</span>
        {blocks[0] ? <> · epoch {blocks[0].epoch.toLocaleString("en-US")}</> : null} · updated{" "}
        {timeAgo(payload.fetchedAt)}
        {stale && <span className="text-destructive"> · reconnecting…</span>}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Latest blocks" count={LIMIT}>
          <ul className="divide-y divide-border/60" data-explorer-blocks="">
            {blocks.map((block) => (
              <li key={block.number} className="flex items-center gap-3 px-4 py-2 text-xs">
                <a
                  href={`/explorer/block/${block.number}`}
                  className="font-mono tabular-nums text-primary hover:underline"
                  data-explorer-block={block.number}
                >
                  {block.number.toLocaleString("en-US")}
                </a>
                <span className="w-16 text-muted-foreground">{timeAgo(block.timestamp)}</span>
                <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                  {block.txCount} tx
                </span>
                <span className="hidden w-16 text-right font-mono tabular-nums text-muted-foreground sm:inline">
                  {block.size} B
                </span>
                {block.producer ? (
                  <a
                    href={`/graph/?seed=${compactAddress(block.producer)}`}
                    className="hidden w-28 truncate text-right font-mono text-muted-foreground hover:text-foreground md:inline"
                    title={block.producer}
                  >
                    {shortAddress(block.producer)}
                  </a>
                ) : (
                  <span className="hidden w-28 md:inline" />
                )}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Latest transactions" count={LIMIT}>
          {txs.length === 0 ? (
            <p className="px-4 py-6 text-xs text-muted-foreground">
              No transactions in the last {LIMIT} blocks — the chain is quiet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60" data-explorer-txs="">
              {txs.map((tx) => (
                <li key={tx.hash} className="flex items-center gap-2.5 px-4 py-2 text-xs">
                  <KindDot tx={tx} />
                  <a
                    href={`/explorer/tx/${tx.hash}`}
                    className="font-mono text-primary hover:underline"
                    data-explorer-tx={tx.hash}
                  >
                    {shortHash(tx.hash, 8, 5)}
                  </a>
                  <span className="hidden min-w-0 flex-1 truncate font-mono text-muted-foreground sm:inline">
                    {shortAddress(tx.from)} → {shortAddress(tx.to)}
                  </span>
                  <span className="ml-auto shrink-0 font-mono tabular-nums text-foreground">
                    {formatNim(tx.value)} NIM
                  </span>
                  <span className="w-14 shrink-0 text-right text-muted-foreground">
                    {timeAgo(tx.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  )
}
