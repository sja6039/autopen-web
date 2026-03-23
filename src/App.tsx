import React, { useMemo, useState, useEffect } from 'react'
import JSZip from 'jszip'
import { Button } from '@/components/ui/button'
import type { Drawing } from '@/components/DrawingPad'
import { DrawingPad, drawingToSvgPath } from '@/components/DrawingPad'

type RecipientEntry = {
  name: Drawing | null
  specialMessage: Drawing | null
}

const MAX_CARDS = 50
const CARD_WIDTH = 1000
const CARD_HEIGHT = 700
const CARD_MARGIN_X = CARD_WIDTH * 0.08
const CARD_MARGIN_Y = CARD_HEIGHT * 0.08
const CARD_INNER_W = CARD_WIDTH - CARD_MARGIN_X * 2
const CARD_INNER_H = CARD_HEIGHT - CARD_MARGIN_Y * 2
const NAME_TOP = CARD_MARGIN_Y
const NAME_H = CARD_HEIGHT * 0.14
const SPECIAL_TOP = NAME_TOP + NAME_H + CARD_HEIGHT * 0.04
const SPECIAL_H = CARD_HEIGHT * 0.14
const MESSAGE_TOP = SPECIAL_TOP + SPECIAL_H + CARD_HEIGHT * 0.06
const MESSAGE_H = CARD_HEIGHT * 0.32

function createCardSvg(
  baseMessage: Drawing | null,
  recipient: RecipientEntry,
  index: number,
): string {
  const namePath = drawingToSvgPath(recipient.name)
  const specialPath = drawingToSvgPath(recipient.specialMessage)
  const messagePath = drawingToSvgPath(baseMessage)

  const scaleSection = (
    raw: string | null,
    ox: number,
    oy: number,
    w: number,
    h: number,
  ) => {
    if (!raw) return ''
    const strokeW = 1 / Math.max(w, h)
    return `<g transform="translate(${ox},${oy}) scale(${w},${h})"><path d="${raw}" fill="none" stroke="black" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" /></g>`
  }

  const parts: string[] = []
  parts.push(scaleSection(namePath, CARD_MARGIN_X, NAME_TOP, CARD_INNER_W, NAME_H))
  parts.push(scaleSection(specialPath, CARD_MARGIN_X, SPECIAL_TOP, CARD_INNER_W, SPECIAL_H))
  parts.push(scaleSection(messagePath, CARD_MARGIN_X, MESSAGE_TOP, CARD_INNER_W, MESSAGE_H))

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" data-card-index="${index}">`,
    `<rect width="100%" height="100%" fill="white" />`,
    ...parts,
    `</svg>`,
  ].join('')
}

// ─── Progress bar ────────────────────────────────────────────────────────────

const STEP_LABELS = ['Count', 'Message', 'Names', 'Export']

