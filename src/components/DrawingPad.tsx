/**
 * DrawingPad.tsx — Apple Pencil / mouse canvas drawing component.
 *
 * Overview
 * --------
 * Captures pointer events on an HTML <canvas>, converts them to normalised
 * point arrays (0–1 range), and emits a `Drawing` value via `onChange`.
 * Points are stored in canvas-normalised coordinates so the drawing scales
 * correctly when the canvas is resized or the SVG is placed at a different
 * size.
 *
 * Rendering
 * ---------
 * All strokes are painted using Catmull-Rom cubic bezier splines, which pass
 * through every recorded point — no pen position is approximated or smoothed
 * away. The same math is used for both the live canvas preview and the final
 * SVG export, so what you see is exactly what the plotter receives.
 *
 * Erasing
 * -------
 * Erase strokes are stored alongside draw strokes in the same array (marked
 * `erase: true`). On canvas they use `destination-out` compositing. For SVG
 * export, `drawingToSvg()` resolves erases geometrically — splitting draw
 * strokes wherever they intersect an erase region — so the output contains
 * only the lines that should actually be plotted, with no hidden paths or
 * mask elements.
 *
 * Event handling
 * --------------
 * All pointer/touch listeners are registered via native addEventListener with
 * `{ passive: false }` rather than React's synthetic events. This is required
 * because React attaches synthetic listeners as passive by default in WebKit,
 * which silently ignores e.preventDefault() and causes Safari to show its
 * "Share…" / long-press popup on Apple Pencil input.
 *
 * Palm rejection
 * --------------
 * Only `pointerType === "pen"` and `pointerType === "mouse"` events are
 * processed. Touch (finger) events are blocked entirely, giving natural palm
 * rejection with no configuration required.
 */
import React, { useRef, useEffect, useState } from "react";

/** Normalised 2-D point. x and y are in [0, 1] relative to the canvas size. */
type Point = { x: number; y: number };

/**
 * A single continuous stroke recorded from one pen-down → pen-up sequence.
 * `erase: true` marks strokes drawn with the eraser tool.
 */
export type Stroke = { points: Point[]; erase?: boolean };

/**
 * The full drawing state emitted by DrawingPad via `onChange`.
 * `canvasWidth` / `canvasHeight` record the pixel dimensions of the canvas at
 * the time the drawing was captured — needed to scale erase radii correctly
 * when converting to SVG coordinates.
 */
export interface Drawing {
  strokes: Stroke[];
  canvasWidth?: number;
  canvasHeight?: number;
}

/** Props accepted by the DrawingPad component. */
interface DrawingPadProps {
  /** Current drawing value (controlled). Pass null for an empty canvas. */
  value: Drawing | null;
  /** Called whenever a stroke is committed or the canvas is cleared. */
  onChange: (drawing: Drawing | null) => void;
  className?: string;
  /** Canvas display height in CSS pixels (default 280). */
  height?: number;
}

// Converts a point array to a smooth SVG path using Catmull-Rom cubic bezier splines.
// The curve passes through every original point, so no pen position is lost or rounded away.
// sx/sy are the x and y scale factors (canvas width and height in the target coordinate space).
function pointsToSvgPath(points: Point[], sx: number, sy: number): string {
  if (points.length === 0) return "";
  const px = (p: Point) => +(p.x * sx).toFixed(3);
  const py = (p: Point) => +(p.y * sy).toFixed(3);

  if (points.length === 1) {
    // Dot (tap/period/i-dot): a near-zero-length line renders as a circle with round linecap.
    return `M ${px(points[0])} ${py(points[0])} l 0.001 0`;
  }
  if (points.length === 2) {
    return `M ${px(points[0])} ${py(points[0])} L ${px(points[1])} ${py(points[1])}`;
  }

  const n = points.length;
  let d = `M ${px(points[0])} ${py(points[0])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, n - 1)];
    // Catmull-Rom → cubic bezier control points (alpha = 0.5 tension)
    const cp1x = +((p1.x + (p2.x - p0.x) / 6) * sx).toFixed(3);
    const cp1y = +((p1.y + (p2.y - p0.y) / 6) * sy).toFixed(3);
    const cp2x = +((p2.x - (p3.x - p1.x) / 6) * sx).toFixed(3);
    const cp2y = +((p2.y - (p3.y - p1.y) / 6) * sy).toFixed(3);
    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${px(p2)} ${py(p2)}`;
  }
  return d;
}

