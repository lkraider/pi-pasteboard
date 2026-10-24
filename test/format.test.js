import assert from "node:assert/strict";
import test from "node:test";

import {
	describePaste,
	expandInlinePastes,
	formatPasteSize,
	INLINE_FORMATS,
} from "../src/format.js";

const typed = (text) => ({ kind: "typed", text });
const paste = (text, extra = {}) => ({ kind: "paste", text, ...extra });

// ---------------------------------------------------------------------------
// Size descriptions
// ---------------------------------------------------------------------------

test("formatPasteSize: bytes, KB and MB", () => {
	assert.equal(formatPasteSize(0), "0B");
	assert.equal(formatPasteSize(812), "812B");
	assert.equal(formatPasteSize(1024), "1.0KB");
	assert.equal(formatPasteSize(46_712), "45.6KB");
	assert.equal(formatPasteSize(1024 * 1024), "1.0MB");
	assert.equal(formatPasteSize(3 * 1024 * 1024), "3.0MB");
});

test("describePaste: line count is singular-aware and compact", () => {
	assert.equal(describePaste(812, 1), "1 line, 812B");
	assert.equal(describePaste(46_712, 812), "812 lines, 45.6KB");
	// No thousands separators: they cost tokens without adding information.
	assert.equal(describePaste(2_000_000, 12_345), "12345 lines, 1.9MB");
});

// ---------------------------------------------------------------------------
// Inline expansion: spacing
// ---------------------------------------------------------------------------

test("expandInlinePastes: paste between typed text gets a blank line either side", () => {
	const result = expandInlinePastes(
		[typed("Review this:"), paste("line1\nline2"), typed("Thanks")],
		"spaced",
	);
	assert.equal(result, "Review this:\n\nline1\nline2\n\nThanks");
});

test("expandInlinePastes: paste at start of submission", () => {
	const result = expandInlinePastes([paste("pasted"), typed("after")], "spaced");
	assert.equal(result, "pasted\n\nafter");
});

test("expandInlinePastes: paste at end of submission", () => {
	const result = expandInlinePastes([typed("before"), paste("pasted")], "spaced");
	// Trailing newlines are trimmed by the editor's submit path.
	assert.equal(result.trimEnd(), "before\n\npasted");
});

test("expandInlinePastes: adjacent pastes stay separate blocks", () => {
	const result = expandInlinePastes([paste("one"), paste("two")], "spaced");
	assert.equal(result, "one\n\ntwo");
});

test("expandInlinePastes: existing blank lines are not doubled", () => {
	const result = expandInlinePastes(
		[typed("Review:\n\n"), paste("body"), typed("\n\nThanks")],
		"spaced",
	);
	assert.equal(result, "Review:\n\nbody\n\nThanks");
});

test("expandInlinePastes: single trailing newline in typed text becomes a blank line", () => {
	const result = expandInlinePastes([typed("Review:\n"), paste("body")], "spaced");
	assert.equal(result, "Review:\n\nbody");
});

test("expandInlinePastes: trailing newlines in paste content are normalised", () => {
	const result = expandInlinePastes([paste("body\n\n\n"), typed("after")], "spaced");
	assert.equal(result, "body\n\nafter");
});

test("expandInlinePastes: horizontal space glued after a paste is dropped", () => {
	// "Review: [paste] and thoughts" — the leading space belongs to the marker
	// position, not to the user's sentence.
	const result = expandInlinePastes(
		[typed("Review: "), paste("body"), typed(" and thoughts")],
		"spaced",
	);
	assert.equal(result, "Review: \n\nbody\n\nand thoughts");
});

test("expandInlinePastes: empty paste content does not corrupt the text", () => {
	const result = expandInlinePastes([typed("before"), paste(""), typed("after")], "spaced");
	assert.equal(result.trim(), "before\n\nafter");
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test("expandInlinePastes: rejects formats it cannot render", () => {
	assert.throws(() => expandInlinePastes([paste("x")], "stock"), /unsupported format/);
	assert.throws(() => expandInlinePastes([paste("x")], "yaml"), /unsupported format/);
	// Fencing was deliberately dropped: it wrapped the paste in ``` markers and
	// gained nothing over blank-line separation.
	assert.throws(() => expandInlinePastes([paste("x")], "fenced"), /unsupported format/);
});

test("INLINE_FORMATS: exposes only stock and spaced", () => {
	assert.deepEqual(INLINE_FORMATS, ["stock", "spaced"]);
});
