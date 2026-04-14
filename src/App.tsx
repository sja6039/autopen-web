import React, { useMemo, useState, useEffect, useRef } from "react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import type { Drawing } from "@/components/DrawingPad";
import { DrawingPad, drawingToSvg } from "@/components/DrawingPad";
import {
  connect,
  disconnect,
  getStatus,
  sendSvgBatch,
  getConnectedIp,
  type PiStatus,
} from "@/services/piConnectionService";

type RecipientEntry = {
  name: Drawing | null;
  specialMessage: Drawing | null;
};

const MAX_CARDS = 50;
// 100 internal units = 1 inch → SVG outputs at exactly 5.5 × 4.3 in
const CARD_WIDTH = 550;
const CARD_HEIGHT = 430;
const CARD_MARGIN_X = CARD_WIDTH * 0.08;
const CARD_MARGIN_Y = CARD_HEIGHT * 0.08;
const CARD_INNER_W = CARD_WIDTH - CARD_MARGIN_X * 2;
const NAME_TOP = CARD_MARGIN_Y;
// NAME_H and SPECIAL_H are sized so their canvas→card scale matches the
// main message: 220px canvas / NAME_H ≈ 300px canvas / MESSAGE_H
const NAME_H = CARD_HEIGHT * 0.2345; // ≈ 101 units
const SPECIAL_TOP = NAME_TOP + NAME_H + CARD_HEIGHT * 0.02;
const SPECIAL_H = CARD_HEIGHT * 0.2345;
const MESSAGE_TOP = SPECIAL_TOP + SPECIAL_H + CARD_HEIGHT * 0.02;
const MESSAGE_H = CARD_HEIGHT * 0.32;

// Render each drawing section at DRAW_SCALE× its logical slot size so that
// handwriting appears larger on the final card.  The outer card SVG clips any
// overflow at the card boundary.  Centered sections stay centered; the name
// section (top-left) expands rightward from the left margin.
const DRAW_SCALE = 1.5;

function createCardSvg(
  baseMessage: Drawing | null,
  recipient: RecipientEntry,
  index: number,
): string {
  const placeSection = (
    drawing: Drawing | null,
    ox: number,
    oy: number,
    w: number,
    h: number,
    _maskId: string,
    par: string,
  ) => {
    const result = drawingToSvg(drawing);
    if (!result) return "";
    const { groups, width: cw, height: ch } = result;
    const viewBox = `0 0 ${cw} ${ch}`;
    const paths = groups.map(
      (g) =>
        `<path d="${g.path}" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`,
    );
    return `<svg x="${ox}" y="${oy}" width="${w}" height="${h}" viewBox="${viewBox}" preserveAspectRatio="${par}" overflow="visible">${paths.join("")}</svg>`;
  };

  // Scale each section up by DRAW_SCALE.
  // Centered sections (xMidYMid): shift x and y so the section center is
  // preserved — the scaled box extends equally in all directions.
  // Name section (xMinYMin): expand rightward/downward from the left margin.
  const scaledW = CARD_INNER_W * DRAW_SCALE;
  const scaledNH = NAME_H * DRAW_SCALE;
  const scaledSH = SPECIAL_H * DRAW_SCALE;
  const scaledMH = MESSAGE_H * DRAW_SCALE;
  // Horizontal offset that keeps the center of a scaled section at card center
  const cxOff = CARD_MARGIN_X - (CARD_INNER_W * (DRAW_SCALE - 1)) / 2;

  const parts: string[] = [];
  parts.push(
    placeSection(
      recipient.name,
      CARD_MARGIN_X,
      NAME_TOP,
      scaledW,
      scaledNH,
      `nm${index}`,
      "xMinYMin meet",
    ),
  );
  parts.push(
    placeSection(
      recipient.specialMessage,
      cxOff,
      SPECIAL_TOP - (SPECIAL_H * (DRAW_SCALE - 1)) / 2,
      scaledW,
      scaledSH,
      `sm${index}`,
      "xMidYMid meet",
    ),
  );
  parts.push(
    placeSection(
      baseMessage,
      cxOff,
      MESSAGE_TOP - (MESSAGE_H * (DRAW_SCALE - 1)) / 2,
      scaledW,
      scaledMH,
      `bm${index}`,
      "xMidYMid meet",
    ),
  );

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="5.5in" height="4.3in" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" data-card-index="${index}">`,
    `<rect width="100%" height="100%" fill="white" />`,
    ...parts,
    `</svg>`,
  ].join("");
}

