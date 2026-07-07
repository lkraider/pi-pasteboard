import { processSegmentedPastes } from "./segmenter.js";
import { DEFAULT_ROOT, HAS_PASTE_MARKER_RE } from "./constants.js";

/**
 * Monkey-patch an editor instance so that `submitValue()` intercepts paste
 * markers BEFORE expansion.  Pastes are saved to private per-submission
 * directories and replaced with file-reference text.  Typed text stays inline.
 *
 * When the editor internals (pastes Map, pasteCounter) are unavailable or the
 * patching fails, the original submitValue behaviour is preserved unchanged
 * — the v1 whole-input capture via the `input` event remains the fallback.
 *
 * @param {import("@earendil-works/pi-tui").Editor} editor  An Editor (or
 *   CustomEditor) instance freshly created by the editor factory.
 * @param {{root?:string}} [options]
 * @returns {typeof editor}  The same instance, now patched.
 */
export function patchEditorForSegmentedPaste(editor, options = {}) {
	const root = options.root ?? DEFAULT_ROOT;

	// Capture the original submitValue before we shadow it.
	// TS declares submitValue as private but in compiled JS it is a regular
	// prototype method — accessible at runtime.
	const originalSubmitValue = editor.submitValue.bind(editor);

	editor.submitValue = function () {
		// --- Safe runtime checks for the internal paste machinery ---
		// These fields are regular JS properties (not #private), accessible
		// on the instance even though TS types mark them private.
		const pastes = this.pastes;

		if (!pastes || !(pastes instanceof Map) || pastes.size === 0) {
			return originalSubmitValue();
		}

		// Use the public API to read marker-bearing text.  This is the
		// documented way to get text before paste expansion; it avoids
		// direct coupling to the private state.lines internal layout.
		let markerText;
		try {
			markerText = this.getText();
		} catch {
			return originalSubmitValue();
		}

		if (typeof markerText !== "string" || markerText.length === 0) {
			return originalSubmitValue();
		}

		// Fast bail-out: no paste markers in the text
		if (!HAS_PASTE_MARKER_RE.test(markerText)) {
			return originalSubmitValue();
		}

		// --- Segment and transform ---
		try {
			const result = processSegmentedPastes(markerText, pastes, { root });

			// Segment-count cap exceeded — fall back to original behaviour
			// so the v1 whole-input capture takes over.
			if (result.error === "too-many-segments") {
				return originalSubmitValue();
			}

			// Replace editor text with the transformed version.
			// We mutate state.lines directly rather than calling setText()
			// to avoid triggering onChange / autocomplete side effects during
			// the submit interception window.  The public setText() method
			// exists but would fire callbacks we don't want here.
			const stateLines = this.state?.lines;
			if (!stateLines || !Array.isArray(stateLines)) {
				return originalSubmitValue();
			}
			this.state.lines = result.transformedText.split("\n");
			this.state.cursorLine = 0;
			this.state.cursorCol = 0;

			// Clear pastes so expandPasteMarkers in originalSubmitValue is a
			// no-op (markers are already replaced with file refs).
			this.pastes.clear();
			this.pasteCounter = 0;
		} catch {
			// If anything fails (disk full, permission error, etc.), fall
			// through to the original behaviour.  The v1 whole-input capture
			// via the `input` event still fires as a safety net.
		}

		return originalSubmitValue();
	};

	return editor;
}
