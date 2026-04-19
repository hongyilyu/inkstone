import { useKeyboard, useRenderer } from "@opentui/solid"
import { ThemeProvider } from "./context/theme"
import { ToastProvider } from "./ui/toast"
import { DialogProvider } from "./ui/dialog"
import { AgentProvider } from "./context/agent"
import { Header } from "./components/header"
import { Footer } from "./components/footer"
import { Conversation } from "./components/conversation"
import { Input } from "./components/input"

function Layout() {
  const renderer = useRenderer()

  useKeyboard((evt: any) => {
    if (evt.ctrl && evt.name === "c") {
      renderer.destroy()
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
