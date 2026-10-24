import { processSegmentedPastes } from "./segmenter.js";
import {
	DEFAULT_ANNOTATE_PASTE_SIZE,
	DEFAULT_INLINE_FORMAT,
	DEFAULT_MAX_SEGMENTS,
	DEFAULT_MIN_PASTE_BYTES,
	DEFAULT_ROOT,
	HAS_PASTE_MARKER_RE,
} from "./constants.js";
import { expandInlinePastes } from "./format.js";

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
 * @param {{root?:string, minPasteBytes?:number, maxSegments?:number, annotatePasteSize?:boolean, inlineFormat?:string}} [options]
 * @returns {typeof editor}  The same instance, now patched.
 */
export function patchEditorForSegmentedPaste(editor, options = {}) {
	const root = options.root ?? DEFAULT_ROOT;
	// Capture policy lives here, not in the segmenter: below this floor a file
	// reference plus the follow-up read costs more than the inline paste.
	const minPasteBytes = options.minPasteBytes ?? DEFAULT_MIN_PASTE_BYTES;
	const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
	const annotatePasteSize = options.annotatePasteSize ?? DEFAULT_ANNOTATE_PASTE_SIZE;
	// Presentation policy for pastes that stay inline.
	const inlineFormat = options.inlineFormat ?? DEFAULT_INLINE_FORMAT;

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
			const result = processSegmentedPastes(markerText, pastes, {
				root,
				minPasteBytes,
				maxSegments,
				annotatePasteSize,
			});

			// Not worth capturing — either the segment cap was exceeded or the
			// pastes are too small to be worth a file.  The paste stays inline,
			// optionally reformatted so it reads as its own block instead of
			// running into the typed text on either side.
			if (!result?.transformedText) {
				return submitWithInlinePastes.call(this, result);
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

	/**
	 * Expand this submission's paste markers in place, applying the configured
	 * inline format.  Falls back to stock Pi expansion whenever reformatting
	 * would lose information — `inlineFormat: "stock"`, a marker that is not in
	 * the pastes Map (stock leaves such markers untouched), or unavailable
	 * editor state.
	 */
	function submitWithInlinePastes(result) {
		const segments = result?.segments;
		if (inlineFormat === "stock" || !Array.isArray(segments)) {
			return originalSubmitValue();
		}
		if (segments.some((segment) => segment.kind === "paste" && segment.missing)) {
			return originalSubmitValue();
		}

		const stateLines = this.state?.lines;
		if (!stateLines || !Array.isArray(stateLines)) {
			return originalSubmitValue();
		}

		let expanded;
		try {
			expanded = expandInlinePastes(segments, inlineFormat);
		} catch {
			return originalSubmitValue();
		}

		this.state.lines = expanded.split("\n");
		this.state.cursorLine = 0;
		this.state.cursorCol = 0;
		this.pastes.clear();
		this.pasteCounter = 0;

		return originalSubmitValue();
	}

	return editor;
}
