import { useKeyboard, useRenderer } from "@opentui/solid"
import { ThemeProvider } from "./context/theme"
import { ToastProvider } from "./ui/toast"
import { DialogProvider } from "./ui/dialog"
import { AgentProvider } from "./context/agent"
import { Header } from "./components/header"
import { Footer } from "./components/footer"
import { Conversation } from "./components/conversation"
import { Input } from "./components/input"
import type { ScrollBoxRenderable } from "@opentui/core"

let scroll: ScrollBoxRenderable | null = null

export function setScrollRef(ref: ScrollBoxRenderable) {
  scroll = ref
}

export function toBottom() {
  setTimeout(() => {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(scroll.scrollHeight)
  }, 50)
}

function Layout() {
  const renderer = useRenderer()

  useKeyboard((evt: any) => {
    if (evt.ctrl && evt.name === "c") {
      renderer.destroy()
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
