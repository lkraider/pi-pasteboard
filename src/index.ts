import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureInput, extensionOptionsFromEnv } from "./capture.js";
import { cleanupOldPasteFiles, cleanupOldSubmissions } from "./pasteboard.js";
import { patchEditorForSegmentedPaste } from "./pasteboard-editor.js";

export default function (pi: ExtensionAPI) {
	const options = extensionOptionsFromEnv();

	pi.on("session_start", async (_event, ctx) => {
		// Clean up old paste files and submission directories.
		await cleanupOldPasteFiles(options).catch(() => undefined);
		await cleanupOldSubmissions(options).catch(() => undefined);

		// Install a custom editor wrapper that intercepts paste markers BEFORE
		// expansion.  This is the ONLY window where paste-id → content mapping
		// and typed/paste boundaries exist — after submitValue runs, markers
		// are expanded and the pastes Map is cleared irreversibly.
		if (ctx.mode === "tui") {
			const previousFactory = ctx.ui.getEditorComponent();

			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				// Compose with a prior custom editor if one exists (e.g. vim mode).
				// Otherwise create a standard CustomEditor instance ourselves.
				let editor;
				if (previousFactory) {
					editor = previousFactory(tui, theme, keybindings);
				} else {
					editor = new CustomEditor(tui, theme, keybindings);
				}

				return patchEditorForSegmentedPaste(editor, { root: options.root });
			});
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
				return { action: "transform", text: result.text };
			}
			return { action: "continue" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-pasteboard failed to save large input; sending original text. ${message}`, "error");
			return { action: "continue" };
		}
	});
}
