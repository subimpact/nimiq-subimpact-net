import { useEffect, useRef } from "react"
import { DEFAULT_CENTER_STRENGTH, ForceSimulation } from "@/lib/forceSim"
import { formatNim } from "@/lib/nimiq"
import type { GraphModel, GraphNode, ViewportTransform } from "./types"

export interface GraphCanvasHandle {
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  focusNode: (id: string) => void
  reheat: () => void
}

/** Everything the renderer needs from the controls, read fresh on every frame. */
export interface GraphCanvasView {
  /** Stakers below this balance (luna) are hidden. Validators always stay. */
  minStakerBalance: number
  showLabels: boolean
  highlightImpact: boolean
  selectedId: string | null
  hoveredId: string | null
  highlightClusterId: number | null
  /** Search hits, or null when the box is empty. */
  matchIds: Set<string> | null
}

interface HexGraphCanvasProps {
  model: GraphModel
  view: GraphCanvasView
  onSelect: (node: GraphNode | null) => void
  onHover: (node: GraphNode | null, point: { x: number; y: number } | null) => void
  onReady?: (handle: GraphCanvasHandle) => void
}

const SURFACE = "#09090b"
const GRID_STROKE = "rgba(7, 193, 255, 0.045)"
const LABEL_FONT = "'Geist Variable', ui-sans-serif, system-ui, sans-serif"
const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

const MIN_SCALE = 0.06
const MAX_SCALE = 6
/** Below this on-screen radius a node is drawn flat and batched instead of shaded. */
const DETAIL_RADIUS = 7
/** Satellites stay visible when the whole map is in view. */
const MIN_SCREEN_RADIUS = 1.4
const DRAG_SLOP = 6
/** Ticks run before the first paint so the map opens already readable. */
const WARMUP_TICKS = 24

/** Pointy-top regular hexagon. */
function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6
    const px = x + radius * Math.cos(angle)
    const py = y + radius * Math.sin(angle)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

function drawHexagon(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath()
  hexPath(ctx, x, y, radius)
}

/** Exact point-in-hexagon test, pointy-top orientation. */
function isPointInHex(dx: number, dy: number, radius: number): boolean {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const h = radius * 0.86602540378 // sqrt(3)/2
  if (ay > radius || ax > h) return false
  return 2 * radius * h - radius * ax - h * ay >= 0
}