function StepProgress({ current }: { current: number }) {
  return (
    <div className="flex items-center w-full mb-8 px-1">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1
        const done = current > n
        const active = current === n
        return (
          <React.Fragment key={n}>
            <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
              <div
                className={[
                  'w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300',
                  done
                    ? 'bg-violet-600 text-white'
                    : active
                      ? 'bg-violet-600 text-white shadow-lg shadow-violet-200 ring-4 ring-violet-100'
                      : 'bg-stone-100 text-stone-400',
                ].join(' ')}
              >
                {done ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : n}
              </div>
              <span
                className={[
                  'text-xs font-medium whitespace-nowrap',
                  current >= n ? 'text-violet-600' : 'text-stone-400',
                ].join(' ')}
              >
                {label}
              </span>
            </div>
            {i < STEP_LABELS.length - 1 && (
              <div
                className={[
                  'flex-1 h-0.5 mx-2 mb-5 rounded-full transition-all duration-500',
                  current > n ? 'bg-violet-600' : 'bg-stone-200',
                ].join(' ')}
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

// ─── Section label ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-2">
      {children}
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  useEffect(() => {
    // Block every browser/iOS default action triggered by the Apple Pencil.
    // We run in the CAPTURE phase so this fires before any element handler —
    // nothing on the page ever gets a chance to open the share/copy popup.
    const blockPen = (e: PointerEvent) => {
      if (e.pointerType === 'pen') e.preventDefault()
    }

    // contextmenu and selectstart must also be blocked in capture so they
    // cannot be re-enabled by child elements.
    const blockAlways = (e: Event) => e.preventDefault()

    const opts = { passive: false, capture: true } as const

    document.addEventListener('pointerdown',  blockPen,    opts)
    document.addEventListener('pointermove',  blockPen,    opts)
    document.addEventListener('pointerup',    blockPen,    opts)
    document.addEventListener('contextmenu',  blockAlways, opts)
    document.addEventListener('selectstart',  blockAlways, opts)

    return () => {
      document.removeEventListener('pointerdown',  blockPen,    opts)
      document.removeEventListener('pointermove',  blockPen,    opts)
      document.removeEventListener('pointerup',    blockPen,    opts)
      document.removeEventListener('contextmenu',  blockAlways, opts)
      document.removeEventListener('selectstart',  blockAlways, opts)
    }
  }, [])

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [cardCount, setCardCount] = useState(4)
  const [baseMessage, setBaseMessage] = useState<Drawing | null>(null)
  const [recipients, setRecipients] = useState<RecipientEntry[]>(
    () =>
      Array.from({ length: MAX_CARDS }, () => ({
        name: null,
        specialMessage: null,
      })) as RecipientEntry[],
  )
  const [activeRecipientIndex, setActiveRecipientIndex] = useState(0)

  const visibleRecipients = useMemo(
    () => recipients.slice(0, cardCount),
    [recipients, cardCount],
  )

  const handleDownloadSvg = (i: number) => {
    const svg = createCardSvg(baseMessage, visibleRecipients[i], i)
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `card-${i + 1}.svg`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleShareAll = async () => {
    const nav = typeof navigator !== 'undefined' ? (navigator as any) : null
    const supportsFiles =
      nav && typeof nav.share === 'function' && typeof nav.canShare === 'function'

    if (!supportsFiles) {
      alert('Sharing files is not supported in this browser. Download the ZIP and attach it to an email manually.')
      return
    }

    const files: File[] = []
    visibleRecipients.forEach((recipient, i) => {
      const svg = createCardSvg(baseMessage, recipient, i)
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      files.push(new File([blob], `card-${i + 1}.svg`, { type: blob.type }))
    })

    if (nav.canShare({ files })) {
      try {
        await nav.share({ files, title: 'Greeting cards', text: 'SVG cards from Autopen.' })
      } catch (err) {
        console.error(err)
      }
    } else {
      alert('This device cannot share SVG files. Use "Download ZIP" instead.')
    }
  }

  const handleDownloadZip = async () => {
    const zip = new JSZip()
    visibleRecipients.forEach((recipient, i) => {
      const svg = createCardSvg(baseMessage, recipient, i)
      zip.file(`card-${i + 1}.svg`, svg, { binary: false })
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'greeting-cards.zip'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const currentRecipient = visibleRecipients[activeRecipientIndex]

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="bg-white border-b border-stone-100 shadow-sm sticky top-0 z-10">
        <div className="mx-auto max-w-2xl px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-violet-600 flex items-center justify-center shadow-sm shadow-violet-200">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-bold text-stone-900 leading-none">Autopen</h1>
              <p className="text-[11px] text-stone-400 mt-0.5">iPad + Apple Pencil</p>
            </div>
          </div>
          <div className="text-xs font-semibold text-stone-400 bg-stone-100 px-3 py-1.5 rounded-full">
            Step {step} of 4
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
              <h2 className="text-lg font-semibold text-stone-900">How many cards?</h2>
              <p className="mt-1 text-sm text-stone-500">Up to 50 recipients. Drag the slider or tap a preset.</p>
            </div>

            <div className="px-6 pt-8 pb-4">
              {/* Big number display */}
              <div className="flex flex-col items-center mb-8">
                <div className="relative flex items-end justify-center gap-2">
                  <span className="text-8xl font-black text-stone-900 tabular-nums leading-none tracking-tight">
                    {cardCount}
                  </span>
                  <span className="text-xl font-semibold text-stone-400 mb-3">
                    {cardCount === 1 ? 'card' : 'cards'}
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
                <p className="text-xs font-bold uppercase tracking-widest text-stone-400 mb-3">Quick pick</p>
                <div className="grid grid-cols-5 gap-2">
                  {[5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((n) => (
                    <button
                      key={n}
                      onClick={() => setCardCount(n)}
                      className={[
                        'h-11 rounded-xl text-sm font-semibold transition-all active:scale-95',
                        cardCount === n
                          ? 'bg-violet-600 text-white shadow-sm shadow-violet-200'
                          : 'bg-stone-100 text-stone-500 hover:bg-violet-50 hover:text-violet-600',
                      ].join(' ')}
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
                <span className="text-xs font-semibold text-stone-400 uppercase tracking-widest">fine tune</span>
                <button
                  onClick={() => setCardCount((c) => Math.min(MAX_CARDS, c + 1))}
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
              <h2 className="text-lg font-semibold text-stone-900">Write your message</h2>
              <p className="mt-1 text-sm text-stone-500">
                This message will appear on all{' '}
                <span className="font-semibold text-violet-600">{cardCount}</span> cards.
                Draw with your Apple Pencil.
              </p>
            </div>

            <div className="px-6 py-5">
              <SectionLabel>Main message</SectionLabel>
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
                  <span className="text-stone-400 font-normal"> of {cardCount}</span>
                </h2>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={activeRecipientIndex === 0}
                    onClick={() => setActiveRecipientIndex((i) => Math.max(0, i - 1))}
                  >
                    ← Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={activeRecipientIndex >= cardCount - 1}
                    onClick={() => setActiveRecipientIndex((i) => Math.min(cardCount - 1, i + 1))}
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
                      'w-2.5 h-2.5 rounded-full transition-all',
                      i === activeRecipientIndex
                        ? 'bg-violet-600 scale-125'
                        : recipients[i].name
                          ? 'bg-violet-300'
                          : 'bg-stone-200',
                    ].join(' ')}
                  />
                ))}
              </div>
            </div>

            <div className="px-6 py-5 space-y-6">
              <div>
                <SectionLabel>Name</SectionLabel>
                <DrawingPad
                  value={currentRecipient?.name ?? null}
                  height={220}
                  onChange={(drawing) => {
                    setRecipients((prev) => {
                      const next = [...prev]
                      next[activeRecipientIndex] = { ...next[activeRecipientIndex], name: drawing }
                      return next
                    })
                  }}
                />
              </div>

              <div>
                <SectionLabel>Special note <span className="normal-case font-normal text-stone-300">(optional)</span></SectionLabel>
                <DrawingPad
                  value={currentRecipient?.specialMessage ?? null}
                  height={220}
                  onChange={(drawing) => {
                    setRecipients((prev) => {
                      const next = [...prev]
                      next[activeRecipientIndex] = { ...next[activeRecipientIndex], specialMessage: drawing }
                      return next
                    })
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
                  <h2 className="text-lg font-semibold text-stone-900">Preview & export</h2>
                  <p className="mt-1 text-sm text-stone-500">
                    {cardCount} card{cardCount !== 1 ? 's' : ''} ready. Download or share as SVG files.
                  </p>
                </div>
                <Button variant="outline" onClick={() => setStep(3)}>
                  ← Edit
                </Button>
              </div>

              <div className="flex flex-wrap gap-3 mt-5">
                <Button size="lg" onClick={handleDownloadZip}>
                  <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download ZIP
                </Button>
                <Button variant="outline" size="lg" onClick={handleShareAll}>
                  <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                  </svg>
                  Share / Email
                </Button>
              </div>
            </div>

            {/* Card grid */}
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
              {visibleRecipients.map((recipient, i) => {
                const svgPathName = drawingToSvgPath(recipient.name)
                const svgPathMessage = drawingToSvgPath(baseMessage)
                const svgPathSpecial = drawingToSvgPath(recipient.specialMessage)

                return (
                  <div key={i} className="bg-white rounded-2xl border border-stone-100 shadow-sm overflow-hidden">
                    <div className="px-4 py-3 flex items-center justify-between border-b border-stone-50">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg bg-violet-100 flex items-center justify-center text-xs font-bold text-violet-600">
                          {i + 1}
                        </div>
                        <span className="text-sm font-medium text-stone-600">
                          {recipient.name ? 'Card' : 'Blank card'}
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
                        <svg viewBox={`0 0 ${CARD_WIDTH} ${CARD_HEIGHT}`} className="block h-44 w-full">
                          <rect width="100%" height="100%" fill="white" />
                          <rect
                            x={CARD_MARGIN_X} y={CARD_MARGIN_Y}
                            width={CARD_INNER_W} height={CARD_INNER_H}
                            fill="none" stroke="#e7e5e4" strokeWidth="6" strokeDasharray="20 14"
                          />
                          {svgPathName && (
                            <g transform={`translate(${CARD_MARGIN_X}, ${NAME_TOP}) scale(${CARD_INNER_W}, ${NAME_H})`}>
                              <path d={svgPathName} fill="none" stroke="#1c1917" strokeWidth={1 / Math.max(CARD_INNER_W, NAME_H)} strokeLinecap="round" strokeLinejoin="round" />
                            </g>
                          )}
                          {svgPathSpecial && (
                            <g transform={`translate(${CARD_MARGIN_X}, ${SPECIAL_TOP}) scale(${CARD_INNER_W}, ${SPECIAL_H})`}>
                              <path d={svgPathSpecial} fill="none" stroke="#1c1917" strokeWidth={1 / Math.max(CARD_INNER_W, SPECIAL_H)} strokeLinecap="round" strokeLinejoin="round" />
                            </g>
                          )}
                          {svgPathMessage && (
                            <g transform={`translate(${CARD_MARGIN_X}, ${MESSAGE_TOP}) scale(${CARD_INNER_W}, ${MESSAGE_H})`}>
                              <path d={svgPathMessage} fill="none" stroke="#1c1917" strokeWidth={1 / Math.max(CARD_INNER_W, MESSAGE_H)} strokeLinecap="round" strokeLinejoin="round" />
                            </g>
                          )}
                        </svg>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
