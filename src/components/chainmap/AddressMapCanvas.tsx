import { useEffect, useRef } from "react"
import { ForceSimulation } from "@/lib/forceSim"
import type { MapGraphEdge, MapGraphNode, MapModel, ViewportTransform } from "./types"

export interface MapCanvasHandle {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  focusNode: (key: string) => void
  reheat: () => void
  /** The whole map, framed and rendered at device resolution, as a PNG blob. */
  exportBlob: () => Promise<Blob | null>
}

export interface MapCanvasView {
  selectedNodeKey: string | null
  selectedEdgeHash: string | null
  hoveredNodeKey: string | null
  hoveredEdgeHash: string | null
  showLabels: boolean
}

export interface HoverTarget {
  node: MapGraphNode | null
  edge: MapGraphEdge | null
  x: number
  y: number
}

interface AddressMapCanvasProps {
  model: MapModel
  view: MapCanvasView
  onSelectNode: (node: MapGraphNode | null) => void
  onSelectEdge: (edge: MapGraphEdge) => void
  onHover: (target: HoverTarget | null) => void
  /** Double-click on a node — the paid "re-scan from here" gesture. */
  onRescan: (node: MapGraphNode) => void
  onReady?: (handle: MapCanvasHandle) => void
}

const SURFACE = "#09090b"
const GRID_STROKE = "rgba(7, 193, 255, 0.04)"
const LABEL_FONT = "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

const MIN_SCALE = 0.08
const MAX_SCALE = 6
const DRAG_SLOP = 6
const WARMUP_TICKS = 28

/** Below this on-screen radius a node is a batched dot, not a shaded circle. */
const DETAIL_RADIUS = 9
/** Above this simulation alpha the map is moving too fast to read the detail. */
const MOTION_ALPHA = 0.08
/** An arrowhead below this many pixels stops reading as a direction. */
const MIN_ARROW_LENGTH = 7
const MAX_ARROW_LENGTH = 15
/** How close a click has to land to count as hitting an edge. */
const EDGE_HIT_SLOP = 7
/** Samples along a bowed edge for hit-testing. */
const EDGE_SAMPLES = 12

/** A transaction older than this is drawn fully cooled. */
const AGE_HORIZON_DAYS = 365
const RECENT_RGB = [7, 193, 255]
const OLD_RGB = [82, 82, 91]
/**
 * Age is quantised before it becomes a colour so that edges can be batched: one
 * `stroke()` per (age, width) bucket instead of one per transaction. Twelve
 * steps is finer than the eye separates on a 1px line, and it turns a 5,000-edge
 * map from ~10,000 canvas calls a frame into a few dozen.
 */
const AGE_STEPS = 12

/**
 * How old a transaction reads, 0 (today) to 1 (a year or more).
 *
 * Logarithmic: the difference between yesterday and last week matters far more
 * to someone following money than the difference between two and three years.
 */
export function ageT(timestamp: number, now: number): number {
  if (!timestamp) return 1
  const days = Math.max(0, (now - timestamp) / 86400000)
  return Math.min(1, Math.log10(1 + days) / Math.log10(1 + AGE_HORIZON_DAYS))
}

