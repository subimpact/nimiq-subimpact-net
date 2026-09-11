/**
 * ChainMap — type an address, follow its money.
 *
 * The whole free tier runs without a wallet, a popup or a sign-in: the paywall
 * dialog (and with it @nimiq/hub-api) is only imported once someone reaches for
 * depth 4, an export, or the Unlock button.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DownloadIcon, Loader2Icon, SearchIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { track } from "@/lib/analytics"
import { formatAddress, formatNim, isValidAddress, shortAddress } from "@/lib/nimiq"
import { useChainmapAuth, type Pass } from "@/lib/chainmapAuth"
import { AddressMapCanvas, type HoverTarget, type MapCanvasHandle } from "./AddressMapCanvas"
import { EdgeDetail, NodeDetail } from "./DetailPanels"
import { buildMap, findEdge, findNode, sortedEdges } from "./buildMap"
import { downloadCsv, downloadPng } from "./exports"
import { relativeTime } from "./format"
import { scanAddress } from "./scan"
import { TIER_LIMITS, type MapModel, type ScanProgress } from "./types"

const PaywallDialog = lazy(() =>
  import("./PaywallDialog").then((module) => ({ default: module.PaywallDialog })),
)

const EXAMPLES = [
  { label: "ImpactZero validator", address: "NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY" },
  { label: "a staking wallet", address: "NQ27 NCB1 3CYU 9P4L EM2V D7L2 28QE 36PA EXB1" },
]

const DEPTHS = [1, 2, 3, 4, 5, 6]
const DEFAULT_DEPTH = 3
/** Rows of the transaction list under the map; the CSV export carries them all. */
const LIST_LIMIT = 25

type Status = "idle" | "scanning" | "ready" | "error"

