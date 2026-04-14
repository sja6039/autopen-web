let _tunnelUrl: string | null = null;

/** Look up the Cloudflare tunnel URL for a 6-char code via ntfy.sh. */
async function lookupTunnelUrl(code: string): Promise<string> {
  const res = await fetch(
    `https://ntfy.sh/autopen_${code}/json?poll=1&since=10m`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`ntfy.sh returned HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Code not found");
  const last = JSON.parse(lines[lines.length - 1]);
  const url: string = last?.message ?? "";
  if (!url.startsWith("https://")) throw new Error("Code not found");
  return url;
}

function connectedBase(): string {
  if (!_tunnelUrl) throw new Error("Not connected to a printer");
  return _tunnelUrl;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Look up the tunnel URL from ntfy.sh, ping the Pi's health endpoint, and store the URL. */
export async function connect(code: string): Promise<string> {
  if (code.length !== 6) throw new Error("Pairing code must be 6 characters");
  const tunnelUrl = await lookupTunnelUrl(code);
  const res = await fetch(`${tunnelUrl}/api/health`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Printer returned HTTP ${res.status}`);
  _tunnelUrl = tunnelUrl;
  return tunnelUrl;
}

/** Ping the currently connected Pi. Returns true if reachable. */
export async function ping(): Promise<boolean> {
  try {
    const res = await fetch(`${connectedBase()}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Clear the stored connection. */
export function disconnect(): void {
  _tunnelUrl = null;
}

/** Return the connected tunnel URL, or null if not connected. */
export function getConnectedIp(): string | null {
  return _tunnelUrl;
}

export interface PiStatus {
  status: string;
  current_job: string | null;
  queue: string[];
  completed: string[];
  total_received: number;
}

/** Fetch live status from the printer. */
export async function getStatus(): Promise<PiStatus> {
  const res = await fetch(`${connectedBase()}/api/status`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Status endpoint returned HTTP ${res.status}`);
  return res.json() as Promise<PiStatus>;
}

/** POST a single SVG to the printer. */
export async function sendSvg(
  filename: string,
  svgString: string,
): Promise<void> {
  const res = await fetch(`${connectedBase()}/api/svg`, {
    method: "POST",
    headers: {
      "Content-Type": "image/svg+xml",
      "X-Filename": filename,
    },
    body: svgString,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Printer returned HTTP ${res.status}`);
  }
}

/** Send an array of SVGs one by one, calling onProgress after each. */
export async function sendSvgBatch(
  cards: Array<{ filename: string; svgString: string }>,
  onProgress: (sent: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < cards.length; i++) {
    await sendSvg(cards[i].filename, cards[i].svgString);
    onProgress(i + 1, cards.length);
  }
}
