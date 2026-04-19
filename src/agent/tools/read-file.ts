import { resolve } from "path"
import { readFileSync, existsSync } from "fs"
import { Type, type Static } from "@sinclair/typebox"
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core"
import { VAULT_DIR } from "../constants"

const Parameters = Type.Object({
  path: Type.String({ description: "Absolute or vault-relative path to the file to read" }),
})

export const readFileTool: AgentTool<typeof Parameters> = {
  name: "read_file",
  label: "Read File",
  description: "Read the contents of a file. Path must be within the vault directory.",
  parameters: Parameters,

  async execute(_id, params): Promise<AgentToolResult<unknown>> {
    const filePath = resolvePath(params.path)

    if (!filePath.startsWith(VAULT_DIR)) {
      return {
        content: [{ type: "text", text: `Error: path must be within ${VAULT_DIR}` }],
        details: { error: true },
      }
    }

    if (!existsSync(filePath)) {
      return {
        content: [{ type: "text", text: `Error: file not found: ${filePath}` }],
        details: { error: true },
      }
    }

    const content = readFileSync(filePath, "utf-8")
    return {
      content: [{ type: "text", text: content }],
      details: { path: filePath, size: content.length },
    }
  },
}

function resolvePath(p: string): string {
  if (p.startsWith("/")) return resolve(p)
  return resolve(VAULT_DIR, p)
}
