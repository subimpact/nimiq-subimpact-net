/**
 * On-site staking: pick an account, choose an amount, sign in the Nimiq Hub,
 * broadcast through our worker.
 *
 * The keys never touch this page. Transactions are built here from public data
 * (sender, validator, amount, current block height), handed to the Hub popup as
 * raw bytes for the user to inspect and sign, and the signed bytes go back out
 * through the worker's /api/broadcast relay.
 *
 * Two ordering rules shape the code below, both about browser popup blockers:
 * `chooseAddress` and `signStaking` must be reached from inside the click
 * handler with no `await` in front of them. So @nimiq/core and the block height
 * are loaded while the user is still typing an amount (see the prepare effect),
 * and the submit button stays disabled until both are in hand.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import HubApi from "@nimiq/hub-api"
import type { SignStakingRequest, SignedTransaction } from "@nimiq/hub-api"
import { CheckIcon, ExternalLinkIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CopyAddress } from "@/components/CopyAddress"
import { VALIDATOR_ADDRESS } from "@/config"
import { LUNA_PER_NIM, compactAddress, formatNimFull, shortAddress } from "@/lib/nimiq"

const API_BASE = "https://nimiq-api.subimpact.net"
const HUB_URL = "https://hub.nimiq.com"
const APP_NAME = "ImpactZero stake"
const VALIDATOR_IMAGE_URL = "https://nimiq.subimpact.net/logo.svg"
const WALLET_URL = "https://wallet.nimiq.com"

// Mainnet. Staking transactions carry no fee on Nimiq PoS.
const NETWORK_ID = 24
const FEE = 0n

// Consensus minimum for a brand-new staker; adding to an existing stake has none.
const MIN_CREATE_NIM = 100
const MIN_ADD_NIM = 1
const PRESETS_NIM = [100, 1000, 10000]

const REQUEST_TIMEOUT_MS = 12000
// The height only feeds validityStartHeight, so a value a few seconds old is
// fine — this refresh exists so the value is never minutes stale.
const HEIGHT_REFRESH_MS = 30000

type NimiqCore = typeof import("@nimiq/core")

interface StakerData {
  address?: string
  balance?: number
  delegation?: string | null
  inactiveBalance?: number
  retiredBalance?: number
}

/** `{data: null}` is the worker's normalized "this address is not a staker". */
interface StakerPayload {
  data?: StakerData | null
}

interface AccountPayload {
  data?: { balance?: number } | null
}

interface NetworkPayload {
  blockNumber?: number
}

interface BroadcastPayload {
  result?: string
  error?: string
}

interface ChosenAccount {
  address: string
  label?: string
}

/** Which staking transaction the account's current state calls for. */
type Mode = "create" | "add" | "switch"

type Stage = "connect" | "amount" | "working" | "done" | "error"

type Progress = "signing" | "broadcasting"

export interface StakeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

let hub: HubApi | null = null

/** One HubApi per page — it owns a popup handle and an RPC client. */
function getHub(): HubApi {
  if (!hub) hub = new HubApi(HUB_URL)
  return hub
}

