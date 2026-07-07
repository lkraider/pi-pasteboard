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

		const stateLines = this.state?.lines;
		if (!stateLines || !Array.isArray(stateLines)) {
			return originalSubmitValue();
		}

		const markerText = stateLines.join("\n");

		// Fast bail-out: no paste markers in the text
		if (!HAS_PASTE_MARKER_RE.test(markerText)) {
			return originalSubmitValue();
		}

		// --- Segment and transform ---
		try {
			const result = processSegmentedPastes(markerText, pastes, { root });

			// Replace editor text with the transformed version.
			// Mutate the existing state object so originalSubmitValue's read
			// of this.state.lines.join("\n") picks up our transformed text.
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