export function ChainMap() {
  const auth = useChainmapAuth()
  const tier = auth.tier
  const limits = TIER_LIMITS[tier]

  const [input, setInput] = useState("")
  const [depth, setDepth] = useState(DEFAULT_DEPTH)
  const [status, setStatus] = useState<Status>("idle")
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [model, setModel] = useState<MapModel | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)
  const [selectedEdgeHash, setSelectedEdgeHash] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverTarget | null>(null)
  const [showLabels, setShowLabels] = useState(true)

  const [paywallOpen, setPaywallOpen] = useState(false)
  const [paywallMode, setPaywallMode] = useState<"unlock" | "manage">("unlock")

  const controller = useRef<AbortController | null>(null)
  const canvas = useRef<MapCanvasHandle | null>(null)

  // A pass that lapses mid-session must not leave the controls offering depth 6.
  useEffect(() => {
    if (depth > limits.maxDepth) setDepth(limits.maxDepth)
  }, [depth, limits.maxDepth])

  useEffect(() => () => controller.current?.abort(), [])

  const trimmed = input.trim()
  const valid = isValidAddress(trimmed)
  const showInvalid = trimmed.length > 3 && !valid

  const runScan = useCallback(
    (rawAddress: string, requestedDepth: number) => {
      const address = formatAddress(rawAddress)
      if (!isValidAddress(address)) {
        setError("That is not a valid Nimiq address. It should look like NQ08 ACT8 T0FE …")
        setStatus("error")
        return
      }

      controller.current?.abort()
      const abort = new AbortController()
      controller.current = abort

      setInput(address)
      setError(null)
      setStatus("scanning")
      setProgress({ scanned: 0, addresses: 1, txs: 0, level: 0 })
      setSelectedNodeKey(null)
      setSelectedEdgeHash(null)
      setHover(null)
      track("chainmap_scan_started", { depth: requestedDepth, tier })

      scanAddress(address, {
        depth: requestedDepth,
        tier,
        limits,
        signal: abort.signal,
        onProgress: setProgress,
      })
        .then((result) => {
          if (abort !== controller.current) return
          setModel(buildMap(result))
          setStatus("ready")
          if (result.meta.reachedAddressCap) track("chainmap_limit_hit", { limit: "cap" })
          else if (result.meta.reachedDepth && requestedDepth >= limits.maxDepth) {
            track("chainmap_limit_hit", { limit: "depth" })
          }
        })
        .catch((cause) => {
          if (abort !== controller.current) return
          console.debug("chainmap scan failed", cause)
          setError("The scan could not be completed. The history service may be busy — try again.")
          setStatus("error")
        })
    },
    [limits, tier],
  )

  const openPaywall = useCallback((mode: "unlock" | "manage") => {
    setPaywallMode(mode)
    setPaywallOpen(true)
  }, [])

  const stop = useCallback(() => controller.current?.abort(), [])

  const clear = useCallback(() => {
    controller.current?.abort()
    controller.current = null
    setModel(null)
    setStatus("idle")
    setProgress(null)
    setError(null)
    setInput("")
    setSelectedNodeKey(null)
    setSelectedEdgeHash(null)
    setHover(null)
  }, [])

  // Esc clears the selection — the same key that closes the dialogs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setSelectedNodeKey(null)
      setSelectedEdgeHash(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const selectedNode = useMemo(
    () => (model ? findNode(model, selectedNodeKey) : null),
    [model, selectedNodeKey],
  )
  const selectedEdge = useMemo(
    () => (model ? findEdge(model, selectedEdgeHash) : null),
    [model, selectedEdgeHash],
  )
  const recentEdges = useMemo(() => (model ? sortedEdges(model).slice(0, LIST_LIMIT) : []), [model])

  const exportPng = useCallback(async () => {
    if (!model) return
    if (!limits.exports) {
      openPaywall("unlock")
      return
    }
    const blob = await canvas.current?.exportBlob()
    if (!blob) return
    downloadPng(blob, model.meta.seed)
    track("chainmap_export", { format: "png", tier })
  }, [limits.exports, model, openPaywall, tier])

  const exportCsv = useCallback(() => {
    if (!model) return
    if (!limits.exports) {
      openPaywall("unlock")
      return
    }
    downloadCsv(model)
    track("chainmap_export", { format: "csv", tier })
  }, [limits.exports, model, openPaywall, tier])

  const onEntitled = useCallback(
    (pass: Pass) => {
      auth.adopt(pass)
    },
    [auth],
  )

  const scanning = status === "scanning"

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card/30">
        {/* --- controls --- */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-3">
          <form
            className="flex w-full min-w-0 items-center gap-2 md:w-auto md:flex-1"
            onSubmit={(event) => {
              event.preventDefault()
              if (valid) runScan(trimmed, depth)
            }}
          >
            <div className="relative min-w-0 flex-1 md:max-w-96">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="NQ… paste any Nimiq address"
                aria-label="Nimiq address to map"
                aria-invalid={showInvalid || undefined}
                data-chainmap-input=""
                className={cn(
                  "h-8 w-full min-w-0 rounded-lg border border-border bg-background pr-3 pl-8 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring",
                  showInvalid && "border-destructive/60",
                )}
              />
            </div>
            <Button type="submit" size="sm" disabled={!valid || scanning} data-chainmap-scan="">
              {scanning ? <Loader2Icon className="animate-spin" /> : null}
              {scanning ? "Scanning" : "Scan"}
            </Button>
            {scanning && (
              <Button type="button" size="sm" variant="outline" onClick={stop} data-chainmap-stop="">
                Stop
              </Button>
            )}
            {!scanning && model && (
              <Button type="button" size="sm" variant="outline" onClick={clear} data-chainmap-clear="">
                Clear
              </Button>
            )}
          </form>

          <DepthPicker
            depth={depth}
            maxDepth={limits.maxDepth}
            disabled={scanning}
            onPick={setDepth}
            onLocked={() => openPaywall("unlock")}
          />

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Zoom out"
              onClick={() => canvas.current?.zoomOut()}
            >
              −
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Zoom in"
              onClick={() => canvas.current?.zoomIn()}
            >
              +
            </Button>
            <Button variant="outline" size="sm" onClick={() => canvas.current?.resetView()}>
              Reset
            </Button>
            <TierBadge
              tier={tier}
              expired={auth.status === "expired"}
              daysLeft={auth.pass?.daysLeft ?? 0}
              address={auth.pass?.address ?? null}
              onClick={() => openPaywall(tier === "paid" ? "manage" : "unlock")}
            />
          </div>
        </div>

        {/* --- map --- */}
        <div className="relative h-[26rem] border-b border-border sm:h-[32rem] lg:h-[calc(100vh-15rem)] lg:min-h-[36rem]">
          {model ? (
            <>
              <AddressMapCanvas
                model={model}
                view={{
                  selectedNodeKey,
                  selectedEdgeHash,
                  hoveredNodeKey: hover?.node?.key ?? null,
                  hoveredEdgeHash: hover?.edge?.hash ?? null,
                  showLabels,
                }}
                onSelectNode={(node) => {
                  setSelectedNodeKey(node?.key ?? null)
                  setSelectedEdgeHash(null)
                }}
                onSelectEdge={(edge) => {
                  setSelectedEdgeHash(edge.hash)
                  setSelectedNodeKey(null)
                }}
                onHover={setHover}
                onRescan={(node) => {
                  if (tier !== "paid") {
                    openPaywall("unlock")
                    return
                  }
                  runScan(node.address, depth)
                }}
                onReady={(handle) => {
                  canvas.current = handle
                }}
              />

              <div className="pointer-events-none absolute top-3 left-3 flex flex-col items-start gap-1.5">
                <span
                  className="rounded-md bg-background/80 px-2 py-1 font-mono text-[11px] tabular-nums text-muted-foreground backdrop-blur"
                  data-chainmap-counts=""
                >
                  {model.nodes.length.toLocaleString("en-US")} addresses ·{" "}
                  {model.edges.length.toLocaleString("en-US")} transactions
                </span>
                <span className="rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
                  Drag to pan · scroll to zoom · click a node or an arrow
                </span>
              </div>

              <button
                type="button"
                onClick={() => setShowLabels((on) => !on)}
                aria-pressed={showLabels}
                className="absolute top-3 right-3 z-10 cursor-pointer rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
              >
                {showLabels ? "Hide labels" : "Show labels"}
              </button>

              {hover && !selectedNode && !selectedEdge && <Tooltip hover={hover} />}

              {selectedNode && (
                <NodeDetail
                  node={selectedNode}
                  tier={tier}
                  onClose={() => setSelectedNodeKey(null)}
                  onRescan={(node) => runScan(node.address, depth)}
                  onUnlock={() => openPaywall("unlock")}
                />
              )}
              {selectedEdge && (
                <EdgeDetail edge={selectedEdge} onClose={() => setSelectedEdgeHash(null)} />
              )}

              <Legend />
            </>
          ) : (
            <EmptyState
              status={status}
              error={error}
              progress={progress}
              onPick={(address) => runScan(address, depth)}
            />
          )}

          {scanning && model && <ScanOverlay progress={progress} />}
        </div>

        {/* --- summary --- */}
        {model && (
          <Summary
            model={model}
            tier={tier}
            exportsAllowed={limits.exports}
            onUnlock={() => openPaywall("unlock")}
            onExportPng={exportPng}
            onExportCsv={exportCsv}
          />
        )}
      </div>

      {model && recentEdges.length > 0 && (
        <TransactionList
          edges={recentEdges}
          total={model.edges.length}
          selectedHash={selectedEdgeHash}
          onPick={(hash) => {
            setSelectedEdgeHash(hash)
            setSelectedNodeKey(null)
          }}
        />
      )}

      {paywallOpen && (
        <Suspense fallback={null}>
          <PaywallDialog
            open={paywallOpen}
            onOpenChange={setPaywallOpen}
            mode={paywallMode}
            pass={auth.pass}
            expired={auth.status === "expired"}
            onEntitled={onEntitled}
            onSignOut={auth.signOut}
            onRefresh={auth.refresh}
          />
        </Suspense>
      )}
    </div>
  )
}

