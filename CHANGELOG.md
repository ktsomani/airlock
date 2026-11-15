# Airlock release notes

## Features

- **Pressure visual review.** Open a staged review in Pressure to compare before and proposed states as live DOM in two synchronized panes. Scrub supported changes and inspect labeled crossfades for properties that cannot be interpolated.
- **Cascade inspection.** Pressure displays the previous and current winning rules verbatim when a full snapshot pair supplies them. Reviews reconstructed from Airlock’s current API mark missing rule provenance as unavailable.
- **Keyboard review and performance feedback.** Use `J` and `K` to navigate changes, `Space` to emit an approval decision, `X` to reject, and `Esc` to abort the review. Pressure switches to crossfades and displays the measured p95 when the scrub frame budget is exceeded. Airlock controls approval and admission.
- **Live Paper Desktop adapter.** Connect to Paper Desktop over MCP, capture page snapshots, and prepare supported `write_html` calls for replay after approval.

## Bug fixes

- **Corrected node IDs on replay.** Airlock uses `fileId:rootNodeId` internally for snapshot targets. The replay payload sends the bare `targetNodeId` that Paper expects, alongside `fileId`, `mode`, and `html`.
- **Surfaced MCP replay errors.** Failed admissions log Paper’s response or the thrown error to the terminal with review, tool call group, and tool identifiers. The UI displays the returned error.
- **Handled Paper page-root restrictions.** Airlock catches unsupported root-level `replace` calls during staging. For a captured empty page, the staging form can prefill `insert-children` with the captured root ID.

## Testing

- **80 Airlock tests passed across five files**, including MCP transport and local review API integration tests.
- **TypeScript build passed.**
- **Four Pressure browser assertions passed.** The DOM at 100% matches the proposed sample structurally, the unchanged fixture node retains its geometry, an unsupported property shows a labeled crossfade, and repeated approval keypresses emit one decision event.
