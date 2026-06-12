# web-mock design notes

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/data/mock/entities.ts — entities (preview Library items)

Preview Library items covering the CONTEXT.md domain vocabulary: Journal Entry / Person / Project / Todo / Recipe.

These are VISUAL ONLY for item types not read live from Core yet. The Library hook overlays live Core rows for implemented types and keeps this fixture for the rest, mirroring how ActivityRail renders from mock data.

The shapes follow CONTEXT.md vocabulary so the future live wiring maps cleanly. The data is one coherent personal workspace (the account is "H" — Hongyi) and deliberately overlaps the API-migration project already referenced in `proposals.ts` and the Alice / daycare example from CONTEXT.md's dialogue.
