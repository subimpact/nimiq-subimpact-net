/**
 * Fiat display for the site: the currencies offered, the NIM rate behind them,
 * and the formatting both use. Ported from NimBooks, whose picker mirrors the
 * Nimiq Wallet's currency list (the four currencies CoinGecko does not publish
 * are absent, so no rate ever reads 0).
 *
 * Rates come from CoinGecko directly in the browser — one consolidated request
 * for every currency, cached for five minutes. Everything degrades: with no
 * rate the callers simply show NIM alone.
 *
 * No React context: the islands on a page are separate roots, so the chosen
 * currency travels as a window event (and in localStorage across visits).
 */

import { useEffect, useState } from "react"

export type CurrencyCode =
  | "aed" | "ars" | "aud" | "brl" | "cad" | "chf" | "clp" | "cny"
  | "czk" | "dkk" | "eur" | "gbp" | "hkd" | "huf" | "idr" | "ils"
  | "inr" | "jpy" | "krw" | "mxn" | "myr" | "ngn" | "nok" | "nzd"
  | "php" | "pkr" | "pln" | "rub" | "sek" | "sgd" | "thb" | "try"
  | "twd" | "uah" | "usd" | "vnd" | "zar"

export interface CurrencyInfo {
  code: CurrencyCode
  label: string
  symbol: string
  flag: string
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: "aed", label: "AED", symbol: "AED ", flag: "AE" },
  { code: "ars", label: "ARS", symbol: "ARS ", flag: "AR" },
  { code: "aud", label: "AUD", symbol: "A$", flag: "AU" },
  { code: "brl", label: "BRL", symbol: "R$", flag: "BR" },
  { code: "cad", label: "CAD", symbol: "C$", flag: "CA" },
  { code: "chf", label: "CHF", symbol: "Fr ", flag: "CH" },
  { code: "clp", label: "CLP", symbol: "CLP ", flag: "CL" },
  { code: "cny", label: "CNY", symbol: "¥", flag: "CN" },
  { code: "czk", label: "CZK", symbol: "Kč ", flag: "CZ" },
  { code: "dkk", label: "DKK", symbol: "kr ", flag: "DK" },
  { code: "eur", label: "EUR", symbol: "€", flag: "EU" },
  { code: "gbp", label: "GBP", symbol: "£", flag: "GB" },
  { code: "hkd", label: "HKD", symbol: "HK$", flag: "HK" },
  { code: "huf", label: "HUF", symbol: "Ft ", flag: "HU" },
  { code: "idr", label: "IDR", symbol: "Rp ", flag: "ID" },
  { code: "ils", label: "ILS", symbol: "₪", flag: "IL" },
  { code: "inr", label: "INR", symbol: "₹", flag: "IN" },
  { code: "jpy", label: "JPY", symbol: "¥", flag: "JP" },
  { code: "krw", label: "KRW", symbol: "₩", flag: "KR" },
  { code: "mxn", label: "MXN", symbol: "MX$", flag: "MX" },
  { code: "myr", label: "MYR", symbol: "RM", flag: "MY" },
  { code: "ngn", label: "NGN", symbol: "₦", flag: "NG" },
  { code: "nok", label: "NOK", symbol: "kr ", flag: "NO" },
  { code: "nzd", label: "NZD", symbol: "NZ$", flag: "NZ" },
  { code: "php", label: "PHP", symbol: "₱", flag: "PH" },
  { code: "pkr", label: "PKR", symbol: "₨ ", flag: "PK" },
  { code: "pln", label: "PLN", symbol: "zł ", flag: "PL" },
  { code: "rub", label: "RUB", symbol: "₽", flag: "RU" },
  { code: "sek", label: "SEK", symbol: "kr ", flag: "SE" },
  { code: "sgd", label: "SGD", symbol: "S$", flag: "SG" },
  { code: "thb", label: "THB", symbol: "฿", flag: "TH" },
  { code: "try", label: "TRY", symbol: "₺", flag: "TR" },
  { code: "twd", label: "TWD", symbol: "NT$", flag: "TW" },
  { code: "uah", label: "UAH", symbol: "₴", flag: "UA" },
  { code: "usd", label: "USD", symbol: "$", flag: "US" },
  { code: "vnd", label: "VND", symbol: "₫", flag: "VN" },
  { code: "zar", label: "ZAR", symbol: "R ", flag: "ZA" },
]

export type FiatRates = Partial<Record<CurrencyCode, number>>

const CURRENCY_KEY = "nimiq:currency"
const RATE_CACHE_KEY = "nimiq:rates"
const RATE_TTL_MS = 5 * 60 * 1000
const RATE_EVENT = "nimiq:currency-changed"

