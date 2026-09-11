import { useEffect, useState, type ReactNode } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

const API_HOST = "nimiq-api.subimpact.net"
const API_BASE = `https://${API_HOST}`
const IMPACT_ADDR_KEY = "ACT8T0FE"
const BATCHES_PER_EPOCH = 720
const REQUEST_TIMEOUT_MS = 12000
const REFRESH_MS = 60 * 1000

interface ValidatorRow {
  address?: string
  balance?: number
  numStakers?: number
  stakers?: number
}

// NimiqHub wraps the list in `{data: [...]}`; older mirrors use a bare array or `{validators}`.
type ValidatorsPayload = ValidatorRow[] | { data?: ValidatorRow[]; validators?: ValidatorRow[] }

interface NetworkPayload {
  epochNumber?: number
  epoch?: {
    batchInEpoch?: number
    batchesRemaining?: number
    approxSecondsRemaining?: number
  }
}

export interface LiveStatsProps {
  initialStake: number
  initialStakers: number
  initialEpoch: number | null
}

function nim(luna: number): string {
  return (luna / 1e5).toLocaleString("en-US", { maximumFractionDigits: 0 })
}

// Same problem as the hero stat card: a 7-digit NIM figure needs more room than
// a tile gets on a narrow phone, or in the 4-up grid between md and lg.
function nimCompact(luna: number): string {
  const value = luna / 1e5
  if (value >= 1e9) return (luna / 1e14).toFixed(2) + "B"
  if (value >= 1e6) return (luna / 1e11).toFixed(2) + "M"
  if (value >= 1e3) return (luna / 1e8).toFixed(1) + "k"
  return nim(luna)
}

function countdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${total % 60}s`
}

async function getJson<T>(path: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function Stat({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardContent className="px-4 py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div
          className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground"
          data-stat={value}
        >
          {children}
        </div>
      </CardContent>
    </Card>
  )
}

export function LiveStats({ initialStake, initialStakers, initialEpoch }: LiveStatsProps) {
  const [stake, setStake] = useState(initialStake)
  const [stakers, setStakers] = useState(initialStakers)
  const [epochNumber, setEpochNumber] = useState<number | null>(initialEpoch)
  const [seconds, setSeconds] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const [validators, network] = await Promise.all([
          getJson<ValidatorsPayload>("/api/validators"),
          getJson<NetworkPayload>("/api/network"),
        ])
        if (cancelled) return
        const list = Array.isArray(validators)
          ? validators
          : validators?.data ?? validators?.validators ?? []
        const impact = list.find((v) =>
          String(v.address ?? "").replace(/\s+/g, "").includes(IMPACT_ADDR_KEY)
        )
        if (typeof impact?.balance === "number") setStake(impact.balance)
        const count = impact?.numStakers ?? impact?.stakers
        if (typeof count === "number" && count >= 0) setStakers(count)
        if (typeof network?.epochNumber === "number") setEpochNumber(network.epochNumber)
        if (typeof network?.epoch?.approxSecondsRemaining === "number") {
          setSeconds(network.epoch.approxSecondsRemaining)
        }
        setFailed(false)
      } catch (error) {
        if (cancelled) return
        console.debug("live stats refresh failed", error)
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

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((s) => (s === null ? null : Math.max(0, s - 1)))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  const batchesRemaining =
    seconds === null ? null : Math.min(BATCHES_PER_EPOCH, Math.ceil(seconds / 60))
  const batchInEpoch = batchesRemaining === null ? null : BATCHES_PER_EPOCH - batchesRemaining
  const progress = batchInEpoch === null ? 0 : (batchInEpoch / BATCHES_PER_EPOCH) * 100

  // No epoch data yet: a placeholder bar while the first fetch runs, "n/a" once it failed.
  const pending = (width: string) =>
    failed ? <>n/a</> : <Skeleton className={`my-0.5 h-6 ${width}`} />

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {/* Compact below sm and across md, where the grid goes 4-up and each
            tile drops to ~124px — the same two windows the hero card uses.
            At lg+ the unit drops to text-base to match the hero card, which
            already renders its "NIM" a step down from the figure. The ~288px
            cell fits the pair either way, so this is consistency, not room. */}
        <Stat label="Total stake" value="total-stake">
          <span className="sm:hidden md:inline lg:hidden">{nimCompact(stake)} NIM</span>
          <span className="hidden sm:inline md:hidden lg:inline">{nim(stake)}</span><span className="hidden sm:inline md:hidden lg:inline lg:text-base"> NIM</span>
        </Stat>
        <Stat label="Stakers">{stakers >= 0 ? stakers.toLocaleString("en-US") : "n/a"}</Stat>
        <Stat label="Next election">
          {seconds === null ? pending("w-20") : countdown(seconds)}
        </Stat>
        <Stat label="Epoch">
          {epochNumber === null ? pending("w-16") : epochNumber.toLocaleString("en-US")}
        </Stat>
      </div>
      <div className="mt-4">
        <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
          <span>Epoch progress</span>
          <span className="tabular-nums">
            {batchInEpoch === null
              ? `${BATCHES_PER_EPOCH} batches per epoch`
              : `batch ${batchInEpoch} / ${BATCHES_PER_EPOCH}`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Epoch progress"
          aria-valuemin={0}
          aria-valuemax={BATCHES_PER_EPOCH}
          aria-valuenow={batchInEpoch ?? undefined}
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <p className="mt-3 font-mono text-xs text-muted-foreground">
        {failed
          ? `Live refresh from ${API_HOST} unavailable. Showing the last known values.`
          : `Live from ${API_HOST}, refreshed every 60s.`}
      </p>
    </div>
  )
}
