# Airlock

[Watch the 55-second Paper Desktop walkthrough](https://github.com/ktsomani/airlock/raw/refs/heads/main/launch/airlock-paper-full-workflow.mp4) to see Codex stage a welcome card through Airlock MCP, the designer review it in Pressure and approve admission, and the card render on the live Paper canvas.

Open **Pressure** from a review to compare its staged canvas states, or visit `/pressure/` for the sample. See the [Pressure README](public/pressure/README.md) for the snapshot format and browser tests.

**A human checkpoint between an agent and your Paper canvas.**

Airlock is a local, open-source MCP proxy with a CLI and a small web review chamber. Agents stage normalized changes over a captured base; a human inspects and approves the diff; approved tool calls are replayed to Paper. It is a staging chamber, not a VCS: no branches, commits, merges, or history graph.

The complete demo runs against a persistent mock canvas. Live transport and runtime schema discovery are implemented. **Live semantic reads/writes require an endpoint-specific adapter**, implemented from the configured endpoint's actual `tools/list` contract. No live Paper instance was used to validate the bundled demo. The mock catalog is never a live fallback.

## Run locally

Requires Node 20+ and pnpm. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo
pnpm start
```

Open **http://127.0.0.1:4317**. Inspect the demo's node and token changes, approve its diff, then admit it. `pnpm dev` runs the UI directly from TypeScript. `pnpm test` runs the safety and integration tests; `pnpm check` checks types. The native SQLite dependency may need a compiler toolchain on platforms without a prebuilt binary.

The commands below use `node dist/cli.js`; the package also exports an `airlock` executable. `pnpm exec airlock` is available after installing the package as a dependency, or use a global package link.

```sh
node dist/cli.js open "Welcome screen" --agent Cursor
node dist/cli.js tools
node dist/cli.js stage <review-id> write_html @examples/mock-call.json
node dist/cli.js diff <review-id>
node dist/cli.js approve <review-id> --diff-hash <inspected-diffHash>
node dist/cli.js admit <review-id> --token <approvalToken>
```

`mock-call.json` is a **mock-only fixture**, not a documented Paper input contract. `approve` returns `{approvalToken, diffHash}`. The UI requires the hash of the displayed diff; the CLI's optional `--diff-hash` provides the same protection against unseen changes between inspection and approval. Keep the raw token private; you can pass it via `AIRLOCK_APPROVAL_TOKEN` instead of a shell argument. Approval is separate from admission. CLI exit codes: 0 success, 1 error, 2 partial admission.

## Agent connection

Configure your MCP host to launch Airlock instead of giving that agent direct write access to Paper:

```json
{
  "mcpServers": {
    "airlock": {
      "command": "node",
      "args": ["/absolute/path/to/airlock/dist/cli.js", "serve"],
      "env": {
        "PAPER_MCP_MODE": "mock",
        "AIRLOCK_DATA_DIR": "/absolute/path/to/shared-airlock-data"
      }
    }
  }
}
```

Use the same **absolute** data directory and environment for the UI, CLI, and every agent process. Relative directories resolve from each process's working directory. On Windows, use a JSON-escaped absolute path or forward slashes.

The stdio proxy exposes `airlock_open`, `airlock_list`, `airlock_tools`, `airlock_diff`, `airlock_stage`, and `airlock_admit`. Verified read tools and passthrough tools retain their upstream names. Agents discover original upstream input/output contracts with `airlock_tools`, then pass unmodified tool arguments to `airlock_stage`. Writes called directly without a review fail closed. Unknown capabilities are treated as writes and require an adapter.

**Human-only approval:** `airlock_approve` is exported from `dist/index.js` and served through `airlock approve` and the local UI. It is deliberately not advertised to agents over MCP. Otherwise an agent could approve its own changes. The admission MCP tool requires the human-issued token. Airlock's local data, secret, UI, and approval CLI must remain outside an untrusted agent's access. This is a workflow boundary, not a sandbox against an agent with unrestricted access to the same operating-system account.

## Local Paper configuration

Copy `.env.example` to `.env`, configure a unique data directory and strong secret, and opt into live mode explicitly:

```dotenv
PAPER_MCP_MODE=live
AIRLOCK_LIVE_CONFIRM=1
AIRLOCK_APPROVAL_SECRET=<random-secret-at-least-32-characters>
AIRLOCK_DATA_DIR=.airlock-live
PAPER_MCP_ENDPOINT=http://127.0.0.1:29979/mcp
AIRLOCK_ADAPTER=./my-paper-adapter.mjs
```

Alternatively, point to your local bridge command:

```dotenv
PAPER_MCP_ENDPOINT='stdio:"C:/path with spaces/paper.exe" mcp'
```

Copy the actual bridge path from Paper's connection panel. `shell-quote` parses command/arguments without a shell; operators such as pipes, redirects, and command separators are rejected. Environment expansion is disabled. Shell scripts must be invoked through their explicit interpreter, and trusted command configuration is required.

Paper documents its local stdio bridge and legacy local HTTP endpoint in its [MCP guide](https://paper.design/docs/mcp). This is connection guidance only; no public-doc JSON schemas are copied or assumed. The client uses the [official TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

`client.connect()` races an 8-second timer by default. Timeout closes the client and reports:

```text
Could not connect to Paper MCP at <endpoint>. Is Paper Desktop running with a file open?
```

Set `PAPER_MCP_CONNECT_TIMEOUT_MS` if necessary. Use header-based credentials, not secrets embedded in endpoint URLs (the endpoint appears in errors).

## Remote Paper configuration

Airlock can run near a cloud agent and connect to a configured, authenticated remote **Streamable HTTP** MCP endpoint:

```dotenv
PAPER_MCP_MODE=live
AIRLOCK_LIVE_CONFIRM=1
AIRLOCK_APPROVAL_SECRET=<random-secret-at-least-32-characters>
PAPER_MCP_ENDPOINT=https://your-paper-gateway.example/mcp
PAPER_MCP_HEADERS='{"Authorization":"Bearer <gateway-token>"}'
AIRLOCK_ADAPTER=./my-paper-adapter.mjs
```

That URL is illustrative, not a claim that Paper provides a public hosted service. Use a remote endpoint you operate or are authorized to access. Headers must be a JSON string-to-string object. Do not put them in version control. The local review UI binds only to `127.0.0.1`; reach a remotely running UI through a trusted tunnel. Airlock's agent-facing transport is stdio; remote capability here refers to its upstream Paper connection. Built-in OAuth negotiation and a public multi-user UI are outside this implementation.

## Live adapters and authoritative schemas

Start with `node dist/cli.js tools` in live mode. This can discover and inspect contracts even without an adapter. Implement `examples/live-adapter.mjs` for the exact discovered contract; this file is an interface scaffold, **not a working Paper adapter**. The adapter must capture the entire canvas and global tokens, provide stable target/file identities, and predict every effect of every supported tool. Partial snapshots are not adequate for base identity. Verify adapters against a disposable live document before trusting them.

The internal adapter interface is independent of Paper:

```ts
interface Adapter {
  classify(name: string): 'read' | 'write' | 'passthrough' | undefined;
  capture(paper: Paper): Promise<Snapshot>;
  normalize(
    name: string,
    args: Record<string, unknown>,
    state: Snapshot,
  ): Mutation[] | Promise<Mutation[]>;
}
```

`Snapshot` contains `canvas: Record<targetId, CanonicalNode[]>` and `tokens: Record<varName, string>`. Internal mutations replace a target's predicted HTML subtree or set/delete a global token. For an append-style upstream call the adapter must produce the entire resulting subtree, while the original upstream arguments remain the replay payload. Fail closed for tools or effects the adapter cannot represent. The core rejects embedded stylesheets; adapters need explicit normalization before supporting them.

The bundled capability map gives **names and rough purposes only**, never schemas. Actual availability and contract columns resolve at runtime:

| Name                                                | Classification | Rough purpose                       |
| --------------------------------------------------- | -------------- | ----------------------------------- |
| `get_basic_info`, `get_selection`                   | read           | Inspect file or selection           |
| `get_node_info`, `get_children`, `get_tree_summary` | read           | Inspect node structure              |
| `get_screenshot`, `get_jsx`, `get_computed_styles`  | read           | Inspect render/code/style           |
| `write_html`                                        | write          | Create or update HTML-derived nodes |
| `update_styles`, `set_text`, `delete_nodes`         | write          | Modify canvas content               |
| `create_artboard`, `duplicate_nodes`                | write          | Add canvas structures               |
| `finish_working_on_nodes`                           | passthrough    | Release working indicators          |

The classifier and this map agree. `finish_working_on_nodes` is always directly forwarded, never staged, diffed, or replayed. Mock-only `get_canvas` and `set_tokens` exist only in the fixture. Unknown names fail closed as writes; an adapter must verify any newly classified read.

## Contract cache and drift

Every cache record has `{tools, fetchedAt, hash, source, degraded, toolHashes, changed, removed, baseHash}`. Cache identity includes endpoint, mode, and a hash of headers; header values are not stored in cache keys. Mock cache provenance is `source: "catalog"`; live cache provenance is `source: "live"`.

`toolHash = sha256(name + canonical(inputSchema) + canonical(outputSchema ?? null))`. Descriptions, annotations, and other prose do not affect contract hashes. Object keys are sorted deterministically. The catalog's mock definitions are never used for live validation.

`airlock serve` and `airlock start` always attempt fresh `tools/list` on boot and fail if discovery fails. Other CLI commands also attempt refresh; if unreachable they can use an existing live cache only while inside `SCHEMA_CACHE_TTL_MINUTES` (default 60). Expired caches fail `schema_stale`. Long-lived processes refresh when TTL expires. Admit always requires live discovery again.

Changed hashes enter `changed`; missing tools enter `removed`. Both persist across refreshes. `airlock schema accept-drift` clears **only changed**, updating the accepted aggregate `baseHash`. Removed tools still throw `SCHEMA_REMOVED`. A restored tool requires contract inspection before staging. Accepting drift does not reinterpret previously staged calls: a group pinned to an old hash fails `staged_schema_drift` and must be staged in a new review with an updated adapter.

## Review and admission invariants

1. Capture a snapshot; store canonical `canvas_json`, `tokens_json`, and `base_hash = sha256(canvas_json + tokens_json)` in `snapshots`. Reviews opened on the same state share this hash, even with different snapshot IDs.
2. Validate against the discovered input contract. Normalize into separate `node_ops` and `token_ops`; replay information lives in ordered originating tool-call `groups`.
3. `write_html` is parsed with `node-html-parser`, never diffed as a string. Canonical nodes carry `path`, `tag`, `id`, `testid`, sorted `classes`, `text`, `style`, and extra attributes. Text preserves whitespace and descendant order so preformatted content and text moving around child elements cannot disappear from the diff. Matching order: unique ID → unique testid → tag/classes/text hash → positional LCS among siblings. Ambiguous duplicate IDs/testids are rejected.
4. CSS custom properties are global token operations keyed by `varName`; they do not require a target node. Node `var(--x)` references conflict with another pending review's `--x` mutation, in either direction. Conflict joins use shared snapshot `base_hash`. Subtree replacement overlaps are conservatively blocked even when different individual nodes changed, because replay replaces the whole subtree.
5. A human inspects and approves. `diffHash` hashes the sorted list of `{opId, after}` with canonical after-values. The random approval token is stored only as a keyed SHA-256 digest in `reviews.approval_token_hash`; the raw token is returned once, kept only in browser memory, and never persisted by Airlock. Every new staged op clears approval.
6. Admission checks token, current diff hash, pending conflicts, fresh schemas, pinned group contracts, and current base identity before the first run. Any external canvas change requires a new review; there is no automatic rebase.
7. Groups replay in order. A successful group marks all its ops `applied`. On the first thrown call or MCP `isError`, that group's ops become `failed` with `appliedWithinGroup: "unknown"`; every later group becomes `skipped`; the review becomes `partial`; replay stops. The report has `partialWithinGroup: "unknown"`. **A failed group may have landed internally.** No inverse writes or automatic rollback are attempted. Every report contains `atomic: false`.
8. Admitting a `partial` review without `--resume` fails `resume_required`. Resume skips applied groups and retries the first failed/skipped group as a whole. It uses the same diff-bound approval unless a human issues a replacement token. Completed groups are idempotent in Airlock; a partially failed upstream call may duplicate internal effects on retry. Inspect Paper first.

```sh
node dist/cli.js admit <review-id> --token <approvalToken> --resume
```

The durable SQLite lock serializes mutation/admission across cooperating processes using the same database. It is intentionally not automatically expired: a timed-out process may have sent a write. After a crash, **stop all Airlock processes and inspect Paper**, then run `airlock recover --confirm-stopped`. An interrupted applying group becomes failed/unknown; later groups become skipped. Restart the UI/agents and explicitly resume. Database transactions keep local bookkeeping consistent; they do not make Paper writes transactional.

## Limits and trust model

- **Token-to-token dependency resolution (`--a: var(--b)`) is out of scope.** Direct node-to-token references are detected; transitive token dependency graphs are not.
- Live semantic coverage depends on a verified adapter and a complete snapshot. No stable Paper JSON schema is assumed. The demo's replacement semantics are deliberately mock-only.
- HTML normalization is structural rather than a full browser CSS engine. Stylesheets, scoped custom-property semantics, CSS escapes in variable names, generated content, and style inheritance need additional adapter support. Mock HTML uses inline styles; inline custom properties are lifted to global token operations.
- Airlock does not lock Paper itself. A direct client can race between preflight capture and replay. Remove direct agent write connections and coordinate human edits during admission. Resume cannot establish the precise internal result of a failed call; it therefore does not claim a clean base or perform rollback.
- The human UI is local, with host/origin checks, a per-process CSRF token, restrictive CSP, and no execution of staged HTML. It is not a hardened boundary against malicious software running as the same user. Do not expose it publicly.
- Reviews contain canvas content and original arguments in SQLite. Protect the data directory. Secrets and raw approval tokens are not written to it. Read/passthrough MCP results are forwarded as supplied by the upstream service.
- `better-sqlite3` is a local durable store, not a distributed coordinator. Processes coordinating reviews must share one database on a suitable local filesystem.

## Layout

`src/schema.ts`: discovery/cache/drift; `src/html.ts`: structural normalization; `src/engine.ts`: reviews, approvals, conflicts, admission; `src/paper.ts`: transports, classifier, mock fixture; `src/mcp.ts`: agent-facing server; `src/web.ts` and `public/`: local human UI; `src/cli.ts`: CLI. `test/` covers the hard requirements and transport/UI integration. CI runs mock checks on Node 20/22 on Windows and Linux.

MIT licensed.