export function loadCurrency(): CurrencyCode {
  try {
    const saved = window.localStorage.getItem(CURRENCY_KEY)
    if (CURRENCIES.some((c) => c.code === saved)) return saved as CurrencyCode
  } catch {
    /* storage unavailable */
  }
  return "usd"
}

export function saveCurrency(code: CurrencyCode): void {
  try {
    window.localStorage.setItem(CURRENCY_KEY, code)
  } catch {
    /* storage unavailable */
  }
}

/** Set, persist, and tell every island on the page (they are separate React roots). */
export function setCurrency(code: CurrencyCode): void {
  saveCurrency(code)
  try {
    window.dispatchEvent(new CustomEvent(RATE_EVENT, { detail: code }))
  } catch {
    /* no window to talk to */
  }
}

export function currencySymbol(code: CurrencyCode): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? "$"
}

// Currencies quoted without minor units — there is no such thing as 0.56 yen.
const ZERO_DECIMAL = new Set<CurrencyCode>(["clp", "idr", "jpy", "krw", "vnd"])

/**
 * Money for display. Sub-cent amounts get 4 decimals so a small value never
 * reads as "0.00"; pass `decimals` to pin the precision instead (the rate line
 * asks for 6 — a NIM price rounds away at fewer).
 */
export function formatFiat(amount: number, code: CurrencyCode, decimals?: number): string {
  const n = Number.isFinite(amount) ? amount : 0
  const dp = ZERO_DECIMAL.has(code)
    ? n > 0 && n < 1
      ? 2
      : 0
    : decimals ?? (n > 0 && n < 0.01 ? 4 : 2)
  return `${currencySymbol(code)}${n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`
}

// --- rates ------------------------------------------------------------------

// A live NIM price at or above this is a wrong-id response, not a rally: NIM
// has never traded near a cent. Zero it rather than put it in front of readers.
const NIM_MAX_PLAUSIBLE_USD = 0.01

function usable(rates: FiatRates): boolean {
  return CURRENCIES.every((c) => {
    const v = rates[c.code]
    return typeof v === "number" && Number.isFinite(v) && v > 0
  })
}

function pickRates(entry: unknown): FiatRates {
  const rates: FiatRates = {}
  for (const c of CURRENCIES) {
    const v = (entry as Record<string, unknown> | null)?.[c.code]
    rates[c.code] = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
  }
  return rates
}

function readCache(): { rates: FiatRates; at: number } | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RATE_CACHE_KEY) ?? "null")
    if (parsed && typeof parsed.at === "number" && typeof parsed.rates === "object") {
      return parsed as { rates: FiatRates; at: number }
    }
  } catch {
    /* storage unavailable */
  }
  return null
}

function writeCache(rates: FiatRates, at: number): void {
  try {
    window.localStorage.setItem(RATE_CACHE_KEY, JSON.stringify({ rates, at }))
  } catch {
    /* storage unavailable */
  }
}

let inFlight: Promise<FiatRates | null> | null = null

/** NIM rates for every offered currency, or null when they cannot be had. */
export function fetchNimRates(): Promise<FiatRates | null> {
  const cached = readCache()
  if (cached && Date.now() - cached.at < RATE_TTL_MS && usable(cached.rates)) {
    return Promise.resolve(cached.rates)
  }
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const query = CURRENCIES.map((c) => c.code).join(",")
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=nimiq-2&vs_currencies=${query}`,
        { signal: AbortSignal.timeout(8000) },
      )
      if (!res.ok) throw new Error(String(res.status))
      const json = await res.json()
      const rates = pickRates(json["nimiq-2"])
      if (!(typeof rates.usd === "number" && rates.usd > 0 && rates.usd < NIM_MAX_PLAUSIBLE_USD)) return null
      if (!usable(rates)) return null
      writeCache(rates, Date.now())
      return rates
    } catch {
      return null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// --- hooks ------------------------------------------------------------------

/** The selected currency as React state, synced across islands via the window event. */
export function useCurrency(): [CurrencyCode, (next: CurrencyCode) => void] {
  // Start at the server-rendered default and read storage after mount: the page
  // is static, so the first client render has to match the pre-rendered HTML.
  const [currency, setState] = useState<CurrencyCode>("usd")

  useEffect(() => {
    setState(loadCurrency())
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<CurrencyCode>).detail
      if (detail) setState(detail)
    }
    window.addEventListener(RATE_EVENT, onChange)
    return () => window.removeEventListener(RATE_EVENT, onChange)
  }, [])

  return [currency, setCurrency]
}

/** The NIM rate for `currency`, fetched once per page and shared by every caller. */
export function useNimRate(currency: CurrencyCode): { rate: number | null; loading: boolean } {
  const [rates, setRates] = useState<FiatRates | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetchNimRates().then((result) => {
      if (cancelled) return
      setRates(result)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const rate = rates?.[currency]
  return { rate: typeof rate === "number" && rate > 0 ? rate : null, loading }
}
