import { Show } from "solid-js"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { ThemeProvider, useTheme } from "./context/theme"
import { Toast, ToastProvider } from "./ui/toast"
import { DialogProvider, useDialog } from "./ui/dialog"
import { AgentProvider, useAgent } from "./context/agent"
import { Header } from "./components/header"
import { Footer } from "./components/footer"
import { Conversation } from "./components/conversation"
import { Prompt } from "./components/prompt"
import { OpenPage } from "./components/open-page"
import { DialogCommand } from "./components/dialog-command"
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
  const { actions, store } = useAgent()
  const { theme } = useTheme()

  useKeyboard((evt: any) => {
    if (evt.ctrl && evt.name === "c") {
      renderer.destroy()
      // renderer.destroy() restores terminal state; exit the process
      // since pi-agent-core keeps handles alive
      setTimeout(() => process.exit(0), 100)
      return
    }

    // Ctrl+P opens command panel
    if (evt.ctrl && evt.name === "p") {
      evt.preventDefault()
      evt.stopPropagation()
      DialogCommand.show(dialog, actions)
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
    <>
      <Show when={store.messages.length > 0} fallback={<OpenPage />}>
        <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
          <Header />
          <Conversation />
          <Prompt />
          <Footer />
        </box>
      </Show>
      <Toast />
    </>
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
