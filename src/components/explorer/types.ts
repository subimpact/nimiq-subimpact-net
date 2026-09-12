/** The shapes `/api/blocks`, `/api/block` and `/api/tx` answer with. */

export interface ExplorerTx {
  hash: string
  from: string
  to: string
  value: number
  fee: number
  blockNumber: number
  timestamp: number
  confirmations?: number
  size?: number
  fromType?: number
  toType?: number
  flags?: number
  dataType?: number | null
  senderDataType?: number | null
}

export interface ExplorerBlock {
  number: number
  hash: string
  parentHash: string | null
  timestamp: number
  size: number
  batch: number
  epoch: number
  producer: string | null
  txCount: number
  transactions: ExplorerTx[]
}

export interface BlocksPayload {
  height: number
  fetchedAt: number
  source: string
  blocks: ExplorerBlock[]
}
