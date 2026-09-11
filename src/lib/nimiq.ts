/**
 * Nimiq address and amount formatting.
 *
 * Every balance that reaches the browser is in luna, the chain's base unit
 * (1 NIM = 100,000 luna), so conversion happens here and nowhere else.
 */

export const LUNA_PER_NIM = 1e5

export function toNim(luna: number): number {
  return luna / LUNA_PER_NIM
}

/** Strip spacing and case so two spellings of one address compare equal. */
export function compactAddress(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase()
}

/**
 * NQ + 2 check digits + 32 base32 characters. Nimiq's alphabet drops I, O, W and
 * Z, the four that read as 1, 0, VV and 2.
 */
const ADDRESS_SHAPE = /^NQ[0-9]{2}[0-9A-HJ-NP-VXY]{32}$/

/**
 * True only for an address that is also self-consistent — the IBAN mod-97 check
 * the two digits after NQ carry. A single mistyped character fails it, which is
 * why the NimMap input can refuse to start a scan before spending a request.
 */
export function isValidAddress(raw: string): boolean {
  const clean = compactAddress(raw)
  if (!ADDRESS_SHAPE.test(clean)) return false
  // IBAN check: move the country prefix to the back, read letters as 10..35,
  // and take the whole thing mod 97 — a valid address leaves 1.
  const rearranged = `${clean.slice(4)}${clean.slice(0, 4)}`
  let remainder = 0
  for (const char of rearranged) {
    const value = char >= "0" && char <= "9" ? char.charCodeAt(0) - 48 : char.charCodeAt(0) - 55
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97
  }
  return remainder === 1
}

/** Canonical Nimiq spelling: NQ08 ACT8 T0FE ... in four-character blocks. */
export function formatAddress(raw: string): string {
  const clean = compactAddress(raw)
  if (!clean.startsWith("NQ")) return raw
  return (clean.match(/.{1,4}/g) ?? []).join(" ")
}

/** NQ08 ACT8…NVXY — recognisable, but short enough for a canvas label. */
export function shortAddress(raw: string, tail = 4): string {
  const clean = compactAddress(raw)
  if (clean.length <= 12) return formatAddress(raw)
  return `${clean.slice(0, 4)} ${clean.slice(4, 8)}…${clean.slice(-tail)}`
}

/** 1.23M NIM — compact enough for tooltips and canvas labels. */
export function formatNim(luna: number): string {
  const nim = toNim(luna)
  if (nim >= 1e9) return `${(nim / 1e9).toFixed(2)}B NIM`
  if (nim >= 1e6) return `${(nim / 1e6).toFixed(2)}M NIM`
  if (nim >= 1e3) return `${(nim / 1e3).toFixed(1)}K NIM`
  return `${nim.toFixed(nim >= 1 || nim === 0 ? 0 : 2)} NIM`
}

/** Exact and grouped: "351,219,403 NIM". */
export function formatNimFull(luna: number): string {
  return `${toNim(luna).toLocaleString("en-US", { maximumFractionDigits: 0 })} NIM`
}

/** Percent with enough precision that a tiny share never reads as 0.00%. */
export function formatShare(share: number): string {
  const pct = share * 100
  if (pct === 0) return "0%"
  if (pct < 0.01) return "<0.01%"
  if (pct < 1) return `${pct.toFixed(2)}%`
  return `${pct.toFixed(1)}%`
}

export function explorerUrl(raw: string): string {
  return `https://nimiq.watch/#${compactAddress(raw)}`
}
