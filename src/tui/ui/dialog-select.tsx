import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { batch, createEffect, createMemo, For, Show, on } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"

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
  closeOnSelect?: boolean
}

/**
 * Truncate a string to a maximum length, adding "..." if truncated.
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max - 1) + "…"
}

/**
 * Fuzzy-searchable select dialog.
 * Ported from OpenCode's ui/dialog-select.tsx (minimal slice).
 *
 * TODO: Port remaining upstream features from opencode/src/cli/cmd/tui/ui/dialog-select.tsx:
 * - Grouped categories (groupBy category key, categoryView rendering)
 * - skipFilter option to disable filtering
 * - Per-option keybind actions (keybind[] prop with footer display)
 * - selectedForeground() for contrast-aware highlight text
 * - Scroll acceleration (getScrollAcceleration util)
 * - Disabled items (disabled flag + dimmed rendering)
 * - footer / gutter / margin slots per option
 * - DialogSelectRef for external control (moveTo, getSelected)
 * - onMove / onFilter callbacks
 * - flat mode toggle
 */
export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()

  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
    input: "keyboard" as "keyboard" | "mouse",
  })

  // When current prop is set, scroll to it
  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
          }
        }
      },
    ),
  )

  let input: InputRenderable

  const filtered = createMemo(() => {
    const needle = store.filter.toLowerCase()
    if (!needle) return props.options
    return fuzzysort
      .go(needle, props.options, { key: "title" })
      .map((x) => x.obj)
  })

  // When the filter changes, the mousemove might still be triggered
  // via a synthetic event as layout moves underneath the cursor.
  // Force keyboard mode to prevent mouseover from hijacking selection.
  createEffect(() => {
    filtered()
    setStore("input", "keyboard")
  })

  const flat = createMemo(() => filtered())

  const dimensions = useTerminalDimensions()
  const height = createMemo(() => Math.min(flat().length, Math.floor(dimensions().height / 2) - 6))

  const selected = createMemo(() => flat()[store.selected])

  // Reset selection when filter changes
  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      setTimeout(() => {
        if (filter.length > 0) {
          moveTo(0, true)
        } else if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            moveTo(currentIndex, true)
          }
        }
      }, 0)
    }),
  )

  function move(direction: number) {
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = flat().length - 1
    if (next >= flat().length) next = 0
    moveTo(next, true)
  }

  function moveTo(next: number, center = false) {
    setStore("selected", next)
    if (!scroll) return
    const target = scroll.getChildren().find((child) => {
      return child.id === JSON.stringify(selected()?.value)
    })
    if (!target) return
    const y = target.y - scroll.y
    if (center) {
      const centerOffset = Math.floor(scroll.height / 2)
      scroll.scrollBy(y - centerOffset)
    } else {
      if (y >= scroll.height) {
        scroll.scrollBy(y - scroll.height + 1)
      }
      if (y < 0) {
        scroll.scrollBy(y)
        if (isDeepEqual(flat()[0]?.value, selected()?.value)) {
          scroll.scrollTo(0)
        }
      }
    }
  }

  useKeyboard((evt: any) => {
    setStore("input", "keyboard")

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "home") moveTo(0)
    if (evt.name === "end") moveTo(flat().length - 1)

    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        props.onSelect?.(option)
        if (props.closeOnSelect !== false) {
          dialog.clear()
        }
      }
    }
  })

  let scroll: ScrollBoxRenderable | undefined

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
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
            onInput={(e: string) => {
              batch(() => {
                setStore("filter", e)
              })
            }}
            backgroundColor={theme.backgroundPanel}
            focusedBackgroundColor={theme.backgroundPanel}
            textColor={theme.text}
            cursorColor={theme.primary}
            focusedTextColor={theme.text}
            ref={(r: InputRenderable) => {
              input = r
              setTimeout(() => {
                if (!input) return
                if (input.isDestroyed) return
                input.focus()
              }, 1)
            }}
            placeholder={props.placeholder ?? "Search"}
            placeholderColor={theme.textMuted}
          />
        </box>
      </box>
      <Show
        when={flat().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
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
          <For each={flat()}>
            {(option) => {
              const active = createMemo(() => isDeepEqual(option.value, selected()?.value))
              const current = createMemo(() => isDeepEqual(option.value, props.current))
              return (
                <box
                  id={JSON.stringify(option.value)}
                  flexDirection="row"
                  position="relative"
                  onMouseMove={() => {
                    setStore("input", "mouse")
                  }}
                  onMouseUp={() => {
                    props.onSelect?.(option)
                    if (props.closeOnSelect !== false) {
                      dialog.clear()
                    }
                  }}
                  onMouseOver={() => {
                    if (store.input !== "mouse") return
                    const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                    if (index === -1) return
                    moveTo(index)
                  }}
                  onMouseDown={() => {
                    const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                    if (index === -1) return
                    moveTo(index)
                  }}
                  backgroundColor={active() ? theme.primary : theme.backgroundPanel}
                  paddingLeft={current() ? 1 : 3}
                  paddingRight={3}
                  gap={1}
                >
                  <Show when={current()}>
                    <text
                      flexShrink={0}
                      fg={active() ? theme.selectedListItemText : theme.primary}
                      marginRight={0}
                    >
                      ●
                    </text>
                  </Show>
                  <text
                    flexGrow={1}
                    fg={active() ? theme.selectedListItemText : current() ? theme.primary : theme.text}
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    overflow="hidden"
                    wrapMode="none"
                  >
                    {truncate(option.title, 61)}
                  </text>
                  <Show when={option.description}>
                    <text
                      flexShrink={0}
                      fg={active() ? theme.selectedListItemText : theme.textMuted}
                      wrapMode="none"
                    >
                      {option.description}
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
