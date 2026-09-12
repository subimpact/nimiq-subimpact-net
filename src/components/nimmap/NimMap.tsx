/**
 * NimMap — type an address, follow its money.
 *
 * The whole free tier runs without a wallet, a popup or a sign-in: the paywall
 * dialog (and with it @nimiq/hub-api) is only imported once someone reaches for
 * depth 4, an export, or the Unlock button.
 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { DownloadIcon, Loader2Icon, SearchIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { track } from "@/lib/analytics"
import { formatAddress, formatNim, isValidAddress, shortAddress } from "@/lib/nimiq"
import { useNimmapAuth, type Pass } from "@/lib/nimmapAuth"
import { AddressMapCanvas, type HoverTarget, type MapCanvasHandle } from "./AddressMapCanvas"
import { EdgeDetail, NodeDetail } from "./DetailPanels"
import { CONTRACT_COLOR, NODE_COLOR, SEED_COLOR, buildMap, findEdge, findNode, sortedEdges } from "./buildMap"
import { downloadCsv, downloadPng } from "./exports"
import { relativeTime } from "./format"
import { scanAddress } from "./scan"
import { DASHED_KIND, EDGE_COLORS, EDGE_KIND_LABELS, type EdgeKind } from "./txKinds"
import { TIER_LIMITS, type ColorMode, type MapModel, type ScanProgress } from "./types"

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

export function NimMap() {
  const auth = useNimmapAuth()
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
  // Type by default: what a transaction *is* survives a glance better than how old it
  // is, and age is still one chip away.
  const [colorMode, setColorMode] = useState<ColorMode>("type")

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
      track("nimmap_scan_started", { depth: requestedDepth, tier })

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
          if (result.meta.reachedAddressCap) track("nimmap_limit_hit", { limit: "cap" })
          else if (result.meta.reachedDepth && requestedDepth >= limits.maxDepth) {
            track("nimmap_limit_hit", { limit: "depth" })
          }
        })
        .catch((cause) => {
          if (abort !== controller.current) return
          console.debug("nimmap scan failed", cause)
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
    track("nimmap_export", { format: "png", tier })
  }, [limits.exports, model, openPaywall, tier])

  const exportCsv = useCallback(() => {
    if (!model) return
    if (!limits.exports) {
      openPaywall("unlock")
      return
    }
    downloadCsv(model)
    track("nimmap_export", { format: "csv", tier })
  }, [limits.exports, model, openPaywall, tier])

  const onEntitled = useCallback(
    (pass: Pass) => {
      auth.adopt(pass)
    },
    [auth],
  )

  const scanning = status === "scanning"

  // Picking a depth while a map is drawn re-runs that map at the new depth — without
  // this the control reads as dead: the highlight moves but nothing else does. A
  // cleared map skips the rescan; the depth then applies to the next Scan.
  const pickDepth = useCallback(
    (value: number) => {
      setDepth(value)
      if (model && !scanning && value !== depth) runScan(model.meta.seed, value)
    },
    [model, scanning, depth, runScan],
  )

  // A `?seed=NQ…` link — the explorer's address search, or anyone deep-linking a wallet —
  // opens the map already scanning that address. Once per mount, so a re-render can never
  // restart the scan; the ref guard is the whole of the protection.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    const seed = new URLSearchParams(window.location.search).get("seed")
    if (!seed) return
    if (isValidAddress(formatAddress(seed))) runScan(seed, DEFAULT_DEPTH)
    // Deliberately run-once with the mount-time runScan; the ref above owns re-entrancy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
                data-nimmap-input=""
                className={cn(
                  "h-8 w-full min-w-0 rounded-lg border border-border bg-background pr-3 pl-8 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring",
                  showInvalid && "border-destructive/60",
                )}
              />
            </div>
            <Button type="submit" size="sm" disabled={!valid || scanning} data-nimmap-scan="">
              {scanning ? <Loader2Icon className="animate-spin" /> : null}
              {scanning ? "Scanning" : "Scan"}
            </Button>
            {scanning && (
              <Button type="button" size="sm" variant="outline" onClick={stop} data-nimmap-stop="">
                Stop
              </Button>
            )}
            {!scanning && model && (
              <Button type="button" size="sm" variant="outline" onClick={clear} data-nimmap-clear="">
                Clear
              </Button>
            )}
          </form>

          <DepthPicker
            depth={depth}
            maxDepth={limits.maxDepth}
            disabled={scanning}
            onPick={pickDepth}
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
              comp={auth.pass?.comp ?? false}
              staker={auth.pass?.staker ?? false}
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
                  colorMode,
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
                  data-nimmap-counts=""
                >
                  {model.nodes.length.toLocaleString("en-US")} addresses ·{" "}
                  {model.edges.length.toLocaleString("en-US")} transactions
                </span>
                <span className="rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
                  Drag to pan · scroll to zoom · click a node or an arrow
                </span>
              </div>

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

              {/* The legend and the labels toggle share the top-right corner: the
                  legend reads first, the toggle keeps the corner itself. */}
              <div className="absolute top-3 right-3 z-20 flex items-start gap-2">
                <Legend
                  mode={colorMode}
                  onMode={setColorMode}
                  yielding={Boolean(selectedNode || selectedEdge)}
                />
                <button
                  type="button"
                  onClick={() => setShowLabels((on) => !on)}
                  aria-pressed={showLabels}
                  data-nimmap-labels-toggle=""
                  className="cursor-pointer rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
                >
                  {showLabels ? "Hide labels" : "Show labels"}
                </button>
              </div>
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
              data-nimmap-depth={value}
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
              title={locked ? "Depth 4–6 needs a NimMap pass" : `Depth ${value}`}
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
  comp,
  staker,
  address,
  onClick,
}: {
  tier: "free" | "paid"
  expired: boolean
  daysLeft: number
  /** An operator-granted pass: same tier, but there is no countdown to show. */
  comp: boolean
  /** A pass earned by staking: renews at each sign-in, so it also shows no countdown. */
  staker: boolean
  address: string | null
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-nimmap-tier={expired && tier === "free" ? "expired" : tier}
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
          <span className="font-semibold">{staker ? "Staker pass" : comp ? "Owner pass" : "Pass"}</span>
          {staker ? (
            <span>while staked</span>
          ) : comp ? (
            <span>no expiry</span>
          ) : (
            <span className="font-mono tabular-nums">
              {daysLeft} day{daysLeft === 1 ? "" : "s"} left
            </span>
          )}
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
        <p className="font-mono text-xs text-muted-foreground" data-nimmap-progress="">
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
          data-nimmap-error=""
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
            data-nimmap-example=""
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
        data-nimmap-progress=""
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

/**
 * A flat-top hexagon, the same orientation the canvas draws, so a swatch is a shrunken
 * address rather than a different shape. The box is cut to the hexagon — 2r by r√3 —
 * because at 16px a hexagon with any padding around it just reads as a dot.
 */
const HEX_POINTS = Array.from({ length: 6 }, (_, i) => {
  const angle = (Math.PI / 3) * i
  return `${(10 + 9 * Math.cos(angle)).toFixed(2)},${(8.66 + 9 * Math.sin(angle)).toFixed(2)}`
}).join(" ")

function HexSwatch({ fill, outline }: { fill?: string; outline?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 17.32" className="h-3.5 w-4 shrink-0">
      <polygon
        points={HEX_POINTS}
        fill={fill ?? "none"}
        stroke={outline ?? "none"}
        strokeWidth={outline ? 2 : 0}
        // One period per side (the sides are 9 units long), so every corner keeps an
        // arm and the outline still reads as a hexagon rather than a dotted circle.
        strokeDasharray={outline ? "6 3" : undefined}
      />
    </svg>
  )
}

/** One family's stroke, drawn the way the canvas draws it — dashed included. */
function LineSwatch({ kind }: { kind: EdgeKind }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 18 4"
      data-nimmap-legend-edge={kind}
      className="h-1 w-[18px] shrink-0 overflow-visible"
    >
      <line
        x1="0"
        y1="2"
        x2="18"
        y2="2"
        stroke={EDGE_COLORS[kind]}
        strokeWidth="2"
        strokeDasharray={kind === DASHED_KIND ? "4 2.5" : undefined}
      />
    </svg>
  )
}

