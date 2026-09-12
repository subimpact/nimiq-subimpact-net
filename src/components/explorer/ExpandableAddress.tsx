import { useState } from "react"
import { shortAddress } from "./format"

/**
 * An address that reads compact until asked for more: click toggles between the
 * abbreviated `NQ08 ACT8 … NVXY` form and the exact bech32 string (hover shows it too).
 * Used wherever a row is too tight to show 44 characters at rest.
 */
export function ExpandableAddress({
  address,
  className,
}: {
  address: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      title={open ? undefined : address}
      aria-expanded={open}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setOpen((value) => !value)
      }}
      data-explorer-address={open ? "full" : "short"}
      className={`cursor-pointer text-left hover:underline hover:underline-offset-2 ${className ?? ""}`}
    >
      {open ? address : shortAddress(address)}
    </button>
  )
}

/** The two ends of a transaction as one unit — they reveal together. */
export function ExpandableAddressPair({
  from,
  to,
  className,
}: {
  from: string
  to: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      title={open ? undefined : `${from} → ${to}`}
      aria-expanded={open}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setOpen((value) => !value)
      }}
      data-explorer-address-pair={open ? "full" : "short"}
      className={`cursor-pointer text-left hover:underline hover:underline-offset-2 ${className ?? ""}`}
    >
      {open ? `${from} → ${to}` : `${shortAddress(from)} → ${shortAddress(to)}`}
    </button>
  )
}