async function getJson<T>(path: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal, cache: "no-store" })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** Relay one signed transaction; resolves to its hash or throws the node's reason. */
async function broadcast(hex: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  let payload: BroadcastPayload | null = null
  let status = 0
  try {
    const res = await fetch(`${API_BASE}/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx: hex }),
      signal: ctrl.signal,
    })
    status = res.status
    payload = (await res.json().catch(() => null)) as BroadcastPayload | null
  } finally {
    clearTimeout(timer)
  }
  if (payload?.result) return payload.result
  throw new Error(payload?.error || `The network rejected the transaction (${status}).`)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return ""
}

/** The Hub reports a closed or dismissed popup as an ordinary rejection. */
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

/** "1234.5" NIM -> luna, rounded to the integer base unit. */
function toLuna(nim: string): number {
  const value = Number(nim)
  if (!Number.isFinite(value)) return NaN
  return Math.round(value * LUNA_PER_NIM)
}

/** Luna as an editable NIM string — no grouping, no trailing zeros. */
function lunaToInput(luna: number): string {
  return String(Number((luna / LUNA_PER_NIM).toFixed(5)))
}

const IMPACT_ZERO = compactAddress(VALIDATOR_ADDRESS)

function modeFor(staker: StakerData | null): Mode {
  if (!staker) return "create"
  const delegation = staker.delegation ? compactAddress(staker.delegation) : ""
  return delegation === IMPACT_ZERO ? "add" : "switch"
}

export function StakeDialog({ open, onOpenChange }: StakeDialogProps) {
  const [stage, setStage] = useState<Stage>("connect")
  const [account, setAccount] = useState<ChosenAccount | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [readingState, setReadingState] = useState(false)
  const [stateError, setStateError] = useState<string | null>(null)
  const [balanceLuna, setBalanceLuna] = useState<number | null>(null)
  const [staker, setStaker] = useState<StakerData | null>(null)
  const [amount, setAmount] = useState("")
  const [progress, setProgress] = useState<Progress>("signing")
  const [sentCount, setSentCount] = useState(0)
  const [txCount, setTxCount] = useState(0)
  const [hashes, setHashes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // Loaded ahead of the submit click so signStaking() can run inside the gesture.
  const coreRef = useRef<NimiqCore | null>(null)
  const [coreReady, setCoreReady] = useState(false)
  const heightRef = useRef<number | null>(null)
  const [heightReady, setHeightReady] = useState(false)

  const mode = modeFor(staker)
  const minNim = mode === "create" ? MIN_CREATE_NIM : MIN_ADD_NIM
  // A delegation switch carries no value of its own: the existing stake moves
  // with it, so an extra deposit is optional there and required everywhere else.
  const amountOptional = mode === "switch"
  const amountLuna = amount.trim() === "" ? 0 : toLuna(amount)
  const maxLuna = balanceLuna ?? 0

  const amountProblem = useMemo(() => {
    if (amount.trim() === "") return amountOptional ? null : "Enter an amount."
    if (!Number.isFinite(amountLuna) || amountLuna <= 0) return "Enter a valid amount."
    if (amountLuna < minNim * LUNA_PER_NIM) {
      return mode === "create"
        ? `A first stake must be at least ${MIN_CREATE_NIM} NIM.`
        : `Add at least ${MIN_ADD_NIM} NIM.`
    }
    if (amountLuna > maxLuna) {
      return `That is more than your available ${formatNimFull(maxLuna)}.`
    }
    return null
  }, [amount, amountLuna, amountOptional, maxLuna, minNim, mode])

  const canSubmit =
    stage === "amount" && !!account && amountProblem === null && coreReady && heightReady

  /** Balance and staker state together — both decide what we build and offer. */
  const readAccountState = useCallback(async (address: string) => {
    const encoded = encodeURIComponent(address)
    setReadingState(true)
    setStateError(null)
    try {
      const [accountPayload, stakerPayload] = await Promise.all([
        getJson<AccountPayload>(`/api/account/${encoded}`),
        getJson<StakerPayload>(`/api/staker/${encoded}`),
      ])
      setBalanceLuna(
        typeof accountPayload?.data?.balance === "number" ? accountPayload.data.balance : 0
      )
      setStaker(stakerPayload?.data ?? null)
      setStage("amount")
    } catch (cause) {
      console.debug("account state lookup failed", cause)
      // Guessing here would mean building the wrong staking transaction, so the
      // flow drops back to step 1 rather than assuming "not a staker yet".
      setStateError(
        "We could not read your account from the network. Check your connection and try again."
      )
      setStage("connect")
    } finally {
      setReadingState(false)
    }
  }, [])

  const connect = useCallback(() => {
    setError(null)
    setNotice(null)
    setConnecting(true)
    // No await before chooseAddress: the popup needs this click.
    getHub()
      .chooseAddress({ appName: APP_NAME })
      .then((result) => {
        if (!result || !result.address) throw new Error("No account was selected.")
        setAccount({ address: result.address, label: result.label })
        return readAccountState(result.address)
      })
      .catch((cause) => {
        if (isCancellation(cause)) setNotice("No account selected.")
        else setError(hubErrorMessage(cause))
      })
      .finally(() => setConnecting(false))
  }, [readAccountState])

  // Everything signStaking() needs, fetched while the user picks an amount.
  useEffect(() => {
    if (stage !== "amount") return
    let cancelled = false

    if (!coreRef.current) {
      import("@nimiq/core")
        .then((core) => {
          if (cancelled) return
          coreRef.current = core
          setCoreReady(true)
        })
        .catch((cause) => {
          console.debug("@nimiq/core failed to load", cause)
          if (!cancelled) setError("The Nimiq library failed to load. Please reload the page.")
        })
    } else {
      setCoreReady(true)
    }

    async function readHeight() {
      try {
        const network = await getJson<NetworkPayload>("/api/network")
        if (cancelled || typeof network?.blockNumber !== "number") return
        heightRef.current = network.blockNumber
        setHeightReady(true)
      } catch (cause) {
        console.debug("block height lookup failed", cause)
      }
    }
    readHeight()
    const timer = setInterval(readHeight, HEIGHT_REFRESH_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [stage])

  /** The transaction list this account's state calls for, in broadcast order. */
  const buildTransactions = useCallback(
    (core: NimiqCore, sender: string, height: number): Uint8Array[] => {
      const { Address, TransactionBuilder } = core
      const from = Address.fromUserFriendlyAddress(sender)
      const validator = Address.fromUserFriendlyAddress(VALIDATOR_ADDRESS)

      if (mode === "create") {
        return [
          TransactionBuilder.newCreateStaker(
            from,
            validator,
            BigInt(amountLuna),
            FEE,
            height,
            NETWORK_ID
          ).serialize(),
        ]
      }

      const transactions: Uint8Array[] = []
      if (mode === "switch") {
        // Signalling transaction: moves the delegation, and reactivates the
        // whole stake so the new validator earns on all of it.
        transactions.push(
          TransactionBuilder.newUpdateStaker(
            from,
            validator,
            true,
            FEE,
            height,
            NETWORK_ID
          ).serialize()
        )
      }
      if (amountLuna > 0) {
        transactions.push(
          TransactionBuilder.newAddStake(
            from,
            from,
            BigInt(amountLuna),
            FEE,
            height,
            NETWORK_ID
          ).serialize()
        )
      }
      return transactions
    },
    [amountLuna, mode]
  )

  const submit = useCallback(() => {
    const core = coreRef.current
    const height = heightRef.current
    if (!account || !core || height === null) return

    let transactions: Uint8Array[]
    try {
      transactions = buildTransactions(core, account.address, height)
    } catch (cause) {
      console.debug("transaction build failed", cause)
      setError(messageOf(cause) || "The transaction could not be built.")
      setStage("error")
      return
    }
    if (transactions.length === 0) return

    const fromValidator = mode === "switch" && staker?.delegation ? staker.delegation : undefined
    const request: SignStakingRequest = {
      appName: APP_NAME,
      transaction: transactions.length === 1 ? transactions[0] : transactions,
      recipientLabel: APP_NAME,
      validatorAddress: VALIDATOR_ADDRESS,
      validatorImageUrl: VALIDATOR_IMAGE_URL,
      ...(amountLuna > 0 ? { amount: amountLuna } : {}),
      ...(fromValidator ? { fromValidatorAddress: fromValidator } : {}),
    }

    setError(null)
    setNotice(null)
    setHashes([])
    setSentCount(0)
    setTxCount(transactions.length)
    setProgress("signing")
    setStage("working")

    // Still inside the click: no await before signStaking opens the popup.
    getHub()
      .signStaking(request)
      .then(async (signed) => {
        const list: SignedTransaction[] = Array.isArray(signed) ? signed : [signed]
        if (list.length === 0) throw new Error("The Hub returned no signed transaction.")
        setProgress("broadcasting")
        setTxCount(list.length)
        const sent: string[] = []
        // Sequential and fail-fast: an add-stake is meaningless if the
        // delegation switch before it never landed.
        for (const transaction of list) {
          try {
            sent.push(await broadcast(transaction.serializedTx))
          } catch (cause) {
            setHashes([...sent])
            setSentCount(sent.length)
            throw cause
          }
          setHashes([...sent])
          setSentCount(sent.length)
        }
        setStage("done")
      })
      .catch((cause) => {
        if (isCancellation(cause)) {
          setNotice("Signing cancelled — nothing was sent.")
          setStage("amount")
          return
        }
        setError(hubErrorMessage(cause))
        setStage("error")
      })
  }, [account, amountLuna, buildTransactions, mode, staker])

  const retry = useCallback(() => {
    setError(null)
    setNotice(null)
    setHashes([])
    setSentCount(0)
    if (account) {
      // State may have moved — part of the batch can already be on-chain.
      setStage("amount")
      readAccountState(account.address)
    } else {
      setStage("connect")
    }
  }, [account, readAccountState])

  // A fresh open after a finished run starts over rather than showing old hashes.
  // Deliberately keyed on `open` alone: re-running on every stage change would
  // reset the flow mid-use.
  useEffect(() => {
    if (!open) return
    setError(null)
    setNotice(null)
    if (stage === "done" || stage === "error") {
      setStage(account ? "amount" : "connect")
      setHashes([])
      setSentCount(0)
      setAmount("")
      if (account) readAccountState(account.address)
    }
  }, [open])

  const busy = stage === "working"
  const stakedLuna = (staker?.balance ?? 0) + (staker?.inactiveBalance ?? 0)

  const stateLine = !staker
    ? "New staker — you'll delegate to ImpactZero."
    : mode === "add"
      ? `You already stake ${formatNimFull(stakedLuna)} with ImpactZero — this adds to it.`
      : staker.delegation
        ? `You're staking ${formatNimFull(stakedLuna)} with another validator. This switches your delegation to ImpactZero; your stake moves with it.`
        : `You have ${formatNimFull(stakedLuna)} staked without a validator. This delegates it to ImpactZero.`

  const submitLabel =
    amountLuna > 0
      ? mode === "switch"
        ? `Switch and add ${amount} NIM`
        : `Stake ${amount} NIM`
      : "Switch to ImpactZero"

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        showCloseButton={!busy}
        // While a signature or a broadcast is in flight, closing would hide a
        // transaction the user cannot see anywhere else yet.
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Stake NIM with ImpactZero</DialogTitle>
          <DialogDescription>
            0% fee, rewards restaked automatically. You sign in the Nimiq Hub — your keys stay in
            your wallet.
          </DialogDescription>
        </DialogHeader>

        <Steps stage={stage} />

        {stage === "connect" && (
          <div className="grid gap-3">
            {account ? (
              <AccountRow account={account} balanceLuna={balanceLuna} />
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Connect the Nimiq account you want to stake from. The Hub opens in a small window
                and asks you to pick one.
              </p>
            )}

            {readingState && <Hint icon="spinner">Reading your account from the network…</Hint>}
            {stateError && <ErrorBox message={stateError} />}
            {error && <ErrorBox message={error} />}
            {notice && (
              <p className="text-xs text-muted-foreground" role="status">
                {notice}
              </p>
            )}

            <Button
              size="lg"
              onClick={account && stateError ? () => readAccountState(account.address) : connect}
              disabled={connecting || readingState}
            >
              {connecting ? (
                <>
                  <Loader2Icon className="animate-spin" /> Waiting for the Hub…
                </>
              ) : account && stateError ? (
                "Try again"
              ) : account ? (
                "Choose a different account"
              ) : (
                "Connect your Nimiq account"
              )}
            </Button>
          </div>
        )}

        {stage === "amount" && account && (
          <div className="grid gap-4">
            <AccountRow account={account} balanceLuna={balanceLuna} onChange={connect} />

            <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              {stateLine}
            </p>

            <div className="grid gap-2">
              <label htmlFor="stake-amount" className="text-xs font-medium text-foreground">
                Amount to stake{amountOptional ? " (optional)" : ""}
              </label>
              <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                <input
                  id="stake-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  placeholder={amountOptional ? "0" : String(minNim)}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  aria-invalid={amountProblem !== null || undefined}
                  aria-describedby="stake-amount-help"
                  className="h-11 w-full bg-transparent font-mono text-lg tabular-nums outline-none placeholder:text-muted-foreground/60"
                />
                <span className="shrink-0 font-mono text-sm text-muted-foreground">NIM</span>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {PRESETS_NIM.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setAmount(String(preset))}
                  >
                    {preset.toLocaleString("en-US")}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={maxLuna <= 0}
                  onClick={() => setAmount(lunaToInput(maxLuna))}
                >
                  Max
                </Button>
              </div>

              <p id="stake-amount-help" className="font-mono text-xs text-muted-foreground">
                {amountProblem ? (
                  <span className="text-destructive">{amountProblem}</span>
                ) : (
                  <>Fee: 0 NIM · Min first stake: {MIN_CREATE_NIM} NIM</>
                )}
              </p>
            </div>

            {notice && (
              <p className="text-xs text-muted-foreground" role="status">
                {notice}
              </p>
            )}
            {error && <ErrorBox message={error} />}

            <Button size="lg" onClick={submit} disabled={!canSubmit}>
              {!coreReady || !heightReady ? (
                <>
                  <Loader2Icon className="animate-spin" /> Preparing…
                </>
              ) : (
                submitLabel
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {mode === "switch" && amountLuna > 0
                ? "Two transactions to sign: the delegation switch, then the added stake."
                : "You'll confirm the transaction in the Nimiq Hub."}
            </p>
          </div>
        )}

        {stage === "working" && (
          <div className="grid gap-3 py-2" role="status" aria-live="polite">
            <div className="flex items-center gap-3">
              <Loader2Icon className="size-5 animate-spin text-primary" />
              <p className="text-sm font-medium">
                {progress === "signing"
                  ? "Waiting for your signature in the Nimiq Hub…"
                  : txCount > 1
                    ? `Broadcasting ${Math.min(sentCount + 1, txCount)} of ${txCount}…`
                    : "Broadcasting to the Nimiq network…"}
              </p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {progress === "signing"
                ? "Check the Hub window — it may be behind this one. Nothing is sent until you confirm there."
                : "Keep this window open until the network confirms."}
            </p>
            {hashes.length > 0 && <HashList hashes={hashes} />}
          </div>
        )}

        {stage === "done" && (
          <div className="grid gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-primary">
                <CheckIcon className="size-4" />
              </span>
              <p className="text-sm font-semibold">
                Your stake is now delegated to ImpactZero stake.
              </p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The transaction is on its way to the network. Your delegation becomes active from the
              next election, at the start of the next epoch, and rewards are restaked from then on.
            </p>
            <HashList hashes={hashes} />
            <div className="flex flex-wrap gap-2">
              <Button asChild size="lg" variant="outline">
                <a href={WALLET_URL} target="_blank" rel="noopener">
                  View in wallet <ExternalLinkIcon />
                </a>
              </Button>
              <Button size="lg" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {stage === "error" && (
          <div className="grid gap-3">
            <ErrorBox message={error ?? "Something went wrong."} />
            {hashes.length > 0 && (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {sentCount} of {txCount} transactions reached the network before this failed:
                </p>
                <HashList hashes={hashes} />
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" onClick={retry}>
                Try again
              </Button>
              <Button size="lg" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        )}

        {(stage === "connect" || stage === "amount") && (
          <p className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            Prefer the app? Open Nimiq Pay → Staking, or Nimiq Wallet → Staking, and search for
            this address:
            <CopyAddress
              value={VALIDATOR_ADDRESS}
              label="ImpactZero validator address"
              className="mt-1.5 block text-[0.7rem] text-muted-foreground"
            />
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

const STEPS: { key: Stage; label: string }[] = [
  { key: "connect", label: "Account" },
  { key: "amount", label: "Amount" },
  { key: "working", label: "Sign" },
]

function Steps({ stage }: { stage: Stage }) {
  // done and error both belong to the last step.
  const current = stage === "connect" ? 0 : stage === "amount" ? 1 : 2
  return (
    <ol className="flex items-center gap-2 font-mono text-[0.7rem] tracking-wide text-muted-foreground uppercase">
      {STEPS.map((step, index) => (
        <li key={step.key} className="flex items-center gap-2">
          {index > 0 && <span aria-hidden className="h-px w-3 bg-border" />}
          <span
            aria-current={index === current ? "step" : undefined}
            className={index === current ? "text-primary" : index < current ? "" : "opacity-50"}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function AccountRow({
  account,
  balanceLuna,
  onChange,
}: {
  account: ChosenAccount
  balanceLuna: number | null
  onChange?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-foreground">
          {account.label || "Nimiq account"}
        </p>
        <CopyAddress
          value={account.address}
          label="your address"
          className="mt-0.5 text-xs text-muted-foreground"
        >
          {shortAddress(account.address, 4)}
        </CopyAddress>
      </div>
      <div className="text-right">
        <p className="text-[0.7rem] text-muted-foreground">Available</p>
        <p className="font-mono text-sm tabular-nums text-foreground">
          {balanceLuna === null ? "…" : formatNimFull(balanceLuna)}
        </p>
        {onChange && (
          <button
            type="button"
            onClick={onChange}
            className="mt-0.5 cursor-pointer text-[0.7rem] text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            Change account
          </button>
        )}
      </div>
    </div>
  )
}

function HashList({ hashes }: { hashes: string[] }) {
  if (hashes.length === 0) return null
  return (
    <ul className="grid gap-1.5">
      {hashes.map((hash) => (
        <li
          key={hash}
          className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2"
        >
          <CopyAddress
            value={hash}
            label="transaction hash"
            className="min-w-0 text-xs text-muted-foreground"
          >
            {`${hash.slice(0, 10)}…${hash.slice(-8)}`}
          </CopyAddress>
          <a
            href={`https://nimiq.watch/#${hash}`}
            target="_blank"
            rel="noopener"
            className="shrink-0 text-[0.7rem] text-primary underline-offset-4 hover:underline"
          >
            Explorer
          </a>
        </li>
      ))}
    </ul>
  )
}

function Hint({ icon, children }: { icon?: "spinner"; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      {icon === "spinner" && <Loader2Icon className="size-3.5 animate-spin" />}
      {children}
    </p>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2.5 rounded-lg bg-destructive/10 px-3 py-2.5 text-xs leading-relaxed text-destructive"
    >
      <TriangleAlertIcon className="mt-px size-4 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  )
}
