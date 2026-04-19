import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { refocusInput } from "../app"

export function Header() {
  const { theme } = useTheme()

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
        article-reader
      </text>
    </box>
  )
}
