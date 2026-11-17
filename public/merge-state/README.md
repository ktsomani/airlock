# Merge State

Merge State is a local review surface for Airlock. It uses browser APIs and plain HTML, CSS, and JavaScript, with no dependencies in the surface itself.

From the Airlock package, run `pnpm build` and `node dist/cli.js start`. Open `http://127.0.0.1:4317/merge-state/` for the sample, or use **Open in Merge State** from a review. Run the browser assertions at `/merge-state/?test`.

## Supply a full snapshot pair

Use **Import review** with a JSON file, or call the exported `loadReview(input)` function from the local host. The surface also accepts a `merge-state:load` event dispatched to `#merge-state`, with the input in `detail`.

```json
{
  "id": "review-42",
  "mutationId": "mutation-8",
  "diffHash": "host-supplied-diff-hash",
  "title": "Update the label",
  "before": {
    "html": "<p data-merge-state-id=\"label\">Trail open</p>",
    "css": "p { color: #4c6558; }"
  },
  "proposed": {
    "html": "<p data-merge-state-id=\"label\">Trail open</p>",
    "css": "p { color: #244c30; }"
  },
  "changes": [{
    "id": "label",
    "label": "Trail label",
    "properties": [{
      "name": "color",
      "before": "rgb(76, 101, 88)",
      "after": "rgb(36, 76, 48)",
      "previousRule": "p { color: #4c6558; }",
      "rule": "p { color: #244c30; }"
    }]
  }]
}
```

Load one pair per mutation, or provide a combined pair for reviewing a full proposal. HTML is a fragment, and CSS is optional. Keep `data-merge-state-id` stable and unique within each snapshot. List all affected nodes, including nodes whose boxes move indirectly. Set `structural: true` for content or structure changes. Nodes may exist in just one snapshot. Supply CSS property names in kebab case. Rules are displayed as received, and missing rules are marked unavailable. The existing Airlock review endpoint supplies canonical nodes and inline styles only, so its link opens a labeled reconstruction rather than a full fidelity snapshot pair. Global token values in the reconstruction are applied as CSS custom properties, but the bridge cannot infer their computed cascade.

`merge-state:decision` bubbles from `#merge-state` once per loaded pair. Its detail contains `decision` (`approve`, `reject` or `abort`), `reviewId`, `mutationId` and `diffHash`. The Airlock link is a preview. Decisions are local events. Approve and admit from Airlock to change a review or the canvas.

## Rendering and limits

- Each pane renders live DOM in a sandboxed frame. Scripts, embedded documents and network resources are unavailable. Safe HTML fragments match the proposed subtree at 100%. Unsafe input is sanitized before display.
- Scroll is visual and uses the same pixel offset on both pane layers. Dimensions are read at setup or resize. Wheel, keyboard, touch, and the shared scroll control write transforms without reading layout.
- Scrubbing measures supported boxes and computed style up front. It seeks paused browser animations from one animation frame callback, without creating per-frame arrays, keyframes, DOM elements, or style strings. Color is interpolated by the browser. Transform and box motion are composed as matrices. The browser may still paint interpolated colors.
- Only changed nodes receive animations. A changed ancestor may require a labeled subtree crossfade, which can visually affect descendants. The exact pane layouts can differ when the edit causes document reflow. Merge State cannot guarantee fixed geometry for nodes whose actual captured boxes differ. There is no independent interpolation for those layout changes unless the producer supplies them in the diff.
- Added or removed nodes, structural edits, overlapping subtree changes, unsupported CSS properties and unsupported transforms fall back to a labeled crossfade. Clipped or complex nested layouts may be approximated by that layer.
- The performance gate measures animation frame intervals, including display cadence. A rolling p95 above 8.33 ms for 500 ms switches the loaded pair to crossfades and shows the measured interval. A 60 Hz display can trigger this budget even on a lightly loaded page.
- While the surface has keyboard focus, Tab cycles inside it. J and K move selection, Space approves, X rejects and Escape aborts. A browser or operating system shortcut can still move focus away from the page.

## Visual language

Merge State pairs a graphite workspace with pale canvases. Cornflower blue marks active controls and amber marks approximations. A compact monospace register distinguishes IDs, rules and numerical controls from the subject of the review. The sample’s contour lines are procedural CSS. The tool’s visual identity is independent of the content shown in its comparison panes.
