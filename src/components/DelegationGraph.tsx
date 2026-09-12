import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  LUNA_PER_NIM,
  compactAddress,
  explorerUrl,
  formatNim,
  formatNimFull,
  formatShare,
} from "@/lib/nimiq"
import { buildGraph } from "@/components/graph/buildGraph"
import { HexGraphCanvas, type GraphCanvasHandle, type GraphCanvasView } from "@/components/graph/HexGraphCanvas"
import type { Cluster, GraphModel, GraphNode, GraphPayload } from "@/components/graph/types"

const API_HOST = "nimiq-api.subimpact.net"
const GRAPH_URL = `https://${API_HOST}/api/graph`
/** Covers the whole part sequence: part 1, then parts 2..N in parallel. */
const REQUEST_TIMEOUT_MS = 25000
/**
 * Runaway guard on the part count the API reports. 32 parts is ~830 validators, far
 * past any plausible chain state, so this only ever trips on a malformed response.
 */
const MAX_PARTS = 32

async function fetchPart(part: number, signal: AbortSignal): Promise<GraphPayload> {
  const response = await fetch(`${GRAPH_URL}?part=${part}`, { signal, cache: "no-store" })
  if (!response.ok) throw new Error(`part ${part}: ${response.status}`)
  return (await response.json()) as GraphPayload
}

/**
 * Part 1 carries the validator list and the part count; parts 2..N add their staker
 * slices. Any part failing rejects the whole load — a partial map would silently
 * under-report delegation, which this page must never do.
 */
async function fetchGraph(signal: AbortSignal): Promise<GraphPayload> {
  const first = await fetchPart(1, signal)
  const reported = first.part?.count ?? 1
  const count = Number.isInteger(reported) ? Math.min(Math.max(reported, 1), MAX_PARTS) : 1
  if (count < 2) return first

  const rest = await Promise.all(
    Array.from({ length: count - 1 }, (_, index) => fetchPart(index + 2, signal)),
  )
  return {
    ...first,
    stakers: first.stakers.concat(...rest.map((payload) => payload.stakers ?? [])),
  }
}

/** Slider stops, in NIM. Stake is steeply skewed, so the steps are logarithmic. */
const MIN_STAKE_STEPS = [0, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]

type Status = "loading" | "ready" | "error"

