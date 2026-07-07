# pi-pasteboard

> **Keeps large pastes out of model context.** Segments typed text and pasted content at the TUI boundary, saves pastes as private local files, and gives the model file references instead of 100 KB paste blobs. Automatic, transparent, zero-config.

`pi-pasteboard` is a standalone Pi package that keeps very large interactive TUI submissions out of the model context. It offers two capture strategies that activate automatically:

- **v2 segmented (active by default):** Intercepts paste boundaries BEFORE marker expansion via a custom editor wrapper. Pastes are saved as individual private files; typed text stays inline. The model sees file references instead of huge paste blobs.
- **v1 whole-input (fallback):** Hooks the `input` event with a 32 KiB size threshold. The entire submission is saved as one content-addressed file. Used when the custom editor cannot install or paste internals are unreachable.

## How it works (v2 segmented)

Pi's editor collapses large pastes (>10 lines or >1000 chars) into display markers like `[paste #1 +123 lines]`. Before submit these markers and the `pastes` Map coexist — afterwards markers are expanded and the Map is cleared, forever losing the typed/paste boundary.

pi-pasteboard installs a custom editor wrapper on `session_start` via `ctx.ui.setEditorComponent()` that monkey-patches `submitValue()`. The wrapper reads marker-bearing text and the runtime `pastes` Map BEFORE expansion, then:

1. Parses the marker text into ordered segments: `typed → paste → typed → paste → typed`.
2. Saves each paste to a 0600 file under `/tmp/pi-pasteboard/submissions/<uuid>/paste-<N>.txt`.
3. Writes a `manifest.json` with segment metadata (submission id, order, kind, file path, byte/line counts, timestamps, fallback reason if any).
4. Replaces each paste marker with `[paste saved: <path>]` so the model can `read` the file.
5. Lets the original submit flow continue — the model sees only short file references.

### Example

User submits: `Review this:\n` + [paste 500 lines of code] + `\nThanks!` + [paste 200 lines of config]

The model receives:

```
Review this:
[paste saved: /tmp/pi-pasteboard/submissions/<uuid>/paste-1.txt]
Thanks!
[paste saved: /tmp/pi-pasteboard/submissions/<uuid>/paste-3.txt]
```

And can read each paste file individually via the `read` tool.

## v1 whole-input fallback

The v1 `input`-event handler remains active as a safety net. When the custom editor cannot install (non-TUI modes, editor patching failure at runtime), or when pastes are absent, the existing 32 KiB threshold whole-input capture takes over:

- Writes the full submitted text to `/tmp/pi-pasteboard/sha256-<hash>.txt`.
- Replaces the prompt with: `Large input captured at <path>. Read that file if needed; do not ask the user to paste it again.`

The fallback is explicit: the manifest (v2) or the absence of a submission directory (v1) makes it clear which path was taken.

## Install

From a checkout:

```bash
pi install /absolute/path/to/pi-pasteboard
```

For one run without installing:

```bash
pi -e /absolute/path/to/pi-pasteboard
```

The package manifest exposes `./src/index.ts` as a Pi extension.

## Safety notes

