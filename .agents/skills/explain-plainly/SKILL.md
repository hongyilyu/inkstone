---
name: explain-plainly
description: >
  Explains a technical concept, system, or design in plain, jargon-free language
  built on an everyday analogy, then renders it as a calm self-contained HTML page
  opened in the browser — never a wall of terminal text. Use when the user says
  "explain this", "ELI5", "explain like I'm five", "I don't understand", "I don't
  get it", "break it down", "in plain English", "no jargon", "help me understand",
  or "dumb it down".
---

# Explain plainly

Make a hard idea click for someone who's lost. Lead with an everyday analogy,
strip the jargon, render the result as a calm HTML page — not a terminal wall.

## Principles

1. **Analogy first.** Open with a concrete everyday analogy (order tracking,
   mail, a kitchen line, a checklist) that matches the *shape* of the idea.
   Shape before specifics.
2. **Graph-led, less prose.** Every section carries a simple picture and earns
   its words. Lead with the graph (a `A → B → C` sketch, or a before → after);
   write a line only when the graph can't carry the point. More graph, less text.
3. **No jargon up front.** Ban "seam / abstraction / leverage / polymorphism /
   idempotent" and friends from the visible copy. Plain words only. Precise terms,
   mechanics, and file paths live *only* inside the "Go deeper" expander.
4. **Three beats.** *what it is → what's wrong today → what changes.* Keep each
   beat short. Drop the middle beat if there's no problem to fix — then it's
   *what it is → how it works.*
5. **Map back.** After the analogy, connect it to the real things by name.
6. **Inkstone surface.** Render in the project's look (the template bakes in
   `DESIGN.md`'s palette + type): warm blush surfaces, deep-plum headings, one
   rationed magenta accent, tonal layers over shadows. Calm and trustworthy.
7. **Short lines.** Bold only the 2–3 words that carry the point.
8. **Don't dump.** Keep the technical depth behind the "Go deeper" expander, and
   end by offering 2–3 specific things the user can pull on. Pull, don't push.

## Workflow

1. Find the single best everyday analogy *before* writing anything.
2. Copy `TEMPLATE.html` and fill it in following the principles above.
3. Write to a fresh temp file: resolve `$TMPDIR` (fallback `/tmp`, `%TEMP%` on
   Windows), name it `explain-<slug>-<timestamp>.html`. Never write into the repo.
4. Open it: `open` (macOS) / `xdg-open` (Linux) / `start` (Windows).
5. In chat, output **only** the file path + one sentence. Do not re-explain in
   the terminal — the page *is* the explanation.

## Avoid

- Jargon walls, dense or color-coded diagrams, legends — exactly what confuses
  people.
- Restating the whole thing in chat after opening the page.
- Cramming every detail onto the page. The page is the first layer; the
  "go deeper" options are the next.

See [TEMPLATE.html](TEMPLATE.html) for the scaffold.
