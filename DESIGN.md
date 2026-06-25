---
name: Inkstone
description: A local-first thinking surface where chat accrues browsable personal knowledge.
colors:
  ink-magenta: "#e33f86"
  magenta-ring: "#db2777"
  alert-crimson: "#b3003f"
  deep-plum-ink: "#501854"
  slate-ink: "#454554"
  plum-label: "#77347c"
  deep-magenta-muted: "#ac1668"
  lavender-shell: "#f2e1f4"
  petal-sidebar: "#ead0ef"
  blush-surface: "#fdf7fd"
  card-surface: "#faf3fb"
  soft-pink: "#f1c4e6"
  hairline: "#eee1ed"
  field-line: "#e7c1dc"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  md: "6px"
  lg: "8px"
  xl: "12px"
  "2xl": "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.ink-magenta}"
    textColor: "#ffffff"
    rounded: "{rounded.lg}"
    padding: "10px 14px"
  button-ghost:
    textColor: "{colors.deep-magenta-muted}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
  chip:
    backgroundColor: "{colors.soft-pink}"
    textColor: "{colors.plum-label}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  card:
    backgroundColor: "{colors.card-surface}"
    textColor: "{colors.slate-ink}"
    rounded: "{rounded.xl}"
    padding: "20px"
  input-search:
    backgroundColor: "{colors.card-surface}"
    textColor: "{colors.deep-plum-ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  glyph-tile:
    backgroundColor: "{colors.soft-pink}"
    textColor: "{colors.plum-label}"
    rounded: "{rounded.lg}"
    size: "32px"
---

# Design System: Inkstone

## 1. Overview

**Creative North Star: "The Lamplit Desk"**

Inkstone is the desk you return to at dusk: a private, warm-lit place where the
day's loose thoughts settle into something you can find again. The whole system
is built around one committed magenta that behaves like lamplight, a single warm
glow that anchors a near-monochrome field of plums and blushes. It is
characterful without being loud, and unhurried by construction: generous
whitespace, calm lists over busy cards, and a quiet confidence that the work is
*yours* and stays private.

The surface is a layered set of warm tints rather than stark white: a petal
sidebar, a near-white blush reading surface, and a slightly lifted card. Depth
comes from these tonal steps and thin hairlines, not from heavy shadows. Type
does the heavy lifting (one Inter family across the whole product), and the
magenta is rationed so its appearances always mean something: a primary action,
the current selection, a captured-from link.

This system explicitly rejects the **generic SaaS dashboard** (identical card
grids, hero-metric templates, Notion/Linear sameness), **corporate enterprise**
sterility (navy-and-gray, stock imagery, buzzwords), and the **cluttered
power-tool** (toolbar soup, everything visible at once). It should read as a
personal instrument someone chose, not software a committee shipped.

**Key Characteristics:**
- One committed magenta as the only accent; everything else is a warm plum neutral.
- Tonal layering (sidebar → surface → card) over drop shadows.
- Lists, grouping, and whitespace instead of card grids.
- One typeface (Inter), hierarchy through weight and size, not ornament.
- Full light and dark parity; the same tokens flip under `[data-theme]`.

## 2. Colors

A near-monochrome magenta-and-plum field where a single saturated ink carries every accent.

