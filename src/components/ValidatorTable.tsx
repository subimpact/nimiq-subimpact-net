import { useEffect, useMemo, useState } from "react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface Validator {
  id: number
  name: string
  address: string
  description?: string
  fee: number
  payoutType: string
  payoutSchedule?: string
  website?: string
  isListed?: boolean
  accentColor?: string
  score?: {
    availability: number | null
    reliability: number | null
    dominance: number | null
    total: number | null
    epochNumber?: number
  }
  dominanceRatio?: number
  balance?: number
  stakers?: number
}

type SortKey = "name" | "fee" | "payoutType" | "availability" | "reliability" | "dominance" | "stakers" | "balance"

const IMPACT_ADDR = "NQ08 ACT8 T0FE PTG8 P5RL H2S3 QGXH V15R NVXY"

function pct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "n/a"
  return (x * 100).toFixed(2) + "%"
}

function nim(luna: number | null | undefined): string {
  if (!luna) return "0"
  return (luna / 1e5).toLocaleString("en-US", { maximumFractionDigits: 0 })
}

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Validator" },
  { key: "fee", label: "Fee", numeric: true },
  { key: "payoutType", label: "Payout" },
  { key: "availability", label: "Availability", numeric: true },
  { key: "reliability", label: "Reliability", numeric: true },
  { key: "dominance", label: "Dominance", numeric: true },
  { key: "stakers", label: "Stakers", numeric: true },
  { key: "balance", label: "Self-stake", numeric: true },
]

export function ValidatorTable({ initial }: { initial: Validator[] }) {
  const [rows, setRows] = useState<Validator[]>(initial)
  const [sortKey, setSortKey] = useState<SortKey>("name")
  const [sortDir, setSortDir] = useState<1 | -1>(1)
  const [status, setStatus] = useState<"live" | "snapshot" | "error">("snapshot")
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const res = await fetch("https://validators-api-main.je-cf9.workers.dev/api/v1/validators")
        if (!res.ok) throw new Error(String(res.status))
        const data = await res.json()
        if (cancelled) return
        const list = Array.isArray(data) ? data : (data.validators || [])
        if (list.length > 0) {
          setRows(list)
          setStatus("live")
          setLastUpdated(new Date().toISOString())
        }
      } catch {
        if (!cancelled) setStatus("error")
      }
    }
    refresh()
    const t = setInterval(refresh, 5 * 60 * 1000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const sorted = useMemo(() => {
    const arr = [...rows]
    arr.sort((a, b) => {
      let av: number | string = a[sortKey] as never
      let bv: number | string = b[sortKey] as never
      if (sortKey === "name") return String(av).localeCompare(String(bv)) * sortDir
      if (sortKey === "payoutType") return String(av).localeCompare(String(bv)) * sortDir
      if (sortKey === "stakers") {
        av = av == null || (av as number) < 0 ? -1 : (av as number)
        bv = bv == null || (bv as number) < 0 ? -1 : (bv as number)
      }
      if (sortKey === "availability" || sortKey === "reliability" || sortKey === "dominance") {
        av = (a.score?.[sortKey] ?? -1) as number
        bv = (b.score?.[sortKey] ?? -1) as number
      }
      if (sortKey === "balance") {
        av = a.balance ?? 0
        bv = b.balance ?? 0
      }
      return ((av as number) - (bv as number)) * sortDir
    })
    return arr
  }, [rows, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1))
    else {
      setSortKey(key)
      setSortDir(1)
    }
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              {COLUMNS.map((col) => (
                <TableHead key={col.key} className={cn("px-4 py-3", col.numeric && "text-right")}>
                  <button
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide transition-colors hover:text-foreground",
                      sortKey === col.key ? "text-primary" : "text-muted-foreground"
                    )}
                  >
                    {col.label}
                    {sortKey === col.key ? (
                      sortDir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUpDown className="size-3 opacity-50" />
                    )}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((v) => {
              const isImpact = v.address.replace(/\s/g, "").includes("ACT8T0FE")
              const s = v.score || {}
              return (
                <TableRow
                  key={v.id}
                  className={cn(isImpact && "bg-primary/5 hover:bg-primary/10")}
                >
                  <TableCell className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: v.accentColor || "#07c1ff" }}
                      />
                      <div>
                        <p className="font-medium text-foreground">
                          {v.name}
                          {isImpact && (
                            <Badge variant="outline" className="ml-2 border-primary/40 text-primary">
                              you
                            </Badge>
                          )}
                        </p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {v.address.slice(0, 14)}...
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tabular-nums">
                    {(v.fee * 100).toFixed(0)}%
                  </TableCell>
                  <TableCell className="px-4 py-3 capitalize">{v.payoutType}</TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tabular-nums">
                    {pct(s.availability)}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tabular-nums">
                    {pct(s.reliability)}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tabular-nums">
                    {pct(s.dominance)}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tabular-nums">
                    {v.stakers != null && v.stakers >= 0 ? v.stakers.toLocaleString() : "n/a"}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tabular-nums">
                    {nim(v.balance)}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="mt-3 font-mono text-xs text-muted-foreground">
        {status === "live"
          ? `Live data from validators-api-main.je-cf9.workers.dev, updated ${lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : "just now"}.`
          : status === "error"
            ? "Live refresh unavailable. Showing snapshot from the official API."
            : "Loading live data..."}
      </p>
    </div>
  )
}

export function ValidatorTableSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-10 w-full" />
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}