/**
 * Converts a Drawing to a single SVG path string using a 1×1 coordinate
 * space (i.e. scale factors of 1). Erase strokes are skipped — the result
 * does NOT apply erases geometrically. Use `drawingToSvg()` instead when
 * you need a plotter-ready output with erases resolved.
 */
export function drawingToSvgPath(drawing: Drawing | null): string | null {
  if (!drawing || drawing.strokes.length === 0) return null;
  const segments: string[] = [];
  for (const stroke of drawing.strokes) {
    if (stroke.erase) continue;
    const path = pointsToSvgPath(stroke.points, 1, 1);
    if (path) segments.push(path);
  }
  return segments.length > 0 ? segments.join(" ") : null;
}

/** One group of SVG path data. erasePath is always null in the current output
 *  (erases are resolved into the path itself) but the field is kept for
 *  forward compatibility with mask-based approaches. */
export type SvgGroup = { path: string; erasePath: string | null };

// ── Geometric erase helpers ────────────────────────────────────────────────────

/**
 * Returns the distance in pixels from point (px, py) to the line segment
 * from (ax, ay) to (bx, by). All values are in canvas pixel space.
 */
function distToSegmentPx(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function isPointErased(
  nx: number,
  ny: number,
  eraseStrokes: Stroke[],
  cw: number,
  ch: number,
  radiusPx: number,
): boolean {
  const ppx = nx * cw;
  const ppy = ny * ch;
  for (const { points } of eraseStrokes) {
    if (points.length === 0) continue;
    if (points.length === 1) {
      if (
        Math.hypot(ppx - points[0].x * cw, ppy - points[0].y * ch) <= radiusPx
      )
        return true;
      continue;
    }
    for (let i = 0; i < points.length - 1; i++) {
      if (
        distToSegmentPx(
          ppx,
          ppy,
          points[i].x * cw,
          points[i].y * ch,
          points[i + 1].x * cw,
          points[i + 1].y * ch,
        ) <= radiusPx
      )
        return true;
    }
  }
  return false;
}

// Removes erased portions from a single draw stroke by splitting it into
// sub-strokes wherever the pen passes through an erased region.
function applyErases(
  drawStroke: Stroke,
  eraseStrokes: Stroke[],
  cw: number,
  ch: number,
): Stroke[] {
  const ERASE_RADIUS_PX = 12; // half of the 24px erase lineWidth used on canvas
  const result: Stroke[] = [];
  let current: Point[] = [];
  for (const pt of drawStroke.points) {
    if (isPointErased(pt.x, pt.y, eraseStrokes, cw, ch, ERASE_RADIUS_PX)) {
      if (current.length > 0) {
        result.push({ points: current });
        current = [];
      }
    } else {
      current.push(pt);
    }
  }
  if (current.length > 0) result.push({ points: current });
  return result;
}

/** Converts a Drawing to SVG-ready data, resolving erases geometrically so the
 *  output contains only the lines that should actually be drawn — no masks, no
 *  hidden paths. Erased content is physically absent from the path data, which
 *  means gcode converters and other consumers see exactly what was intended. */
export function drawingToSvg(
  drawing: Drawing | null,
): { groups: SvgGroup[]; width: number; height: number } | null {
  if (!drawing || drawing.strokes.length === 0) return null;
  const w = drawing.canvasWidth ?? 1;
  const h = drawing.canvasHeight ?? 1;

  const finalStrokes: Stroke[] = [];
  let pendingDraws: Stroke[] = [];
  let pendingErases: Stroke[] = [];

  const flush = () => {
    if (pendingErases.length > 0) {
      for (const draw of pendingDraws)
        finalStrokes.push(...applyErases(draw, pendingErases, w, h));
    } else {
      finalStrokes.push(...pendingDraws);
    }
    pendingDraws = [];
    pendingErases = [];
  };

  for (const stroke of drawing.strokes) {
    if (stroke.erase) {
      pendingErases.push(stroke);
    } else {
      // Erase group is complete — apply it to the draws that preceded it.
      if (pendingErases.length > 0 && pendingDraws.length > 0) flush();
      pendingDraws.push(stroke);
    }
  }
  flush();

  const path = finalStrokes
    .map((s) => pointsToSvgPath(s.points, w, h))
    .filter(Boolean)
    .join(" ");

  if (!path) return null;

  return { groups: [{ path, erasePath: null }], width: w, height: h };
}

export const DrawingPad: React.FC<DrawingPadProps> = ({
  value,
  onChange,
  className,
  height = 280,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // All mutable drawing state lives in refs so native event handlers
  // (which close over these refs once at mount) always see fresh values.
  const activePointerRef = useRef<number | null>(null);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const strokesRef = useRef<Stroke[]>(value?.strokes ?? []);
  const isErasingRef = useRef(false);

  // Keep onChange in a ref so the event-handler effect never needs to re-run
  // when the parent re-renders with a new callback reference.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // A counter that tells React "please re-render and redraw the canvas now."
  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);

  // Eraser toggle (React state so the button re-renders)
  const [isErasing, setIsErasing] = useState(false);
  const toggleEraser = () => {
    const next = !isErasingRef.current;
    isErasingRef.current = next;
    setIsErasing(next);
  };

  // ── Sync external value into refs ──────────────────────────────────────────
  useEffect(() => {
    strokesRef.current = value?.strokes ?? [];
    currentStrokeRef.current = null;
    activePointerRef.current = null;
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // ── Canvas redraw ───────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const paint = (stroke: Stroke) => {
      const { points, erase } = stroke;
      if (points.length === 0) return;
      const lw = erase ? 24 : 2;
      ctx.save();
      if (erase) {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "#1c1917";
      }
      ctx.lineWidth = lw;

      if (points.length === 1) {
        // Single-point tap: render as a filled circle (dot)
        ctx.beginPath();
        ctx.arc(
          points[0].x * rect.width,
          points[0].y * rect.height,
          lw / 2,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = erase ? "rgba(0,0,0,1)" : "#1c1917";
        ctx.fill();
        ctx.restore();
        return;
      }

      // Catmull-Rom cubic bezier — passes through every recorded point
      const n = points.length;
      const W = rect.width;
      const H = rect.height;
      ctx.beginPath();
      ctx.moveTo(points[0].x * W, points[0].y * H);
      if (n === 2) {
        ctx.lineTo(points[1].x * W, points[1].y * H);
      } else {
        for (let i = 0; i < n - 1; i++) {
          const p0 = points[Math.max(i - 1, 0)];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[Math.min(i + 2, n - 1)];
          ctx.bezierCurveTo(
            (p1.x + (p2.x - p0.x) / 6) * W,
            (p1.y + (p2.y - p0.y) / 6) * H,
            (p2.x - (p3.x - p1.x) / 6) * W,
            (p2.y - (p3.y - p1.y) / 6) * H,
            p2.x * W,
            p2.y * H,
          );
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    strokesRef.current.forEach(paint);
    if (currentStrokeRef.current) paint(currentStrokeRef.current);
  }, [tick]);

  // ── Native event listeners (registered once at mount) ──────────────────────
  //
  // IMPORTANT: React synthetic event handlers (onPointerDown etc.) are
  // registered as passive by default, which means e.preventDefault() is
  // silently ignored by Safari/WebKit. We MUST use native addEventListener
  // with { passive: false } so preventDefault() actually works and stops
  // Safari from showing its "Share…" popup on pen-down.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Helper: extract a normalised point from any PointerEvent
    const pt = (e: PointerEvent): Point | null => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return {
        x: (e.clientX - r.left) / r.width,
        y: (e.clientY - r.top) / r.height,
      };
    };

    // Save the in-progress stroke to the committed list and notify parent.
    const commit = () => {
      const stroke = currentStrokeRef.current;
      currentStrokeRef.current = null;
      if (stroke && stroke.points.length >= 2) {
        const next = [...strokesRef.current, stroke];
        strokesRef.current = next;
        const r = canvas.getBoundingClientRect();
        onChangeRef.current({
          strokes: next,
          canvasWidth: r.width,
          canvasHeight: r.height,
        });
      }
      setTick((n) => n + 1);
    };

    // ── pointerdown ─────────────────────────────────────────────────────────
    const onDown = (e: PointerEvent) => {
      // Only Apple Pencil ('pen') or mouse. Ignore finger touches — this
      // gives natural palm rejection.
      if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;

      // This preventDefault() MUST be reachable — it stops Safari from
      // interpreting pen-down as a long-press / "Share…" gesture.
      e.preventDefault();

      if (activePointerRef.current !== null) return; // already drawing
      activePointerRef.current = e.pointerId;

      // setPointerCapture keeps pointermove/pointerup bound to this canvas
      // even if the pencil drifts outside its bounds.
      canvas.setPointerCapture(e.pointerId);

      const p = pt(e);
      if (!p) return;
      currentStrokeRef.current = { points: [p], erase: isErasingRef.current };
      setTick((n) => n + 1);
    };

    // ── pointermove ─────────────────────────────────────────────────────────
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      e.preventDefault();

      // getCoalescedEvents() recovers intermediate points that the browser
      // batched together during fast strokes — critical for Chrome on iPad.
      const events: PointerEvent[] =
        typeof e.getCoalescedEvents === "function"
          ? e.getCoalescedEvents()
          : [e];

      for (const ce of events) {
        const p = pt(ce);
        if (!p) continue;
        const cur = currentStrokeRef.current;
        if (cur)
          currentStrokeRef.current = { ...cur, points: [...cur.points, p] };
      }
      setTick((n) => n + 1);
    };

    // ── pointerup ───────────────────────────────────────────────────────────
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      e.preventDefault();
      activePointerRef.current = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ok */
      }
      commit();
    };

    // ── pointercancel ───────────────────────────────────────────────────────
    // Fires when iOS takes over the gesture (Control Centre swipe, etc.).
    // Save what we have rather than losing the stroke.
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      activePointerRef.current = null;
      commit();
    };

    // ── pointerleave ────────────────────────────────────────────────────────
    // Safety net: if pointerup didn't fire (iOS quirk), pressure drops to 0
    // as the pencil truly lifts — commit the stroke then.
    const onLeave = (e: PointerEvent) => {
      if (e.pointerId !== activePointerRef.current) return;
      if (e.pressure > 0) return; // still touching, just moved outside
      activePointerRef.current = null;
      commit();
    };

    // ── touchstart / touchmove ──────────────────────────────────────────────
    // Some WebKit versions still route pen input through touch events before
    // pointer events. Preventing default here is the last line of defence
    // against the Safari share popup and scroll hijacking.
    const blockTouch = (e: TouchEvent) => {
      e.preventDefault();
    };

    // ── contextmenu ─────────────────────────────────────────────────────────
    const blockContext = (e: Event) => {
      e.preventDefault();
    };

    // ALL listeners use { passive: false } — without this, preventDefault()
    // is silently ignored by WebKit for touch-related events.
    const opts: AddEventListenerOptions = { passive: false };

    canvas.addEventListener("pointerdown", onDown, opts);
    canvas.addEventListener("pointermove", onMove, opts);
    canvas.addEventListener("pointerup", onUp, opts);
    canvas.addEventListener("pointercancel", onCancel, opts);
    canvas.addEventListener("pointerleave", onLeave, opts);
    canvas.addEventListener("touchstart", blockTouch, opts);
    canvas.addEventListener("touchmove", blockTouch, opts);
    canvas.addEventListener("contextmenu", blockContext);

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("touchstart", blockTouch);
      canvas.removeEventListener("touchmove", blockTouch);
      canvas.removeEventListener("contextmenu", blockContext);
    };
  }, []); // Empty deps — all mutable state goes through refs, not closures

  // ── Clear ───────────────────────────────────────────────────────────────────
  const handleClear = () => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
    activePointerRef.current = null;
    onChangeRef.current(null);
    bump();
  };

  const empty = strokesRef.current.length === 0 && !currentStrokeRef.current;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={className}>
      <div
        className="flex w-full rounded-2xl overflow-hidden border border-stone-200"
        style={{ touchAction: "none" }}
      >
        {/* ── Canvas ── */}
        <div className="relative flex-1 bg-white">
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-2 opacity-20">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"
                  />
                </svg>
                <span className="text-xs text-stone-400 font-medium">
                  Draw here
                </span>
              </div>
            </div>
          )}

          {/* No React event props on canvas — all handled by native listeners above */}
          <canvas
            ref={canvasRef}
            style={{
              display: "block",
              width: "100%",
              height: `${height}px`,
              cursor: isErasing ? "cell" : "crosshair",
              touchAction: "none",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
          />
        </div>
      </div>

      <div className="mt-2 flex justify-between items-center px-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-stone-400">
            Apple Pencil · palm ignored
          </span>
          <button
            type="button"
            onClick={toggleEraser}
            className={`text-xs font-medium px-2 py-1 rounded-lg transition-colors ${
              isErasing
                ? "bg-stone-800 text-white"
                : "text-stone-400 hover:text-stone-700 hover:bg-stone-100"
            }`}
          >
            {isErasing ? "Erasing" : "Eraser"}
          </button>
        </div>
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
  );
};
