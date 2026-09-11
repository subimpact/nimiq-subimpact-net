/**
 * Minimal force-directed layout — the handful of d3-force behaviours the delegation
 * map needs, with no dependency (d3 is not in this site's package.json).
 *
 * Integration is the same velocity-Verlet-with-cooling scheme d3-force uses, and the
 * link and collision maths are ports of it. The many-body force is the one deliberate
 * departure: instead of a Barnes-Hut quadtree it is split in two, which suits a
 * hub-and-spoke graph and keeps this module small.
 *
 *   - hubs (the 52 validators) repel each other exactly, at any distance;
 *   - every node repels the neighbours inside one grid cell, on the same uniform grid
 *     the collision pass already needs.
 *
 * Nothing here reads the clock or Math.random: a given graph always lays out the same
 * way, so a reload does not reshuffle the map under the reader.
 */

export interface SimNode {
  x: number
  y: number
  vx: number
  vy: number
  /** Pinned position while dragging; null lets the simulation move the node. */
  fx: number | null
  fy: number | null
  /** Collision radius in world units. */
  radius: number
  /** Repulsion weight. Negative repels, as in d3. */
  charge: number
  /** Hubs take part in the exact long-range repulsion. */
  isHub: boolean
  /**
   * For a satellite, the hub it orbits.
   *
   * Long-range forces are computed once per hub and applied to the whole cluster, so a
   * cluster drifts as one body. Without this the hub is pushed out of a crowd while its
   * shell, which feels nothing beyond its own neighbours, trails behind it as a comet tail.
   */
  hub?: SimNode | null
}

export interface SimLink<TNode extends SimNode = SimNode> {
  source: TNode
  target: TNode
  /** Rest length. */
  distance: number
}

export interface ForceSimulationOptions {
  alpha?: number
  alphaMin?: number
  alphaDecay?: number
  /** Fraction of velocity shed each tick, as in d3 (0.4 keeps 60%). */
  velocityDecay?: number
  /** Cutoff for neighbour repulsion; also the grid cell size. */
  neighborhood?: number
  /**
   * Pull toward the origin, applied to hubs only. Satellites must be free to orbit
   * their own hub — a global pull drags every cluster's shell toward the middle and
   * leaves each hub trailing a comet tail.
   */
  centerStrength?: number
  /**
   * Vertical pull. Setting it above `centerStrength` squashes the map into the
   * aspect ratio of the viewport instead of a disc, which wastes far less canvas.
   */
  centerStrengthY?: number
  /** Extra breathing room between touching hexagons. */
  collidePadding?: number
  collideStrength?: number
  linkStrength?: number
  /** Ceiling on per-tick displacement; keeps a hot start from flinging nodes away. */
  maxSpeed?: number
}

/**
 * Pull toward the origin. Tuned with the hub charge in `buildGraph` against the live
 * 2,923-node graph: the map settles about 1.15× wider than the clusters strictly need,
 * which keeps them legibly apart without wasting canvas.
 */
export const DEFAULT_CENTER_STRENGTH = 0.28

const DEFAULTS = {
  alpha: 0.8,
  alphaMin: 0.0015,
  alphaDecay: 0.0225,
  velocityDecay: 0.4,
  neighborhood: 90,
  centerStrength: DEFAULT_CENTER_STRENGTH,
  centerStrengthY: DEFAULT_CENTER_STRENGTH,
  collidePadding: 2,
  collideStrength: 0.85,
  linkStrength: 1,
  maxSpeed: 45,
} satisfies Required<ForceSimulationOptions>

/** Below this separation the inverse-square term is clamped, or nodes fire off-screen. */
const MIN_SEPARATION_SQUARED = 25

interface InternalLink<TNode extends SimNode> extends SimLink<TNode> {
  /** d3's 1/min(degree) — a leaf snaps to its hub, a hub barely feels one leaf. */
  strength: number
  /** Share of the correction applied to the target; the source takes the rest. */
  bias: number
}

export class ForceSimulation<TNode extends SimNode = SimNode> {
  readonly nodes: TNode[]

  private readonly links: InternalLink<TNode>[]
  private readonly hubs: TNode[]
  private readonly options: Required<ForceSimulationOptions>
  private readonly cellSize: number

  // Uniform grid, counting-sorted in place each tick so a settling run allocates nothing.
  private readonly cellOfNode: Int32Array
  private readonly order: Int32Array
  private readonly cellStart: number[] = []
  private readonly cellCol: number[] = []
  private readonly cellRow: number[] = []
  private readonly cellIndex = new Map<number, number>()

  // Long-range acceleration per hub, shared with that hub's satellites.
  private readonly hubDvx: Float64Array
  private readonly hubDvy: Float64Array
  private readonly satellites: TNode[]
  private readonly satelliteHub: Int32Array

  private alphaValue: number

