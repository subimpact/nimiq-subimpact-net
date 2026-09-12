import { useEffect, useState } from "react"
import { EDGE_COLORS } from "@/components/nimmap/txKinds"
import { compactAddress } from "@/lib/nimiq"
import {
  detailId,
  exactTime,
  formatNim,
  getJson,
  timeAgo,
  txKind,
  txKindLabel,
} from "./format"
import type { ExplorerTx } from "./types"

type State = "loading" | "ready" | "missing" | "error"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-border/60 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-3">
      <span className="w-32 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 font-mono text-sm break-all">{children}</span>
    </div>
  )
}

/** `0x05` — an op code, or an em dash when the chain did not send one. */
function op(code: number | null | undefined): string {
  if (code === null || code === undefined) return "—"
  return `0x${code.toString(16).padStart(2, "0")}`
}

function AddressLink({ address }: { address: string }) {
  return (
    <a
      href={`/graph/?seed=${compactAddress(address)}`}
      className="text-primary hover:underline"
      title={`${address} — open in NimMap`}
    >
      {address}
    </a>
  )
}

/** One transaction, fetched by the hash the URL carries. */
export function TxView() {
  const [hash] = useState(() => detailId())
  const [tx, setTx] = useState<ExplorerTx | null>(null)
  const [state, setState] = useState<State>("loading")

  useEffect(() => {
    let alive = true
    if (!hash) {
      setState("missing")
      return
    }
    getJson<{ tx: ExplorerTx }>(`/api/tx/${encodeURIComponent(hash)}`)
      .then((data) => {
        if (!alive) return
        setTx(data.tx)
        setState("ready")
      })
      .catch((error: unknown) => {
        if (!alive) return
        setState(error instanceof Error && error.message === "404" ? "missing" : "error")
      })
    return () => {
      alive = false
    }
  }, [hash])

  if (state === "loading") {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading transaction…</p>
  }

  if (state === "missing") {
    return (
      <div className="rounded-xl border border-border px-6 py-10 text-center" data-explorer-missing="">
        <p className="text-sm text-muted-foreground">
          No transaction with that hash on this chain.
        </p>
        <a href="/explorer/" className="mt-3 inline-block text-sm text-primary hover:underline">
          ← Back to the explorer
        </a>
      </div>
    )
  }

  if (state === "error" || !tx) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        The node did not answer. Refresh to try again.
      </p>
    )
  }

  const kind = txKind(tx)
  const label = txKindLabel(tx)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Transaction</h1>
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground"
          data-explorer-tx-kind={kind}
        >
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ backgroundColor: EDGE_COLORS[kind] }}
          />
          {label ?? "Basic transfer"}
        </span>
      </div>

      <section className="rounded-xl border border-border bg-card/30 px-4 py-1" data-explorer-tx-detail="">
        <Row label="Hash">{tx.hash}</Row>
        <Row label="Block">
          <a
            href={`/explorer/block/${tx.blockNumber}`}
            className="text-primary hover:underline"
          >
            {typeof tx.blockNumber === "number" ? `#${tx.blockNumber.toLocaleString("en-US")}` : "—"}
          </a>
          {typeof tx.confirmations === "number" && (
            <span className="ml-2 text-muted-foreground">
              · {tx.confirmations.toLocaleString("en-US")} confirmations
            </span>
          )}
        </Row>
        <Row label="Time">
          {timeAgo(tx.timestamp)} · {exactTime(tx.timestamp)}
        </Row>
        <Row label="From">
          <AddressLink address={tx.from} />
        </Row>
        <Row label="To">
          <AddressLink address={tx.to} />
        </Row>
        <Row label="Value">
          <span data-explorer-tx-value={tx.value}>{formatNim(tx.value)} NIM</span>
        </Row>
        <Row label="Fee">{formatNim(tx.fee, 5)} NIM</Row>
        <Row label="Size">
          {typeof tx.size === "number" ? `${tx.size.toLocaleString("en-US")} bytes` : "—"}
        </Row>
        <Row label="Data">
          {tx.dataType === null || tx.dataType === undefined ? (
            "No payload"
          ) : (
            <span className="text-muted-foreground">
              op {op(tx.dataType)} on {tx.fromType === 3 || tx.toType === 3 ? "staking" : "target"}
              {tx.senderDataType !== null && tx.senderDataType !== undefined && (
                <> · sender op {op(tx.senderDataType)}</>
              )}
              {typeof tx.flags === "number" && tx.flags !== 0 && <> · flags {op(tx.flags)}</>}
            </span>
          )}
        </Row>
      </section>

      <p className="text-xs text-muted-foreground">
        Following the money? <a href="/graph/" className="text-primary hover:underline">NimMap</a>{" "}
        draws this transaction — and everything around it — as a map.
      </p>
    </div>
  )
}
