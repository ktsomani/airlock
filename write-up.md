# Airlock: The Visual Merge Engine for Agentic Canvases

Git's standard line merge cannot resolve two agents' visual intent when they edit HTML and CSS together. Reordering a div can become a delete and an insert. Airlock parses DOM trees, matches siblings with positional LCS, and compares structural node and global token changes at the intent level. It uses no pixel diffing.

## One canvas, two drafts

Start on a light canvas. Agent A drafts a hero and sets the background token to black. Agent B drafts a navbar and selects dark gray text. The hero and navbar target separate subtrees, so both appear in the projection. The navbar references a text token whose contrast against the other draft's new background falls below 4.5:1. Selecting a light text swatch updates the projection immediately. The human can then compile and merge both drafts.

## Resolution and replay

The compiler joins drafts on the hash of their captured canvas and tokens. Normalized node and token ops stay in separate keyspaces. Node matching prefers unique IDs, unique test IDs, and structural signatures before positional LCS among siblings. Shared-target subtree replacements block replay. The live adapter can combine verified plain-text updates for two distinct layers in the same Paper frame; edits to the same layer block replay. The resolution layer checks that the source drafts still match the inspected intent. The compiled draft receives its own diff-bound resolution token.

MergeLedger records which tool-call groups applied, failed, or skipped and carries the resolved conflicts. Every ledger has `atomic: false`. When Paper reports an error, a failed call may already have changed part of the canvas. Airlock records that internal result as unknown and stops replay. Resume retries the failed group and skips the known applied groups. Inspect Paper before resuming.

## Preview and adapter scope

The browser builds a structural preview from canonical nodes and selected inline styles. The contrast check covers direct text-token references and simple hex colors. Token-to-token dependency resolution (`--a: var(--b)`) is out of scope. Mock token writes support swatch-based resolution. Overwriting live token arguments requires a verified endpoint adapter. Live contracts come from the configured endpoint's `tools/list`.

See the README for [local Paper MCP](README.md#local-paper-configuration) and [remote Paper MCP](README.md#remote-paper-configuration).
