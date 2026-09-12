/**
 * NimMap pass state: the worker's auth routes, the one token in localStorage,
 * and the React hook the page reads its tier from.
 *
 * There is no account and no session. A `sub` token minted by the worker is the
 * whole of the client's state — it carries the address and the expiry inside a
 * payload the worker signed, so `/api/me` can re-check a pass without a popup,
 * a database, or a request to the chain.
 *
 * Nothing here imports @nimiq/hub-api: the wallet popup lives in PaywallDialog,
 * which is lazily loaded, so a reader who never signs in never downloads it.
 */

import { useCallback, useEffect, useState } from "react"

export const API_BASE = "https://nimiq-api.subimpact.net"
/**
 * Deliberately still the old name. The map was renamed from ChainMap to NimMap;
 * this key is the only thing standing between a paying reader and signing in
 * again, so it keeps the string their browser already has.
 */
export const TOKEN_KEY = "chainmap.token"

const REQUEST_TIMEOUT_MS = 15000

export interface Pass {
  address: string
  /** Epoch ms the pass runs out. */
  paidUntil: number
  daysLeft: number
  token: string
  /**
   * A pass the operator granted rather than one the chain was paid for. It is an
   * ordinary pass in every other respect — same token, same tier, same limits — but
   * its `paidUntil` is a century out, so it is labelled rather than counted down.
   */
  comp: boolean
}

export interface NonceResponse {
  nonce: string
  message: string
  expiresInMs: number
}

/** `/api/auth/verify` and `/api/entitlement` answer with the same vocabulary. */
export interface EntitlementResponse {
  ok?: boolean
  entitled?: boolean
  reason?: string
  address?: string
  paidUntil?: number
  daysLeft?: number
  token?: string
  authToken?: string
  /** Present, and true, only for a comped wallet; a paid pass omits it entirely. */
  comp?: boolean
  requiredLuna?: number
  priceUsd?: number
  paywallAddress?: string
  error?: string
}

export interface VerifyRequest {
  address: string
  signerPublicKey: string
  signature: string
  nonce: string
}

export class ApiError extends Error {
  readonly status: number
  readonly reason: string

  constructor(status: number, reason: string, message: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal, cache: "no-store" })
  } finally {
    clearTimeout(timer)
  }
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok) {
    const reason = payload?.error ?? String(response.status)
    throw new ApiError(response.status, reason, signInErrorMessage(response.status, reason))
  }
  if (!payload) throw new ApiError(response.status, "empty", "The server sent an empty answer.")
  return payload
}

/** Each 401 the sign-in routes can return means something different to the reader. */
export function signInErrorMessage(status: number, reason: string): string {
  if (status === 401) {
    if (reason === "invalid nonce") {
      return "That sign-in challenge expired. Please sign again — it only stays valid for ten minutes."
    }
    if (reason === "invalid signature") {
      return "The signature did not check out. Please try signing again."
    }
    if (reason === "address mismatch") {
      return "The signature came from a different account than the one you picked. Sign with the account you selected."
    }
    if (reason === "invalid token") {
      return "Your sign-in has expired. Connect your wallet again."
    }
    return "The signature could not be verified. Please try again."
  }
  if (status === 502) return "The network data source is not answering. Please try again in a moment."
  if (status === 500) return "The pass service is misconfigured. Please try again later."
  return "The request failed. Please try again."
}

/** Why the chain says there is no pass — in the reader's words. */
export function entitlementReasonMessage(reason: string | undefined, requiredNim: string): string {
  switch (reason) {
    case "amount_too_low":
      return `We found a payment from your wallet, but it was below the pass price. Send the difference — the pass costs ${requiredNim}.`
    case "expired":
      return "Your last pass has run out. Send the amount below to renew for another 30 days."
    case "no_payment":
    default:
      return "No payment from your wallet to the pass address yet."
  }
}

export function fetchNonce(): Promise<NonceResponse> {
  // no-store on both sides: a reused challenge is a replay.
  return request<NonceResponse>("/api/auth/nonce", { cache: "no-store" })
}

