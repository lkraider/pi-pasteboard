import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { readFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { HAS_PASTE_MARKER_RE, PASTE_MARKER_RE } from "../src/constants.js";
import { parseSegments, processSegmentedPastes } from "../src/segmenter.js";
import { patchEditorForSegmentedPaste } from "../src/pasteboard-editor.js";
import { cleanupOldSubmissions, ensurePasteboardRoot } from "../src/pasteboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal fake editor whose submitValue flow mirrors the real Editor.
 *
 * The real Editor's submitValue:
 *   1. this.expandPasteMarkers(this.state.lines.join("\n")).trim()
 *   2. Reset state, clear pastes/pasteCounter, reset history/undo
 *   3. Fire onChange(""), then onSubmit(result)
 *
 * We also make expandPasteMarkers tolerate non-Map pastes to mirror how the
 * real code would work if Pi changed the field type — the original
 * submitValue would handle it internally and our patcher falls through.
 */
function fakeEditor(pastesMap, text) {
	const pastes = pastesMap ?? new Map();
	const state = { lines: text.split("\n"), cursorLine: 0, cursorCol: 0 };
	let submittedText = null;

	const editor = {
		state,
		pastes,
		pasteCounter: pastes instanceof Map ? pastes.size : 0,
		onSubmit: null,
		onChange: null,
		cancelAutocomplete() {},
		exitHistoryBrowsing() {},

		expandPasteMarkers(t) {
			if (!(this.pastes instanceof Map)) return t;
			let result = t;
			for (const [pasteId, pasteContent] of this.pastes) {
				const markerRegex = new RegExp(
					`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`,
					"g",
				);
				result = result.replace(markerRegex, () => pasteContent);
			}
			return result;
		},

		submitValue() {
			this.cancelAutocomplete();
			const result = this.expandPasteMarkers(
				(this.state?.lines ?? [""]).join("\n"),
			).trim();
			this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
			if (this.pastes instanceof Map) this.pastes.clear();
			this.pasteCounter = 0;
			this.exitHistoryBrowsing();
			this.scrollOffset = 0;
			if (this.undoStack) this.undoStack.clear();
			this.lastAction = null;
			if (this.onChange) this.onChange("");
			submittedText = result;
			if (this.onSubmit) this.onSubmit(result);
		},

		getSubmittedText() {
			return submittedText;
		},
	};

	return editor;
}

function tmpRoot() {
	const parent = mkdtempSync(join(tmpdir(), "pi-pasteboard-test-"));
	const root = join(parent, "root");
	mkdirSync(root, { mode: 0o700 });
	return { root, parent };
}

// ---------------------------------------------------------------------------
// parseSegments
// ---------------------------------------------------------------------------

test("parseSegments: typed-only text (no markers)", () => {
	const pastes = new Map();
	const text = "Hello, please review this code.";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 1);
	assert.equal(segs[0].kind, "typed");
	assert.equal(segs[0].text, text);
});

test("parseSegments: single paste between typed text", () => {
	const pastes = new Map([[1, "PASTED_CODE\n".repeat(10)]]);
	const text = "Check this:\n[paste #1 +10 lines]\nThoughts?";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 3);
	assert.equal(segs[0].kind, "typed");
	assert.equal(segs[0].text, "Check this:\n");
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[1].pasteId, 1);
	assert.equal(segs[1].text, "PASTED_CODE\n".repeat(10));
	assert.equal(segs[1].missing, false);
	assert.equal(segs[2].kind, "typed");
	assert.equal(segs[2].text, "\nThoughts?");
});

test("parseSegments: two adjacent paste markers (no typed text between)", () => {
	const pastes = new Map([
		[1, "first paste content\n"],
		[2, "second paste content\n"],
	]);
	const text = "[paste #1 +3 lines][paste #2 100 chars]";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 2);
	assert.equal(segs[0].kind, "paste");
	assert.equal(segs[0].pasteId, 1);
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[1].pasteId, 2);
});

test("parseSegments: paste marker missing from map", () => {
	const pastes = new Map(); // empty — marker id 1 not present
	const text = "Before\n[paste #1 +5 lines]\nAfter";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 3);
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[1].pasteId, 1);
	assert.equal(segs[1].text, "");
	assert.equal(segs[1].missing, true);
});

test("parseSegments: typed text containing marker-like strings", () => {
	const pastes = new Map();
	// If a user types literal "[paste #N ...]" text AND there happens to be a
	// matching paste id in the map, it would be treated as a marker.  This is
	// a known edge case — in practice pastes are cleared on every submit, so
	// stale ids won't exist.  We document it as a limitation.
	const text = "User typed [paste #1 +5 lines] literally";
	const segs = parseSegments(text, pastes);

	// No pastes in map → the marker-like text becomes a paste segment with missing=true
	assert.equal(segs.length, 3);
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[1].missing, true);
});

