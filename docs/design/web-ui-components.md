# web-ui-components

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/components/ui/workspace-shell.tsx — WorkspaceShell carved-bay layout

The card's top-right is carved into a "bay" that holds the floating control whenever a rail is present — present or collapsed, the card shape is the same, so the bay never pops in or out as the rail toggles.

We measure the card and write the clip-path AND the matching border outline straight to the DOM inside the ResizeObserver (no React state). Routing it through state lagged a frame behind the width during the collapse animation, which made the carved edge flicker; a direct style/attr write lands in the same frame as the resize. With no rail at all (e.g. the Library's Today overview) the card is a plain rounded rectangle.

The border SVG is clipped to the same shape so only the inner half of the stroke shows. Otherwise the stroke straddles the card edge and its outer half is cut off-screen when the card sits at the viewport edge.

The grid always keeps a thin strip of chrome on the right (never 0px) so the card's rounded right edge and its frame stay visible against the sidebar — the boundary reads the same whether the rail is open, collapsed to a sliver, or absent entirely (the Library with nothing selected). The strip only ever shows bg, no content.
