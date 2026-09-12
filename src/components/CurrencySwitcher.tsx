/**
 * The currency bar on the validators page: pick the display currency, see the
 * NIM rate it implies, and the whole book of stake priced in it. The per-row
 * "≈" values live in the table; this is where the reader controls them.
 *
 * With no rate (request failed, CoinGecko unreachable) the bar still works and
 * the page shows NIM alone — the fiat figures simply stay hidden.
 */

import { useEffect, useRef, useState } from "react"
import { CURRENCIES, formatFiat, useCurrency, useNimRate } from "@/lib/currency"
import { cn } from "@/lib/utils"

export function CurrencySwitcher({ totalStakedLuna }: { totalStakedLuna: number }) {
  const [currency, pick] = useCurrency()
  const { rate, loading } = useNimRate(currency)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const current = CURRENCIES.find((c) => c.code === currency) ?? CURRENCIES[CURRENCIES.length - 1]

  // The popover closes on an outside press or Escape, like every other menu.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const totalNim = totalStakedLuna / 1e5

  return (
    <div
      ref={rootRef}
      data-currency-bar=""
      className="relative flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Change display currency"
        data-currency-switcher=""
        className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-foreground transition-colors hover:bg-muted"
      >
        <img src={`/flags/flag-${current.flag}.svg`} alt="" width={18} height={18} loading="lazy" />
        <span className="font-medium">{current.label}</span>
        <span aria-hidden="true" className="opacity-60">
          ▾
        </span>
      </button>

      <span data-rate-line="">
        {rate ? (
          <>
            1 NIM ≈{" "}
            <span className="font-mono text-foreground">{formatFiat(rate, currency, 6)}</span>
          </>
        ) : loading ? (
          <span className="opacity-70">fetching rate…</span>
        ) : (
          <span className="opacity-70">rate unavailable — showing NIM only</span>
        )}
      </span>

      {rate ? (
        <span data-total-fiat="">
          Total staked ≈{" "}
          <span className="font-mono text-foreground">{formatFiat(totalNim * rate, currency)}</span>
        </span>
      ) : null}

      {open && (
        <div
          data-currency-menu=""
          className="absolute top-full left-0 z-30 mt-2 w-[292px] rounded-xl border border-border bg-card p-3 shadow-lg"
        >
          <p className="mb-2 text-[11px] tracking-wide uppercase">Display currency</p>
          <div
            role="radiogroup"
            aria-label="Display currency"
            className="grid max-h-[300px] grid-cols-3 gap-1.5 overflow-y-auto pr-1"
          >
            {CURRENCIES.map((c) => (
              <button
                key={c.code}
                type="button"
                role="radio"
                aria-checked={c.code === currency}
                data-currency-tile={c.code}
                onClick={() => {
                  pick(c.code)
                  setOpen(false)
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1.5 transition-colors hover:bg-muted",
                  c.code === currency ? "border-primary/50 bg-primary/10 text-foreground" : "border-transparent",
                )}
              >
                <img src={`/flags/flag-${c.flag}.svg`} alt="" width={16} height={16} loading="lazy" />
                <span className="font-mono text-[11px]">{c.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
