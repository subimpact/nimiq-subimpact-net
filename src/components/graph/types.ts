import type { SimLink, SimNode } from "@/lib/forceSim"

/** Shape of GET https://nimiq-api.subimpact.net/api/graph. Balances are luna. */
export interface GraphPayload {
  validators: ApiValidator[]
  stakers: ApiStaker[]
  totalActiveStake: number
  updatedAt: string
}

export interface ApiValidator {
  address: string
  name?: string
  balance: number
  numStakers: number
  stakeShare: number
}

export interface ApiStaker {
  address: string
  validatorAddress: string
  balance: number
}

export interface GraphNode extends SimNode {
  /** Unique key; namespaced so a self-staking address cannot collide with its validator. */
  id: string
  kind: "validator" | "staker"
  address: string
  shortAddress: string
  name?: string
  label: string
  balance: number
  /** Fraction of total active stake. */
  share: number
  clusterId: number
  color: string
  isImpact: boolean
  /** Set on stakers: the validator they delegate to. */
  validatorAddress?: string
  /** Lowercase address + name, for the search box. */
  searchKey: string
}

export type GraphLink = SimLink<GraphNode>

export interface Cluster {
  id: number
  color: string
  /** The hub node — every cluster is exactly one validator and its stakers. */
  validator: GraphNode
  label: string
  address: string
  isImpact: boolean
  stakerCount: number
  /** Sum of the delegated staker balances, luna. */
  delegatedStake: number
  /** The validator's own active stake as NimiqHub reports it, luna. */
  validatorStake: number
  share: number
}

export interface GraphModel {
  nodes: GraphNode[]
  links: GraphLink[]
  clusters: Cluster[]
  totalActiveStake: number
  updatedAt: string
}

export interface ViewportTransform {
  x: number
  y: number
  scale: number
}