### Primary
- **Ink Magenta** (#e33f86): The signature. Primary buttons, the current selection, progress fill, captured-from links, focus emphasis. Rationed so it always signals action or state, never decoration.
- **Magenta Ring** (#db2777): Focus-visible rings only, on both themes, so keyboard focus reads against any surface.

### Secondary
- **Soft Pink** (#f1c4e6): The workhorse tint. Chips, badges, glyph tiles, selected rows (`/70`), hover wash (`/40`). Carries categorization without introducing a second hue.
- **Plum Label** (#77347c): Text on soft-pink chips and tints.

### Neutral (warm plums, not grays)
- **Lavender Shell** (#f2e1f4) / **Petal Sidebar** (#ead0ef): App chrome and the left nav.
- **Blush Surface** (#fdf7fd): The primary reading surface (chat column, Library content). Near-white but unmistakably warm.
- **Card Surface** (#faf3fb): The lifted layer: detail panels, review cards, inputs.
- **Deep Plum Ink** (#501854): Primary text and headings.
- **Slate Ink** (#454554): Secondary body text on cards.
- **Deep Magenta Muted** (#ac1668): Subtitles and metadata. A *darkened version of the brand hue*, never a flat gray, so muted text stays warm and legible (it clears 4.5:1 on the light surfaces).
- **Hairline** (#eee1ed) / **Field Line** (#e7c1dc): Borders and dividers.

### Tertiary (status only)
- **Alert Crimson** (light #b3003f / dark #ff9ebb): Destructive and overdue states, always paired with an icon and a word ("Overdue"), never color alone. It is a *readable* alert, tuned to clear 4.5:1 as text on the warm surfaces and its own soft tint (`destructive/10`) in both themes, and deliberately deeper than the bright magenta primary so "error" never reads as "primary action". The earlier vivid #f7086c failed AA as body text (≈3.8:1 light, ≈2.2:1 dark) and was retired.

### Named Rules
**The One Ink Rule.** Magenta is the only accent. New categories earn distinction through icon + label + tonal soft-pink, never a new hue. If you reach for a second saturated color, stop.

**The Warm Neutral Rule.** There are no true grays. Every "gray" is a plum or magenta tint. Muted text is a *darkened brand hue* (#ac1668), not `#888`.

## 3. Typography

**Display / Body / Label Font:** Inter Variable, self-hosted (with `ui-sans-serif, system-ui, sans-serif` fallback).
**Mono Font:** `ui-monospace, "SF Mono", Menlo, Consolas` (code and diffs only).

**Character:** One humanist-grotesque family across the entire product. Personality comes from weight contrast and tight display tracking, not from a second typeface. This is the product register: predictable, legible, invisible when it should be.

### Hierarchy
- **Display** (700, 1.875rem/`text-3xl`, line-height 1.1, -0.02em): The "Today" overview title. The largest type in the app.
- **Headline** (700, 1.5rem/`text-2xl`, -0.02em): Collection titles (People, Projects), settings page titles.
- **Title** (600, 1.125rem/`text-lg`, -0.01em): Detail-panel entity names, dialog titles.
- **Body** (400, 0.875rem/`text-sm`, line-height 1.55): Row titles, descriptions, prose. Cap prose at 65–75ch.
- **Label** (500–600, 0.75rem/`text-xs`): Field labels, counts, metadata, kbd hints. Sentence case.

### Named Rules
**The Fixed-Scale Rule.** App UI uses a fixed `rem` scale, never fluid `clamp()`. Headings must not shrink in a sidebar or panel.

**The Sentence-Case Rule.** Section headers and labels are sentence case ("Due soon", "Needs review"). No tiny tracked all-caps eyebrow above every section; uppercase is reserved for short kbd hints and badges.

## 4. Elevation

Flat by tonal layering, not by shadow. Depth is read from the warm-neutral stack (petal sidebar → blush surface → card surface) and 1px hairlines. Shadows are reserved for genuinely floating layers (popovers, the command palette), where they are soft and wide, never a hard drop.

### Shadow Vocabulary
- **Resting** (no shadow): Cards, rows, panels, inputs. They sit on a different tonal layer instead.
- **Raised** (`shadow-sm`): Primary buttons only, a 1px lift to mark the single most actionable element.
- **Floating** (`shadow-lg` / `shadow-2xl`): Popovers (model picker) and the command palette, which live above the page over a blurred backdrop.

### Named Rules
**The No Ghost-Card Rule.** Never pair a 1px border with a wide (≥16px blur) drop shadow on the same element. Pick one: a hairline border *or* a defined shadow. Resting surfaces get neither; they layer tonally.

## 5. Components

### Buttons
- **Shape:** Gently rounded (`rounded-lg`, 8px); icon buttons `rounded-md` (6px); pills `rounded-full`.
- **Primary:** Ink Magenta (#e33f86) on white, `shadow-sm`, hover drops to `primary/90`. The only saturated fill in the UI. Used once per context (New Chat, Start a chat, the todo "Done" toggle).
- **Ghost / Icon:** No fill at rest; `muted-foreground` text, hover washes to `accent`. The default for secondary actions.
- **Chip:** 1px `input` border, transparent fill, hover `secondary/50`. Used for filters and inline actions ("Confirm", model picker).
- **Focus:** Every variant shows a 1px `ring-ring` (#db2777) on `focus-visible`. Never removed.

### Chips / Badges
- **Style:** Soft-pink fill (#f1c4e6), plum-label text, `rounded-full`, `text-xs`. Relationship/role/tag/status metadata.
- **Status:** Project status pairs a tiny dot with a word ("In review"); overdue pairs an alert-crimson `AlertTriangle` with "Overdue". Color is never the only signal.

### Cards / Containers
- **Corner Style:** `rounded-xl` (12px). Cap card radius at 16px; never 24px+.
- **Background:** Card Surface (#faf3fb), often at `/50` over the blush surface for a quiet lift.
- **Shadow Strategy:** None at rest (see Elevation). Tonal layer + optional hairline.
- **Border:** Optional 1px Hairline. Never nested cards.
- **Internal Padding:** 16–20px (`p-4`/`p-5`).

### Inputs / Fields
- **Style:** Card-surface fill at `/40`, 1px `input` border, `rounded-lg`, a leading `Search` glyph in muted text.
- **Focus:** Border shifts and a 1px ring; placeholder is `muted-foreground` (never lighter, to hold contrast).

### Navigation
- **Style:** Sidebar/Library rows are `rounded-lg`, `text-sidebar-foreground/80`, hover `sidebar-accent`. Active row is filled `sidebar-accent` with medium weight, plus a trailing count. Icons are Lucide, 16px.

### Command Palette (signature)
A centered `rounded-2xl` popover over a blurred `foreground/25` backdrop, opened with ⌘K from anywhere. A search field over results grouped by type (Threads, People, Projects, Todos, Bookmarks), fully keyboard-driven (↑↓ to move, ↵ to open), the active row washed `accent` with a return-key hint. Entrance scales from 0.98 + fades; disabled under reduced motion.

### Entity Detail Inspector (signature)
A ~400px right-hand panel (collapses to full-width below `lg`) that opens when a row is selected. Header (glyph + title + close), a scrollable body of labelled fields and deep-linked relations, and a pinned "Captured from · <when> / <thread>" footer that returns to the originating chat — the chat-origin (thread) link only; a graph/journal-sourced Entity surfaces its relationships via backlinks ("Mentioned in"), not this footer. The expression of "chat is the verb, knowledge is the noun."

## 6. Do's and Don'ts

### Do:
- **Do** ration Ink Magenta (#e33f86) to one primary action or the current selection per context. Its rarity is the point (The One Ink Rule).
- **Do** convey depth by tonal layering (petal → blush → card) and hairlines, not drop shadows.
- **Do** distinguish entity kinds with icon + label and a uniform soft-pink glyph tile, so the near-monochrome palette stays color-blind safe.
- **Do** keep muted text at the darkened brand hue (#ac1668) so subtitles clear 4.5:1 on warm surfaces.
- **Do** prefer grouped lists with generous whitespace; reach for a card only when content is truly distinct.
- **Do** give every animation a `prefers-reduced-motion` alternative; entrance reveals must enhance already-visible content.

### Don't:
- **Don't** ship the **generic SaaS dashboard**: identical card grids, the big-number hero-metric template, Notion/Linear sameness.
- **Don't** drift toward **corporate enterprise**: navy-and-gray, stock photography, buzzword copy.
- **Don't** build a **cluttered power-tool**: toolbar soup, dense nested menus, everything visible at once.
- **Don't** introduce a second saturated hue. Categories earn distinction through icon, label, and tint.
- **Don't** pair a 1px border with a wide drop shadow (the "ghost card"); pick one.
- **Don't** round cards past 16px, encode meaning in color alone, set a tracked all-caps eyebrow above every section, or use em dashes in copy.
