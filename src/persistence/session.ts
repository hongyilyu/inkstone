import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import type { DisplayMessage } from "../context/agent"

const STATE_DIR = join(
  process.env.XDG_STATE_HOME || join(process.env.HOME || "~", ".local", "state"),
  "inkstone",
)
const SESSION_FILE = join(STATE_DIR, "session.json")

interface SessionData {
  messages: DisplayMessage[]
  activeArticle: string | null
}

export function saveSession(data: SessionData): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true })
  }
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8")
}

export function loadSession(): SessionData | null {
  if (!existsSync(SESSION_FILE)) return null
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8")
    return JSON.parse(raw) as SessionData
  } catch {
    return null
  }
}

export function clearSession(): void {
  if (existsSync(SESSION_FILE)) {
    writeFileSync(SESSION_FILE, "{}", "utf-8")
  }
}
