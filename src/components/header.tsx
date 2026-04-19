import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { refocusInput } from "../app"
import { useAgent } from "../context/agent"

export function Header() {
  const { theme } = useTheme()
  const { store } = useAgent()

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      borderColor={theme.borderSubtle}
      border={["bottom"]}
      onMouseUp={() => setTimeout(() => refocusInput(), 1)}
    >
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        inkstone
      </text>
      <text fg={theme.textMuted}>
        {store.modelName} (ctrl+p)
      </text>
    </box>
  )
}
