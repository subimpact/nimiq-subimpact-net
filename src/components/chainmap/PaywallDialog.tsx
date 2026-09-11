/**
 * The ChainMap pass: sign in with a wallet, pay on chain, come back entitled.
 *
 * Three steps, and the order is forced by browser popup blockers rather than by
 * taste — `chooseAddress` and `signMessage` each have to be reached from inside
 * a click with no `await` in front of them, so they cannot share one button.
 * The nonce is fetched *inside* the signMessage call: HubApi opens the popup
 * synchronously and awaits its request argument afterwards, so the challenge is
 * always minted fresh at the moment of signing and never cached here.
 *
 * This module is the only place @nimiq/hub-api is imported, and it is loaded
 * lazily — the free tier never downloads it.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import HubApi from "@nimiq/hub-api"
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CopyAddress } from "@/components/CopyAddress"
import { track } from "@/lib/analytics"
import { shortAddress } from "@/lib/nimiq"
import {
  ApiError,
  checkEntitlement,
  entitlementReasonMessage,
  fetchNonce,
  passExpiryLabel,
  passFrom,
  verifySignature,
  type EntitlementResponse,
  type Pass,
} from "@/lib/chainmapAuth"
import { loadQuote } from "./roles"

const HUB_URL = "https://hub.nimiq.com"
const APP_NAME = "ImpactZero ChainMap"

/** How many times "I've paid" re-asks the chain before giving up for now. */
const MAX_POLLS = 6
const POLL_DELAY_MS = 10000

let hub: HubApi | null = null

function getHub(): HubApi {
  if (!hub) hub = new HubApi(HUB_URL)
  return hub
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return ""
}

function isCancellation(error: unknown): boolean {
  return /cancel|abort|closed|denied|rejected by the user/i.test(messageOf(error))
}

function hubErrorMessage(error: unknown): string {
  const message = messageOf(error)
  if (/popup/i.test(message)) {
    return "Your browser blocked the Nimiq Hub window. Allow pop-ups for this site, then try again."
  }
  return message || "The Nimiq Hub request failed. Please try again."
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Luna → the whole NIM a payer should send, rounded up so it is never short. */
function requiredNim(luna: number): string {
  return Math.ceil(luna / 1e5).toLocaleString("en-US")
}

type Step = "connect" | "sign" | "checkout" | "done" | "manage"

export interface PaywallDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** `manage` opens straight on the status screen for an existing pass. */
  mode: "unlock" | "manage"
  pass: Pass | null
  /** A genuine token whose pass has run out — the renew case. */
  expired: boolean
  onEntitled: (pass: Pass) => void
  onSignOut: () => void
  /** Re-ask `/api/me` about the stored token. */
  onRefresh: () => void
}