/** Today's transfers in the site's cyan, old ones in its zinc. */
export function ageColorFromT(t: number, alpha = 1): string {
  const channel = (index: number) => Math.round(RECENT_RGB[index] + (OLD_RGB[index] - RECENT_RGB[index]) * t)
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})`
}


export function AddressMapCanvas({
  model,
  view,
  onSelectNode,
  onSelectEdge,
  onHover,
  onRescan,
  onReady,
}: AddressMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const viewRef = useRef(view)
  viewRef.current = view
  const onSelectNodeRef = useRef(onSelectNode)
  onSelectNodeRef.current = onSelectNode
  const onSelectEdgeRef = useRef(onSelectEdge)
  onSelectEdgeRef.current = onSelectEdge
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const onRescanRef = useRef(onRescan)
  onRescanRef.current = onRescan

  useEffect(() => {
    const containerEl = containerRef.current
    const canvasEl = canvasRef.current
    if (!containerEl || !canvasEl) return
    const context = canvasEl.getContext("2d")
    if (!context) return
    // Re-bound so the type carries the null check into the closures below: a
    // narrowed `let`/`const` does not stay narrowed inside a hoisted function.
    const container = containerEl
    const canvas = canvasEl
    const ctx = context

    const { nodes, edges, links } = model
    const byKey = new Map(nodes.map((node) => [node.key, node]))
    const now = Date.now()

    // Adjacency, built once: the dimming pass asks "is this next to the focus?"
    // for every node on every frame, which must not walk the edge list.
    const neighbours = new Map<string, Set<string>>()
    for (const edge of edges) {
      const add = (a: string, b: string) => {
        const set = neighbours.get(a)
        if (set) set.add(b)
        else neighbours.set(a, new Set([b]))
      }
      add(edge.source.key, edge.target.key)
      add(edge.target.key, edge.source.key)
    }

    // Age bucket per edge and the three palettes it can be drawn in, all fixed
    // for the life of the map — a frame only looks colours up.
    const ageStep = new Map<string, number>()
    for (const edge of edges) {
      ageStep.set(edge.hash, Math.round(ageT(edge.timestamp, now) * (AGE_STEPS - 1)))
    }
    const palette = {
      lit: Array.from({ length: AGE_STEPS }, (_, i) => ageColorFromT(i / (AGE_STEPS - 1), 0.66)),
      near: Array.from({ length: AGE_STEPS }, (_, i) => ageColorFromT(i / (AGE_STEPS - 1), 0.95)),
      dim: Array.from({ length: AGE_STEPS }, (_, i) => ageColorFromT(i / (AGE_STEPS - 1), 0.13)),
    }

    const aspect = Math.min(1.6, Math.max(0.9, container.clientWidth / Math.max(1, container.clientHeight)))
    const simulation = new ForceSimulation(nodes, links, {
      // Every address repels every other exactly: a flow map has no hub tier to
      // approximate against, and 400 nodes is 80k pairs a tick.
      centerStrength: 0.09,
      centerStrengthY: 0.09 * aspect,
      collidePadding: 6,
      neighborhood: 90,
    })
    simulation.tick(WARMUP_TICKS)

    const transform: ViewportTransform = { x: 0, y: 0, scale: 1 }
    let dirty = true
    let pulse = 0
    let cameraFollows = true

    // --- viewport ----------------------------------------------------------

    function fitToContent(): void {
      const bounds = simulation.bounds()
      const width = container.clientWidth || 1
      const height = container.clientHeight || 1
      const padding = width < 640 ? 28 : 56
      const spanX = Math.max(1, bounds.maxX - bounds.minX)
      const spanY = Math.max(1, bounds.maxY - bounds.minY)
      const scale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)),
      )
      transform.scale = scale
      transform.x = width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale
      transform.y = height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale
      dirty = true
    }

    function zoomAround(factor: number, screenX: number, screenY: number): void {
      cameraFollows = false
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale * factor))
      transform.x = screenX - (screenX - transform.x) * (next / transform.scale)
      transform.y = screenY - (screenY - transform.y) * (next / transform.scale)
      transform.scale = next
      dirty = true
    }

    function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
      return {
        x: (screenX - transform.x) / transform.scale,
        y: (screenY - transform.y) / transform.scale,
      }
    }

    function screenRadius(node: MapGraphNode): number {
      return Math.max(node.isSeed ? 7 : 3, node.radius * transform.scale)
    }

    function nodeAt(screenX: number, screenY: number): MapGraphNode | null {
      const world = screenToWorld(screenX, screenY)
      let hit: MapGraphNode | null = null
      let best = Infinity
      for (const node of nodes) {
        const distance = Math.hypot(node.x - world.x, node.y - world.y) * transform.scale
        // A few pixels of slack, so a small address stays clickable zoomed out.
        const reach = screenRadius(node) + 5
        if (distance <= reach && distance < best) {
          best = distance
          hit = node
        }
      }
      return hit
    }

    /** Screen-space control point of a bowed edge. */
    function controlPoint(edge: MapGraphEdge): { cx: number; cy: number } {
      const { scale, x: tx, y: ty } = transform
      const sx = edge.source.x * scale + tx
      const sy = edge.source.y * scale + ty
      const gx = edge.target.x * scale + tx
      const gy = edge.target.y * scale + ty
      const mx = (sx + gx) / 2
      const my = (sy + gy) / 2
      if (edge.bow === 0) return { cx: mx, cy: my }
      const dx = gx - sx
      const dy = gy - sy
      const length = Math.hypot(dx, dy) || 1
      // A quadratic curve passes through midpoint + offset/2, so the control
      // point carries twice the bow the reader should see.
      const offset = edge.bow * scale * 2
      return { cx: mx + (-dy / length) * offset, cy: my + (dx / length) * offset }
    }

    function edgeAt(screenX: number, screenY: number): MapGraphEdge | null {
      const { scale, x: tx, y: ty } = transform
      let hit: MapGraphEdge | null = null
      let best = Infinity
      for (const edge of edges) {
        const sx = edge.source.x * scale + tx
        const sy = edge.source.y * scale + ty
        const gx = edge.target.x * scale + tx
        const gy = edge.target.y * scale + ty
        // Cheap reject on the bounding box before sampling the curve.
        const pad = Math.abs(edge.bow * scale) + EDGE_HIT_SLOP + 4
        if (screenX < Math.min(sx, gx) - pad || screenX > Math.max(sx, gx) + pad) continue
        if (screenY < Math.min(sy, gy) - pad || screenY > Math.max(sy, gy) + pad) continue

        const { cx, cy } = controlPoint(edge)
        for (let i = 1; i < EDGE_SAMPLES; i++) {
          const t = i / EDGE_SAMPLES
          const inv = 1 - t
          const px = inv * inv * sx + 2 * inv * t * cx + t * t * gx
          const py = inv * inv * sy + 2 * inv * t * cy + t * t * gy
          const distance = Math.hypot(px - screenX, py - screenY)
          if (distance <= EDGE_HIT_SLOP + edge.width && distance < best) {
            best = distance
            hit = edge
          }
        }
      }
      return hit
    }

    // --- interaction -------------------------------------------------------

    let panning = false
    let panStart = { x: 0, y: 0, tx: 0, ty: 0 }
    let dragged: MapGraphNode | null = null
    let dragDistance = 0
    let pinchDistance = 0

    function localPoint(clientX: number, clientY: number): { x: number; y: number } {
      const rect = canvas.getBoundingClientRect()
      return { x: clientX - rect.left, y: clientY - rect.top }
    }

    function beginGesture(x: number, y: number): void {
      dragDistance = 0
      const node = nodeAt(x, y)
      if (node) {
        dragged = node
        node.fx = node.x
        node.fy = node.y
        simulation.reheat(0.3)
      } else {
        panning = true
        panStart = { x, y, tx: transform.x, ty: transform.y }
      }
    }

    function moveGesture(x: number, y: number, delta: number): boolean {
      if (dragged) {
        dragDistance += delta
        const world = screenToWorld(x, y)
        dragged.fx = world.x
        dragged.fy = world.y
        dragged.x = world.x
        dragged.y = world.y
        simulation.reheat(0.2)
        dirty = true
        return true
      }
      if (panning) {
        dragDistance += delta
        cameraFollows = false
        transform.x = panStart.tx + (x - panStart.x)
        transform.y = panStart.ty + (y - panStart.y)
        dirty = true
        return true
      }
      return false
    }

    function endGesture(x: number, y: number): void {
      const wasDrag = dragDistance > DRAG_SLOP
      if (dragged) {
        const node = dragged
        // The seed keeps its pin: it is the map's frame of reference.
        if (!node.isSeed) {
          node.fx = null
          node.fy = null
        } else {
          node.fx = node.x
          node.fy = node.y
        }
        if (!wasDrag) onSelectNodeRef.current(node)
        dragged = null
      } else if (panning) {
        panning = false
        if (!wasDrag) {
          const edge = edgeAt(x, y)
          if (edge) onSelectEdgeRef.current(edge)
          else onSelectNodeRef.current(null)
        }
      }
      dirty = true
    }

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = localPoint(event.clientX, event.clientY)
      zoomAround(event.deltaY < 0 ? 1.12 : 0.89, point.x, point.y)
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      const point = localPoint(event.clientX, event.clientY)
      beginGesture(point.x, point.y)
    }

    const handleMouseMove = (event: MouseEvent) => {
      const point = localPoint(event.clientX, event.clientY)
      if (moveGesture(point.x, point.y, Math.abs(event.movementX) + Math.abs(event.movementY))) return
      const node = nodeAt(point.x, point.y)
      const edge = node ? null : edgeAt(point.x, point.y)
      const current = viewRef.current
      const changed =
        (node?.key ?? null) !== current.hoveredNodeKey || (edge?.hash ?? null) !== current.hoveredEdgeHash
      if (node || edge) {
        onHoverRef.current({ node, edge, x: point.x, y: point.y })
      } else if (changed) {
        onHoverRef.current(null)
      }
      if (changed) dirty = true
      canvas.style.cursor = node || edge ? "pointer" : "grab"
    }

    const handleMouseUp = (event: MouseEvent) => {
      const point = localPoint(event.clientX, event.clientY)
      endGesture(point.x, point.y)
    }

    const handleMouseLeave = () => {
      panning = false
      if (dragged) {
        if (!dragged.isSeed) {
          dragged.fx = null
          dragged.fy = null
        }
        dragged = null
      }
      onHoverRef.current(null)
      dirty = true
    }

    const handleDoubleClick = (event: MouseEvent) => {
      const point = localPoint(event.clientX, event.clientY)
      const node = nodeAt(point.x, point.y)
      if (node) {
        event.preventDefault()
        onRescanRef.current(node)
      }
    }

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const point = localPoint(event.touches[0].clientX, event.touches[0].clientY)
        beginGesture(point.x, point.y)
      } else if (event.touches.length === 2) {
        pinchDistance = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY,
        )
      }
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        const point = localPoint(event.touches[0].clientX, event.touches[0].clientY)
        if (moveGesture(point.x, point.y, 5)) event.preventDefault()
      } else if (event.touches.length === 2 && pinchDistance > 0) {
        event.preventDefault()
        const next = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY,
        )
        const mid = localPoint(
          (event.touches[0].clientX + event.touches[1].clientX) / 2,
          (event.touches[0].clientY + event.touches[1].clientY) / 2,
        )
        zoomAround(next / pinchDistance, mid.x, mid.y)
        pinchDistance = next
      }
    }

    const handleTouchEnd = (event: TouchEvent) => {
      pinchDistance = 0
      const touch = event.changedTouches[0]
      const point = touch ? localPoint(touch.clientX, touch.clientY) : { x: -1, y: -1 }
      endGesture(point.x, point.y)
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false })
    canvas.addEventListener("mousedown", handleMouseDown)
    canvas.addEventListener("mousemove", handleMouseMove)
    canvas.addEventListener("mouseup", handleMouseUp)
    canvas.addEventListener("mouseleave", handleMouseLeave)
    canvas.addEventListener("dblclick", handleDoubleClick)
    canvas.addEventListener("touchstart", handleTouchStart, { passive: true })
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false })
    canvas.addEventListener("touchend", handleTouchEnd)

    // --- rendering ---------------------------------------------------------

    function drawGrid(width: number, height: number): void {
      const step = 110 * transform.scale
      if (step < 26) return
      ctx.strokeStyle = GRID_STROKE
      ctx.lineWidth = 1
      ctx.beginPath()
      const firstX = transform.x % step
      for (let x = firstX; x < width; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, height)
      }
      const firstY = transform.y % step
      for (let y = firstY; y < height; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5)
        ctx.lineTo(width, Math.round(y) + 0.5)
      }
      ctx.stroke()
    }

    /** One arrow, added to `path`, at the target end and outside its circle. */
    function addArrowhead(
      path: Path2D,
      gx: number,
      gy: number,
      cx: number,
      cy: number,
      radius: number,
      width: number,
    ): void {
      let dx = gx - cx
      let dy = gy - cy
      const length = Math.hypot(dx, dy) || 1
      dx /= length
      dy /= length
      const tipX = gx - dx * (radius + 1)
      const tipY = gy - dy * (radius + 1)
      // Never smaller than MIN_ARROW_LENGTH: at low zoom the arrow is the only
      // thing saying which way the money went.
      const size = Math.max(MIN_ARROW_LENGTH, Math.min(MAX_ARROW_LENGTH, 4 + width * 2.2))
      const spread = size * 0.42
      path.moveTo(tipX, tipY)
      path.lineTo(tipX - dx * size + -dy * spread, tipY - dy * size + dx * spread)
      path.lineTo(tipX - dx * size - -dy * spread, tipY - dy * size - dx * spread)
      path.closePath()
    }

    /**
     * `full` forces every detail on. The loop leaves it off while the layout is
     * still moving: a profile of a 400-address map puts ~78% of the frame in
     * rasterisation, and the arrowheads are 1,200 filled triangles nobody can
     * read while the map is sliding. They come back the moment it settles.
     */
    function render(full = false): void {
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        dirty = true
      }
      paint(width, height, dpr, full || simulation.alpha < MOTION_ALPHA)
    }

    function paint(width: number, height: number, dpr: number, showArrows: boolean): void {
      const current = viewRef.current
      const selectedNode = current.selectedNodeKey ? byKey.get(current.selectedNodeKey) ?? null : null
      const hoveredNode = current.hoveredNodeKey ? byKey.get(current.hoveredNodeKey) ?? null : null
      const focus = hoveredNode ?? selectedNode
      const { x: tx, y: ty, scale } = transform
      const margin = 90

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = SURFACE
      ctx.fillRect(0, 0, width, height)
      drawGrid(width, height)

      // 1. Flows, batched into one stroke and one fill per (age, width, state)
      //    bucket. A 5,000-edge map draws in a few dozen canvas calls instead of
      //    ten thousand, which is the difference between 15fps and 60.
      const strokeScale = Math.min(1.8, Math.max(0.75, Math.sqrt(scale)))
      const batches = new Map<string, { color: string; width: number; curves: Path2D; heads: Path2D }>()
      const highlighted: MapGraphEdge[] = []

      for (const edge of edges) {
        const sx = edge.source.x * scale + tx
        const sy = edge.source.y * scale + ty
        const gx = edge.target.x * scale + tx
        const gy = edge.target.y * scale + ty
        if (Math.max(sx, gx) < -margin || Math.min(sx, gx) > width + margin) continue
        if (Math.max(sy, gy) < -margin || Math.min(sy, gy) > height + margin) continue

        if (edge.hash === current.selectedEdgeHash || edge.hash === current.hoveredEdgeHash) {
          // At most two, and they go on top of everything else.
          highlighted.push(edge)
          continue
        }

        const touchesFocus = focus != null && (edge.source === focus || edge.target === focus)
        const state = focus == null ? "lit" : touchesFocus ? "near" : "dim"
        const step = ageStep.get(edge.hash) ?? AGE_STEPS - 1
        // Half-pixel width buckets: finer than the difference is visible.
        const widthStep = Math.round(edge.width * 2)
        const key = `${state}|${step}|${widthStep}`

        let batch = batches.get(key)
        if (!batch) {
          batch = {
            color: palette[state][step],
            width: (widthStep / 2) * strokeScale,
            curves: new Path2D(),
            heads: new Path2D(),
          }
          batches.set(key, batch)
        }

        const { cx, cy } = controlPoint(edge)
        batch.curves.moveTo(sx, sy)
        batch.curves.quadraticCurveTo(cx, cy, gx, gy)
        if (showArrows && state !== "dim") {
          addArrowhead(batch.heads, gx, gy, cx, cy, screenRadius(edge.target), batch.width)
        }
      }

      for (const batch of batches.values()) {
        ctx.strokeStyle = batch.color
        ctx.lineWidth = batch.width
        ctx.stroke(batch.curves)
        ctx.fillStyle = batch.color
        ctx.fill(batch.heads)
      }

      for (const edge of highlighted) {
        const sx = edge.source.x * scale + tx
        const sy = edge.source.y * scale + ty
        const gx = edge.target.x * scale + tx
        const gy = edge.target.y * scale + ty
        const { cx, cy } = controlPoint(edge)
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.quadraticCurveTo(cx, cy, gx, gy)
        ctx.strokeStyle = "#fafafa"
        ctx.lineWidth = edge.width * strokeScale * 1.8
        ctx.stroke()
        const head = new Path2D()
        addArrowhead(head, gx, gy, cx, cy, screenRadius(edge.target), edge.width * strokeScale * 1.8)
        ctx.fillStyle = "#fafafa"
        ctx.fill(head)
      }

      // 2. Addresses. Anything below DETAIL_RADIUS on screen is a dot, so it is
      //    batched by colour rather than shaded and stroked individually.
      const dots = new Map<string, Path2D>()
      const detailed: MapGraphNode[] = []
      for (const node of nodes) {
        const sx = node.x * scale + tx
        const sy = node.y * scale + ty
        if (sx < -margin || sx > width + margin || sy < -margin || sy > height + margin) continue
        const r = screenRadius(node)
        const isFocus = focus?.key === node.key
        if (r >= DETAIL_RADIUS || node.isSeed || isFocus) {
          detailed.push(node)
          continue
        }
        const dimmed = focus != null && !isNeighbour(node, focus)
        const key = `${node.color}|${dimmed ? "dim" : "lit"}|${node.expanded ? "full" : "edge"}`
        let path = dots.get(key)
        if (!path) dots.set(key, (path = new Path2D()))
        path.moveTo(sx + r, sy)
        path.arc(sx, sy, r, 0, Math.PI * 2)
      }

      for (const [key, path] of dots) {
        const [color, state, opened] = key.split("|")
        ctx.globalAlpha = state === "dim" ? 0.22 : opened === "edge" ? 0.62 : 0.95
        ctx.fillStyle = color
        ctx.fill(path)
      }
      ctx.globalAlpha = 1

      for (const node of detailed) {
        const sx = node.x * scale + tx
        const sy = node.y * scale + ty
        const r = screenRadius(node)
        const isSelected = selectedNode?.key === node.key
        const isHovered = hoveredNode?.key === node.key
        const dimmed = focus != null && !isSelected && !isHovered && !isNeighbour(node, focus)

        ctx.globalAlpha = dimmed ? 0.25 : 1

        if (isSelected || isHovered || node.isSeed) {
          ctx.shadowColor = node.color
          ctx.shadowBlur = node.isSeed ? 22 : 14
        }
        const gradient = ctx.createLinearGradient(sx, sy - r, sx, sy + r)
        gradient.addColorStop(0, node.color)
        gradient.addColorStop(0.65, `${node.color}cc`)
        gradient.addColorStop(1, "#0b0f16")
        ctx.beginPath()
        ctx.arc(sx, sy, r, 0, Math.PI * 2)
        ctx.fillStyle = gradient
        ctx.fill()
        ctx.shadowBlur = 0

        ctx.lineWidth = isSelected ? 2.4 : isHovered ? 1.9 : 1.1
        ctx.strokeStyle = isSelected ? "#ffffff" : isHovered ? "#fafafa" : node.color
        // An address the scan never opened is drawn hollow: that dashed outline
        // is the edge of what was looked at, not the edge of the money.
        if (!node.expanded && !node.isSeed) ctx.setLineDash([3, 3])
        ctx.stroke()
        ctx.setLineDash([])

        if (node.isSeed) {
          ctx.beginPath()
          ctx.arc(sx, sy, r + 5, 0, Math.PI * 2)
          ctx.strokeStyle = `${node.color}99`
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
        if (isSelected) {
          const offset = Math.sin(pulse * 3) * 2.5
          ctx.beginPath()
          ctx.arc(sx, sy, r + 8 + offset, 0, Math.PI * 2)
          ctx.strokeStyle = "#ffffff"
          ctx.lineWidth = 1.4
          ctx.setLineDash([5, 5])
          ctx.stroke()
          ctx.setLineDash([])
        }
        ctx.globalAlpha = 1
      }

      // 3. Labels — the seed always, the rest once they have earned the room.
      if (current.showLabels) {
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        for (const node of nodes) {
          const r = screenRadius(node)
          const isFocus = focus?.key === node.key
          if (!node.isSeed && !isFocus && r < 13) continue
          const sx = node.x * scale + tx
          const sy = node.y * scale + ty
          if (sx < -margin || sx > width + margin || sy < -margin || sy > height + margin) continue

          const fontSize = node.isSeed ? 12 : Math.max(10, Math.min(13, r * 0.55))
          ctx.font = `600 ${fontSize}px ${node.isSeed ? LABEL_FONT : MONO_FONT}`
          const text = node.isSeed ? "Seed" : node.shortAddress
          const textWidth = ctx.measureText(text).width
          const labelY = sy + r + 6 + fontSize / 2

          ctx.fillStyle = "rgba(9, 9, 11, 0.82)"
          ctx.fillRect(sx - textWidth / 2 - 4, labelY - fontSize / 2 - 2, textWidth + 8, fontSize + 4)
          ctx.fillStyle = node.isSeed ? "#07c1ff" : "#d4d4d8"
          ctx.fillText(text, sx, labelY)

          if (node.isSeed) {
            ctx.font = `500 11px ${MONO_FONT}`
            ctx.fillStyle = "#a1a1aa"
            ctx.fillText(node.shortAddress, sx, labelY + fontSize + 4)
          }
        }
      }
    }

    /** Neighbours of the focus stay lit so a hover reads as "who touched this". */
    function isNeighbour(node: MapGraphNode, focus: MapGraphNode): boolean {
      return node === focus || (neighbours.get(focus.key)?.has(node.key) ?? false)
    }

    // --- loop --------------------------------------------------------------

    let frame = 0
    let lastSignature = ""
    let lastRunning = true
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

    const loop = () => {
      const current = viewRef.current
      const signature = `${current.selectedNodeKey}|${current.selectedEdgeHash}|${current.hoveredNodeKey}|${current.hoveredEdgeHash}|${current.showLabels}`
      if (signature !== lastSignature) {
        lastSignature = signature
        dirty = true
      }

      const running = !simulation.settled
      if (running) {
        simulation.tick(reduceMotion ? 8 : 1)
        if (cameraFollows) fitToContent()
      }

      const animating = !reduceMotion && current.selectedNodeKey !== null
      if (animating) pulse += 0.05

      const settling = running && reduceMotion
      if (!settling && (running || dirty || animating || lastRunning)) {
        dirty = false
        render()
      }
      lastRunning = running
      frame = requestAnimationFrame(loop)
    }

    fitToContent()
    frame = requestAnimationFrame(loop)

    const observer = new ResizeObserver(() => {
      dirty = true
    })
    observer.observe(container)

    onReady?.({
      zoomIn: () => zoomAround(1.35, container.clientWidth / 2, container.clientHeight / 2),
      zoomOut: () => zoomAround(1 / 1.35, container.clientWidth / 2, container.clientHeight / 2),
      resetView: () => {
        cameraFollows = true
        fitToContent()
        simulation.reheat(0.35)
      },
      focusNode: (key: string) => {
        const node = byKey.get(key)
        if (!node) return
        cameraFollows = false
        transform.scale = Math.min(MAX_SCALE, Math.max(transform.scale, 1.2))
        transform.x = container.clientWidth / 2 - node.x * transform.scale
        transform.y = container.clientHeight / 2 - node.y * transform.scale
        dirty = true
      },
      reheat: () => simulation.reheat(0.6),
      exportBlob: () =>
        new Promise<Blob | null>((resolve) => {
          // Export the whole map, not the reader's current pan — then put the
          // view back exactly as it was.
          const saved = { ...transform }
          const wasFollowing = cameraFollows
          fitToContent()
          // An export is read, not watched: every arrowhead, however hot the
          // layout still is.
          render(true)
          canvas.toBlob((blob) => {
            transform.x = saved.x
            transform.y = saved.y
            transform.scale = saved.scale
            cameraFollows = wasFollowing
            dirty = true
            resolve(blob)
          }, "image/png")
        }),
    })

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      simulation.stop()
      canvas.removeEventListener("wheel", handleWheel)
      canvas.removeEventListener("mousedown", handleMouseDown)
      canvas.removeEventListener("mousemove", handleMouseMove)
      canvas.removeEventListener("mouseup", handleMouseUp)
      canvas.removeEventListener("mouseleave", handleMouseLeave)
      canvas.removeEventListener("dblclick", handleDoubleClick)
      canvas.removeEventListener("touchstart", handleTouchStart)
      canvas.removeEventListener("touchmove", handleTouchMove)
      canvas.removeEventListener("touchend", handleTouchEnd)
    }
    // The simulation owns the node objects, so it is rebuilt only for a new model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        data-chainmap-canvas=""
        role="img"
        aria-label={`Money-flow map of ${model.nodes.length} Nimiq addresses and ${model.edges.length} transactions, seeded from ${model.meta.seed}. The transaction list below the map carries the same data as text.`}
        className="block h-full w-full select-none"
        style={{ cursor: "grab", touchAction: "pan-y" }}
      />
    </div>
  )
}
