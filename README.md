# pi-pasteboard

`pi-pasteboard` is a standalone Pi package that keeps very large interactive TUI submissions out of the model context. For eligible large input, it writes the exact submitted text to a private temp file and replaces the prompt with a short file-reference instruction.

## How it hooks Pi (paste event vs. input event)

Pi's built-in paste handling collapses large pasted text in the editor as `[paste #N +X lines]` markers. This is purely visual/display-level. On submit, Pi expands the markers and fires the `input` event with the **full, uncollapsed raw text**. Pi's current extension API does **not** expose a paste event, paste marker, or paste-segment metadata that extensions can hook directly.

pi-pasteboard therefore hooks the `input` event (the only available extension surface) and uses a conservative size threshold (default 32 KiB) to decide when to redirect content to a pasteboard file. This is the only viable approach in the current Pi extension API.

**Why not a simpler paste-event approach?** There is no `paste`, `beforePaste`, or `clipboard` event in Pi's extension API. The editor's paste-marker collapse is display-only and not exposed to extensions. Until Pi adds a paste-specific event or marker metadata on `InputEvent`, size-threshold heuristics on `input` are the best available strategy. The current approach is correct for v1.

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

## Behavior

When an interactive TUI input is large enough, the extension writes the full submitted text to:

```text
/tmp/pi-pasteboard/sha256-<64 hex chars>.txt
```

Then the model receives only:

```text
Large input captured at /tmp/pi-pasteboard/sha256-....txt. Read that file if needed; do not ask the user to paste it again.
```

The transformed prompt includes no content preview. The extension does not notify on successful capture.

## Safety notes

- `/tmp/pi-pasteboard` is created as mode `0700` and must be a current-user-owned directory, not a symlink.
- Paste files are mode `0600` and content-addressed by SHA-256 of the submitted UTF-8 bytes.
- Duplicate content reuses the same file and refreshes its mtime.
- Writes use same-directory temp files plus no-overwrite hard-link creation.
- Cleanup is best-effort and deletes only old regular files matching `sha256-*.txt`.
- Default cleanup TTL is 7 days (`PI_PASTEBOARD_TTL_MS` may override). Default capture threshold is 32 KiB (`PI_PASTEBOARD_MIN_BYTES` may override).

## Conservative bypasses

The extension passes input through unchanged when it is:

- extension-sourced;
- not interactive TUI (`rpc`, `json`, and `print` modes are bypassed);
- below the size threshold;
- a slash command or bang command;
- likely to contain an `@` file reference;
- carrying images or attachments.

## v1 limitations

- Captures the whole eligible submitted text, not just the pasted segment.
- No settings UI or per-project policy controls.
- No binary/image pasteboard support.
- No RPC/json/print capture.
- No preview, custom notification, publication metadata, or segment-aware paste-only replacement.

## Development

```bash
npm test
```
