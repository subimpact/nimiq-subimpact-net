import { useEffect, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"

const API_HOST = "nimiq-api.subimpact.net"
const API_BASE = `https://${API_HOST}`
const REQUEST_TIMEOUT_MS = 12000
const REFRESH_MS = 60 * 1000

// Where the numbers actually come from. The worker echoes both back in every payload;
// these are the fallback so the credit line and its link survive a failed fetch.
const SOURCE_HOST = "uptime.subimpact.net"
const SOURCE_URL = "https://uptime.subimpact.net/status/live"

// The worker sends up to 100 beats. 60 of them — an hour at Kuma's one-a-minute
// cadence — is as much as the strip can show at 3px a bar without crowding the card,
// and on a phone the oldest half is hidden rather than shrunk to a smear.
const MAX_BARS = 60
const MOBILE_BARS = 30

interface Monitor {
  id: number
  label: string
  status: number
  ping: number | null
  lastCheck: string | null
  uptime24h: number | null
  heartbeats: number[]
}

interface StatusPayload {
  fetchedAt: number
  source: string
  sourceUrl: string
  monitors: Monitor[]
}

/** Uptime Kuma's status codes, and how each one reads and looks. */
const STATES: Record<number, { label: string; dot: string; text: string; bar: string; pulse?: boolean }> = {
  0: { label: "Down", dot: "bg-destructive", text: "text-destructive", bar: "bg-destructive" },
  1: { label: "Up", dot: "bg-emerald-400", text: "text-emerald-400", bar: "bg-emerald-400", pulse: true },
  2: { label: "Pending", dot: "bg-amber-400", text: "text-amber-400", bar: "bg-amber-400" },
  3: { label: "Maintenance", dot: "bg-muted-foreground", text: "text-muted-foreground", bar: "bg-muted-foreground" },
}

const UNKNOWN = {
  label: "Unknown",
  dot: "bg-muted-foreground",
  text: "text-muted-foreground",
  bar: "bg-muted-foreground/40",
}

function stateOf(status: number) {
  return STATES[status] ?? UNKNOWN
}

/**
 * A 0–1 ratio as a percentage, truncated rather than rounded: 99.99% uptime is not
 * 100%, and a status strip that rounds a real outage away is worse than useless.
 */
function uptimePercent(ratio: number): string {
  const value = Math.floor(ratio * 1000) / 10
  return value >= 100 ? "100%" : `${value.toFixed(1)}%`
}

/** "38s", "4m", "2h", "3d". Anything at or before now reads as "just now". */
function since(fromMs: number, nowMs: number): string {
  const seconds = Math.round((nowMs - fromMs) / 1000)
  // A clock a few seconds behind the worker's would otherwise print "-2s ago".
  if (seconds <= 0) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** Kuma's beat times arrive as ISO instants from the worker; null if it could not parse one. */
function parseTime(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

async function getStatus(): Promise<StatusPayload> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}/api/status`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as StatusPayload
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The beat strip. Decorative for a screen reader — every fact in it is already in the
 * row above, in words — so it is hidden from the accessibility tree rather than read
 * out as sixty unlabelled elements.
 */
function Heartbeats({ monitor }: { monitor: Monitor }) {
  const beats = monitor.heartbeats.slice(-MAX_BARS)
  const hiddenOnMobile = Math.max(0, beats.length - MOBILE_BARS)
  const lastCheck = parseTime(monitor.lastCheck)

  return (
    <div className="flex min-w-0 items-end gap-[1px] overflow-hidden" aria-hidden="true">
      {beats.map((status, index) => {
        const state = stateOf(status)
        const back = beats.length - 1 - index
        // Only the newest beat has a time and a ping attached to it — the rest of the
        // series is statuses alone, so it is counted backwards rather than guessed at.
        const title =
          back === 0
            ? [lastCheck === null ? null : clock(lastCheck), state.label.toLowerCase(), monitor.ping === null ? null : `${monitor.ping} ms`]
                .filter(Boolean)
                .join(" · ")
            : `${state.label.toLowerCase()} · ${back} ${back === 1 ? "beat" : "beats"} back`
        return (
          <span
            key={index}
            title={title}
            className={`h-[14px] w-[3px] shrink-0 rounded-[1px] ${state.bar} ${
              index < hiddenOnMobile ? "hidden sm:block" : ""
            }`}
          />
        )
      })}
    </div>
  )
}

function MonitorRow({ monitor, now }: { monitor: Monitor; now: number }) {
  const state = stateOf(monitor.status)
  const lastCheck = parseTime(monitor.lastCheck)
  const meta = [
    state.label,
    monitor.uptime24h === null ? null : `24h ${uptimePercent(monitor.uptime24h)}`,
    monitor.ping === null ? null : `${monitor.ping} ms`,
  ].filter(Boolean)

  return (
    <div className="min-w-0" data-monitor={monitor.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`h-2 w-2 shrink-0 rounded-full ${state.dot} ${
              state.pulse ? "animate-pulse motion-reduce:animate-none" : ""
            }`}
          />
          <span className="truncate text-sm font-medium text-foreground">{monitor.label}</span>
        </span>
        {/* The state is spelled out, not left to the colour of the dot. */}
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          <span className={state.text}>{meta[0]}</span>
          {meta.length > 1 ? ` · ${meta.slice(1).join(" · ")}` : ""}
        </span>
      </div>
      {/* The beats and the time of the last one belong together, so they sit side by
          side rather than pinned to opposite edges of a 1440px card. */}
      <div className="mt-1.5 flex items-center gap-3">
        <Heartbeats monitor={monitor} />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {lastCheck === null ? "not checked yet" : `checked ${since(lastCheck, now)}`}
        </span>
      </div>
    </div>
  )
}

export function ServerStatus() {
  const [data, setData] = useState<StatusPayload | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const payload = await getStatus()
        if (cancelled) return
        // A payload with no monitors at all means Kuma answered but no longer knows
        // these ids — the last good reading is still the better thing to show.
        if (!Array.isArray(payload?.monitors)) throw new Error("shape")
        setData(payload)
        setNow(Date.now())
        setFailed(false)
      } catch (error) {
        if (cancelled) return
        console.debug("server status refresh failed", error)
        setFailed(true)
      }
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // "checked 38s ago" is only true for a second at a time.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const monitors = data?.monitors ?? []
  const sourceUrl = data?.sourceUrl ?? SOURCE_URL
  const sourceHost = data?.source ?? SOURCE_HOST
  const state = monitors.length > 0 ? "ready" : failed || data ? "unavailable" : "loading"

  return (
    <div className="mt-5 border-t border-border pt-4" data-server-status={state}>
      <div className="space-y-3">
        {state === "loading" ? (
          <>
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-[14px] w-full max-w-[244px]" />
          </>
        ) : state === "unavailable" ? (
          <p className="font-mono text-xs text-muted-foreground" data-status-fallback>
            Node status from {sourceHost} is unavailable right now.
          </p>
        ) : (
          monitors.map((monitor) => <MonitorRow key={monitor.id} monitor={monitor} now={now} />)
        )}
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
        <span>Live from {sourceHost}</span>
        <span aria-hidden="true">·</span>
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener"
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
          data-status-source
        >
          Open full status page ↗
        </a>
        {data ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{`updated ${since(data.fetchedAt, now)}`}</span>
          </>
        ) : null}
        {failed && data ? <span className="text-muted-foreground/70">(refresh failed)</span> : null}
      </p>
    </div>
  )
}