test("parseSegments: repeated same paste marker id", () => {
	const pastes = new Map([[1, "shared content\n"]]);
	const text = "[paste #1 +2 lines] middle [paste #1 +2 lines]";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 3);
	assert.equal(segs[0].kind, "paste");
	assert.equal(segs[0].pasteId, 1);
	assert.equal(segs[1].kind, "typed");
	assert.equal(segs[1].text, " middle ");
	assert.equal(segs[2].kind, "paste");
	assert.equal(segs[2].pasteId, 1);
});

test("parseSegments: chars variant of paste marker", () => {
	const pastes = new Map([[3, "short"]]);
	const text = "[paste #3 5 chars]";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 1);
	assert.equal(segs[0].kind, "paste");
	assert.equal(segs[0].pasteId, 3);
	assert.equal(segs[0].text, "short");
});

test("parseSegments: bare marker without lines/chars suffix", () => {
	// The regex allows optional lines/chars suffix, so "[paste #1]" alone matches.
	// This is a marker the editor could produce (though currently it always
	// includes lines or chars).  Verify we handle it.
	const pastes = new Map([[1, "content"]]);
	const segs = parseSegments("[paste #1]", pastes);

	assert.equal(segs.length, 1);
	assert.equal(segs[0].kind, "paste");
	assert.equal(segs[0].pasteId, 1);
	assert.equal(segs[0].text, "content");
});

// ---------------------------------------------------------------------------
// processSegmentedPastes (I/O)
// ---------------------------------------------------------------------------

