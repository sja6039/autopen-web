import React, { useRef, useEffect, useState } from 'react'

type Point = { x: number; y: number }

export type Stroke = Point[]

export interface Drawing {
  strokes: Stroke[]
}

interface DrawingPadProps {
  value: Drawing | null
  onChange: (drawing: Drawing | null) => void
  className?: string
  height?: number
}

export function drawingToSvgPath(drawing: Drawing | null): string | null {
  if (!drawing || drawing.strokes.length === 0) return null
  const segments: string[] = []
  for (const stroke of drawing.strokes) {
    if (stroke.length === 0) continue
    const [first, ...rest] = stroke
    segments.push(`M ${first.x} ${first.y}`)
    for (const p of rest) segments.push(`L ${p.x} ${p.y}`)
  }
  return segments.join(' ')
}

export const DrawingPad: React.FC<DrawingPadProps> = ({
  value,
  onChange,
  className,
  height = 280,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // All mutable drawing state lives in refs so native event handlers
  // (which close over these refs once at mount) always see fresh values.
  const activePointerRef = useRef<number | null>(null)
  const currentStrokeRef = useRef<Stroke | null>(null)
  const strokesRef      = useRef<Stroke[]>(value?.strokes ?? [])

  // Keep onChange in a ref so the event-handler effect never needs to re-run
  // when the parent re-renders with a new callback reference.
  const onChangeRef = useRef(onChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])

  // A counter that tells React "please re-render and redraw the canvas now."
  const [tick, setTick] = useState(0)
  const bump = () => setTick((n) => n + 1)

  // ── Sync external value into refs ──────────────────────────────────────────
  useEffect(() => {
    strokesRef.current      = value?.strokes ?? []
    currentStrokeRef.current = null
    activePointerRef.current = null
    bump()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // ── Canvas redraw ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr  = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width  = rect.width  * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.strokeStyle = '#1c1917'
    ctx.lineWidth   = 2

    const paint = (stroke: Stroke) => {
      if (stroke.length < 2) return
      ctx.beginPath()
      ctx.moveTo(stroke[0].x * rect.width, stroke[0].y * rect.height)
      for (let i = 1; i < stroke.length; i++)
        ctx.lineTo(stroke[i].x * rect.width, stroke[i].y * rect.height)
      ctx.stroke()
    }

    strokesRef.current.forEach(paint)
    if (currentStrokeRef.current) paint(currentStrokeRef.current)
  }, [tick])

  // ── Native event listeners (registered once at mount) ──────────────────────
  //
  // IMPORTANT: React synthetic event handlers (onPointerDown etc.) are
  // registered as passive by default, which means e.preventDefault() is
  // silently ignored by Safari/WebKit. We MUST use native addEventListener
  // with { passive: false } so preventDefault() actually works and stops
  // Safari from showing its "Share…" popup on pen-down.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Helper: extract a normalised point from any PointerEvent
    const pt = (e: PointerEvent): Point | null => {
      const r = canvas.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    }

    // Save the in-progress stroke to the committed list and notify parent.
    const commit = () => {
      const stroke = currentStrokeRef.current
      currentStrokeRef.current = null
      if (stroke && stroke.length >= 2) {
        const next = [...strokesRef.current, stroke]
        strokesRef.current = next
        onChangeRef.current({ strokes: next })
      }
      setTick((n) => n + 1)
    }

    // ── pointerdown ─────────────────────────────────────────────────────────
    const onDown = (e: PointerEvent) => {
      // Only Apple Pencil ('pen') or mouse. Ignore finger touches — this
      // gives natural palm rejection.
      if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return

      // This preventDefault() MUST be reachable — it stops Safari from
      // interpreting pen-down as a long-press / "Share…" gesture.
      e.preventDefault()

      if (activePointerRef.current !== null) return // already drawing
      activePointerRef.current = e.pointerId

      // setPointerCapture keeps pointermove/pointerup bound to this canvas
      // even if the pencil drifts outside its bounds.
      canvas.setPointerCapture(e.pointerId)

      const p = pt(e)
      if (!p) return
      currentStrokeRef.current = [p]
      setTick((n) => n + 1)
    }

    // ── pointermove ─────────────────────────────────────────────────────────
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return
      e.preventDefault()

      // getCoalescedEvents() recovers intermediate points that the browser
      // batched together during fast strokes — critical for Chrome on iPad.
      const events: PointerEvent[] =
        typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]

      for (const ce of events) {
        const p = pt(ce)
        if (!p) continue
        currentStrokeRef.current = [...(currentStrokeRef.current ?? []), p]
      }
      setTick((n) => n + 1)
    }

    // ── pointerup ───────────────────────────────────────────────────────────
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return
      e.preventDefault()
      activePointerRef.current = null
      try { canvas.releasePointerCapture(e.pointerId) } catch { /* ok */ }
      commit()
    }

    // ── pointercancel ───────────────────────────────────────────────────────
    // Fires when iOS takes over the gesture (Control Centre swipe, etc.).
    // Save what we have rather than losing the stroke.
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return
      activePointerRef.current = null
      commit()
    }

    // ── pointerleave ────────────────────────────────────────────────────────
    // Safety net: if pointerup didn't fire (iOS quirk), pressure drops to 0
    // as the pencil truly lifts — commit the stroke then.
    const onLeave = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return
      if (e.pressure > 0) return // still touching, just moved outside
      activePointerRef.current = null
      commit()
    }

    // ── touchstart / touchmove ──────────────────────────────────────────────
    // Some WebKit versions still route pen input through touch events before
    // pointer events. Preventing default here is the last line of defence
    // against the Safari share popup and scroll hijacking.
    const blockTouch = (e: TouchEvent) => { e.preventDefault() }

    // ── contextmenu ─────────────────────────────────────────────────────────
    const blockContext = (e: Event) => { e.preventDefault() }

    // ALL listeners use { passive: false } — without this, preventDefault()
    // is silently ignored by WebKit for touch-related events.
    const opts: AddEventListenerOptions = { passive: false }

    canvas.addEventListener('pointerdown',   onDown,       opts)
    canvas.addEventListener('pointermove',   onMove,       opts)
    canvas.addEventListener('pointerup',     onUp,         opts)
    canvas.addEventListener('pointercancel', onCancel,     opts)
    canvas.addEventListener('pointerleave',  onLeave,      opts)
    canvas.addEventListener('touchstart',    blockTouch,   opts)
    canvas.addEventListener('touchmove',     blockTouch,   opts)
    canvas.addEventListener('contextmenu',   blockContext)

    return () => {
      canvas.removeEventListener('pointerdown',   onDown)
      canvas.removeEventListener('pointermove',   onMove)
      canvas.removeEventListener('pointerup',     onUp)
      canvas.removeEventListener('pointercancel', onCancel)
      canvas.removeEventListener('pointerleave',  onLeave)
      canvas.removeEventListener('touchstart',    blockTouch)
      canvas.removeEventListener('touchmove',     blockTouch)
      canvas.removeEventListener('contextmenu',   blockContext)
    }
  }, []) // Empty deps — all mutable state goes through refs, not closures

  // ── Clear ───────────────────────────────────────────────────────────────────
  const handleClear = () => {
    strokesRef.current      = []
    currentStrokeRef.current = null
    activePointerRef.current = null
    onChangeRef.current(null)
    bump()
  }

  const empty = strokesRef.current.length === 0 && !currentStrokeRef.current

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={className}>
      <div
        className="flex w-full rounded-2xl overflow-hidden border border-stone-200"
        style={{ touchAction: 'none' }}
      >
        {/* ── Canvas ── */}
        <div className="relative flex-1 bg-white">
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-2 opacity-20">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
                </svg>
                <span className="text-xs text-stone-400 font-medium">Draw here</span>
              </div>
            </div>
          )}

          {/* No React event props on canvas — all handled by native listeners above */}
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              width: '100%',
              height: `${height}px`,
              cursor: 'crosshair',
              touchAction: 'none',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}
          />
        </div>

      </div>

      <div className="mt-2 flex justify-between items-center px-1">
        <span className="text-xs text-stone-400">Apple Pencil · palm ignored</span>
        <button
          type="button"
          onClick={handleClear}
          disabled={empty}
          className="text-xs font-medium text-stone-400 hover:text-red-500 transition-colors px-2 py-1 rounded-lg hover:bg-red-50 disabled:opacity-30 disabled:pointer-events-none"
        >
          Clear
        </button>
      </div>
    </div>
  )
}
