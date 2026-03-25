// Base-62 charset for pairing-code decoding
const CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const PORT = 5000

let _ip: string | null = null

// Decode a 6-char base-62 code → IPv4 string.
// Encoding scheme: IP (32 bits) left-shifted 4, with 4 random low bits appended.
// Decoding: convert to integer, right-shift 4 to drop the random nibble, interpret as IPv4.
function decodeIp(code: string): string {
  let n = 0
  for (const ch of code) {
    const idx = CHARSET.indexOf(ch)
    if (idx === -1) throw new Error(`Invalid character in pairing code: "${ch}"`)
    n = n * 62 + idx
  }
  // Drop random nibble (low 4 bits)
  n = n % (2 ** 32)
  // Extract IPv4 octets using unsigned right-shift
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
  const c = (n >>> 8) & 0xff
  const d = n & 0xff
  return `${a}.${b}.${c}.${d}`
}

function base(ip: string): string {
  return `http://${ip}:${PORT}`
}

function connectedBase(): string {
  if (!_ip) throw new Error('Not connected to a printer')
  return base(_ip)
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Decode the pairing code, ping the Pi's health endpoint, and store the IP. */
export async function connect(code: string): Promise<string> {
  const ip = decodeIp(code)
  const res = await fetch(`${base(ip)}/api/health`, {
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`Printer returned HTTP ${res.status}`)
  _ip = ip
  return ip
}

/** Ping the currently connected Pi. Returns true if reachable. */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${connectedBase()}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Clear the stored connection. */
export function disconnect(): void {
  _ip = null
}

/** Return the connected IP, or null if not connected. */
export function getConnectedIp(): string | null {
  return _ip
}

export interface PiStatus {
  status: string
  current_job: string | null
  queue: string[]
  completed: string[]
  total_received: number
}

/** Fetch live status from the printer. */
export async function getStatus(): Promise<PiStatus> {
  const res = await fetch(`${connectedBase()}/api/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`Status endpoint returned HTTP ${res.status}`)
  return res.json() as Promise<PiStatus>
}

/** POST a single SVG to the printer. */
export async function sendSvg(filename: string, svgString: string): Promise<void> {
  const res = await fetch(`${connectedBase()}/api/svg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/svg+xml',
      'X-Filename': filename,
    },
    body: svgString,
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Printer returned HTTP ${res.status}`)
  }
}

/** Send an array of SVGs one by one, calling onProgress after each. */
export async function sendSvgBatch(
  cards: Array<{ filename: string; svgString: string }>,
  onProgress: (sent: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < cards.length; i++) {
    await sendSvg(cards[i].filename, cards[i].svgString)
    onProgress(i + 1, cards.length)
  }
}
