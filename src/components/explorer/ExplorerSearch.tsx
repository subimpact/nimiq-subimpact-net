import { useState } from "react"
import { Search as SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { compactAddress } from "@/lib/nimiq"
import { API_BASE } from "./format"

type State = "idle" | "busy" | "none" | "error"

/**
 * The one box: height, block hash, transaction hash or address. The worker's /api/search
 * says what the text is; this decides where the reader lands. An address has no page of
 * its own here — the money view is NimMap, so it opens there with the address as the seed.
 */
export function ExplorerSearch() {
  const [q, setQ] = useState("")
  const [state, setState] = useState<State>("idle")

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const query = q.trim()
    if (!query || state === "busy") return
    setState("busy")
    try {
      const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      })
      if (res.status === 404) {
        setState("none")
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      const found = (await res.json()) as
        | { type: "block"; number?: number; hash?: string }
        | { type: "tx"; hash: string }
        | { type: "address"; address: string }
      if (found.type === "block") {
        window.location.href = `/explorer/block/${found.number ?? found.hash}`
      } else if (found.type === "tx") {
        window.location.href = `/explorer/tx/${found.hash}`
      } else {
        window.location.href = `/graph/?seed=${compactAddress(found.address)}`
      }
    } catch {
      setState("error")
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="flex w-full items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(event) => {
              setQ(event.target.value)
              if (state === "none" || state === "error") setState("idle")
            }}
            placeholder="Block height, block hash, transaction hash, or NQ address…"
            aria-label="Search the chain"
            data-explorer-search=""
            className="h-11 w-full rounded-lg border border-border bg-background pr-3 pl-10 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
        </div>
        <Button type="submit" disabled={!q.trim() || state === "busy"} data-explorer-search-submit="">
          {state === "busy" ? "Searching…" : "Search"}
        </Button>
      </form>
      <p className="mt-2 min-h-5 font-mono text-xs text-muted-foreground" data-explorer-search-note="">
        {state === "none" && "Nothing on chain matches that — check the height or hash."}
        {state === "error" && "The search service did not answer. Try again in a moment."}
        {state === "idle" && "Addresses open in NimMap, seeded on the address."}
      </p>
    </div>
  )
}
