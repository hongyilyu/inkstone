import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"

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
