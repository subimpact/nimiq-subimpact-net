import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyAddress } from "@/components/CopyAddress"
import { compactAddress, explorerUrl, formatNimFull, shortAddress } from "@/lib/nimiq"
import { absoluteTime, relativeTime } from "./format"
import { useAddressRole, useBalance } from "./roles"
import { STAKING_CONTRACT } from "./scan"
import type { MapGraphEdge, MapGraphNode, Tier } from "./types"

const ROLE_LABEL: Record<string, string> = {
  validator: "Validator",
  paywall: "Paywall",
  staking: "Staking contract",
}

const STAKING_KEY = compactAddress(STAKING_CONTRACT)

function PanelShell({
  title,
  badge,
  onClose,
  children,
}: {
  title: string
  badge?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="absolute bottom-3 left-3 z-10 w-[min(21rem,calc(100%-1.5rem))] rounded-lg border border-border bg-popover/95 p-3 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badge}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close details" onClick={onClose}>
          ×
        </Button>
      </div>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

export function NodeDetail({
  node,
  tier,
  onClose,
  onRescan,
  onUnlock,
}: {
  node: MapGraphNode
  tier: Tier
  onClose: () => void
  onRescan: (node: MapGraphNode) => void
  onUnlock: () => void
}) {
  const role = useAddressRole(node.address)
  const balance = useBalance(node.address)

  return (
    <PanelShell
      title={node.isSeed ? "Seed address" : "Address"}
      badge={
        <>
          {role && (
            <Badge variant="outline" className="border-primary/40 text-primary">
              {ROLE_LABEL[role]}
            </Badge>
          )}
          {node.partial && (
            <Badge variant="outline" className="border-destructive/40 text-destructive">
              Partial
            </Badge>
          )}
          {!node.expanded && !node.isSeed && !node.contract && (
            <Badge variant="outline" className="text-muted-foreground">
              Edge of scan
            </Badge>
          )}
        </>
      }
      onClose={onClose}
    >
      <CopyAddress
        value={node.address}
        label="address"
        className="mt-2 text-[11px] break-all text-muted-foreground"
      />

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Field
          label="Balance"
          value={balance === undefined ? "…" : balance === null ? "--" : formatNimFull(balance)}
        />
        <Field label="Transactions" value={node.txCount.toLocaleString("en-US")} />
        <Field label="Received" value={formatNimFull(node.totalIn)} />
        <Field label="Sent" value={formatNimFull(node.totalOut)} />
        <Field label="Hops from seed" value={node.level} />
        {node.truncated && (
          <div className="col-span-2">
            <dt className="text-muted-foreground">Note</dt>
            <dd className="text-[11px] leading-relaxed text-muted-foreground">
              This address has more transactions than the scan reads per address — the flows
              shown are its most recent ones.
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!node.isSeed && (
          <Button
            size="xs"
            variant="outline"
            data-chainmap-rescan=""
            onClick={() => (tier === "paid" ? onRescan(node) : onUnlock())}
          >
            {tier === "paid" ? "Scan from here" : "Scan from here — Pass"}
          </Button>
        )}
        <a
          href={explorerUrl(node.address)}
          target="_blank"
          rel="noopener"
          className="font-mono text-[11px] text-primary hover:underline"
        >
          View on nimiq.watch →
        </a>
      </div>
    </PanelShell>
  )
}

export function EdgeDetail({ edge, onClose }: { edge: MapGraphEdge; onClose: () => void }) {
  const staking =
    compactAddress(edge.source.address) === STAKING_KEY ||
    compactAddress(edge.target.address) === STAKING_KEY

  return (
    <PanelShell
      title="Transaction"
      badge={
        staking ? (
          <Badge variant="outline" className="border-primary/40 text-primary">
            Staking
          </Badge>
        ) : undefined
      }
      onClose={onClose}
    >
      <p className="mt-2 font-mono text-lg tabular-nums text-foreground">
        {formatNimFull(edge.value)}
      </p>

      <div className="mt-2 grid gap-1 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-muted-foreground">From</span>
          <span className="font-mono text-foreground">{shortAddress(edge.source.address, 4)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-8 shrink-0 text-muted-foreground">To</span>
          <span className="font-mono text-foreground">{shortAddress(edge.target.address, 4)}</span>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Field label="When" value={relativeTime(edge.timestamp)} />
        <Field label="Confirmations" value={edge.confirmations.toLocaleString("en-US")} />
        <div className="col-span-2">
          <dt className="text-muted-foreground">Timestamp</dt>
          <dd className="font-mono text-[11px] tabular-nums text-foreground">
            {absoluteTime(edge.timestamp)}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Hash</dt>
          <dd>
            <CopyAddress
              value={edge.hash}
              label="transaction hash"
              className="text-[11px] break-all text-foreground"
            >
              {`${edge.hash.slice(0, 18)}…${edge.hash.slice(-8)}`}
            </CopyAddress>
          </dd>
        </div>
      </dl>

      <a
        href={`https://nimiq.watch/#${edge.hash}`}
        target="_blank"
        rel="noopener"
        className="mt-3 inline-block font-mono text-[11px] text-primary hover:underline"
      >
        View on nimiq.watch →
      </a>
    </PanelShell>
  )
}
