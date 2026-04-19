# Inkstone — Architecture

## Overview

Inkstone is a terminal UI application built with OpenTUI (Solid reconciler) that uses pi-agent-core as a headless LLM agent backend. The agent runs in-process — no server, no worker threads, no network boundary.

## Data Flow

```
User input (textarea)
  → command parsing (/article, /model, etc.)
  → agent.prompt(text)
    → pi-agent-core Agent loop
      → LLM API call (Bedrock)
      → tool calls (read_file, edit_file, write_file, quote_article)
        → beforeToolCall guard (block/confirm/allow)
      → streaming events
    → agent.subscribe() callback
      → batch() Solid store updates
        → fine-grained reactivity → UI re-render
```

## File Structure

```
src/
  index.tsx                     Entry: createCliRenderer() + render(<App />)
  app.tsx                       Provider stack + root layout + commands

  agent/
    index.ts                    Agent instance, subscribe, expose actions
    prompt.ts                   READING_RULES system prompt
    constants.ts                VAULT_DIR, ARTICLES_DIR, SCRAPS_DIR, etc.
    guard.ts                    beforeToolCall (frontmatter guard + confirm)
    tools/
      quote-article.ts          Paragraph search in active article
      read-file.ts              readFileSync, scoped to VAULT_DIR
      edit-file.ts              String replace + unified diff, scoped to VAULT_DIR
      write-file.ts             writeFileSync/append, scoped to VAULT_DIR

  context/
    helper.tsx                  createSimpleContext() factory
    agent.tsx                   Bridge agent events → Solid store
    dialog.tsx                  Dialog stack context
    keybind.tsx                 Keyboard shortcut system
    theme.tsx                   Theme loading, resolution, application
    kv.tsx                      JSON-file-backed reactive KV store
    local.tsx                   Model selection state + persistence

  ui/
    dialog.tsx                  Stack-based modal rendering
    dialog-confirm.tsx          Promise-based yes/no confirmation
    dialog-select.tsx           Fuzzy filterable select list
    toast.tsx                   Toast notifications

  components/
    dialog-model.tsx            Model selection dialog
    conversation.tsx            Scrollbox + message list
    message.tsx                 Render user/assistant/tool messages
    input.tsx                   Textarea prompt with /command parsing
    header.tsx                  Article, model, status
    footer.tsx                  Keybind hints

  persistence/
    session.ts                  Save/load messages as JSON
```

## Provider Stack

```tsx
<ThemeProvider>
  <KVProvider>
    <KeybindProvider>
      <DialogProvider>
        <AgentProvider>
          <LocalProvider>
            <App />
          </LocalProvider>
        </AgentProvider>
      </DialogProvider>
    </KeybindProvider>
  </KVProvider>
</ThemeProvider>
```

## Agent Integration

The `AgentProvider` creates a pi-agent-core `Agent` instance and subscribes to its events. State is held in a `createStore`:

```ts
{
  messages: AgentMessage[]       // full history
  streamingText: string          // current delta accumulator
  isStreaming: boolean
  activeArticle: string | null
  status: "idle" | "streaming" | "tool_executing"
}
```

Events from `agent.subscribe()` are batched via `batch()` and applied to the store. Solid's fine-grained reactivity ensures only affected UI nodes re-render.

## Guard Logic

The `beforeToolCall` hook runs before each tool execution:

1. **Path validation**: reject any path resolving outside VAULT_DIR
2. **Article file protection**: allow frontmatter edits, block content edits and full writes
3. **Notes/scraps confirmation**: show DialogConfirm, await user response

The confirmation dialog is async — `beforeToolCall` awaits the dialog promise before returning `{ block: true/false }`.

## Key Patterns (from OpenCode)

- `createSimpleContext()` — factory for typed context providers
- Stack-based dialog system with focus save/restore
- KV persistence via JSON file in state directory
- Theme resolution: hex → refs → dark/light variants → RGBA
- Keybind system with leader key support
