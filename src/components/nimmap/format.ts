/** Time, the two ways a transaction needs to be read: how long ago, and when. */

const UNITS: [limit: number, seconds: number, name: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86400, 3600, "hour"],
  [2592000, 86400, "day"],
  [31536000, 2592000, "month"],
  [Infinity, 31536000, "year"],
]

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })

export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!timestamp) return "unknown"
  const seconds = (timestamp - now) / 1000
  const magnitude = Math.abs(seconds)
  for (const [limit, divisor, unit] of UNITS) {
    if (magnitude < limit) return relative.format(Math.round(seconds / divisor), unit)
  }
  return relative.format(Math.round(seconds / 31536000), "year")
}

export function absoluteTime(timestamp: number): string {
  if (!timestamp) return "—"
  return new Date(timestamp).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
