import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureInput, extensionOptionsFromEnv } from "./capture.js";
import { cleanupOldPasteFiles, cleanupOldSubmissions } from "./pasteboard.js";
import { patchEditorForSegmentedPaste } from "./pasteboard-editor.js";

// We intentionally import CustomEditor lazily inside session_start rather than
// at module scope.  If a user runs an older Pi version that does not export
// CustomEditor, a static top-level import would crash the extension at load
// time.  Dynamic import degrades gracefully: v2 segmented capture is
// unavailable, but v1 whole-input fallback remains active.

export default function (pi: ExtensionAPI) {
	const options = extensionOptionsFromEnv();
	const debug = options.debug;

	function debugLog(msg: string) {
		if (!debug) return;
		console.error(`[pi-pasteboard:debug] ${msg}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		// Clean up old paste files and submission directories.
		await cleanupOldPasteFiles(options).catch(() => undefined);
		await cleanupOldSubmissions(options).catch(() => undefined);

		// Install a custom editor wrapper that intercepts paste markers BEFORE
		// expansion.  This is the ONLY window where paste-id → content mapping
		// and typed/paste boundaries exist — after submitValue runs, markers
		// are expanded and the pastes Map is cleared irreversibly.
		if (ctx.mode === "tui") {
			// --- Dynamic import: fail gracefully on older Pi versions ---
			let CustomEditorClass;
			try {
				const mod = await import("@earendil-works/pi-coding-agent");
				CustomEditorClass = mod.CustomEditor;
			} catch {
				debugLog("CustomEditor not available; v2 segmented capture disabled.  Ensure @earendil-works/pi-coding-agent >=0.15.0.");
				ctx.ui.notify(
					"pi-pasteboard: CustomEditor unavailable; using v1 whole-input fallback",
					"warning",
				);
				return;
			}

			if (!CustomEditorClass) {
				debugLog("CustomEditor export is undefined; v2 segmented capture disabled.");
				ctx.ui.notify(
					"pi-pasteboard: CustomEditor missing; using v1 whole-input fallback",
					"warning",
				);
				return;
			}

			const previousFactory = ctx.ui.getEditorComponent();

			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				// Compose with a prior custom editor if one exists (e.g. vim mode).
				// Otherwise create a standard CustomEditor instance ourselves.
				let editor;
				if (previousFactory) {
					editor = previousFactory(tui, theme, keybindings);
				} else {
					editor = new CustomEditorClass(tui, theme, keybindings);
				}

				return patchEditorForSegmentedPaste(editor, { root: options.root });
			});

			// Let the user know which mode is active.  The notification is
			// transient — it disappears on the next render.  Set
			// PI_PASTEBOARD_DEBUG=1 for persistent console-level logging.
			ctx.ui.notify("pi-pasteboard: segmented capture active", "info");
			debugLog("segmented editor installed successfully");
		} else {
			debugLog(`non-TUI mode (${ctx.mode}); v2 editor skipped, v1 input-event fallback only`);
		}
	});

	// Fallback: whole-input capture via the `input` event.
	// This handles cases where the custom editor cannot be installed (non-TUI
	// modes, or editor patching failed at runtime).  Also serves as the
	// safety net for paste-segmentation failures.
	pi.on("input", async (event, ctx) => {
		// Steering messages interrupt mid-stream and must be fast — skip capture entirely.
		if (event.streamingBehavior === "steer") {
			return { action: "continue" };
		}

		try {
			const result = await captureInput(
				{
					text: event.text,
					source: event.source,
					mode: ctx.mode,
					images: event.images,
				},
				options,
			);

			if (result.action === "transform") {
				debugLog(`v1 whole-input capture: wrote ${result.bytes ?? "?"} bytes to ${result.path ?? "?"}`);
				return { action: "transform", text: result.text! };
			}
			return { action: "continue" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-pasteboard failed to save large input; sending original text. ${message}`, "error");
			return { action: "continue" };
		}
	});
}
