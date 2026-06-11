---
name: explain-plainly
description: >
  Explains a technical concept, system, or design in plain, jargon-free language —
  answered directly in chat, focused on the exact question asked. No analogies
  unless the user asks for one. Use when the user says "explain this", "ELI5",
  "explain like I'm five", "I don't understand", "I don't get it", "break it down",
  "in plain English", "no jargon", "help me understand", or "dumb it down".
---

# Explain plainly

Make a hard idea click for someone who's lost. Answer the actual question in plain
English, right in the chat. No HTML, no pages — just the explanation.

## Principles

1. **Answer the question.** Explain the specific thing asked, not a general tour
   of the surrounding area. If the question is narrow, keep the answer narrow.
2. **Plain words only.** Strip the jargon. Ban "seam / abstraction / leverage /
   polymorphism / idempotent" and friends from the explanation. If a precise term
   is unavoidable, define it in plain words the first time you use it.
3. **No analogy by default.** Explain the thing itself, directly. Reach for an
   everyday analogy *only* if the user asks for one ("give me an analogy", "what's
   it like").
4. **Three beats.** *what it is → what's wrong today → what changes.* Keep each
   beat short. Drop the middle beat if there's no problem to fix — then it's just
   *what it is → how it works.*
5. **Sketch the flow in ASCII.** When the idea has a flow, a pipeline, or a
   before/after, draw a small ASCII diagram in a code block. Keep it simple — a
   few boxes and arrows that carry the shape at a glance. Skip it when the answer
   is a single fact with no moving parts; never force one.
6. **Short.** Lead with the answer. Bold only the 2–3 words that carry the point.
   No preamble, no "let me walk you through."
7. **Offer depth, don't dump.** Give the clear first layer, then end by offering
   2–3 specific things the user can pull on for more. Pull, don't push.

## ASCII sketches

Plain boxes and arrows, a few nodes at most. For a flow:

```
request ──▶ handler ──▶ database
                │
                ▼
              cache
```

For a before → after:

```
  now                 after
  ───                 ─────
  A ─┐                A ─┐
  B ─┼─▶ ???          B ─┼─▶ one clear path ─▶ result
  C ─┘                C ─┘
```

Keep them readable: align arrows, label the nodes with real names, no legends.

## Workflow

1. Pin down exactly what's being asked. If the question is ambiguous, ask before
   answering.
2. Answer in chat: plain English, the three beats, short lines, an ASCII sketch
   if there's a flow worth showing.
3. Keep the precise terms, mechanics, and file paths to a brief closing note or
   the "want more?" offer — don't lead with them.

## Avoid

- Jargon walls.
- Analogies the user didn't ask for.
- Preamble and meta-commentary about how you're going to explain it.
- Restating the whole thing twice. Say it once, clearly.
- Cramming every detail in. The first answer is the first layer; offer the rest.