  constructor(nodes: TNode[], links: SimLink<TNode>[], options: ForceSimulationOptions = {}) {
    this.nodes = nodes
    this.options = { ...DEFAULTS, ...options }
    this.alphaValue = this.options.alpha
    this.hubs = nodes.filter((node) => node.isHub)

    const degree = new Map<TNode, number>()
    for (const link of links) {
      degree.set(link.source, (degree.get(link.source) ?? 0) + 1)
      degree.set(link.target, (degree.get(link.target) ?? 0) + 1)
    }

    this.links = links.map((link) => {
      const sourceDegree = degree.get(link.source) ?? 1
      const targetDegree = degree.get(link.target) ?? 1
      return {
        ...link,
        strength: this.options.linkStrength / Math.min(sourceDegree, targetDegree),
        bias: sourceDegree / (sourceDegree + targetDegree),
      }
    })

    let maxRadius = 0
    for (const node of nodes) maxRadius = Math.max(maxRadius, node.radius)
    this.cellSize = Math.max(this.options.neighborhood, 2 * maxRadius + this.options.collidePadding)

    this.cellOfNode = new Int32Array(nodes.length)
    this.order = new Int32Array(nodes.length)

    const hubSlot = new Map<TNode, number>()
    this.hubs.forEach((hub, index) => hubSlot.set(hub, index))
    this.hubDvx = new Float64Array(this.hubs.length)
    this.hubDvy = new Float64Array(this.hubs.length)
    this.satellites = nodes.filter((node) => !node.isHub && node.hub != null)
    this.satelliteHub = Int32Array.from(this.satellites, (node) => hubSlot.get(node.hub as TNode) ?? -1)
  }

  get alpha(): number {
    return this.alphaValue
  }

  get settled(): boolean {
    return this.alphaValue <= this.options.alphaMin
  }

  /** Wake the layout up — after a drag, a reset, or a control change. */
  reheat(alpha = 0.5): void {
    this.alphaValue = Math.max(this.alphaValue, alpha)
  }

  stop(): void {
    this.alphaValue = 0
  }

  tick(iterations = 1): void {
    for (let i = 0; i < iterations && !this.settled; i++) {
      this.alphaValue -= this.alphaValue * this.options.alphaDecay
      this.applyLinks()
      this.applyClusterForces()
      this.applyNeighbours()
      this.integrate()
    }
  }

