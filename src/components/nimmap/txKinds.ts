/**
 * What *kind* of transaction an arrow is, and what colour that makes it.
 *
 * Nimiq puts the interesting part of a transaction in two places the map can read
 * cheaply: the account type of each end, and the first byte of each data blob. The
 * worker lifts both out of every history row (see `normalizeTransaction`), so a whole
 * map can be classified without a second request or a byte of WASM.
 *
 * ## The op-code table
 *
 * A transaction *to* the staking contract carries its operation in the first byte of
 * `recipientData`; one *from* it carries its operation in `senderData`. These values are
 * read out of `@nimiq/core` 2.21.0 rather than out of documentation — each incoming one
 * by handing `StakingContract.dataToPlain()` a buffer with that discriminant and reading
 * back the `type` it decoded to, and 0x05–0x09 a second time from the other direction, by
 * reading the first byte of what `StakingDataBuilder` emits:
 *
 *   recipientData, incoming            senderData, outgoing
 *   0x00 create-validator              0x00 delete-validator
 *   0x01 update-validator              0x01 remove-stake
 *   0x02 deactivate-validator
 *   0x03 reactivate-validator          Cross-checked against the builder:
 *   0x04 retire-validator                createStaker(…)[0]   === 0x05
 *   0x05 create-staker                   addStake(…)[0]       === 0x06
 *   0x06 add-stake                       updateStaker(…)[0]   === 0x07
 *   0x07 update-staker                   setActiveStake(…)[0] === 0x08
 *   0x08 set-active-stake                retireStake(…)[0]    === 0x09
 *   0x09 retire-stake                    removeStake()        === [0x01]
 *   0x0a set-signal-data
 *                                      0x0b and up are not variants at all —
 *                                      dataToPlain() refuses them.
 *
 * `remove-stake` is the one the map paints gold. It is the only way value leaves the
 * staking contract for a staker, so it is what a reader following a validator's money
 * sees as income — retired stake and the rewards that accrued on it, paid out together.
 * The chain does not separate the two, so neither does the label.
 */

import { compactAddress } from "@/lib/nimiq"
import { STAKING_CONTRACT } from "./scan"
import type { TxClassification } from "./types"

export type EdgeKind = "basic" | "stake" | "reward" | "data" | "htlc" | "vesting"

/** @nimiq/core `AccountType`. 0 is basic, and is what every ordinary wallet reports. */
const ACCOUNT_VESTING = 1
const ACCOUNT_HTLC = 2
const ACCOUNT_STAKING = 3

/**
 * senderData op code 0x00, on a transaction leaving the staking contract. The only
 * other one is 0x01, remove-stake, which is every payout and is what `reward` means.
 */
const OUT_DELETE_VALIDATOR = 0x00

/**
 * `Transaction.flags` bit 0 — set when the payload creates a vesting contract or an
 * HTLC. (Bit 1 is signalling, which the staking branches above already cover by their
 * op code.) @nimiq/core: "To create a new vesting or HTLC contract, set `flags` to
 * `0b1` and specify the contract type as the `recipient_type`."
 */
const FLAG_CONTRACT_CREATION = 0b1

const STAKING_KEY = compactAddress(STAKING_CONTRACT)

/** recipientData op codes, in the reader's words rather than the protocol's. */
const INCOMING_LABELS: Record<number, string> = {
  0x00: "Create validator",
  0x01: "Update validator",
  0x02: "Deactivate validator",
  0x03: "Reactivate validator",
  0x04: "Retire validator",
  0x05: "Stake",
  0x06: "Add stake",
  0x07: "Update staker",
  0x08: "Set active stake",
  0x09: "Unstake",
  0x0a: "Set signal data",
}

export const EDGE_COLORS: Record<EdgeKind, string> = {
  basic: "#71717a",
  stake: "#07c1ff",
  reward: "#f5c542",
  data: "#a78bfa",
  htlc: "#f472b6",
  vesting: "#2dd4bf",
}

/** The legend's rows, in the order it prints them. */
export const EDGE_KIND_LABELS: { kind: EdgeKind; label: string }[] = [
  { kind: "basic", label: "Basic" },
  { kind: "stake", label: "Stake" },
  { kind: "reward", label: "Reward" },
  { kind: "data", label: "Contract call" },
  { kind: "htlc", label: "HTLC" },
  { kind: "vesting", label: "Vesting" },
]

/** The one family drawn dashed, so a contract call reads as one without its colour. */
export const DASHED_KIND: EdgeKind = "data"

/** An edge, as far as classification is concerned: the two ends plus the worker's fields. */
export interface ClassifiableEdge extends TxClassification {
  source: { address: string }
  target: { address: string }
}

function isStakingEnd(address: string, accountType: number | undefined): boolean {
  return accountType === ACCOUNT_STAKING || compactAddress(address) === STAKING_KEY
}

/**
 * Which family an edge belongs to, and what to call it.
 *
 * Order matters and is the reason this is a chain rather than a table: the staking
 * contract is also an account with a type, and a staking transaction also carries
 * recipientData, so "is this staking?" has to be asked before "does it carry data?" or
 * every stake would come out violet.
 *
 * The label is `null` for a plain transfer between two basic accounts. The detail panel
 * already says everything there is to say about one, and "Basic transfer" printed under
 * the amount would be noise; the legend still names the family.
 */
function classify(edge: ClassifiableEdge): { kind: EdgeKind; label: string | null } {
  if (isStakingEnd(edge.source.address, edge.fromType)) {
    // Value leaving the staking contract. `delete-validator` is the validator's own
    // deposit coming back, which belongs with the rest of the staking machinery; a
    // `remove-stake` — and anything the node did not label — is a payout.
    return edge.senderDataType === OUT_DELETE_VALIDATOR
      ? { kind: "stake", label: "Delete validator" }
      : { kind: "reward", label: "Reward" }
  }
  if (isStakingEnd(edge.target.address, edge.toType)) {
    const named = edge.dataType == null ? undefined : INCOMING_LABELS[edge.dataType]
    return { kind: "stake", label: named ?? "Staking" }
  }

  if (edge.fromType === ACCOUNT_HTLC || edge.toType === ACCOUNT_HTLC) {
    return { kind: "htlc", label: "HTLC" }
  }
  if (edge.fromType === ACCOUNT_VESTING || edge.toType === ACCOUNT_VESTING) {
    return { kind: "vesting", label: "Vesting" }
  }
  // Anything else carrying a payload: a transfer with something attached to it. When
  // `flags` bit 0 is set the chain is saying the payload *creates* a contract, which is
  // the one case where "contract" is literally true; otherwise it is a message, a
  // cashlink, or whatever the sender chose to attach.
  if (edge.dataType != null) {
    const creating = ((edge.flags ?? 0) & FLAG_CONTRACT_CREATION) !== 0
    return { kind: "data", label: creating ? "Contract creation" : "Contract call" }
  }
  return { kind: "basic", label: null }
}

/** The family, for the colour the canvas paints an arrow. */
export function edgeKind(edge: ClassifiableEdge): EdgeKind {
  return classify(edge).kind
}

/** The family in the reader's words, naming the exact operation where the chain said it. */
export function edgeKindLabel(edge: ClassifiableEdge): string | null {
  return classify(edge).label
}
