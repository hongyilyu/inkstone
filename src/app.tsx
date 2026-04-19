import { useKeyboard, useRenderer } from "@opentui/solid"
import { ThemeProvider } from "./context/theme"
import { ToastProvider } from "./ui/toast"
import { DialogProvider, useDialog } from "./ui/dialog"
import { AgentProvider, useAgent } from "./context/agent"
import { Header } from "./components/header"
import { Footer } from "./components/footer"
import { Conversation } from "./components/conversation"
import { Input } from "./components/input"
import { DialogModel } from "./components/dialog-model"
import { getCurrentModelId } from "./agent"
import type { ScrollBoxRenderable } from "@opentui/core"

let scroll: ScrollBoxRenderable | null = null
let inputRef: any = null

export function setScrollRef(ref: ScrollBoxRenderable) {
  scroll = ref
}

export function setInputRef(ref: any) {
  inputRef = ref
}

export function refocusInput() {
  if (inputRef && !inputRef.isDestroyed && !inputRef.focused) {
    inputRef.focus()
  }
}

export function toBottom() {
  setTimeout(() => {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(scroll.scrollHeight)
  }, 50)
}

function Layout() {
  const renderer = useRenderer()
  const dialog = useDialog()
  const { actions } = useAgent()

  useKeyboard((evt: any) => {
    if (evt.ctrl && evt.name === "c") {
      renderer.destroy()
      // renderer.destroy() restores terminal state; exit the process
      // since pi-agent-core keeps handles alive
      setTimeout(() => process.exit(0), 100)
      return
    }

    // Ctrl+P opens model selection
    if (evt.ctrl && evt.name === "p") {
      evt.preventDefault()
      evt.stopPropagation()
      DialogModel.show(dialog, getCurrentModelId(), (model) => {
        actions.setModel(model)
        dialog.clear()
      })
      return
    }

    // Scroll keybinds (prompt stays focused)
    if (scroll && !scroll.isDestroyed) {
      if (evt.name === "pageup" || (evt.meta && evt.name === "up")) {
        scroll.scrollBy(-scroll.height / 2)
        return
      }
      if (evt.name === "pagedown" || (evt.meta && evt.name === "down")) {
        scroll.scrollBy(scroll.height / 2)
        return
      }
      if (evt.ctrl && evt.name === "home") {
        scroll.scrollTo(0)
        return
      }
      if (evt.ctrl && evt.name === "end") {
        scroll.scrollTo(scroll.scrollHeight)
        return
      }
    }
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      <Header />
      <Conversation />
      <Input />
      <Footer />
    </box>
  )
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <DialogProvider>
          <AgentProvider>
            <Layout />
          </AgentProvider>
        </DialogProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}
