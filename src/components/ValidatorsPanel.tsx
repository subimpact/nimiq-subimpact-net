/**
 * The validators page in two readings: the table, and the delegation map that
 * used to live at /graph/ before ChainMap took that page.
 *
 * The map is `lazy()`d rather than rendered hidden, so the many readers who only
 * want the table never download the force simulation or the 2,900-node payload
 * behind it. It is also unmounted when the table comes back: the canvas measures
 * its container on mount, and a `display:none` container measures zero.
 */

import { Suspense, lazy, useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ValidatorTable, type Validator } from "@/components/ValidatorTable"

const DelegationGraph = lazy(() =>
  import("@/components/DelegationGraph").then((module) => ({ default: module.DelegationGraph })),
)

type View = "table" | "map"

export function ValidatorsPanel({ initial }: { initial: Validator[] }) {
  const [view, setView] = useState<View>("table")

  // Read the deep link after mount: the page is static, so the first render has
  // to match the pre-rendered HTML before the query string can change it.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view")
    if (requested === "map") setView("map")
  }, [])

  const pick = useCallback((next: View) => {
    setView(next)
    // Keep the map linkable without a navigation — /validators/?view=map.
    const url = new URL(window.location.href)
    if (next === "map") url.searchParams.set("view", "map")
    else url.searchParams.delete("view")
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [])

  return (
    <div className="space-y-6">
      <div
        role="group"
        aria-label="How to read the validators"
        className="flex w-fit items-center overflow-hidden rounded-lg border border-border"
      >
        {(["table", "map"] as const).map((option) => (
          <Button
            key={option}
            variant={view === option ? "default" : "ghost"}
            size="sm"
            aria-pressed={view === option}
            data-validators-view={option}
            onClick={() => pick(option)}
            className="rounded-none border-r border-border px-4 last:border-r-0"
          >
            {option === "table" ? "Table" : "Map"}
          </Button>
        ))}
      </div>

      {view === "table" ? (
        <ValidatorTable initial={initial} />
      ) : (
        <Suspense fallback={<MapLoading />}>
          <DelegationGraph />
        </Suspense>
      )}
    </div>
  )
}

function MapLoading() {
  return (
    <div className="flex h-96 items-center justify-center rounded-xl border border-border">
      <p className="font-mono text-xs text-muted-foreground">Loading the delegation map…</p>
    </div>
  )
}