export function DelegationGraph() {
  const [status, setStatus] = useState<Status>("loading")
  const [model, setModel] = useState<GraphModel | null>(null)
  const [attempt, setAttempt] = useState(0)

  const [search, setSearch] = useState("")
  const [minStakeStep, setMinStakeStep] = useState(0)
  const [showLabels, setShowLabels] = useState(true)
  const [highlightImpact, setHighlightImpact] = useState(false)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [hovered, setHovered] = useState<{ node: GraphNode; x: number; y: number } | null>(null)
  const [activeCluster, setActiveCluster] = useState<number | null>(null)

  const canvasHandle = useRef<GraphCanvasHandle | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    setStatus("loading")
    fetchGraph(controller.signal)
      .then((payload) => {
        if (cancelled) return
        if (!Array.isArray(payload?.validators) || payload.validators.length === 0) {
          throw new Error("empty payload")
        }
        setModel(buildGraph(payload))
        setStatus("ready")
      })
      .catch((error) => {
        if (cancelled) return
        console.debug("delegation graph fetch failed", error)
        setStatus("error")
      })
      .finally(() => clearTimeout(timer))

    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [attempt])

  const minStakerBalance = MIN_STAKE_STEPS[minStakeStep] * LUNA_PER_NIM

  const matchIds = useMemo(() => {
    const query = search.trim()
    if (query.length < 2 || !model) return null
    const needle = compactAddress(query)
    const loose = query.toLowerCase()
    const hits = new Set<string>()
    for (const node of model.nodes) {
      if (node.searchKey.includes(needle) || node.searchKey.includes(loose)) hits.add(node.id)
    }
    return hits
  }, [search, model])

  // Frame the first hit as soon as the query resolves to one.
  useEffect(() => {
    if (!matchIds || matchIds.size === 0) return
    const first = matchIds.values().next().value
    if (first) canvasHandle.current?.focusNode(first)
  }, [matchIds])

  const visibleCount = useMemo(() => {
    if (!model) return 0
    return model.nodes.filter((node) => node.kind === "validator" || node.balance >= minStakerBalance).length
  }, [model, minStakerBalance])

  const view: GraphCanvasView = {
    minStakerBalance,
    showLabels,
    highlightImpact,
    selectedId: selected?.id ?? null,
    hoveredId: hovered?.node.id ?? null,
    highlightClusterId: activeCluster,
    matchIds,
  }

  const handleHover = useCallback((node: GraphNode | null, point: { x: number; y: number } | null) => {
    setHovered(node && point ? { node, x: point.x, y: point.y } : null)
  }, [])

  const handleSelect = useCallback((node: GraphNode | null) => {
    setSelected(node)
    if (!node) setActiveCluster(null)
  }, [])

  const handleReady = useCallback((handle: GraphCanvasHandle) => {
    canvasHandle.current = handle
  }, [])

  if (status === "error") {
    return <GraphError onRetry={() => setAttempt((n) => n + 1)} />
  }

  if (status === "loading" || !model) {
    return <GraphSkeleton />
  }

  const impact = model.clusters.find((cluster) => cluster.isImpact) ?? null
  const totalStakers = model.nodes.length - model.clusters.length

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Validators" value={model.clusters.length.toLocaleString("en-US")} />
        <Stat label="Stakers mapped" value={totalStakers.toLocaleString("en-US")} />
        <Stat label="Active stake" value={formatNim(model.totalActiveStake)} />
        <Stat
          label="ImpactZero share"
          value={impact ? formatShare(impact.share) : "n/a"}
          accent={Boolean(impact)}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card/30">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-3">
          <div className="flex w-full min-w-0 items-center gap-2 md:w-auto md:flex-1">
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search address or validator…"
              aria-label="Search the delegation map by address or validator name"
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring md:max-w-72"
            />
            {matchIds && (
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {matchIds.size} match{matchIds.size === 1 ? "" : "es"}
              </span>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="whitespace-nowrap">Min staker stake</span>
            <input
              type="range"
              min={0}
              max={MIN_STAKE_STEPS.length - 1}
              step={1}
              value={minStakeStep}
              onChange={(event) => setMinStakeStep(Number(event.target.value))}
              aria-label="Hide stakers below this stake"
              className="w-24 cursor-pointer accent-primary"
            />
            <span className="w-14 font-mono tabular-nums text-foreground">
              {MIN_STAKE_STEPS[minStakeStep] === 0
                ? "all"
                : formatNim(MIN_STAKE_STEPS[minStakeStep] * LUNA_PER_NIM).replace(" NIM", "")}
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-1.5 md:ml-auto">
            <Toggle active={highlightImpact} onClick={() => setHighlightImpact((on) => !on)}>
              Highlight ImpactZero
            </Toggle>
            <Toggle active={showLabels} onClick={() => setShowLabels((on) => !on)}>
              Labels
            </Toggle>
            <Button variant="outline" size="icon-sm" aria-label="Zoom out" onClick={() => canvasHandle.current?.zoomOut()}>
              −
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Zoom in" onClick={() => canvasHandle.current?.zoomIn()}>
              +
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelected(null)
                setActiveCluster(null)
                setSearch("")
                canvasHandle.current?.resetView()
              }}
            >
              Reset
            </Button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="relative h-[26rem] border-b border-border sm:h-[32rem] lg:h-[calc(100vh-13rem)] lg:min-h-[40rem] lg:border-b-0 lg:border-r">
            <HexGraphCanvas
              model={model}
              view={view}
              onSelect={handleSelect}
              onHover={handleHover}
              onReady={handleReady}
            />

            <div className="pointer-events-none absolute left-3 top-3 flex flex-col gap-1.5">
              <span className="w-fit rounded-md bg-background/80 px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground backdrop-blur">
                {visibleCount.toLocaleString("en-US")} / {model.nodes.length.toLocaleString("en-US")} nodes
              </span>
              <span className="w-fit rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
                Drag to pan · scroll to zoom · click a hex
              </span>
            </div>

            <Legend />

            {hovered && <Tooltip hovered={hovered} totalStake={model.totalActiveStake} />}
            {selected && (
              <SelectionPanel
                node={selected}
                model={model}
                onClose={() => {
                  setSelected(null)
                  setActiveCluster(null)
                }}
              />
            )}
          </div>

          <ClusterList
            clusters={model.clusters}
            activeCluster={activeCluster}
            onPick={(cluster) => {
              const next = activeCluster === cluster.id ? null : cluster.id
              setActiveCluster(next)
              setSelected(next === null ? null : cluster.validator)
              if (next !== null) canvasHandle.current?.focusNode(cluster.validator.id)
            }}
          />
        </div>

        <p className="border-t border-border px-3 py-2.5 font-mono text-[11px] text-muted-foreground">
          Live from {API_HOST}/api/graph · NimiqHub chain data · updated{" "}
          {new Date(model.updatedAt).toLocaleTimeString("en-US")} · every address, balance and edge on this
          map is on-chain
        </p>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card size="sm">
      <CardContent className="px-4 py-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-1 font-mono text-xl font-semibold tabular-nums",
            accent ? "text-primary" : "text-foreground",
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  )
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
      className="whitespace-nowrap"
    >
      {children}
    </Button>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 right-3 hidden rounded-lg bg-background/80 px-3 py-2 backdrop-blur sm:block">
      <p className="text-[11px] text-muted-foreground">
        Hex area ∝ stake (√ scale) · colour groups a validator and its stakers
      </p>
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rotate-90 bg-primary [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]" />
          ImpactZero
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 bg-zinc-500 [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]" />
          validator
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 bg-zinc-500 [clip-path:polygon(25%_0,75%_0,100%_50%,75%_100%,25%_100%,0_50%)]" />
          staker
        </span>
      </div>
    </div>
  )
}

