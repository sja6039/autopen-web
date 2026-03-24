/**
 * Autopen backend server
 *
 * - Proxies SVG uploads to the Raspberry Pi's HMI server so the Pi's address
 *   is never exposed to the browser client.
 * - Serves the built frontend (dist/) in production.
 *
 * Required env var:
 *   AUTOPEN_HMI_URL  – base URL of the Pi, e.g. http://192.168.1.50:5000
 *
 * Optional:
 *   PORT             – listening port (default: 3001)
 */

import 'dotenv/config'
import express from 'express'
import multer from 'multer'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()

// ── multer: keep uploaded file in memory (no disk writes) ────────────────────
// 10 MB limit is generous for an SVG; the Pi will reject oversized files anyway.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

// ── POST /api/autopen/upload ──────────────────────────────────────────────────
app.post('/api/autopen/upload', upload.single('file'), async (req, res) => {
  const piBase = (process.env.AUTOPEN_HMI_URL ?? '').trim().replace(/\/+$/, '')

  if (!piBase) {
    return res.status(500).json({ error: 'AUTOPEN_HMI_URL is not configured on the server.' })
  }

  const { code } = req.body
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'A valid 6-digit pairing code is required.' })
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No SVG file provided.' })
  }

  // Re-build the multipart body to forward to the Pi.
  // Node 18+ global FormData + Blob handles the boundary automatically.
  const outForm = new FormData()
  outForm.append('code', code)
  outForm.append(
    'file',
    new Blob([req.file.buffer], { type: 'image/svg+xml' }),
    req.file.originalname,
  )

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const piRes = await fetch(`${piBase}/api/upload`, {
      method: 'POST',
      body: outForm,
      signal: controller.signal,
    })
    clearTimeout(timer)

    const data = await piRes.json().catch(() => ({}))
    return res.status(piRes.status).json(data)
  } catch (err) {
    clearTimeout(timer)

    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request to the Autopen Pi timed out. Is it on the same network?' })
    }
    return res.status(502).json({ error: 'Could not reach the Autopen Pi. Check AUTOPEN_HMI_URL.' })
  }
})

// ── Static frontend (production only) ────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(__dirname, 'dist')))
  app.get('*', (_req, res) => res.sendFile(join(__dirname, 'dist', 'index.html')))
}

const PORT = Number(process.env.PORT ?? 3001)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Autopen backend  →  http://localhost:${PORT}`)
  if (!process.env.AUTOPEN_HMI_URL) {
    console.warn('  ⚠  AUTOPEN_HMI_URL is not set — uploads will fail until it is.')
  } else {
    console.log(`Proxying uploads →  ${process.env.AUTOPEN_HMI_URL}`)
  }
})