// ─── Progress bar ────────────────────────────────────────────────────────────

const STEP_LABELS = ["Count", "Message", "Names", "Export", "Print"];

function StepProgress({ current }: { current: number }) {
  return (
    <div className="flex items-center w-full mb-8 px-1">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const done = current > n;
        const active = current === n;
        return (
          <React.Fragment key={n}>
            <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
              <div
                className={[
                  "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300",
                  done
                    ? "bg-violet-600 text-white"
                    : active
                      ? "bg-violet-600 text-white shadow-lg shadow-violet-200 ring-4 ring-violet-100"
                      : "bg-stone-100 text-stone-400",
                ].join(" ")}
              >
                {done ? (
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  n
                )}
              </div>
              <span
                className={[
                  "text-xs font-medium whitespace-nowrap",
                  current >= n ? "text-violet-600" : "text-stone-400",
                ].join(" ")}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={[
                  "flex-1 h-0.5 mx-2 mb-5 rounded-full transition-all duration-500",
                  current > n ? "bg-violet-600" : "bg-stone-200",
                ].join(" ")}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Section label ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-2">
      {children}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  useEffect(() => {
    // Block every browser/iOS default action triggered by the Apple Pencil.
    // We run in the CAPTURE phase so this fires before any element handler —
    // nothing on the page ever gets a chance to open the share/copy popup.
    const blockPen = (e: PointerEvent) => {
      if (e.pointerType === "pen") e.preventDefault();
    };

    // contextmenu and selectstart must also be blocked in capture so they
    // cannot be re-enabled by child elements.
    const blockAlways = (e: Event) => e.preventDefault();

    const opts = { passive: false, capture: true } as const;

    document.addEventListener("pointerdown", blockPen, opts);
    document.addEventListener("pointermove", blockPen, opts);
    document.addEventListener("pointerup", blockPen, opts);
    document.addEventListener("contextmenu", blockAlways, opts);
    document.addEventListener("selectstart", blockAlways, opts);

    return () => {
      document.removeEventListener("pointerdown", blockPen, opts);
      document.removeEventListener("pointermove", blockPen, opts);
      document.removeEventListener("pointerup", blockPen, opts);
      document.removeEventListener("contextmenu", blockAlways, opts);
      document.removeEventListener("selectstart", blockAlways, opts);
    };
  }, []);

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [cardCount, setCardCount] = useState(4);
  const [baseMessage, setBaseMessage] = useState<Drawing | null>(null);
  const [recipients, setRecipients] = useState<RecipientEntry[]>(
    () =>
      Array.from({ length: MAX_CARDS }, () => ({
        name: null,
        specialMessage: null,
      })) as RecipientEntry[],
  );
  const [activeRecipientIndex, setActiveRecipientIndex] = useState(0);

  // ── Pi printer state ──────────────────────────────────────────────────────
  const [piCode, setPiCode] = useState("");
  const [piConnectState, setPiConnectState] = useState<
    "idle" | "connecting" | "connected" | "error"
  >("idle");
  const [piConnectError, setPiConnectError] = useState("");
  const [piSendState, setPiSendState] = useState<
    "idle" | "sending" | "done" | "error"
  >("idle");
  const [piSendProgress, setPiSendProgress] = useState({ sent: 0, total: 0 });
  const [piSendError, setPiSendError] = useState("");
  const [piStatus, setPiStatus] = useState<PiStatus | null>(null);
  const piPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll Pi status while connected
  useEffect(() => {
    if (piConnectState === "connected") {
      const poll = async () => {
        try {
          const s = await getStatus();
          setPiStatus(s);
        } catch {
          /* ignore transient errors */
        }
      };
      poll();
      piPollRef.current = setInterval(poll, 3_000);
    } else {
      if (piPollRef.current) {
        clearInterval(piPollRef.current);
        piPollRef.current = null;
      }
      setPiStatus(null);
    }
    return () => {
      if (piPollRef.current) clearInterval(piPollRef.current);
    };
  }, [piConnectState]);

  const visibleRecipients = useMemo(
    () => recipients.slice(0, cardCount),
    [recipients, cardCount],
  );

  const handleDownloadSvg = (i: number) => {
    const svg = createCardSvg(baseMessage, visibleRecipients[i], i);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `card-${i + 1}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleShareAll = async () => {
    const nav = typeof navigator !== "undefined" ? (navigator as any) : null;
    const supportsFiles =
      nav &&
      typeof nav.share === "function" &&
      typeof nav.canShare === "function";

    if (!supportsFiles) {
      alert(
        "Sharing files is not supported in this browser. Download the ZIP and attach it to an email manually.",
      );
      return;
    }

    const files: File[] = [];
    visibleRecipients.forEach((recipient, i) => {
      const svg = createCardSvg(baseMessage, recipient, i);
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      files.push(new File([blob], `card-${i + 1}.svg`, { type: blob.type }));
    });

    if (nav.canShare({ files })) {
      try {
        await nav.share({
          files,
          title: "Greeting cards",
          text: "SVG cards from Autopen.",
        });
      } catch (err) {
        console.error(err);
      }
    } else {
      alert('This device cannot share SVG files. Use "Download ZIP" instead.');
    }
  };

  const handleDownloadZip = async () => {
    const zip = new JSZip();
    visibleRecipients.forEach((recipient, i) => {
      const svg = createCardSvg(baseMessage, recipient, i);
      zip.file(`card-${i + 1}.svg`, svg, { binary: false });
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "greeting-cards.zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePiConnect = async () => {
    if (piCode.length !== 6) return;
    setPiConnectState("connecting");
    setPiConnectError("");
    setPiSendState("idle");
    setPiSendError("");
    try {
      await connect(piCode);
      setPiConnectState("connected");
    } catch (err: any) {
      setPiConnectState("error");
      setPiConnectError(err.message ?? "Could not reach the printer");
    }
  };

  const handlePiDisconnect = () => {
    disconnect();
    setPiConnectState("idle");
    setPiConnectError("");
    setPiCode("");
    setPiSendState("idle");
    setPiSendProgress({ sent: 0, total: 0 });
    setPiSendError("");
  };

  const handlePiSendAll = async () => {
    setPiSendState("sending");
    setPiSendError("");
    setPiSendProgress({ sent: 0, total: visibleRecipients.length });
    const now = new Date();
    const ts =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0") +
      "_" +
      String(now.getHours()).padStart(2, "0") +
      String(now.getMinutes()).padStart(2, "0") +
      String(now.getSeconds()).padStart(2, "0");
    const cards = visibleRecipients.map((recipient, i) => ({
      filename: `card_${ts}_${String(i + 1).padStart(2, "0")}.svg`,
      svgString: createCardSvg(baseMessage, recipient, i),
    }));
    try {
      await sendSvgBatch(cards, (sent, total) => {
        setPiSendProgress({ sent, total });
      });
      setPiSendState("done");
    } catch (err: any) {
      setPiSendState("error");
      setPiSendError(err.message ?? "Send failed");
    } finally {
      disconnect();
      setPiConnectState("idle");
      setPiCode("");
    }
  };

  const currentRecipient = visibleRecipients[activeRecipientIndex];

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="bg-white border-b border-stone-100 shadow-sm sticky top-0 z-10">
        <div className="mx-auto max-w-2xl px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-violet-600 flex items-center justify-center shadow-sm shadow-violet-200">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold text-stone-900 leading-none">
                Autopen
              </h1>
              <p className="text-[11px] text-stone-400 mt-0.5">
                iPad + Apple Pencil
              </p>
            </div>
          </div>
          <div className="text-xs font-semibold text-stone-400 bg-stone-100 px-3 py-1.5 rounded-full">
            Step {step} of 5
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-2xl px-5 py-7">
        <StepProgress current={step} />

        {/* ── Step 1: Count ── */}
        {step === 1 && (
          <div className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden">
            <div className="px-6 pt-6 pb-4 border-b border-stone-50">
              <h2 className="text-lg font-semibold text-stone-900">
                How many cards?
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                Up to 50 recipients. Drag the slider or tap a preset.
              </p>
            </div>

            <div className="px-6 pt-8 pb-4">
              {/* Big number display */}
              <div className="flex flex-col items-center mb-8">
                <div className="relative flex items-end justify-center gap-2">
                  <span className="text-8xl font-black text-stone-900 tabular-nums leading-none tracking-tight">
                    {cardCount}
                  </span>
                  <span className="text-xl font-semibold text-stone-400 mb-3">
                    {cardCount === 1 ? "card" : "cards"}
                  </span>
                </div>
              </div>

              {/* Slider */}
              <div className="mb-8">
                <style>{`
                  .card-slider {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 100%;
                    height: 6px;
                    border-radius: 9999px;
                    background: linear-gradient(
                      to right,
                      #7c3aed 0%,
                      #7c3aed ${((cardCount - 1) / 49) * 100}%,
                      #e7e5e4 ${((cardCount - 1) / 49) * 100}%,
                      #e7e5e4 100%
                    );
                    outline: none;
                    cursor: pointer;
                  }
                  .card-slider::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 28px;
                    height: 28px;
                    border-radius: 9999px;
                    background: #7c3aed;
                    box-shadow: 0 2px 8px rgba(124,58,237,0.4);
                    cursor: pointer;
                  }
                  .card-slider::-moz-range-thumb {
                    width: 28px;
                    height: 28px;
                    border-radius: 9999px;
                    background: #7c3aed;
                    border: none;
                    box-shadow: 0 2px 8px rgba(124,58,237,0.4);
                    cursor: pointer;
                  }
                `}</style>
                <input
                  type="range"
                  min={1}
                  max={50}
                  value={cardCount}
                  onChange={(e) => setCardCount(Number(e.target.value))}
                  className="card-slider"
                />
                <div className="flex justify-between mt-1.5 text-xs text-stone-400 font-medium">
                  <span>1</span>
                  <span>25</span>
                  <span>50</span>
                </div>
              </div>

              {/* Preset quick-picks */}
              <div className="mb-6">
                <p className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-3">
                  Quick pick
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {[5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((n) => (
                    <button
                      key={n}
                      onClick={() => setCardCount(n)}
                      className={[
                        "h-11 rounded-xl text-sm font-semibold transition-all active:scale-95",
                        cardCount === n
                          ? "bg-violet-600 text-white shadow-sm shadow-violet-200"
                          : "bg-stone-100 text-stone-500 hover:bg-violet-50 hover:text-violet-600",
                      ].join(" ")}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fine-tune stepper */}
              <div className="flex items-center justify-center gap-4">
                <button
                  onClick={() => setCardCount((c) => Math.max(1, c - 1))}
                  className="w-11 h-11 rounded-xl border-2 border-stone-200 flex items-center justify-center text-xl text-stone-500 hover:border-violet-400 hover:text-violet-600 hover:bg-violet-50 transition-all active:scale-95"
                >
                  −
                </button>
                <span className="text-xs font-semibold text-stone-400 uppercase tracking-widest">
                  fine tune
                </span>
                <button
                  onClick={() =>
                    setCardCount((c) => Math.min(MAX_CARDS, c + 1))
                  }
                  className="w-11 h-11 rounded-xl border-2 border-stone-200 flex items-center justify-center text-xl text-stone-500 hover:border-violet-400 hover:text-violet-600 hover:bg-violet-50 transition-all active:scale-95"
                >
                  +
                </button>
              </div>
            </div>

            <div className="px-6 pb-6 flex justify-end">
              <Button size="lg" onClick={() => setStep(2)}>
                Next: Write message →
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 2: Base message ── */}
        {step === 2 && (
          <div className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden">
            <div className="px-6 pt-6 pb-4 border-b border-stone-50">
              <h2 className="text-lg font-semibold text-stone-900">
                Write your message
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                This message will appear on all{" "}
                <span className="font-semibold text-violet-600">
                  {cardCount}
                </span>{" "}
                cards. Draw with your Apple Pencil.
              </p>
            </div>

            <div className="px-6 pt-5 pb-2">
              <SectionLabel>Main message</SectionLabel>
            </div>
            <div className="pb-5">
              <DrawingPad
                value={baseMessage}
                onChange={setBaseMessage}
                height={300}
              />
            </div>

            <div className="px-6 pb-6 flex justify-between items-center">
              <Button variant="outline" onClick={() => setStep(1)}>
                ← Back
              </Button>
              <Button
                size="lg"
                onClick={() => setStep(3)}
                disabled={!baseMessage}
              >
                Next: Recipient names →
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3: Recipients ── */}
        {step === 3 && (
          <div className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden">
            {/* Header with recipient progress */}
            <div className="px-6 pt-6 pb-4 border-b border-stone-50">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-stone-900">
                  Recipient {activeRecipientIndex + 1}
                  <span className="text-stone-400 font-normal">
                    {" "}
                    of {cardCount}
                  </span>
                </h2>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={activeRecipientIndex === 0}
                    onClick={() =>
                      setActiveRecipientIndex((i) => Math.max(0, i - 1))
                    }
                  >
                    ← Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={activeRecipientIndex >= cardCount - 1}
                    onClick={() =>
                      setActiveRecipientIndex((i) =>
                        Math.min(cardCount - 1, i + 1),
                      )
                    }
                  >
                    Next →
                  </Button>
                </div>
              </div>

              {/* Dot progress */}
              <div className="flex gap-1.5 flex-wrap">
                {Array.from({ length: cardCount }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveRecipientIndex(i)}
                    className={[
                      "w-2.5 h-2.5 rounded-full transition-all",
                      i === activeRecipientIndex
                        ? "bg-violet-600 scale-125"
                        : recipients[i].name
                          ? "bg-violet-300"
                          : "bg-stone-200",
                    ].join(" ")}
                  />
                ))}
              </div>
            </div>

            {/* Name — padded, left-aligned on card */}
            <div className="px-6 pt-5 pb-5">
              <SectionLabel>Name</SectionLabel>
              <DrawingPad
                value={currentRecipient?.name ?? null}
                height={220}
                onChange={(drawing) => {
                  setRecipients((prev) => {
                    const next = [...prev];
                    next[activeRecipientIndex] = {
                      ...next[activeRecipientIndex],
                      name: drawing,
                    };
                    return next;
                  });
                }}
              />
            </div>

            {/* Special note — full-width canvas, centered on card */}
            <div className="border-t border-stone-50">
              <div className="px-6 pt-5 pb-2">
                <SectionLabel>
                  Special note{" "}
                  <span className="normal-case font-normal text-stone-300">
                    (optional)
                  </span>
                </SectionLabel>
              </div>
              <div className="pb-5">
                <DrawingPad
                  value={currentRecipient?.specialMessage ?? null}
                  height={220}
                  onChange={(drawing) => {
                    setRecipients((prev) => {
                      const next = [...prev];
                      next[activeRecipientIndex] = {
                        ...next[activeRecipientIndex],
                        specialMessage: drawing,
                      };
                      return next;
                    });
                  }}
                />
              </div>
            </div>

            <div className="px-6 pb-6 flex justify-between items-center">
              <Button variant="outline" onClick={() => setStep(2)}>
                ← Back
              </Button>
              <Button size="lg" onClick={() => setStep(4)}>
                Preview cards →
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 4: Preview & export ── */}
        {step === 4 && (
          <div>
            {/* Export bar */}
            <div className="bg-white rounded-2xl border border-stone-100 shadow-sm px-6 py-5 mb-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h2 className="text-lg font-semibold text-stone-900">
                    Preview & export
                  </h2>
                  <p className="mt-1 text-sm text-stone-500">
                    {cardCount} card{cardCount !== 1 ? "s" : ""} ready. Download
                    or share before sending to the printer.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setStep(3)}>
                  ← Edit
                </Button>
              </div>

              <div className="flex flex-wrap gap-3 mt-5">
                <Button size="lg" onClick={handleDownloadZip}>
                  <svg
                    className="w-4 h-4 mr-2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  Download ZIP
                </Button>
                <Button variant="outline" size="lg" onClick={handleShareAll}>
                  <svg
                    className="w-4 h-4 mr-2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                    />
                  </svg>
                  Share / Email
                </Button>
                <Button size="lg" onClick={() => setStep(5)}>
                  <svg
                    className="w-4 h-4 mr-2"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2v-4M9 21H5a2 2 0 01-2-2v-4m0 0h18"
                    />
                  </svg>
                  Send to Printer →
                </Button>
              </div>
            </div>

            {/* Card grid */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              {visibleRecipients.map((recipient, i) => {
                const svgName = drawingToSvg(recipient.name);
                const svgMessage = drawingToSvg(baseMessage);
                const svgSpecial = drawingToSvg(recipient.specialMessage);

                return (
                  <div
                    key={i}
                    className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden"
                  >
                    <div className="px-4 py-3 flex items-center justify-between border-b border-stone-50">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg bg-violet-100 flex items-center justify-center text-xs font-bold text-violet-600">
                          {i + 1}
                        </div>
                        <span className="text-sm font-medium text-stone-600">
                          {recipient.name ? "Card" : "Blank card"}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleDownloadSvg(i)}
                      >
                        SVG ↓
                      </Button>
                    </div>

                    <div className="p-3">
                      <div className="relative w-full overflow-hidden rounded-xl border border-stone-100 bg-stone-50">
                        <svg
                          viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`}
                          className="block h-44 w-full"
                        >
                          <rect width="100%" height="100%" fill="white" />
                          {svgName &&
                            (() => {
                              let ei = 0;
                              return (
                                <svg
                                  x={CARD_MARGIN_X}
                                  y={NAME_TOP}
                                  width={CARD_INNER_W * DRAW_SCALE}
                                  height={NAME_H * DRAW_SCALE}
                                  viewBox={`0 0 ${svgName.width} ${svgName.height}`}
                                  preserveAspectRatio="xMinYMin meet"
                                >
                                  {svgName.groups.some((g) => g.erasePath) && (
                                    <defs>
                                      {svgName.groups.map((g, gi) =>
                                        g.erasePath ? (
                                          <mask key={gi} id={`pnm${i}_${gi}`}>
                                            <rect
                                              x={0}
                                              y={0}
                                              width={svgName.width}
                                              height={svgName.height}
                                              fill="white"
                                            />
                                            <path
                                              d={g.erasePath}
                                              fill="none"
                                              stroke="black"
                                              strokeWidth={24}
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            />
                                          </mask>
                                        ) : null,
                                      )}
                                    </defs>
                                  )}
                                  {svgName.groups.map((g, gi) => (
                                    <path
                                      key={gi}
                                      d={g.path}
                                      fill="none"
                                      stroke="#1c1917"
                                      strokeWidth={2}
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      mask={
                                        g.erasePath
                                          ? `url(#pnm${i}_${ei++})`
                                          : undefined
                                      }
                                    />
                                  ))}
                                </svg>
                              );
                            })()}
                          {svgSpecial &&
                            (() => {
                              let ei = 0;
                              return (
                                <svg
                                  x={
                                    CARD_MARGIN_X -
                                    (CARD_INNER_W * (DRAW_SCALE - 1)) / 2
                                  }
                                  y={
                                    SPECIAL_TOP -
                                    (SPECIAL_H * (DRAW_SCALE - 1)) / 2
                                  }
                                  width={CARD_INNER_W * DRAW_SCALE}
                                  height={SPECIAL_H * DRAW_SCALE}
                                  viewBox={`0 0 ${svgSpecial.width} ${svgSpecial.height}`}
                                  preserveAspectRatio="xMidYMid meet"
                                >
                                  {svgSpecial.groups.some(
                                    (g) => g.erasePath,
                                  ) && (
                                    <defs>
                                      {svgSpecial.groups.map((g, gi) =>
                                        g.erasePath ? (
                                          <mask key={gi} id={`psm${i}_${gi}`}>
                                            <rect
                                              x={0}
                                              y={0}
                                              width={svgSpecial.width}
                                              height={svgSpecial.height}
                                              fill="white"
                                            />
                                            <path
                                              d={g.erasePath}
                                              fill="none"
                                              stroke="black"
                                              strokeWidth={24}
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            />
                                          </mask>
                                        ) : null,
                                      )}
                                    </defs>
                                  )}
                                  {svgSpecial.groups.map((g, gi) => (
                                    <path
                                      key={gi}
                                      d={g.path}
                                      fill="none"
                                      stroke="#1c1917"
                                      strokeWidth={2}
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      mask={
                                        g.erasePath
                                          ? `url(#psm${i}_${ei++})`
                                          : undefined
                                      }
                                    />
                                  ))}
                                </svg>
                              );
                            })()}
                          {svgMessage &&
                            (() => {
                              let ei = 0;
                              return (
                                <svg
                                  x={
                                    CARD_MARGIN_X -
                                    (CARD_INNER_W * (DRAW_SCALE - 1)) / 2
                                  }
                                  y={
                                    MESSAGE_TOP -
                                    (MESSAGE_H * (DRAW_SCALE - 1)) / 2
                                  }
                                  width={CARD_INNER_W * DRAW_SCALE}
                                  height={MESSAGE_H * DRAW_SCALE}
                                  viewBox={`0 0 ${svgMessage.width} ${svgMessage.height}`}
                                  preserveAspectRatio="xMidYMid meet"
                                >
                                  {svgMessage.groups.some(
                                    (g) => g.erasePath,
                                  ) && (
                                    <defs>
                                      {svgMessage.groups.map((g, gi) =>
                                        g.erasePath ? (
                                          <mask key={gi} id={`pbm${i}_${gi}`}>
                                            <rect
                                              x={0}
                                              y={0}
                                              width={svgMessage.width}
                                              height={svgMessage.height}
                                              fill="white"
                                            />
                                            <path
                                              d={g.erasePath}
                                              fill="none"
                                              stroke="black"
                                              strokeWidth={24}
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            />
                                          </mask>
                                        ) : null,
                                      )}
                                    </defs>
                                  )}
                                  {svgMessage.groups.map((g, gi) => (
                                    <path
                                      key={gi}
                                      d={g.path}
                                      fill="none"
                                      stroke="#1c1917"
                                      strokeWidth={2}
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      mask={
                                        g.erasePath
                                          ? `url(#pbm${i}_${ei++})`
                                          : undefined
                                      }
                                    />
                                  ))}
                                </svg>
                              );
                            })()}
                        </svg>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 5: Send to Printer ── */}
        {step === 5 && (
          <div className="space-y-4">
            {/* Connection panel */}
            <div className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden">
              <div className="px-6 pt-6 pb-4 border-b border-stone-50 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-stone-900">
                    Send to Printer
                  </h2>
                  <p className="mt-1 text-sm text-stone-500">
                    Enter the 6-character pairing code shown on your plotter's
                    screen.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setStep(4)}>
                  ← Back
                </Button>
              </div>

              <div className="px-6 py-5 space-y-5">
                {/* Code input + connect */}
                {piConnectState !== "connected" ? (
                  <div className="space-y-4">
                    <div>
                      <label className="text-xs font-bold uppercase tracking-widest text-stone-500 block mb-1.5">
                        Pairing code
                      </label>
                      <input
                        type="text"
                        inputMode="text"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        maxLength={6}
                        placeholder="a1B2c3"
                        value={piCode}
                        onChange={(e) =>
                          setPiCode(
                            e.target.value
                              .replace(/[^0-9a-zA-Z]/g, "")
                              .slice(0, 6),
                          )
                        }
                        className="w-full rounded-xl border-2 border-stone-200 bg-white px-4 py-3 text-center text-3xl font-mono tracking-[0.4em] text-stone-900 placeholder:text-stone-300 placeholder:tracking-[0.4em] focus:border-violet-400 focus:outline-none transition-colors"
                      />
                    </div>

                    {piSendState === "done" && (
                      <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
                        <svg
                          className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-emerald-700">
                            All {piSendProgress.total} cards sent
                          </p>
                          <p className="text-xs text-emerald-600 mt-0.5">
                            Enter a new code to connect again.
                          </p>
                        </div>
                      </div>
                    )}

                    {piSendState === "error" && (
                      <div className="flex items-start gap-2.5 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
                        <svg
                          className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <div>
                          <p className="text-sm font-semibold text-red-700">
                            Send failed — disconnected
                          </p>
                          <p className="text-xs text-red-600 mt-0.5">
                            {piSendError}
                          </p>
                        </div>
                      </div>
                    )}

                    {piConnectState === "error" && (
                      <div className="flex items-start gap-2.5 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
                        <svg
                          className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <p className="text-sm text-red-700">{piConnectError}</p>
                      </div>
                    )}

                    <button
                      onClick={handlePiConnect}
                      disabled={
                        piConnectState === "connecting" || piCode.length !== 6
                      }
                      className="w-full h-12 rounded-xl bg-violet-600 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-violet-700 transition-colors shadow-sm shadow-violet-200 disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98]"
                    >
                      {piConnectState === "connecting" ? (
                        <>
                          <svg
                            className="w-4 h-4 animate-spin"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8v8z"
                            />
                          </svg>
                          Connecting…
                        </>
                      ) : (
                        <>
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                            />
                          </svg>
                          Connect
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  /* Connected state */
                  <div className="space-y-4">
                    {/* Connection badge */}
                    <div className="flex items-center justify-between rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        <div>
                          <p className="text-sm font-semibold text-emerald-700">
                            Connected
                          </p>
                          <p className="text-xs text-emerald-600 font-mono">
                            {getConnectedIp()}:5000
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={handlePiDisconnect}
                        className="text-xs font-semibold text-stone-400 hover:text-red-500 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>

                    {/* Live status */}
                    {piStatus && (
                      <div className="rounded-xl border border-stone-100 bg-stone-50 px-4 py-3 space-y-1.5">
                        <p className="text-xs font-bold uppercase tracking-widest text-stone-400">
                          Printer status
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={[
                              "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold",
                              piStatus.status === "idle"
                                ? "bg-stone-100 text-stone-500"
                                : piStatus.status === "plotting"
                                  ? "bg-violet-100 text-violet-700"
                                  : "bg-amber-100 text-amber-700",
                            ].join(" ")}
                          >
                            {piStatus.status}
                          </span>
                          {piStatus.current_job && (
                            <span className="text-xs text-stone-500 font-mono truncate">
                              {piStatus.current_job}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-4 text-xs text-stone-500">
                          <span>
                            Queue:{" "}
                            <strong className="text-stone-700">
                              {piStatus.queue.length}
                            </strong>
                          </span>
                          <span>
                            Done:{" "}
                            <strong className="text-stone-700">
                              {piStatus.completed.length}
                            </strong>
                          </span>
                          <span>
                            Total received:{" "}
                            <strong className="text-stone-700">
                              {piStatus.total_received}
                            </strong>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Send panel — only shown once connected */}
            {piConnectState === "connected" && (
              <div className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden">
                <div className="px-6 pt-6 pb-4 border-b border-stone-50">
                  <h3 className="text-base font-semibold text-stone-900">
                    Send cards
                  </h3>
                  <p className="mt-1 text-sm text-stone-500">
                    {cardCount} card{cardCount !== 1 ? "s" : ""} will be sent
                    one by one to the printer queue.
                  </p>
                </div>

                <div className="px-6 py-5 space-y-4">
                  {/* Progress bar */}
                  {piSendState === "sending" && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-medium text-stone-500">
                        <span>
                          Sending card {piSendProgress.sent + 1} of{" "}
                          {piSendProgress.total}…
                        </span>
                        <span>
                          {Math.round(
                            (piSendProgress.sent / piSendProgress.total) * 100,
                          )}
                          %
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-stone-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-violet-600 transition-all duration-300"
                          style={{
                            width: `${(piSendProgress.sent / piSendProgress.total) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Done summary */}
                  {piSendState === "done" && (
                    <div className="flex items-start gap-2.5 rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3">
                      <svg
                        className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      <div>
                        <p className="text-sm font-semibold text-emerald-700">
                          All {piSendProgress.total} cards sent
                        </p>
                        <p className="text-xs text-emerald-600 mt-0.5">
                          The printer is processing the queue.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {piSendState === "error" && (
                    <div className="flex items-start gap-2.5 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
                      <svg
                        className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                      <div>
                        <p className="text-sm font-semibold text-red-700">
                          Send failed
                        </p>
                        <p className="text-xs text-red-600 mt-0.5">
                          {piSendError}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Send / Retry button */}
                  <button
                    onClick={handlePiSendAll}
                    disabled={piSendState === "sending"}
                    className="w-full h-12 rounded-xl bg-violet-600 text-white font-semibold text-sm flex items-center justify-center gap-2 hover:bg-violet-700 transition-colors shadow-sm shadow-violet-200 disabled:opacity-40 disabled:pointer-events-none active:scale-[0.98]"
                  >
                    {piSendState === "sending" ? (
                      <>
                        <svg
                          className="w-4 h-4 animate-spin"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8v8z"
                          />
                        </svg>
                        Sending…
                      </>
                    ) : piSendState === "done" ? (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                        Send again
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                          />
                        </svg>
                        Send {cardCount} card{cardCount !== 1 ? "s" : ""} to
                        printer
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