function Tooltip({
  hovered,
  totalStake,
}: {
  hovered: { node: GraphNode; x: number; y: number }
  totalStake: number
}) {
  const { node, x, y } = hovered
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[17rem] rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-xl backdrop-blur"
      style={{
        left: 0,
        top: 0,
        transform: `translate(calc(${x}px - 50%), calc(${y}px - 100% - 14px))`,
      }}
    >
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-sm" style={{ background: node.color }} />
        <span className="text-xs font-medium text-foreground">
          {node.kind === "validator" ? node.label : "Staker"}
        </span>
        {node.isImpact && (
          <Badge variant="outline" className="border-primary/40 text-primary">
            ImpactZero
          </Badge>
        )}
      </div>
      <p className="mt-1 font-mono text-[11px] break-all text-muted-foreground">{node.address}</p>
      <p className="mt-1.5 font-mono text-sm tabular-nums text-foreground">{formatNimFull(node.balance)}</p>
      <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatShare(totalStake > 0 ? node.balance / totalStake : 0)} of active stake
      </p>
    </div>
  )
}

function SelectionPanel({
  node,
  model,
  onClose,
}: {
  node: GraphNode
  model: GraphModel
  onClose: () => void
}) {
  const cluster = model.clusters[node.clusterId] ?? null
  return (
    <div className="absolute bottom-3 left-3 w-[min(20rem,calc(100%-1.5rem))] rounded-lg border border-border bg-popover/95 p-3 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: node.color }} />
          <span className="text-sm font-medium text-foreground">
            {node.kind === "validator" ? node.label : "Staker"}
          </span>
          {node.isImpact && (
            <Badge variant="outline" className="border-primary/40 text-primary">
              ImpactZero
            </Badge>
          )}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close details" onClick={onClose}>
          ×
        </Button>
      </div>

      <p className="mt-2 font-mono text-[11px] break-all text-muted-foreground">{node.address}</p>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <div>
          {/* NimiqHub reports a validator's whole pool here, not just its own stake. */}
          <dt className="text-muted-foreground">{node.kind === "validator" ? "Pool stake" : "Stake"}</dt>
          <dd className="font-mono tabular-nums text-foreground">{formatNimFull(node.balance)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Share of total</dt>
          <dd className="font-mono tabular-nums text-foreground">{formatShare(node.share)}</dd>
        </div>
        {node.kind === "staker" ? (
          <div className="col-span-2">
            <dt className="text-muted-foreground">Delegates to</dt>
            <dd className="font-mono break-all text-foreground">
              {cluster?.label ?? node.validatorAddress}
            </dd>
          </div>
        ) : (
          <>
            <div>
              <dt className="text-muted-foreground">Stakers</dt>
              <dd className="font-mono tabular-nums text-foreground">
                {(cluster?.stakerCount ?? 0).toLocaleString("en-US")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Delegated</dt>
              <dd className="font-mono tabular-nums text-foreground">
                {formatNim(cluster?.delegatedStake ?? 0)}
              </dd>
            </div>
          </>
        )}
      </dl>

      <a
        href={explorerUrl(node.address)}
        target="_blank"
        rel="noopener"
        className="mt-3 inline-block font-mono text-[11px] text-primary hover:underline"
      >
        View on nimiq.watch →
      </a>
    </div>
  )
}

function ClusterList({
  clusters,
  activeCluster,
  onPick,
}: {
  clusters: Cluster[]
  activeCluster: number | null
  onPick: (cluster: Cluster) => void
}) {
  // The cap tracks the map height so the list fills the row and scrolls inside it.
  return (
    <aside className="flex max-h-[26rem] flex-col lg:max-h-[max(40rem,calc(100vh-13rem))]">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Validators</h2>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{clusters.length}</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {clusters.map((cluster) => {
          const active = activeCluster === cluster.id
          return (
            <li key={cluster.address}>
              <button
                onClick={() => onPick(cluster)}
                aria-pressed={active}
                className={cn(
                  "flex w-full items-center gap-2.5 border-b border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/50",
                  active && "bg-muted",
                )}
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: cluster.color }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">
                    {cluster.label}
                    {cluster.isImpact && <span className="ml-1.5 text-primary">◆</span>}
                  </span>
                  <span className="block font-mono text-[10px] tabular-nums text-muted-foreground">
                    {cluster.stakerCount.toLocaleString("en-US")} stakers ·{" "}
                    {formatShare(cluster.share)}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatNim(cluster.validatorStake).replace(" NIM", "")}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function GraphSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[4.5rem] w-full rounded-xl" />
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <Skeleton className="h-12 w-full rounded-none" />
        <div className="grid lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex h-[26rem] items-center justify-center sm:h-[32rem] lg:h-[calc(100vh-13rem)] lg:min-h-[40rem]">
            <p className="font-mono text-xs text-muted-foreground">
              Loading delegation data from {API_HOST}…
            </p>
          </div>
          <Skeleton className="hidden rounded-none lg:block lg:h-[calc(100vh-13rem)] lg:min-h-[40rem]" />
        </div>
      </div>
    </div>
  )
}

function GraphError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card>
      <CardContent className="px-6 py-8 text-center">
        <p className="text-sm font-medium text-foreground">The delegation map could not load</p>
        <p className="mx-auto mt-2 max-w-[46ch] text-sm text-muted-foreground">
          {API_HOST} did not answer in time. The map is built entirely from live chain data, so there is
          nothing to show until it does — no placeholder graph is drawn.
        </p>
        <Button className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  )
}
