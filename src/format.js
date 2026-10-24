import { DEFAULT_INLINE_FORMAT } from "./constants.js";

export const INLINE_FORMATS = ["stock", "spaced"];

/**
 * Human-readable byte size, mirroring Pi's own formatSize() so a reference
 * reads the same way as a read-truncation notice.
 */
export function formatPasteSize(bytes) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Compact size description for a paste reference: "812 lines, 45.6KB".
 *
 * Deliberately terse — it rides along in every captured submission, and its
 * only job is to let the model decide between `grep` and a full `read`.  No
 * thousands separators: they cost tokens and add nothing here.
 */
export function describePaste(bytes, lines) {
	return `${lines} ${lines === 1 ? "line" : "lines"}, ${formatPasteSize(bytes)}`;
}

/** Render one paste as a self-contained block (no surrounding blank lines). */
function renderBlock(content) {
	return String(content ?? "").replace(/\n+$/, "");
}

/** Newlines needed before a block so it starts after a blank line. */
function gapBefore(result) {
	if (result === "") return "";
	if (result.endsWith("\n\n")) return "";
	if (result.endsWith("\n")) return "\n";
	return "\n\n";
}

/** Newlines needed before typed text that follows a paste block. */
function gapAfterPaste(text) {
	if (text === "") return "\n\n";
	if (text.startsWith("\n\n")) return "";
	if (text.startsWith("\n")) return "\n";
	return "\n\n";
}

/**
 * Expand paste markers into their content, formatted as separate blocks.
 *
 * Pi's own expansion substitutes content in place, so a paste glued to typed
 * text on either side reads as one run-on paragraph.  This keeps each paste on
 * its own block, separated from the surrounding text by a blank line.
 *
 * Typed text is preserved verbatim apart from horizontal whitespace directly
 * after a paste, where the indentation is an artifact of the marker position.
 *
 * @param {Array<{kind:string, text:string}>} segments  From parseSegments().
 * @param {"spaced"} format
 * @returns {string}
 */
export function expandInlinePastes(segments, format = DEFAULT_INLINE_FORMAT) {
	if (format !== "spaced") {
		throw new Error(`expandInlinePastes: unsupported format "${format}"`);
	}

	let result = "";
	let afterPaste = false;

	for (const segment of segments) {
		if (segment.kind === "paste") {
			const block = renderBlock(segment.text);
			// An empty paste contributes no content, but it was still a boundary
			// between typed text: keep the separation, drop the stray blank line.
			if (block !== "") {
				result += gapBefore(result) + block;
				afterPaste = true;
			} else if (result !== "") {
				afterPaste = true;
			}
			continue;
		}

		let text = String(segment.text ?? "");
		if (afterPaste) text = text.replace(/^[ \t]+/, "");
		result += (afterPaste ? gapAfterPaste(text) : "") + text;
		afterPaste = false;
	}

	return result;
}