export function PaywallDialog({
  open,
  onOpenChange,
  mode,
  pass,
  expired,
  onEntitled,
  onSignOut,
  onRefresh,
}: PaywallDialogProps) {
  const [step, setStep] = useState<Step>(mode === "manage" && pass ? "manage" : "connect")
  const [address, setAddress] = useState<string | null>(pass?.address ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [quote, setQuote] = useState<{ requiredLuna: number; priceUsd: number; paywallAddress: string } | null>(
    null,
  )
  const [reason, setReason] = useState<string | undefined>(undefined)
  const [polling, setPolling] = useState(false)
  const [pollCount, setPollCount] = useState(0)
  const [exhausted, setExhausted] = useState(false)

  const authToken = useRef<string | null>(null)
  const nonceUsed = useRef<string | null>(null)
  const cancelled = useRef(false)

  useEffect(() => () => {
    cancelled.current = true
  }, [])

  // The price is public, so the pass can name itself before any wallet is asked.
  useEffect(() => {
    if (!open || quote) return
    let dead = false
    loadQuote().then((result) => {
      if (!dead && result) setQuote(result)
    })
    return () => {
      dead = true
    }
  }, [open, quote])

  // Keyed on `open` alone. `pass` changes the instant a payment is found, and
  // re-running then would throw the reader back to step 1 at the moment they
  // succeeded.
  const opening = useRef({ mode, pass })
  opening.current = { mode, pass }
  useEffect(() => {
    if (!open) return
    setError(null)
    setNotice(null)
    setExhausted(false)
    const { mode: openedMode, pass: openedPass } = opening.current
    setStep(openedMode === "manage" && openedPass ? "manage" : "connect")
  }, [open])

  const applyEntitlement = useCallback(
    (payload: EntitlementResponse, fallbackAddress: string | null) => {
      if (typeof payload.authToken === "string") authToken.current = payload.authToken
      if (typeof payload.requiredLuna === "number" && typeof payload.priceUsd === "number") {
        setQuote((previous) => ({
          requiredLuna: payload.requiredLuna as number,
          priceUsd: payload.priceUsd as number,
          paywallAddress: payload.paywallAddress ?? previous?.paywallAddress ?? "",
        }))
      }

      const granted = passFrom(payload, fallbackAddress ?? undefined)
      if (granted) {
        onEntitled(granted)
        setStep("done")
        // A comped pass would otherwise report 36,500 days and skew every average.
        track("chainmap_unlock_success", granted.comp ? { comp: true } : { daysLeft: granted.daysLeft })
        return true
      }

      setReason(payload.reason)
      setStep("checkout")
      track("chainmap_checkout_viewed", {
        requiredLuna: payload.requiredLuna ?? 0,
        priceUsd: payload.priceUsd ?? 0,
      })
      return false
    },
    [onEntitled],
  )

  const connect = useCallback(() => {
    setError(null)
    setNotice(null)
    setBusy(true)
    track("chainmap_signin_started")
    // No await before chooseAddress: the popup needs this click.
    getHub()
      .chooseAddress({ appName: APP_NAME })
      .then((result) => {
        if (!result?.address) throw new Error("No account was selected.")
        setAddress(result.address)
        setStep("sign")
      })
      .catch((cause) => {
        if (isCancellation(cause)) setNotice("No account selected.")
        else setError(hubErrorMessage(cause))
      })
      .finally(() => setBusy(false))
  }, [])

  const sign = useCallback(() => {
    if (!address) return
    setError(null)
    setNotice(null)
    setBusy(true)

    // The popup opens synchronously; the nonce is fetched while it is opening,
    // so what gets signed is always a challenge minted seconds ago.
    const request = fetchNonce().then((challenge) => {
      nonceUsed.current = challenge.nonce
      return { appName: APP_NAME, signer: address, message: challenge.message }
    })

    getHub()
      .signMessage(request)
      .then((signed) => {
        const nonce = nonceUsed.current
        if (!nonce) throw new Error("The sign-in challenge was lost. Please try again.")
        return verifySignature({
          address,
          signerPublicKey: toHex(signed.signerPublicKey),
          signature: toHex(signed.signature),
          nonce,
        })
      })
      .then((payload) => {
        applyEntitlement(payload, address)
      })
      .catch((cause) => {
        if (isCancellation(cause)) {
          setNotice("Signing cancelled — nothing was sent.")
          return
        }
        setError(cause instanceof ApiError ? cause.message : hubErrorMessage(cause))
      })
      .finally(() => setBusy(false))
  }, [address, applyEntitlement])

  /** "I've paid": ask the chain, then keep asking while it confirms. */
  const checkPayment = useCallback(async () => {
    const token = authToken.current
    if (!token || polling) return
    setError(null)
    setExhausted(false)
    setPolling(true)

    for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
      setPollCount(attempt)
      let payload: EntitlementResponse
      try {
        payload = await checkEntitlement(token)
      } catch (cause) {
        if (cancelled.current) return
        setError(cause instanceof ApiError ? cause.message : "The check failed. Please try again.")
        setPolling(false)
        return
      }
      if (cancelled.current) return

      track("chainmap_payment_check", { found: Boolean(payload.entitled) })
      if (applyEntitlement(payload, address)) {
        setPolling(false)
        return
      }
      if (attempt < MAX_POLLS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS))
        if (cancelled.current) return
      }
    }

    setPolling(false)
    setExhausted(true)
  }, [address, applyEntitlement, polling])

  const priceLine = quote
    ? `${requiredNim(quote.requiredLuna)} NIM ≈ $${quote.priceUsd.toFixed(2)}`
    : "…"

  return (
    // Closing mid-poll is allowed: nothing is in flight that could be lost, the
    // payment is already on the chain, and the auth token is good for an hour.
    // Trapping someone here for a whole minute would be the worse bargain.
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-chainmap-paywall="">
        <DialogHeader>
          <DialogTitle>
            {step === "manage" ? "Your ChainMap pass" : step === "done" ? "Pass active" : "ChainMap Pass"}
          </DialogTitle>
          <DialogDescription>
            {step === "manage" || step === "done"
              ? "Depth 6, 50 transactions per address, 400 addresses, PNG and CSV export."
              : "Trace six hops instead of three, read 50 transactions per address, map up to 400 addresses, and export what you find. 30 days, paid in NIM."}
          </DialogDescription>
        </DialogHeader>

        {step !== "manage" && step !== "done" && <Steps step={step} />}

        {step === "connect" && (
          <div className="grid gap-3">
            <PriceCard priceLine={priceLine} />
            {expired && (
              <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
                Your previous pass has run out. Sign in with the same wallet to renew it.
              </p>
            )}
            <p className="text-sm leading-relaxed text-muted-foreground">
              Sign in with the wallet you will pay from. The Hub opens in a small window and asks
              you to pick an account — no keys, no email, and nothing is sent yet.
            </p>
            {error && <ErrorBox message={error} />}
            {notice && (
              <p className="text-xs text-muted-foreground" role="status">
                {notice}
              </p>
            )}
            <Button size="lg" onClick={connect} disabled={busy} data-chainmap-connect="">
              {busy ? (
                <>
                  <Loader2Icon className="animate-spin" /> Waiting for the Hub…
                </>
              ) : (
                "Connect your Nimiq wallet"
              )}
            </Button>
          </div>
        )}

        {step === "sign" && address && (
          <div className="grid gap-3">
            <AccountRow address={address} onChange={connect} />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Now prove the wallet is yours: the Hub will ask you to sign one short sentence.
              It is a signature, not a transaction — it costs nothing and moves nothing.
            </p>
            {error && <ErrorBox message={error} />}
            {notice && (
              <p className="text-xs text-muted-foreground" role="status">
                {notice}
              </p>
            )}
            <Button size="lg" onClick={sign} disabled={busy} data-chainmap-sign="">
              {busy ? (
                <>
                  <Loader2Icon className="animate-spin" /> Waiting for your signature…
                </>
              ) : (
                "Sign in with this wallet"
              )}
            </Button>
          </div>
        )}

        {step === "checkout" && (
          <div className="grid gap-3">
            {address && <AccountRow address={address} />}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {entitlementReasonMessage(reason, `${requiredNim(quote?.requiredLuna ?? 0)} NIM`)}
            </p>

            <div className="rounded-lg border border-border bg-muted/40 px-3 py-3">
              <p className="text-[0.7rem] text-muted-foreground">Send exactly</p>
              <p
                className="mt-0.5 font-mono text-2xl font-semibold tabular-nums text-foreground"
                data-chainmap-amount=""
              >
                {quote ? `${requiredNim(quote.requiredLuna)} NIM` : "…"}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                ≈ ${(quote?.priceUsd ?? 29.99).toFixed(2)} · 30 days
              </p>

              <p className="mt-3 text-[0.7rem] text-muted-foreground">To this address</p>
              {quote?.paywallAddress ? (
                <CopyAddress
                  value={quote.paywallAddress}
                  label="pass address"
                  className="mt-0.5 text-xs break-all text-foreground"
                />
              ) : (
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">…</p>
              )}
            </div>

            <ol className="grid gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <li>
                1. Send from <span className="text-foreground">the wallet you just signed with</span>{" "}
                — Nimiq Wallet, Nimiq Pay, or any wallet holding that account.
              </li>
              <li>2. Wait for the transaction to confirm — usually a few seconds.</li>
              <li>3. Come back here and press the button below.</li>
            </ol>

            {polling && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Loader2Icon className="size-3.5 animate-spin" />
                Waiting for the network to confirm… (check {pollCount} of {MAX_POLLS})
              </p>
            )}
            {exhausted && (
              <p
                className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground"
                role="status"
                data-chainmap-not-found=""
              >
                Not found yet — try again in a minute. Your sign-in stays valid for an hour, so
                you can close this and come back.
              </p>
            )}
            {error && <ErrorBox message={error} />}

            <Button size="lg" onClick={checkPayment} disabled={polling} data-chainmap-check="">
              {polling ? (
                <>
                  <Loader2Icon className="animate-spin" /> Checking the chain…
                </>
              ) : (
                "I've paid — check now"
              )}
            </Button>
          </div>
        )}

        {step === "done" && pass && (
          <div className="grid gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
                <CheckIcon className="size-4" />
              </span>
              <p className="text-sm font-semibold">
                {pass.comp ? "Your owner pass is active" : "Your pass is active"} —{" "}
                {passExpiryLabel(pass)}.
              </p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Depth is unlocked to 6 and exports are on. The pass lives in this browser; sign in
              again with the same wallet to move it to another one.
            </p>
            <Button size="lg" onClick={() => onOpenChange(false)}>
              Start mapping
            </Button>
          </div>
        )}

        {step === "manage" && pass && (
          <div className="grid gap-3">
            <div className="rounded-lg bg-muted/50 px-3 py-2.5">
              <p className="text-[0.7rem] text-muted-foreground">Signed in as</p>
              <CopyAddress
                value={pass.address}
                label="your address"
                className="mt-0.5 text-xs text-muted-foreground"
              >
                {shortAddress(pass.address, 4)}
              </CopyAddress>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">{pass.comp ? "Pass" : "Days left"}</dt>
                  <dd className="font-mono tabular-nums text-foreground" data-chainmap-days-left="">
                    {pass.comp ? "Owner" : pass.daysLeft}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd className="font-mono text-[11px] tabular-nums text-foreground">
                    {pass.comp
                      ? "Never"
                      : new Date(pass.paidUntil).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setError(null)
                  onRefresh()
                }}
                data-chainmap-refresh=""
              >
                Refresh status
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  onSignOut()
                  onOpenChange(false)
                }}
              >
                Sign out
              </Button>
              <Button className="ml-auto" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PriceCard({ priceLine }: { priceLine: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <p className="font-mono text-lg font-semibold tabular-nums text-foreground">{priceLine}</p>
      <p className="text-xs text-muted-foreground">30 days · paid on chain · no account</p>
    </div>
  )
}

