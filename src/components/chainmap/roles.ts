/**
 * What an address *is*, beyond its balance: a validator, the pass address, the
 * staking contract, or an ordinary wallet.
 *
 * Both lookups are memoised for the life of the page and only run when a detail
 * panel first opens — a reader who never clicks a node never pays for them.
 */

import { useEffect, useState } from "react"
import { compactAddress } from "@/lib/nimiq"
import { API_BASE } from "@/lib/chainmapAuth"
import { STAKING_CONTRACT } from "./scan"

export type AddressRole = "validator" | "paywall" | "staking" | null

interface ValidatorRow {
  address?: string
}

let validatorsPromise: Promise<Set<string>> | null = null
let paywallPromise: Promise<string | null> | null = null

export function loadValidatorAddresses(): Promise<Set<string>> {
  validatorsPromise ??= fetch(`${API_BASE}/api/validators`)
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((payload: { data?: ValidatorRow[] }) => {
      const rows = Array.isArray(payload?.data) ? payload.data : []
      return new Set(rows.map((row) => compactAddress(row.address ?? "")).filter(Boolean))
    })
    .catch((error) => {
      console.debug("chainmap: validator list failed", error)
      // Reset so the next panel can try again rather than caching a failure.
      validatorsPromise = null
      return new Set<string>()
    })
  return validatorsPromise
}

/** The pass address, straight from the price quote — never hardcoded here. */
export function loadPaywallAddress(): Promise<string | null> {
  paywallPromise ??= fetch(`${API_BASE}/api/quote`)
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
    .then((payload: { paywallAddress?: string }) => payload?.paywallAddress ?? null)
    .catch((error) => {
      console.debug("chainmap: quote failed", error)
      paywallPromise = null
      return null
    })
  return paywallPromise
}

export interface Quote {
  requiredLuna: number
  priceUsd: number
  paywallAddress: string
}

/** The whole quote, for the checkout screen's headline amount. */
export async function loadQuote(): Promise<Quote | null> {
  try {
    const response = await fetch(`${API_BASE}/api/quote`, { cache: "no-store" })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      lunaAmount?: number
      usdTarget?: number
      paywallAddress?: string
    }
    if (typeof payload?.lunaAmount !== "number" || !payload.paywallAddress) return null
    return {
      requiredLuna: payload.lunaAmount,
      priceUsd: payload.usdTarget ?? 29.99,
      paywallAddress: payload.paywallAddress,
    }
  } catch (error) {
    console.debug("chainmap: quote failed", error)
    return null
  }
}

const STAKING_KEY = compactAddress(STAKING_CONTRACT)

export function useAddressRole(address: string | null): AddressRole {
  const [role, setRole] = useState<AddressRole>(null)

  useEffect(() => {
    if (!address) {
      setRole(null)
      return
    }
    const key = compactAddress(address)
    if (key === STAKING_KEY) {
      setRole("staking")
      return
    }

    let cancelled = false
    setRole(null)
    Promise.all([loadValidatorAddresses(), loadPaywallAddress()]).then(([validators, paywall]) => {
      if (cancelled) return
      if (validators.has(key)) setRole("validator")
      else if (paywall && compactAddress(paywall) === key) setRole("paywall")
    })

    return () => {
      cancelled = true
    }
  }, [address])

  return role
}

/** Live balance for one address, in luna. `null` means "could not be read". */
export function useBalance(address: string | null): number | null | undefined {
  const [balance, setBalance] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    if (!address) {
      setBalance(undefined)
      return
    }
    let cancelled = false
    setBalance(undefined)
    fetch(`${API_BASE}/api/account/${encodeURIComponent(compactAddress(address))}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((payload: { data?: { balance?: number } | null }) => {
        if (cancelled) return
        setBalance(typeof payload?.data?.balance === "number" ? payload.data.balance : null)
      })
      .catch((error) => {
        if (cancelled) return
        console.debug("chainmap: balance failed", error)
        setBalance(null)
      })

    return () => {
      cancelled = true
    }
  }, [address])

  return balance
}
