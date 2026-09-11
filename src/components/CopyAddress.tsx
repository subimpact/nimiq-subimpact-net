import { useCallback, useEffect, useRef, useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { cn } from "cn"
import { copyText } from "@/lib/clipboard"

const FEEDBACK_MS = 1500

export interface CopyAddressProps {
  /** The full value copied to the clipboard. */
  value: string
  /** What to show instead of `value` — defaults to `value`. */
  children?: string
  className?: string
  /** Describes what is being copied, for screen readers. */
  label?: string
}

/**
 * A value that copies itself when clicked. Looks like the mono text it replaces
 * until hovered, so it can stand in for a plain address anywhere on the site.
 */
export function CopyAddress({ value, children, className, label = "address" }: CopyAddressProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const copy = useCallback(async () => {
    const copied = await copyText(value)
    setState(copied ? "copied" : "failed")
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS)
  }, [value])

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={state === "copied" ? `Copied ${label}` : `Copy ${label}`}
      className={cn(
        "group inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md text-left font-mono transition-colors outline-none hover:text-zinc-100 focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
    >
      <span className="truncate">{children ?? value}</span>
      {state === "copied" ? (
        <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
      ) : (
        <CopyIcon
          aria-hidden
          className="size-3.5 shrink-0 opacity-50 transition-opacity group-hover:opacity-100"
        />
      )}
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
      {state !== "idle" && (
        <span aria-hidden className="shrink-0 text-xs text-primary">
          {state === "copied" ? "Copied!" : "Press ⌘C"}
        </span>
      )}
    </button>
  )
}