test("processSegmentedPastes: writes paste files and manifest, returns refs", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([
			[1, "line1\nline2\nline3\n"],
			[2, "config=true\n"],
		]);
		const markerText = "Review:\n[paste #1 +3 lines]\nThanks!\n[paste #2 12 chars]";

		const result = processSegmentedPastes(markerText, pastes, { root });

		// Transformed text has file refs, not content
		assert.ok(result.transformedText.includes("[paste saved:"));
		assert.ok(!result.transformedText.includes("line1"));
		assert.ok(!result.transformedText.includes("config=true"));
		assert.ok(result.transformedText.includes("Review:\n"));
		assert.ok(result.transformedText.includes("\nThanks!\n"));

		// Submission directory created
		assert.ok(existsSync(result.submissionDir));

		// Manifest exists and is valid JSON
		const manifestPath = join(result.submissionDir, "manifest.json");
		const manifestRaw = readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(manifestRaw);

		// 4 segments: typed, paste, typed, paste (no trailing typed after last marker)
		assert.equal(manifest.segments.length, 4);
		assert.equal(manifest.segments[0].kind, "typed");
		assert.equal(manifest.segments[1].kind, "paste");
		assert.equal(manifest.segments[1].pasteId, 1);
		assert.equal(manifest.segments[2].kind, "typed");
		assert.equal(manifest.segments[2].text, "\nThanks!\n");
		assert.equal(manifest.segments[3].kind, "paste");
		assert.equal(manifest.segments[3].pasteId, 2);

		// Paste files contain correct content
		const paste1Path = join(result.submissionDir, "paste-1.txt");
		const paste2Path = join(result.submissionDir, "paste-3.txt");
		assert.equal(readFileSync(paste1Path, "utf8"), "line1\nline2\nline3\n");
		assert.equal(readFileSync(paste2Path, "utf8"), "config=true\n");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("processSegmentedPastes: no pastes → typed text preserved as-is", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map();
		const markerText = "Just some typed text.\nNo markers here.";

		const result = processSegmentedPastes(markerText, pastes, { root });

		assert.equal(result.transformedText, markerText);
		assert.equal(result.manifest.segments.length, 1);
		assert.equal(result.manifest.segments[0].kind, "typed");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("processSegmentedPastes: missing marker → flagged in manifest with empty file", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map(); // marker 1 is missing
		const markerText = "[paste #1 +3 lines]";

		const result = processSegmentedPastes(markerText, pastes, { root });

		assert.equal(result.manifest.segments.length, 1);
		assert.equal(result.manifest.segments[0].kind, "paste");
		assert.equal(result.manifest.segments[0].fallbackReason, "paste-marker-missing-from-map");

		// File should exist but be empty
		const pastePath = join(result.submissionDir, "paste-0.txt");
		assert.equal(readFileSync(pastePath, "utf8"), "");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// patchEditorForSegmentedPaste (monkey-patch)
// ---------------------------------------------------------------------------

test("patchEditor: transforms markers, calls original submitValue", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([[1, "PASTED CONTENT\n".repeat(5)]]);
		const markerText = "Before\n[paste #1 +5 lines]\nAfter";

		const editor = fakeEditor(pastes, markerText);
		patchEditorForSegmentedPaste(editor, { root });

		editor.submitValue();

		const submitted = editor.getSubmittedText();
		assert.ok(submitted.includes("[paste saved:"));
		assert.ok(!submitted.includes("PASTED CONTENT"));
		assert.ok(submitted.startsWith("Before\n"));
		assert.ok(submitted.endsWith("\nAfter"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("patchEditor: no pastes → falls through to original behaviour", () => {
	const editor = fakeEditor(new Map(), "plain typed text");
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	editor.submitValue();

	const submitted = editor.getSubmittedText();
	assert.equal(submitted, "plain typed text");
});

test("patchEditor: pastes exist but no markers in text → falls through", () => {
	const pastes = new Map([[1, "content"]]);
	const editor = fakeEditor(pastes, "just typed stuff, no markers");
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	editor.submitValue();

	const submitted = editor.getSubmittedText();
	assert.equal(submitted, "just typed stuff, no markers");
});

test("patchEditor: null/undefined pastes field → falls through safely", () => {
	// Simulate a hypothetical future Pi where pastes is not a regular field.
	// Our patcher detects this and falls through to original submitValue.
	const editor = fakeEditor(new Map(), "text");
	editor.pastes = undefined;
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	// Should not throw — patcher falls through, original submitValue handles
	// undefined pastes gracefully (our fake mirrors this).
	assert.doesNotThrow(() => editor.submitValue());
	assert.equal(editor.getSubmittedText(), "text");
});

test("patchEditor: non-Map pastes field → falls through safely", () => {
	const editor = fakeEditor(new Map(), "text");
	editor.pastes = { not: "a map" };
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	assert.doesNotThrow(() => editor.submitValue());
	assert.equal(editor.getSubmittedText(), "text");
});

test("patchEditor: missing state.lines → falls through safely", () => {
	const editor = fakeEditor(new Map([[1, "x"]]), "[paste #1 1 chars]");
	editor.state = null;
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	// Patcher detects null state and falls through. Fake's submitValue
	// handles null state gracefully (reads [""]).
	assert.doesNotThrow(() => editor.submitValue());
});

// ---------------------------------------------------------------------------
// Counterfactual: segment ordering survives transformation
// ---------------------------------------------------------------------------

test("counterfactual: typed-paste-typed-paste-typed order is preserved", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([
			[1, "AAA\n"],
			[2, "BBB\n"],
		]);
		// Interleaved: <typed1><paste1><paste2><typed2>
		const markerText = "T1\n[paste #1 +1 lines][paste #2 +1 lines]T2";

		const result = processSegmentedPastes(markerText, pastes, { root });

		// The transformed text must preserve order
		assert.ok(result.transformedText.startsWith("T1\n[paste saved:"));
		assert.ok(result.transformedText.includes("][paste saved:"));
		assert.ok(result.transformedText.endsWith("T2"));

		// Manifest order must match
		assert.equal(result.manifest.segments[0].kind, "typed");
		assert.equal(result.manifest.segments[0].text, "T1\n");
		assert.equal(result.manifest.segments[1].kind, "paste");
		assert.equal(result.manifest.segments[1].pasteId, 1);
		assert.equal(result.manifest.segments[2].kind, "paste");
		assert.equal(result.manifest.segments[2].pasteId, 2);
		assert.equal(result.manifest.segments[3].kind, "typed");
		assert.equal(result.manifest.segments[3].text, "T2");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("counterfactual: v1 whole-input behaviour would lose segment boundaries", () => {
	// v1 whole-input capture writes the entire expanded text as one blob.
	// The whole-input approach CANNOT distinguish typed from pasted.
	// This test documents that our segmenter CAN, which is the counterfactual.

	const pastes = new Map([
		[1, "paste1content\n"],
		[2, "paste2content\n"],
	]);
	const markerText = "typed1\n[paste #1 +1 lines]typed2\n[paste #2 +1 lines]typed3";

	// v1 whole-input simulation: expand all markers into one blob
	const expanded = markerText
		.replace(/\[paste #1[^\]]*\]/g, "paste1content\n")
		.replace(/\[paste #2[^\]]*\]/g, "paste2content\n");

	// The expanded text is just one string with no boundaries
	assert.equal(expanded, "typed1\npaste1content\ntyped2\npaste2content\ntyped3");

	// Our segmenter correctly identifies 5 segments
	const segs = parseSegments(markerText, pastes);
	assert.equal(segs.length, 5);
	assert.equal(segs[0].kind, "typed");
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[2].kind, "typed");
	assert.equal(segs[3].kind, "paste");
	assert.equal(segs[4].kind, "typed");
});

// ---------------------------------------------------------------------------
// Edge-case: binary / very large text
// ---------------------------------------------------------------------------

test("processSegmentedPastes: large paste content handled correctly", () => {
	const { root, parent } = tmpRoot();
	try {
		// 100KB paste
		const largeContent = "X".repeat(100 * 1024);
		const pastes = new Map([[1, largeContent]]);
		const markerText = "[paste #1 102400 chars]";

		const result = processSegmentedPastes(markerText, pastes, { root });

		assert.equal(result.manifest.segments[0].bytes, 100 * 1024);
		assert.equal(result.manifest.segments[0].lines, 1); // single line, no newlines

		// Verify file content
		const pastePath = join(result.submissionDir, "paste-0.txt");
		const fileContent = readFileSync(pastePath, "utf8");
		assert.equal(fileContent.length, 100 * 1024);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("processSegmentedPastes: binary-like content with null bytes", () => {
	const { root, parent } = tmpRoot();
	try {
		const binaryContent = "header\n\x00\x01\x02\nfooter\n";
		const pastes = new Map([[1, binaryContent]]);
		const markerText = "[paste #1 +3 lines]";

		const result = processSegmentedPastes(markerText, pastes, { root });

		assert.equal(
			result.manifest.segments[0].bytes,
			Buffer.byteLength(binaryContent, "utf8"),
		);

		const pastePath = join(result.submissionDir, "paste-0.txt");
		const fileContent = readFileSync(pastePath);
		assert.ok(fileContent.includes(0x00));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Edge-case: marker regex specificity
// ---------------------------------------------------------------------------

test("PASTE_MARKER_RE matches valid paste markers", () => {
	// Create a fresh regex for each assertion — the global flag makes
	// .test() stateful (lastIndex advances).
	const re = () => new RegExp(PASTE_MARKER_RE.source, "g");

	// Valid patterns the editor produces
	assert.ok(re().test("[paste #1 +5 lines]"));
	assert.ok(re().test("[paste #42 1234 chars]"));

	// Bare marker (optional suffix)
	assert.ok(re().test("[paste #1]"));

	// Partial patterns that should NOT match
	assert.ok(!re().test("[paste #notanumber lines]"));
	assert.ok(!re().test("[paste #]"));
	assert.ok(!re().test("just text"));
	assert.ok(!re().test("[paste #1 extra stuff]")); // "extra" not lines/chars
});

test("HAS_PASTE_MARKER_RE is a fast bail-out check", () => {
	assert.ok(HAS_PASTE_MARKER_RE.test("[paste #1 +5 lines]"));
	assert.ok(HAS_PASTE_MARKER_RE.test("[paste #1234567890 +1 lines] next"));
	assert.ok(!HAS_PASTE_MARKER_RE.test("no markers here"));
	assert.ok(!HAS_PASTE_MARKER_RE.test("[paste]"));
});

// ---------------------------------------------------------------------------
// Edge-case: cleanup of old submissions
// ---------------------------------------------------------------------------

test("cleanupOldSubmissions removes expired submission dirs", async () => {
	const { root, parent } = tmpRoot();
	try {
		await ensurePasteboardRoot(root);

		// Create a submission dir via processSegmentedPastes, then age it
		const pastes = new Map([[1, "old\n"]]);
		const result = processSegmentedPastes("[paste #1 +1 lines]", pastes, { root });

		// Age the submission dir
		const { utimes } = await import("node:fs/promises");
		const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days
		await utimes(result.submissionDir, oldTime, oldTime);

		// Cleanup with 7-day TTL
		const cleanupResult = await cleanupOldSubmissions({
			root,
			ttlMs: 7 * 24 * 60 * 60 * 1000,
			nowMs: Date.now(),
		});

		assert.equal(cleanupResult.removed, 1);
		assert.ok(!existsSync(result.submissionDir));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("cleanupOldSubmissions keeps fresh submission dirs", async () => {
	const { root, parent } = tmpRoot();
	try {
		await ensurePasteboardRoot(root);

		const pastes = new Map([[1, "fresh\n"]]);
		const result = processSegmentedPastes("[paste #1 +1 lines]", pastes, { root });

		const cleanupResult = await cleanupOldSubmissions({
			root,
			ttlMs: 7 * 24 * 60 * 60 * 1000,
			nowMs: Date.now(),
		});

		assert.equal(cleanupResult.removed, 0);
		assert.ok(existsSync(result.submissionDir));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("cleanupOldSubmissions no-ops when submissions dir missing", async () => {
	const { root, parent } = tmpRoot();
	try {
		await ensurePasteboardRoot(root);
		// No submissions directory at all
		const cleanupResult = await cleanupOldSubmissions({ root });
		assert.equal(cleanupResult.removed, 0);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});
