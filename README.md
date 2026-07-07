# pi-pasteboard

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

## Limitations

- **Paste markers in typed text:** If a user types literal `[paste #N ...]` text AND a matching paste ID exists in the Map (vanishingly rare — pastes are cleared every submit), the typed text is misidentified as a paste marker. The marker regex requires `[paste #` followed by a digit and optional ` +N lines` or ` N chars` suffix, which is unlikely in natural typing.
- **Small pastes (<10 lines, <1000 chars):** Pi never creates markers for small pastes — they stay inline in the typed text. These are invisible to segmentation and remain in the prompt.
- **Fragility of runtime field access:** The `pastes` Map and `pasteCounter` are declared `private` in TypeScript but are regular JS fields at runtime. If Pi upstream changes these to ECMAScript `#private` fields, the custom editor wrapper falls back to v1 whole-input capture. The extension logs nothing on fallback — the `input` event handler is the safety net.
- **Post-submit reconstruction is impossible:** Once markers are expanded and the pastes Map is cleared, there is no way to recover typed/paste boundaries. The editor wrapper is the sole interception window.
- **Compatibility with other custom editors:** The wrapper composes with prior editor factories via `ctx.ui.getEditorComponent()`. If another extension installed a custom editor (e.g., vim mode), this wrapper delegates to it and then patches the result.

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

## Development

```bash
npm test
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
