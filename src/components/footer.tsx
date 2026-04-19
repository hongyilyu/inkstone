import { useTheme } from "../context/theme"

export function Footer() {
  const { theme } = useTheme()

  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      borderColor={theme.borderSubtle}
      border={["top"]}
      gap={2}
    >
      <text fg={theme.textMuted}>ctrl+c quit</text>
      <text fg={theme.textMuted}>pgup/pgdn scroll</text>
      <text fg={theme.textMuted}>enter send</text>
    </box>
  )
}
