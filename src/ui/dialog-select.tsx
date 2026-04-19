import { TextAttributes, RGBA, type ScrollBoxRenderable, type InputRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { batch, createEffect, createMemo, For, Show, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"

export interface DialogSelectOption<T = any> {
  title: string
  value: T
  description?: string
  category?: string
}

export interface DialogSelectProps<T> {
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  onSelect?: (option: DialogSelectOption<T>) => void
  current?: T
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
  })

  let scroll: ScrollBoxRenderable | undefined

  const filtered = createMemo(() => {
    const needle = store.filter.toLowerCase()
    if (!needle) return props.options
    return fuzzysort
      .go(needle, props.options, { key: "title" })
      .map((x) => x.obj)
  })

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => Math.min(filtered().length, Math.floor(dimensions().height / 2) - 6))

  createEffect(on(() => store.filter, () => {
    setStore("selected", 0)
  }))

  function move(direction: number) {
    if (filtered().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = filtered().length - 1
    if (next >= filtered().length) next = 0
    setStore("selected", next)
  }

  useKeyboard((evt: any) => {
    if (evt.name === "up") move(-1)
    if (evt.name === "down") move(1)
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "home") setStore("selected", 0)
    if (evt.name === "end") setStore("selected", filtered().length - 1)

    if (evt.name === "return") {
      const option = filtered()[store.selected]
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        props.onSelect?.(option)
        dialog.clear()
      }
    }
  })

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <box paddingTop={1}>
          <input
            ref={(r: InputRenderable) => {
              setTimeout(() => {
                if (!r || r.isDestroyed) return
                r.focus()
              }, 1)
            }}
            onInput={(e: string) => setStore("filter", e)}
            placeholder={props.placeholder ?? "Search"}
            placeholderColor={theme.textMuted}
            cursorColor={theme.primary}
            focusedBackgroundColor={theme.backgroundPanel}
            focusedTextColor={theme.text}
          />
        </box>
      </box>
      <Show
        when={filtered().length > 0}
        fallback={
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={theme.textMuted}>No results found</text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          maxHeight={height()}
        >
          <For each={filtered()}>
            {(option, index) => {
              const active = () => index() === store.selected
              return (
                <box
                  flexDirection="row"
                  backgroundColor={active() ? theme.primary : RGBA.fromInts(0, 0, 0, 0)}
                  paddingLeft={2}
                  paddingRight={2}
                  onMouseUp={() => {
                    props.onSelect?.(option)
                    dialog.clear()
                  }}
                  onMouseOver={() => setStore("selected", index())}
                >
                  <text
                    flexGrow={1}
                    fg={active() ? theme.selectedListItemText : theme.text}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    overflow="hidden"
                    wrapMode="none"
                  >
                    {option.title}
                  </text>
                  <Show when={option.description}>
                    <text fg={active() ? theme.selectedListItemText : theme.textMuted}>
                      {" "}{option.description}
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