function DepthPicker({
  depth,
  maxDepth,
  disabled,
  onPick,
  onLocked,
}: {
  depth: number
  maxDepth: number
  disabled: boolean
  onPick: (depth: number) => void
  onLocked: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs whitespace-nowrap text-muted-foreground">Depth</span>
      <div
        className="flex items-center overflow-hidden rounded-lg border border-border"
        role="group"
        aria-label="Scan depth"
      >
        {DEPTHS.map((value) => {
          const locked = value > maxDepth
          const active = value === depth
          return (
            <button
              key={value}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              data-chainmap-depth={value}
              data-locked={locked ? "" : undefined}
              onClick={() => (locked ? onLocked() : onPick(value))}
              className={cn(
                "h-8 w-7 cursor-pointer border-r border-border text-xs tabular-nums transition-colors last:border-r-0",
                active
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                locked && !active && "text-muted-foreground/45",
                disabled && "cursor-not-allowed opacity-60",
              )}
              title={locked ? "Depth 4–6 needs a ChainMap pass" : `Depth ${value}`}
            >
              {value}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TierBadge({
  tier,
  expired,
  daysLeft,
  address,
  onClick,
}: {
  tier: "free" | "paid"
  expired: boolean
  daysLeft: number
  address: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-chainmap-tier={expired && tier === "free" ? "expired" : tier}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] whitespace-nowrap transition-colors",
        tier === "paid"
          ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
          : expired
            ? "border-primary/40 text-primary hover:bg-primary/10"
            : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {expired && tier === "free" ? (
        <>
          <span className="font-semibold">Pass expired</span>
          <span>renew</span>
        </>
      ) : tier === "paid" ? (
        <>
          <span className="font-semibold">Pass</span>
          <span className="font-mono tabular-nums">
            {daysLeft} day{daysLeft === 1 ? "" : "s"} left
          </span>
          {address && <span className="font-mono opacity-70">{shortAddress(address, 4)}</span>}
        </>
      ) : (
        <>
          <span className="font-semibold text-foreground">Free</span>
          <span>depth 3</span>
        </>
      )}
    </button>
  )
}

function EmptyState({
  status,
  error,
  progress,
  onPick,
}: {
  status: Status
  error: string | null
  progress: ScanProgress | null
  onPick: (address: string) => void
}) {
  if (status === "scanning") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2Icon className="size-5 animate-spin text-primary" />
        <p className="font-mono text-xs text-muted-foreground" data-chainmap-progress="">
          scanned {progress?.scanned ?? 0} · {progress?.addresses ?? 0} addresses ·{" "}
          {progress?.txs ?? 0} transactions
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      {status === "error" && error ? (
        <p
          role="alert"
          data-chainmap-error=""
          className="flex max-w-[46ch] items-start gap-2 text-sm text-destructive"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : (
        <p className="max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
          Paste a Nimiq address and press Scan. Every arrow on the map is one transaction, drawn
          from the address it left toward the address it reached.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-muted-foreground">Try:</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.address}
            type="button"
            data-chainmap-example=""
            onClick={() => onPick(example.address)}
            className="cursor-pointer rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          >
            {example.label}
            <span className="ml-1.5 font-mono opacity-60">{shortAddress(example.address, 4)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ScanOverlay({ progress }: { progress: ScanProgress | null }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <span
        className="flex items-center gap-2 rounded-full bg-background/90 px-3 py-1.5 font-mono text-[11px] text-muted-foreground shadow-lg backdrop-blur"
        data-chainmap-progress=""
      >
        <Loader2Icon className="size-3 animate-spin text-primary" />
        scanned {progress?.scanned ?? 0} · {progress?.addresses ?? 0} addresses ·{" "}
        {progress?.txs ?? 0} transactions
      </span>
    </div>
  )
}

function Tooltip({ hover }: { hover: HoverTarget }) {
  const { node, edge, x, y } = hover
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-[18rem] rounded-lg border border-border bg-popover/95 px-3 py-2 shadow-xl backdrop-blur"
      style={{ left: 0, top: 0, transform: `translate(calc(${x}px - 50%), calc(${y}px - 100% - 14px))` }}
    >
      {node ? (
        <>
          <p className="font-mono text-[11px] text-foreground">{shortAddress(node.address, 4)}</p>
          <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
            in {formatNim(node.totalIn)} · out {formatNim(node.totalOut)}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {node.txCount} tx · {node.level === 0 ? "seed" : `${node.level} hop${node.level === 1 ? "" : "s"}`}
          </p>
        </>
      ) : edge ? (
        <>
          <p className="font-mono text-sm tabular-nums text-foreground">{formatNim(edge.value)}</p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {shortAddress(edge.source.address, 4)} → {shortAddress(edge.target.address, 4)}
          </p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {relativeTime(edge.timestamp)}
          </p>
        </>
      ) : null}
    </div>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 hidden rounded-lg bg-background/85 px-3 py-2 backdrop-blur sm:block">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-primary" />
          seed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-zinc-400" />
          address
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border border-dashed border-zinc-400" />
          edge of scan
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-5 bg-primary" />
          recent tx
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-5 bg-zinc-600" />
          old tx
        </span>
        <span>arrow = direction · width = amount</span>
      </div>
    </div>
  )
}

function Summary({
  model,
  tier,
  exportsAllowed,
  onUnlock,
  onExportPng,
  onExportCsv,
}: {
  model: MapModel
  tier: "free" | "paid"
  exportsAllowed: boolean
  onUnlock: () => void
  onExportPng: () => void
  onExportCsv: () => void
}) {
  const { meta } = model
  const hitDepth = meta.reachedDepth && meta.depth >= meta.limits.maxDepth
  const hitCap = meta.reachedAddressCap
  const bounded = hitDepth || hitCap

  return (
    <div className="grid gap-3 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
          <span className="text-foreground">{meta.addressCount.toLocaleString("en-US")}</span>{" "}
          addresses ·{" "}
          <span className="text-foreground">{meta.edgeCount.toLocaleString("en-US")}</span>{" "}
          transactions · {meta.scannedCount} scanned · depth {meta.depth} ·{" "}
          {(meta.elapsedMs / 1000).toFixed(1)}s
          {meta.failedCount > 0 && ` · ${meta.failedCount} unreadable`}
          {meta.stopped && " · stopped"}
        </p>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onExportPng} data-chainmap-export-png="">
            <DownloadIcon /> PNG
            {!exportsAllowed && <span className="ml-1 opacity-60">Pass</span>}
          </Button>
          <Button variant="outline" size="sm" onClick={onExportCsv} data-chainmap-export-csv="">
            <DownloadIcon /> CSV
            {!exportsAllowed && <span className="ml-1 opacity-60">Pass</span>}
          </Button>
        </div>
      </div>

      {bounded && (
        <div
          data-chainmap-limit={hitCap ? "cap" : "depth"}
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-3 py-2 text-xs",
            tier === "free" ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground",
          )}
        >
          {tier === "free" ? (
            <>
              <span>
                Free scans stop at depth {meta.limits.maxDepth} and{" "}
                {meta.limits.addressCap} addresses —{" "}
                {hitCap
                  ? `this one hit the address cap, with ${meta.frontierCount} addresses left unopened.`
                  : `${meta.frontierCount} addresses at the edge of this map were never opened.`}
              </span>
              <Button size="xs" onClick={onUnlock} data-chainmap-unlock="">
                Unlock deeper ↓
              </Button>
            </>
          ) : (
            <span>
              The map stops here: {meta.frontierCount.toLocaleString("en-US")} addresses at the
              boundary were not opened
              {hitCap ? `, and the ${meta.limits.addressCap}-address cap was reached` : ""}. Scan
              one of them to keep going.
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function TransactionList({
  edges,
  total,
  selectedHash,
  onPick,
}: {
  edges: ReturnType<typeof sortedEdges>
  total: number
  selectedHash: string | null
  onPick: (hash: string) => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card/30">
      <div className="flex items-baseline justify-between border-b border-border px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Transactions
        </h2>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          newest {edges.length} of {total.toLocaleString("en-US")}
        </span>
      </div>
      <ul className="max-h-72 overflow-y-auto">
        {edges.map((edge) => (
          <li key={edge.hash}>
            <button
              type="button"
              onClick={() => onPick(edge.hash)}
              aria-pressed={selectedHash === edge.hash}
              className={cn(
                "flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/60 px-3 py-2 text-left transition-colors hover:bg-muted/50",
                selectedHash === edge.hash && "bg-muted",
              )}
            >
              <span className="font-mono text-[11px] text-muted-foreground">
                {shortAddress(edge.source.address, 4)} → {shortAddress(edge.target.address, 4)}
              </span>
              <span className="ml-auto font-mono text-xs tabular-nums text-foreground">
                {formatNim(edge.value)}
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                {relativeTime(edge.timestamp)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default ChainMap