  /** Axis-aligned bounds of the laid-out nodes, padded by their radii. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x - node.radius)
      minY = Math.min(minY, node.y - node.radius)
      maxX = Math.max(maxX, node.x + node.radius)
      maxY = Math.max(maxY, node.y + node.radius)
    }
    if (!Number.isFinite(minX)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
    return { minX, minY, maxX, maxY }
  }

  private applyLinks(): void {
    const alpha = this.alphaValue
    for (const link of this.links) {
      const { source, target } = link
      let dx = target.x + target.vx - source.x - source.vx
      let dy = target.y + target.vy - source.y - source.vy
      let length = Math.sqrt(dx * dx + dy * dy)
      if (length === 0) {
        // Perfectly coincident: nudge along a fixed diagonal rather than a random one.
        dx = 0.7071
        dy = 0.7071
        length = 1
      }
      const scale = ((length - link.distance) / length) * alpha * link.strength
      dx *= scale
      dy *= scale
      target.vx -= dx * link.bias
      target.vy -= dy * link.bias
      source.vx += dx * (1 - link.bias)
      source.vy += dy * (1 - link.bias)
    }
  }

  /**
   * The long-range pass: exact pairwise repulsion between hubs — 52 of them, so O(n²)
   * is free — plus the pull toward the origin. The resulting acceleration is applied to
   * each hub *and* to every satellite orbiting it, so clusters travel as whole bodies.
   */
  private applyClusterForces(): void {
    const alpha = this.alphaValue
    const hubs = this.hubs
    const dvx = this.hubDvx
    const dvy = this.hubDvy
    const centeringX = this.options.centerStrength * alpha
    const centeringY = this.options.centerStrengthY * alpha

    for (let i = 0; i < hubs.length; i++) {
      dvx[i] = -hubs[i].x * centeringX
      dvy[i] = -hubs[i].y * centeringY
    }

    for (let i = 0; i < hubs.length; i++) {
      const a = hubs[i]
      for (let j = i + 1; j < hubs.length; j++) {
        const b = hubs[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let distanceSquared = dx * dx + dy * dy
        if (distanceSquared < MIN_SEPARATION_SQUARED) {
          dx = (i % 2 === 0 ? 1 : -1) * (1 + (j % 3))
          dy = 1 + (i % 3)
          distanceSquared = dx * dx + dy * dy
        }
        const toA = (b.charge * alpha) / distanceSquared
        const toB = (a.charge * alpha) / distanceSquared
        dvx[i] += dx * toA
        dvy[i] += dy * toA
        dvx[j] -= dx * toB
        dvy[j] -= dy * toB
      }
    }

    for (let i = 0; i < hubs.length; i++) {
      hubs[i].vx += dvx[i]
      hubs[i].vy += dvy[i]
    }
    for (let i = 0; i < this.satellites.length; i++) {
      const slot = this.satelliteHub[i]
      if (slot < 0) continue
      this.satellites[i].vx += dvx[slot]
      this.satellites[i].vy += dvy[slot]
    }
  }

  /** One grid pass covering both short-range repulsion and hexagon collision. */
  private applyNeighbours(): void {
    const alpha = this.alphaValue
    const nodes = this.nodes
    const { neighborhood, collidePadding, collideStrength } = this.options
    const cutoffSquared = neighborhood * neighborhood

    this.rebuildGrid()

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      const col = this.cellCol[this.cellOfNode[i]]
      const row = this.cellRow[this.cellOfNode[i]]

      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          const cell = this.cellIndex.get(cellKey(col + dc, row + dr))
          if (cell === undefined) continue
          const end = this.cellStart[cell + 1]

          for (let slot = this.cellStart[cell]; slot < end; slot++) {
            const j = this.order[slot]
            if (j <= i) continue // each pair once
            const b = nodes[j]

            let dx = b.x + b.vx - a.x - a.vx
            let dy = b.y + b.vy - a.y - a.vy
            let distanceSquared = dx * dx + dy * dy
            if (distanceSquared === 0) {
              dx = 1 + (j % 3)
              dy = 1 + (i % 3)
              distanceSquared = dx * dx + dy * dy
            }
            if (distanceSquared > cutoffSquared) continue

            const clamped = Math.max(distanceSquared, MIN_SEPARATION_SQUARED)
            const toA = (b.charge * alpha) / clamped
            const toB = (a.charge * alpha) / clamped
            a.vx += dx * toA
            a.vy += dy * toA
            b.vx -= dx * toB
            b.vy -= dy * toB

            const touching = a.radius + b.radius + collidePadding
            if (distanceSquared < touching * touching) {
              const distance = Math.sqrt(distanceSquared)
              const push = ((touching - distance) / distance) * collideStrength
              const pushX = dx * push
              const pushY = dy * push
              // Split the correction by area, so a hub is not shoved by its satellites.
              const areaA = a.radius * a.radius
              const areaB = b.radius * b.radius
              const shareA = areaB / (areaA + areaB)
              a.vx -= pushX * shareA
              a.vy -= pushY * shareA
              b.vx += pushX * (1 - shareA)
              b.vy += pushY * (1 - shareA)
            }
          }
        }
      }
    }
  }

  private integrate(): void {
    const friction = 1 - this.options.velocityDecay
    const maxSpeed = this.options.maxSpeed

    for (const node of this.nodes) {
      if (node.fx !== null) {
        node.x = node.fx
        node.vx = 0
      } else {
        node.vx *= friction
      }
      if (node.fy !== null) {
        node.y = node.fy
        node.vy = 0
      } else {
        node.vy *= friction
      }

      const speed = Math.hypot(node.vx, node.vy)
      if (speed > maxSpeed) {
        const brake = maxSpeed / speed
        node.vx *= brake
        node.vy *= brake
      }
      if (node.fx === null) node.x += node.vx
      if (node.fy === null) node.y += node.vy
    }
  }

  /** Counting-sort every node into its grid cell; `order` ends up grouped by cell. */
  private rebuildGrid(): void {
    const nodes = this.nodes
    const size = this.cellSize

    this.cellIndex.clear()
    this.cellStart.length = 0
    this.cellCol.length = 0
    this.cellRow.length = 0

    const counts: number[] = []
    for (let i = 0; i < nodes.length; i++) {
      const col = Math.floor(nodes[i].x / size)
      const row = Math.floor(nodes[i].y / size)
      const key = cellKey(col, row)
      let cell = this.cellIndex.get(key)
      if (cell === undefined) {
        cell = counts.length
        this.cellIndex.set(key, cell)
        counts.push(0)
        this.cellCol.push(col)
        this.cellRow.push(row)
      }
      this.cellOfNode[i] = cell
      counts[cell]++
    }

    let offset = 0
    for (let cell = 0; cell < counts.length; cell++) {
      this.cellStart.push(offset)
      offset += counts[cell]
    }
    this.cellStart.push(offset)

    const cursor = this.cellStart.slice(0, counts.length)
    for (let i = 0; i < nodes.length; i++) {
      this.order[cursor[this.cellOfNode[i]]++] = i
    }
  }
}

/** Pack a signed cell coordinate pair into one integer key. */
function cellKey(col: number, row: number): number {
  return (col + 0x8000) * 0x10000 + (row + 0x8000)
}