- `/tmp/pi-pasteboard` is created as mode `0700` and must be a current-user-owned directory, not a symlink.
- v1 paste files are mode `0600`, content-addressed by SHA-256. Duplicate content reuses the same file.
- v2 paste files and manifests are mode `0600` under per-submission directories.
- Writes use same-directory temp files plus no-overwrite hard-link creation.
- Cleanup is best-effort: old `sha256-*.txt` files and expired submission directories are removed on session start.
- Default cleanup TTL is 7 days (`PI_PASTEBOARD_TTL_MS` may override). Default capture threshold is 32 KiB (`PI_PASTEBOARD_MIN_BYTES` may override).
- The pasteboard root directory is `/tmp/pi-pasteboard` by default.  Override via `PI_PASTEBOARD_ROOT` env var.

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_PASTEBOARD_ROOT` | `/tmp/pi-pasteboard` | Storage root directory |
| `PI_PASTEBOARD_MIN_BYTES` | `32768` | Minimum byte threshold for v1 whole-input capture |
| `PI_PASTEBOARD_TTL_MS` | `604800000` (7 days) | Retention period for paste files and submission dirs |
| `PI_PASTEBOARD_DEBUG` | unset | When `1`, emits debug-level logs to stderr about mode selection, fallback decisions, and I/O operations |

With `PI_PASTEBOARD_DEBUG=1`, the extension logs whether v2 segmented capture is active, why a fallback occurred, and per-capture metadata (byte counts, file paths).  Without it, only a transient TUI notification marks mode installation — no ongoing noise.

## Limitations

### Paste marker misidentification

If a user types literal `[paste #N ...]` text AND a matching paste ID exists in the Map (vanishingly rare — pastes are cleared every submit), the typed text is misidentified as a paste marker. The marker regex requires `[paste #` followed by a digit and optional ` +N lines` or ` N chars` suffix, which is unlikely in natural typing.

### Small pastes

Small pastes (<10 lines, <1000 chars): Pi never creates markers for small pastes — they stay inline in the typed text. These are invisible to segmentation and remain in the prompt.

### Synchronous I/O latency

Paste-segment files and the manifest are written **synchronously** inside the editor's `submitValue()` — the same call-path that runs the terminal render loop.  Each submission writes `N` paste files + one manifest.  On a local SSD with typical paste sizes (<1 MB each), this adds ~1–2 ms per file; a 5-paste submission might add <10 ms total, which is imperceptible.  On a slow or network filesystem the per-file latency could reach tens of milliseconds.

To bound the worst case, the segmenter caps submissions at **50 segments** (files).  Exceeding the cap causes the patcher to fall back to v1 whole-input capture (one file).  This is a hard guardrail — the submission is NOT silently corrupted; the original markers expand normally and the v1 `input`-event handler captures the expanded text.

### Runtime field fragility

The `pastes` Map, `pasteCounter`, and `state` object are declared `private` in TypeScript but are regular JS fields at runtime.  If Pi upstream changes these to ECMAScript `#private` fields, `this.getText()` (public API) still works but `this.pastes` / `this.state.lines` become unreachable.  In that scenario the patcher falls back to v1 whole-input capture, and the transient notification (or debug log at `PI_PASTEBOARD_DEBUG=1`) documents the fallback reason.

### Public API preference

The patcher reads marker text via `this.getText()` (the public, documented method) rather than `this.state.lines.join("\n")`.  For writing transformed text back, it mutates `state.lines` directly rather than calling `this.setText()`.  The public `setText()` exists on the `Editor` class but triggers `onChange` and autocomplete side effects during the critical submit-interception window.  If a future Pi version makes `setText()` side-effect-free for this use case, the mutation can be switched to the public API.

### Post-submit reconstruction impossible

Once markers are expanded and the pastes Map is cleared, there is no way to recover typed/paste boundaries. The editor wrapper is the sole interception window.

### Compatibility with other custom editors

The wrapper composes with prior editor factories via `ctx.ui.getEditorComponent()`.  If another extension installed a custom editor (e.g., vim mode), this wrapper delegates to it and then patches the result.

**Factory-replacement fragility:** If a third extension calls `ctx.ui.setEditorComponent()` AFTER pi-pasteboard installs its wrapper, the segmented capture is silently replaced.  There is no hook to detect being swapped out.  The v1 `input`-event fallback remains active regardless, so the worst outcome is falling back to whole-input mode mid-session.  This is a Pi API limitation — extensions cannot "stack" editor factories.

### Pi version requirement

v2 segmented capture requires `@earendil-works/pi-coding-agent` exporting the `CustomEditor` class (available since v0.15.0+).  The import is dynamic — on older Pi versions the extension loads without crashing, emits a warning notification, and runs in v1 whole-input-only mode.

## Conservative bypasses (v1 fallback)

The v1 `input`-event handler passes input through unchanged when it is:

- extension-sourced;
- not interactive TUI (`rpc`, `json`, and `print` modes are bypassed);
- below the size threshold;
- a slash command or bang command;
- likely to contain an `@` file reference;
- carrying images or attachments;
- a steering message (`streamingBehavior === "steer"`).

These bypasses do not apply to v2 segmented capture — if the editor wrapper is active, segmentation fires on every submit regardless of size/source (only large pastes have markers, so small submits are effectively no-ops).

## Privacy

- Paste contents are written **only** to local temp files on your machine. Nothing is sent to any external service.
- Files are mode `0600` (v2 submissions) or `0600` (v1) — readable only by the file owner.
- The submission root (`/tmp/pi-pasteboard`) is mode `0700` — no other user can list contents.
- Paste content is **never** logged or stored in Pi's session history. Only the `[paste saved: <path>]` reference appears in the prompt.
- The manifest JSON records metadata (byte counts, timestamps, segment order) but does **not** include the text of typed segments longer than a few characters.
- Enable `PI_PASTEBOARD_DEBUG=1` only for troubleshooting — debug output includes file paths but still excludes paste content.

## Cleanup

Both v1 paste files and v2 submission directories are removed automatically on session start:

- Files/directories older than the TTL (default 7 days) are deleted.
- A `.cleanup.lock` file prevents concurrent cleanup from multiple Pi processes (stale locks expire after 10 minutes).
- To force immediate cleanup without starting a session: delete files/directories manually under `/tmp/pi-pasteboard/`.
- The root directory itself is NOT removed — only its contents.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| No `[paste saved:]` refs in prompt — just expanded text | Editor wrapper not installed or fell back. v1 whole-input may still fire for large inputs. | Run with `PI_PASTEBOARD_DEBUG=1` and check stderr for fallback reason. |
| "CustomEditor unavailable" notification | Pi version too old (<0.15.0) | Update Pi; v1 fallback remains active. |
| Submission feels laggy | Sync I/O on slow filesystem; many segments | Check `PI_PASTEBOARD_ROOT` isn't on a network drive. Segment cap (50) prevents worst case. |
| Paste files not cleaned up | Stale lock or permission issue | Check `/tmp/pi-pasteboard/.cleanup.lock` and `/tmp/pi-pasteboard/submissions/.cleanup.lock`. Delete stuck lock files manually. |
| Segmented capture stopped working mid-session | Another extension replaced the editor factory | This is a known limitation (see Limitations above). v1 fallback takes over. Restart session to reinstall. |

## Development

```bash
npm test          # run all tests
npm run typecheck # TypeScript compilation check
npm run lint      # alias for typecheck
```

## File layout

```
/tmp/pi-pasteboard/
├── sha256-<hash>.txt          # v1 whole-input files
├── .cleanup.lock              # cleanup mutual-exclusion lock
└── submissions/
    └── <uuid>/
        ├── manifest.json      # segment metadata
        ├── paste-0.txt        # paste segment files (0600)
        ├── paste-1.txt
        └── ...
```