export function verifySignature(body: VerifyRequest): Promise<EntitlementResponse> {
  return request<EntitlementResponse>("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
}

/** Re-ask the chain about a wallet that has already signed in this hour. */
export function checkEntitlement(authToken: string): Promise<EntitlementResponse> {
  return request<EntitlementResponse>("/api/entitlement", {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    cache: "no-store",
  })
}

export function fetchMe(token: string): Promise<EntitlementResponse> {
  return request<EntitlementResponse>("/api/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  })
}

export function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    // Private mode and blocked storage both throw; the free tier still works.
    return null
  }
}

export function writeStoredToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* nothing to do — the pass just will not survive a reload */
  }
}

/** An entitled answer from any of the three routes, as the page's Pass shape. */
export function passFrom(payload: EntitlementResponse, fallbackAddress?: string): Pass | null {
  if (!payload.entitled || !payload.token || typeof payload.paidUntil !== "number") return null
  return {
    address: payload.address ?? fallbackAddress ?? "",
    paidUntil: payload.paidUntil,
    daysLeft:
      typeof payload.daysLeft === "number"
        ? payload.daysLeft
        : Math.max(0, Math.ceil((payload.paidUntil - Date.now()) / 86400000)),
    token: payload.token,
    comp: payload.comp === true,
  }
}

/**
 * What the pass has left, in words. A comped pass has a real expiry — a century out —
 * but printing "36,500 days left" would be noise, so it says what it is instead.
 */
export function passExpiryLabel(pass: Pass): string {
  if (pass.comp) return "no expiry"
  return `${pass.daysLeft} day${pass.daysLeft === 1 ? "" : "s"} left`
}

export type AuthStatus = "loading" | "anonymous" | "entitled" | "expired"

export interface NimmapAuth {
  status: AuthStatus
  pass: Pass | null
  /** What the scan engine and the export buttons gate on. */
  tier: "free" | "paid"
  adopt: (pass: Pass) => void
  signOut: () => void
  refresh: () => void
}

/**
 * The page's view of the pass: read the stored token once on mount, ask
 * `/api/me` whether it still means anything, and expose the answer as a tier.
 *
 * A 401 clears the token — it was signed with a rotated secret or edited — while
 * `{entitled: false, reason: 'expired'}` keeps it, because "expired" is the one
 * state where the right prompt is *renew* rather than *connect a wallet*.
 */
export function useNimmapAuth(): NimmapAuth {
  const [status, setStatus] = useState<AuthStatus>("loading")
  const [pass, setPass] = useState<Pass | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    const token = readStoredToken()
    if (!token) {
      setStatus("anonymous")
      return
    }

    fetchMe(token)
      .then((payload) => {
        if (cancelled) return
        if (payload.entitled && typeof payload.paidUntil === "number") {
          setPass({
            address: payload.address ?? "",
            paidUntil: payload.paidUntil,
            daysLeft: payload.daysLeft ?? 0,
            token,
            comp: payload.comp === true,
          })
          setStatus("entitled")
          return
        }
        // Genuine token, spent pass: keep it so the dialog can say "renew".
        setPass(null)
        setStatus("expired")
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          writeStoredToken(null)
          setStatus("anonymous")
          return
        }
        // A network blip must not cost a paying reader their pass: keep the
        // token, fall back to the free tier for this page view.
        console.debug("nimmap pass check failed", error)
        setStatus("anonymous")
      })

    return () => {
      cancelled = true
    }
  }, [attempt])

  const adopt = useCallback((next: Pass) => {
    writeStoredToken(next.token)
    setPass(next)
    setStatus("entitled")
  }, [])

  const signOut = useCallback(() => {
    writeStoredToken(null)
    setPass(null)
    setStatus("anonymous")
  }, [])

  const refresh = useCallback(() => setAttempt((n) => n + 1), [])

  return {
    status,
    pass,
    tier: status === "entitled" && pass ? "paid" : "free",
    adopt,
    signOut,
    refresh,
  }
}