export function HexGraphCanvas({ model, view, onSelect, onHover, onReady }: HexGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Props the render loop reads; refreshed on every React render, never stale.
  const viewRef = useRef(view)
  viewRef.current = view
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const { nodes, links } = model
    const byId = new Map(nodes.map((node) => [node.id, node]))
    // Squash the layout toward the shape of the canvas: on a wide panel that buys
    // ~25% more zoom before the map runs out of room.
    const aspect = Math.min(1.5, Math.max(0.9, container.clientWidth / Math.max(1, container.clientHeight)))
    const simulation = new ForceSimulation(nodes, links, {
      centerStrengthY: DEFAULT_CENTER_STRENGTH * aspect,
    })
    simulation.tick(WARMUP_TICKS)

    const transform: ViewportTransform = { x: 0, y: 0, scale: 1 }
    let dirty = true
    let pulse = 0
    // The camera tracks the settling layout until the reader takes the wheel.
    let cameraFollows = true

    // --- viewport ----------------------------------------------------------

    function fitToContent(): void {
      const bounds = simulation.bounds()
      const width = container.clientWidth || 1
      const height = container.clientHeight || 1
      const padding = width < 640 ? 24 : 48
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

    function isVisible(node: GraphNode): boolean {
      if (node.kind === "validator") return true
      return node.balance >= viewRef.current.minStakerBalance
    }

    function nodeAt(screenX: number, screenY: number): GraphNode | null {
      const world = screenToWorld(screenX, screenY)
      // Satellites are drawn over hubs, so hit-test them first; a tiny hex also gets a
      // slightly generous target so it stays clickable when zoomed out.
      const slack = Math.max(0, 5 / transform.scale)
      let hit: GraphNode | null = null
      for (const node of nodes) {
        if (!isVisible(node)) continue
        const dx = world.x - node.x
        const dy = world.y - node.y
        if (!isPointInHex(dx, dy, node.radius + (node.kind === "staker" ? slack : 0))) continue
        if (!hit || node.kind === "staker") hit = node
        if (node.kind === "staker") break
      }
      return hit
    }

    // --- interaction -------------------------------------------------------

    let panning = false
    let panStart = { x: 0, y: 0, tx: 0, ty: 0 }
    let dragged: GraphNode | null = null
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

    function endGesture(): void {
      const wasDrag = dragDistance > DRAG_SLOP
      if (dragged) {
        dragged.fx = null
        dragged.fy = null
        if (!wasDrag) onSelectRef.current(dragged)
        dragged = null
      } else if (panning) {
        if (!wasDrag) onSelectRef.current(null)
        panning = false
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
      if (node?.id !== viewRef.current.hoveredId) {
        onHoverRef.current(node, node ? point : null)
        dirty = true
      } else if (node) {
        onHoverRef.current(node, point)
      }
      canvas.style.cursor = node ? "pointer" : "grab"
    }

    const handleMouseUp = () => endGesture()

    const handleMouseLeave = () => {
      panning = false
      if (dragged) {
        dragged.fx = null
        dragged.fy = null
        dragged = null
      }
      onHoverRef.current(null, null)
      dirty = true
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

    const handleTouchEnd = () => {
      pinchDistance = 0
      endGesture()
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false })
    canvas.addEventListener("mousedown", handleMouseDown)
    canvas.addEventListener("mousemove", handleMouseMove)
    canvas.addEventListener("mouseup", handleMouseUp)
    canvas.addEventListener("mouseleave", handleMouseLeave)
    canvas.addEventListener("touchstart", handleTouchStart, { passive: true })
    canvas.addEventListener("touchmove", handleTouchMove, { passive: false })
    canvas.addEventListener("touchend", handleTouchEnd)

    // --- rendering ---------------------------------------------------------

    function drawGrid(width: number, height: number): void {
      const scale = transform.scale
      const radius = 48 * scale
      if (radius < 14) return
      const stepX = radius * 1.5
      const stepY = radius * Math.sqrt(3)
      ctx.strokeStyle = GRID_STROKE
      ctx.lineWidth = 1
      ctx.beginPath()
      const firstCol = Math.floor((-transform.x - stepX) / stepX)
      const lastCol = Math.ceil((width - transform.x + stepX) / stepX)
      const firstRow = Math.floor((-transform.y - stepY) / stepY)
      const lastRow = Math.ceil((height - transform.y + stepY) / stepY)
      for (let col = firstCol; col <= lastCol; col++) {
        for (let row = firstRow; row <= lastRow; row++) {
          const cx = transform.x + col * stepX
          const cy = transform.y + row * stepY + (col % 2 !== 0 ? stepY / 2 : 0)
          hexPath(ctx, cx, cy, radius * 0.95)
        }
      }
      ctx.stroke()
    }

    function render(): void {
      const dpr = window.devicePixelRatio || 1
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        dirty = true
      }

      const current = viewRef.current
      const selected = current.selectedId ? byId.get(current.selectedId) ?? null : null
      const hovered = current.hoveredId ? byId.get(current.hoveredId) ?? null : null
      const focus = hovered ?? selected
      const matches = current.matchIds
      const activeCluster =
        current.highlightClusterId ?? (selected && selected.clusterId >= 0 ? selected.clusterId : null)
      const dimming = focus !== null || activeCluster !== null || matches !== null || current.highlightImpact

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = SURFACE
      ctx.fillRect(0, 0, width, height)
      drawGrid(width, height)

      const { x: tx, y: ty, scale } = transform
      const margin = 80

      /** A node is emphasised when it is the focus, in the active cluster, or a search hit. */
      const emphasised = (node: GraphNode): boolean => {
        if (focus && (node.id === focus.id || node.clusterId === focus.clusterId)) return true
        if (activeCluster !== null && node.clusterId === activeCluster) return true
        if (matches?.has(node.id)) return true
        if (current.highlightImpact && node.isImpact) return true
        return false
      }

      // 1. Delegation edges, batched into two passes so 2,800 of them stay cheap.
      ctx.lineWidth = 1
      for (const pass of dimming ? ["dim", "lit"] : ["lit"]) {
        ctx.beginPath()
        let drew = false
        for (const link of links) {
          const staker = link.source
          const hub = link.target
          if (!isVisible(staker)) continue
          const lit = !dimming || emphasised(staker) || emphasised(hub)
          if ((pass === "lit") !== lit) continue
          const sx = staker.x * scale + tx
          const sy = staker.y * scale + ty
          const hx = hub.x * scale + tx
          const hy = hub.y * scale + ty
          if (Math.max(sx, hx) < -margin || Math.min(sx, hx) > width + margin) continue
          if (Math.max(sy, hy) < -margin || Math.min(sy, hy) > height + margin) continue
          ctx.moveTo(sx, sy)
          ctx.lineTo(hx, hy)
          drew = true
        }
        if (!drew) continue
        ctx.strokeStyle = pass === "lit" ? "rgba(161, 161, 170, 0.34)" : "rgba(113, 113, 122, 0.07)"
        ctx.stroke()
      }

      // 2. Small satellites, batched by fill colour — one fill call per bucket.
      const buckets = new Map<string, GraphNode[]>()
      const detailed: GraphNode[] = []
      for (const node of nodes) {
        if (!isVisible(node)) continue
        const sx = node.x * scale + tx
        const sy = node.y * scale + ty
        if (sx < -margin || sx > width + margin || sy < -margin || sy > height + margin) continue
        const screenRadius = Math.max(MIN_SCREEN_RADIUS, node.radius * scale)
        // ImpactZero holds 0.04% of the stake, so its hex is a speck. It keeps that
        // honest size but always gets the detailed pass, which pins and names it.
        if (screenRadius >= DETAIL_RADIUS || node.id === focus?.id || (node.isImpact && node.kind === "validator")) {
          detailed.push(node)
          continue
        }
        const key = `${node.color}|${dimming && !emphasised(node) ? "dim" : "lit"}`
        const bucket = buckets.get(key)
        if (bucket) bucket.push(node)
        else buckets.set(key, [node])
      }

      for (const [key, members] of buckets) {
        const [color, state] = key.split("|")
        ctx.globalAlpha = state === "dim" ? 0.16 : 0.9
        ctx.fillStyle = color
        ctx.beginPath()
        for (const node of members) {
          hexPath(
            ctx,
            node.x * scale + tx,
            node.y * scale + ty,
            Math.max(MIN_SCREEN_RADIUS, node.radius * scale),
          )
        }
        ctx.fill()
      }
      ctx.globalAlpha = 1

      // 3. Hubs and the larger satellites, shaded individually.
      detailed.sort((a, b) => a.radius - b.radius)
      for (const node of detailed) {
        const sx = node.x * scale + tx
        const sy = node.y * scale + ty
        // Hovering a dust-sized staker still has to produce something you can see.
        const floor = node.id === focus?.id ? 6 : MIN_SCREEN_RADIUS
        const r = Math.max(floor, node.radius * scale)
        const isSelected = selected?.id === node.id
        const isHovered = hovered?.id === node.id
        const isMatch = matches?.has(node.id) ?? false
        const lit = !dimming || emphasised(node)

        ctx.globalAlpha = lit ? 1 : 0.2

        if (isSelected || isHovered || isMatch || (node.isImpact && current.highlightImpact)) {
          ctx.shadowColor = node.color
          ctx.shadowBlur = node.isImpact ? 26 : 18
        } else if (node.isImpact && node.kind === "validator") {
          ctx.shadowColor = node.color
          ctx.shadowBlur = 14
        }

        const gradient = ctx.createLinearGradient(sx, sy - r, sx, sy + r)
        gradient.addColorStop(0, node.color)
        gradient.addColorStop(0.62, `${node.color}cc`)
        gradient.addColorStop(1, "#0b0f16")
        drawHexagon(ctx, sx, sy, r)
        ctx.fillStyle = gradient
        ctx.fill()
        ctx.shadowBlur = 0

        ctx.lineWidth = isSelected ? 2.6 : isHovered ? 2 : 1.2
        ctx.strokeStyle = isSelected ? "#ffffff" : isHovered ? "#fafafa" : node.color
        ctx.stroke()

        // Bevel along the top edges — the gem read from the prototype.
        if (r > 16) {
          ctx.beginPath()
          for (let i = 0; i < 4; i++) {
            const angle = -Math.PI / 6 + (i * Math.PI) / 3
            const px = sx + r * 0.84 * Math.cos(angle)
            const py = sy + r * 0.84 * Math.sin(angle)
            if (i === 0) ctx.moveTo(px, py)
            else ctx.lineTo(px, py)
          }
          ctx.strokeStyle = "rgba(255, 255, 255, 0.3)"
          ctx.lineWidth = Math.max(1, r * 0.06)
          ctx.stroke()
        }

        // Validators wear a concentric ring; ImpactZero gets a second, pinned one.
        if (node.kind === "validator" && r > 6) {
          drawHexagon(ctx, sx, sy, r + 4)
          ctx.strokeStyle = `${node.color}88`
          ctx.lineWidth = 1.4
          ctx.stroke()
        }
        if (node.kind === "validator" && node.isImpact) {
          drawHexagon(ctx, sx, sy, Math.max(r + 9, 13))
          ctx.strokeStyle = node.color
          ctx.lineWidth = 1.6
          ctx.setLineDash([5, 4])
          ctx.stroke()
          ctx.setLineDash([])
        }

        if (isSelected || isMatch) {
          const offset = Math.sin(pulse * 3) * 2.5
          drawHexagon(ctx, sx, sy, r + 8 + offset)
          ctx.strokeStyle = isSelected ? "#ffffff" : "#fafafa"
          ctx.lineWidth = 1.5
          ctx.setLineDash([6, 5])
          ctx.stroke()
          ctx.setLineDash([])
        }

        ctx.globalAlpha = 1
      }

      // 4. Labels — validators only, and only where they fit.
      if (current.showLabels) {
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        for (const node of detailed) {
          if (node.kind !== "validator" && node.id !== focus?.id) continue
          const isFocus = node.id === focus?.id
          const r = Math.max(isFocus ? 6 : MIN_SCREEN_RADIUS, node.radius * scale)
          // ImpactZero is always named; everything else has to earn the room.
          if (!isFocus && !node.isImpact && r < 11) continue
          if (dimming && !emphasised(node)) continue

          const sx = node.x * scale + tx
          const sy = node.y * scale + ty
          const fontSize = Math.max(10, Math.min(14, r * 0.4))
          ctx.font = `600 ${fontSize}px ${LABEL_FONT}`
          const text = node.label
          const textWidth = ctx.measureText(text).width
          // A label centred on a speck would hide the pin around it, so drop it below.
          const labelY = r < 10 ? sy + Math.max(r + 9, 13) + fontSize : sy

          ctx.fillStyle = "rgba(9, 9, 11, 0.82)"
          ctx.fillRect(sx - textWidth / 2 - 4, labelY - fontSize / 2 - 2, textWidth + 8, fontSize + 4)
          ctx.fillStyle = "#fafafa"
          ctx.fillText(text, sx, labelY)

          if (r > 24 || isFocus) {
            ctx.font = `500 ${Math.max(9, fontSize * 0.78)}px ${MONO_FONT}`
            ctx.fillStyle = "#a1a1aa"
            ctx.fillText(formatNim(node.balance), sx, labelY + fontSize * 1.2)
          }
        }
      }
    }

    // --- loop --------------------------------------------------------------

    let frame = 0
    let lastSignature = ""
    let lastMatches: Set<string> | null = null
    let lastRunning = true
    // Readers who asked for less motion get the settled map, not the settling of it.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

    const loop = () => {
      const current = viewRef.current
      // Cheap signature of everything a frame depends on beyond the simulation.
      const signature = `${current.minStakerBalance}|${current.showLabels}|${current.highlightImpact}|${current.selectedId}|${current.hoveredId}|${current.highlightClusterId}`
      if (signature !== lastSignature || current.matchIds !== lastMatches) {
        lastSignature = signature
        lastMatches = current.matchIds
        dirty = true
      }

      const running = !simulation.settled
      if (running) {
        simulation.tick(reduceMotion ? 8 : 1)
        if (cameraFollows) fitToContent()
      }

      const animating = !reduceMotion && (current.selectedId !== null || current.matchIds !== null)
      if (animating) pulse += 0.05

      // Under reduced motion the layout still runs, but nothing is painted until it
      // stops — the reader gets the settled map rather than the settling of it. The
      // pending `dirty` flag then paints it on the first frame after it comes to rest.
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
      focusNode: (id: string) => {
        const node = byId.get(id)
        if (!node) return
        cameraFollows = false
        const scale = Math.max(transform.scale, node.kind === "validator" ? 1 : 1.6)
        transform.scale = Math.min(MAX_SCALE, scale)
        transform.x = container.clientWidth / 2 - node.x * transform.scale
        transform.y = container.clientHeight / 2 - node.y * transform.scale
        dirty = true
      },
      reheat: () => simulation.reheat(0.6),
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
      canvas.removeEventListener("touchstart", handleTouchStart)
      canvas.removeEventListener("touchmove", handleTouchMove)
      canvas.removeEventListener("touchend", handleTouchEnd)
    }
    // The simulation owns the node objects, so it is rebuilt only for a new model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model])

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      {/* pan-y keeps a vertical swipe scrolling the page — the canvas only claims
          horizontal drags and pinches, so the map never traps a phone reader. */}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Force-directed map of ${model.nodes.length} nodes: every Nimiq validator and the addresses delegating to it. The validator list beside the map carries the same figures as text.`}
        className="block h-full w-full select-none"
        style={{ cursor: "grab", touchAction: "pan-y" }}
      />
    </div>
  )
}