function LegendRow({ swatch, label }: { swatch: ReactNode; label: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  )
}

/**
 * What the colours mean — and, since the reader can change what they mean, the control
 * that changes them.
 *
 * The panel takes pointer events; the space around it does not, so the canvas underneath
 * stays draggable right up to its edge. It opens expanded on a desktop and collapsed to
 * a pill on a phone, where a 390px viewport has no room to spend on a key nobody asked
 * for yet.
 */
function Legend({
  mode,
  onMode,
  yielding,
}: {
  mode: ColorMode
  onMode: (mode: ColorMode) => void
  /**
   * A detail panel is open. On a phone it is as wide as the canvas, so there the
   * legend gets out of its way rather than sitting on top of the thing the reader
   * just asked to see; a desktop has room for both.
   */
  yielding: boolean
}) {
  // Only ever mounted client-side — the island renders no map until a scan returns — so
  // the media query can decide the first paint instead of flashing open then shut.
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || window.matchMedia("(min-width: 640px)").matches,
  )
  const place = cn(yielding && "hidden sm:block")

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-nimmap-legend-toggle=""
        aria-expanded={false}
        className={cn(
          place,
          "cursor-pointer rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:text-foreground",
        )}
      >
        Legend
      </button>
    )
  }

  return (
    <div
      data-nimmap-legend=""
      className={cn(
        place,
        "max-w-[calc(100vw-8rem)] rounded-lg bg-background/85 px-3 py-2 backdrop-blur sm:max-w-xs",
      )}
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>Colour by</span>
        <div className="flex items-center overflow-hidden rounded-md border border-border">
          {(["type", "age"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onMode(value)}
              aria-pressed={mode === value}
              data-nimmap-colorby={value}
              className={cn(
                "cursor-pointer px-1.5 py-0.5 text-[10px] capitalize transition-colors",
                mode === value
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "hover:bg-muted hover:text-foreground",
              )}
            >
              {value}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          data-nimmap-legend-toggle=""
          aria-expanded
          aria-label="Hide the legend"
          className="ml-auto cursor-pointer px-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          ⌄
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {/* The same three constants the canvas paints nodes with, so the key cannot
            drift away from the map it is explaining. */}
        <LegendRow swatch={<HexSwatch fill={SEED_COLOR} />} label="seed" />
        <LegendRow swatch={<HexSwatch fill={NODE_COLOR} />} label="address" />
        <LegendRow swatch={<HexSwatch fill={CONTRACT_COLOR} />} label="contract" />
        <LegendRow swatch={<HexSwatch outline={NODE_COLOR} />} label="edge of scan" />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground">
        {mode === "type" ? (
          EDGE_KIND_LABELS.map(({ kind, label }) => (
            <LegendRow
              key={kind}
              swatch={<LineSwatch kind={kind} />}
              label={
                <>
                  {label}
                  {/* The one family the canvas dashes, said on the row that owns it. */}
                  {kind === DASHED_KIND && <span className="ml-1 opacity-70">dashed</span>}
                </>
              }
            />
          ))
        ) : (
          <LegendRow
            swatch={
              <span
                data-nimmap-legend-edge="age"
                className="h-0.5 w-12 shrink-0"
                style={{ backgroundImage: "linear-gradient(to right, #52525b, #07c1ff)" }}
              />
            }
            label="old → recent"
          />
        )}
        <span className="basis-full">arrow = direction · width = amount</span>
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
          <Button variant="outline" size="sm" onClick={onExportPng} data-nimmap-export-png="">
            <DownloadIcon /> PNG
            {!exportsAllowed && <span className="ml-1 opacity-60">Pass</span>}
          </Button>
          <Button variant="outline" size="sm" onClick={onExportCsv} data-nimmap-export-csv="">
            <DownloadIcon /> CSV
            {!exportsAllowed && <span className="ml-1 opacity-60">Pass</span>}
          </Button>
        </div>
      </div>

      {bounded && (
        <div
          data-nimmap-limit={hitCap ? "cap" : "depth"}
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
              <Button size="xs" onClick={onUnlock} data-nimmap-unlock="">
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

export default NimMap
