/**
 * Mounted once per page. Listens for the `open-stake-dialog` event the "Stake
 * NIM" CTAs dispatch, and only then pulls in StakeDialog — so @nimiq/hub-api and
 * @nimiq/core stay out of every page load for the many visitors who never stake.
 *
 * The event is cancelable: this host calls preventDefault() on it, which tells
 * the dispatching CTA that the dialog took over and its href should not be
 * followed. A click that lands before hydration finds no listener, leaves the
 * event uncancelled, and falls through to the plain staking link instead.
 */

import { Suspense, lazy, useEffect, useState } from "react"

const StakeDialog = lazy(() =>
  import("./StakeDialog").then((module) => ({ default: module.StakeDialog }))
)

export function StakeDialogHost() {
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onOpenRequest(event: Event) {
      event.preventDefault()
      setLoaded(true)
      setOpen(true)
    }
    document.addEventListener("open-stake-dialog", onOpenRequest)
    return () => document.removeEventListener("open-stake-dialog", onOpenRequest)
  }, [])

  if (!loaded) return null

  return (
    <Suspense fallback={<LoadingOverlay />}>
      <StakeDialog open={open} onOpenChange={setOpen} />
    </Suspense>
  )
}

/** Stand-in for the dialog while its chunk is still downloading. */
function LoadingOverlay() {
  return (
    <div
      role="status"
      aria-label="Opening the staking dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <span className="size-6 animate-spin rounded-full border-2 border-zinc-600 border-t-primary" />
    </div>
  )
}