const STEPS: { key: Step; label: string }[] = [
  { key: "connect", label: "Wallet" },
  { key: "sign", label: "Sign" },
  { key: "checkout", label: "Pay" },
]

function Steps({ step }: { step: Step }) {
  const current = step === "connect" ? 0 : step === "sign" ? 1 : 2
  return (
    <ol className="flex items-center gap-2 font-mono text-[0.7rem] tracking-wide text-muted-foreground uppercase">
      {STEPS.map((entry, index) => (
        <li key={entry.key} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden className="h-px w-3 bg-border" />}
          <span
            aria-current={index === current ? "step" : undefined}
            className={index === current ? "text-primary" : index < current ? "" : "opacity-50"}
          >
            {entry.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function AccountRow({ address, onChange }: { address: string; onChange?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[0.7rem] text-muted-foreground">Signing wallet</p>
        <CopyAddress
          value={address}
          label="your address"
          className="mt-0.5 text-xs text-muted-foreground"
        >
          {shortAddress(address, 4)}
        </CopyAddress>
      </div>
      {onChange && (
        <button
          type="button"
          onClick={onChange}
          className="cursor-pointer text-[0.7rem] text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          Change account
        </button>
      )}
    </div>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      data-chainmap-error=""
      className="flex gap-2.5 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive"
    >
      <TriangleAlertIcon className="mt-px size-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  )
}
