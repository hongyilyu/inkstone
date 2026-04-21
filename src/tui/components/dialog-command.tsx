import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import type { DialogContext } from "../ui/dialog"
import { DialogModel } from "./dialog-model"
import { DialogTheme } from "./dialog-theme"
import { DialogProvider as DialogProviderSelect } from "./dialog-provider"
import { getCurrentModelId } from "@backend/agent"
import type { AgentActions } from "@backend/agent"
import { useTheme } from "../context/theme"

interface CommandOption {
  id: string
}

export function DialogCommand(props: {
  dialog: DialogContext
  actions: AgentActions
}) {
  const { themeId } = useTheme()

  const options: DialogSelectOption<CommandOption>[] = [
    { title: "Models", value: { id: "models" }, description: "Switch model" },
    { title: "Themes", value: { id: "themes" }, description: "Switch theme" },
    { title: "Connect", value: { id: "connect" }, description: "Switch provider" },
  ]

  return (
    <DialogSelect
      title="Command Panel"
      placeholder="Search commands..."
      options={options}
      closeOnSelect={false}
      onSelect={(option) => {
        switch (option.value.id) {
          case "models":
            DialogModel.show(props.dialog, getCurrentModelId(), (model) => {
              props.actions.setModel(model)
              props.dialog.clear()
            })
            break
          case "themes":
            DialogTheme.show(props.dialog, themeId())
            break
          case "connect":
            DialogProviderSelect.show(props.dialog)
            break
        }
      }}
    />
  )
}

DialogCommand.show = (dialog: DialogContext, actions: AgentActions) => {
  dialog.replace(() => <DialogCommand dialog={dialog} actions={actions} />)
}
