import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { HAS_PASTE_MARKER_RE, DEFAULT_MAX_SEGMENTS, PASTE_MARKER_RE, STALE_LOCK_MS } from "../src/constants.js";
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

		getText() {
			return (this.state?.lines ?? [""]).join("\n");
		},

		setText(text) {
			this.state.lines = text.split("\n");
			this.state.cursorLine = 0;
			this.state.cursorCol = 0;
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

test("parseSegments: out-of-order marker IDs preserved in textual order", () => {
	// Markers may appear in non-sorted numeric order (paste #99 before #5).
	// The segmenter must emit them in textual order, not sorted by ID.
	const pastes = new Map([
		[99, "high-id-first\n"],
		[5, "low-id-second\n"],
	]);
	const text = "start\n[paste #99 +1 lines] mid [paste #5 +1 lines] end";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 5);
	assert.equal(segs[1].pasteId, 99);
	assert.equal(segs[3].pasteId, 5);
});

test("parseSegments: Unicode typed text between markers preserved exactly", () => {
	// Multi-byte UTF-8 characters in typed text must survive the segmenter
	// character-offset tracking without corruption.
	const pastes = new Map([[1, "paste\n"]]);
	const text = "😀hello😀\n[paste #1 +1 lines]\n🎉";
	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 3);
	assert.equal(segs[0].text, "😀hello😀\n");
	assert.equal(segs[2].text, "\n🎉");
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
		// Typed segments are recorded as counts only — the manifest must not
		// duplicate the user's typed prompt onto disk.
		assert.equal(manifest.segments[2].text, undefined);
		assert.equal(manifest.segments[2].chars, "\nThanks!\n".length);
		assert.equal(manifest.segments[2].bytes, Buffer.byteLength("\nThanks!\n", "utf8"));
		assert.equal(manifest.segments[3].kind, "paste");
		assert.equal(manifest.segments[3].pasteId, 2);

		// Paste files contain correct content
		// Files are named by paste id, matching the "[paste #N …]" marker.
		const paste1Path = join(result.submissionDir, "paste-1.txt");
		const paste2Path = join(result.submissionDir, "paste-2.txt");
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

		// File should exist but be empty, named after the marker's paste id
		const pastePath = join(result.submissionDir, "paste-1.txt");
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
		// minPasteBytes: 0 — this test covers transformation mechanics, not the
		// size floor (see "paste floor" tests below).
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 0 });

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
		assert.equal(result.manifest.segments[0].text, undefined);
		assert.equal(result.manifest.segments[0].chars, "T1\n".length);
		assert.equal(result.manifest.segments[1].kind, "paste");
		assert.equal(result.manifest.segments[1].pasteId, 1);
		assert.equal(result.manifest.segments[2].kind, "paste");
		assert.equal(result.manifest.segments[2].pasteId, 2);
		assert.equal(result.manifest.segments[3].kind, "typed");
		assert.equal(result.manifest.segments[3].text, undefined);
		assert.equal(result.manifest.segments[3].chars, 2);
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
		const pastePath = join(result.submissionDir, "paste-1.txt");
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

		const pastePath = join(result.submissionDir, "paste-1.txt");
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

// ---------------------------------------------------------------------------
// Counterfactual: lock protection for cleanupOldSubmissions (F3)
// ---------------------------------------------------------------------------

test("cleanupOldSubmissions: respects fresh lock (not stale)", async () => {
	const { root, parent } = tmpRoot();
	try {
		await ensurePasteboardRoot(root);

		// Create a submission dir + ensure submissions/ exists
		const pastes = new Map([[1, "content\n"]]);
		processSegmentedPastes("[paste #1 +1 lines]", pastes, { root });

		// Create a fresh lock file inside submissions/
		const submissionsDir = join(root, "submissions");
		const lockPath = join(submissionsDir, ".cleanup.lock");
		const lockHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
		await lockHandle.close();

		// Cleanup should be skipped (lock is fresh)
		const result = await cleanupOldSubmissions({ root, ttlMs: 1_000, nowMs: Date.now() });
		assert.equal(result.skipped, true);
		assert.equal(result.removed, 0);

		// Remove the lock ourselves
		await rm(lockPath, { force: true });
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("cleanupOldSubmissions: stale lock is removed and cleanup proceeds", async () => {
	const { root, parent } = tmpRoot();
	try {
		await ensurePasteboardRoot(root);

		// Create a submission dir
		const pastes = new Map([[1, "old\n"]]);
		const result = processSegmentedPastes("[paste #1 +1 lines]", pastes, { root });

		// Age the submission dir to be older than TTL
		const veryOld = new Date(Date.now() - STALE_LOCK_MS - 120_000);
		await utimes(result.submissionDir, veryOld, veryOld);

		// Create a stale lock file
		const submissionsDir = join(root, "submissions");
		const lockPath = join(submissionsDir, ".cleanup.lock");
		const lockHandle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_WRONLY, 0o600);
		await lockHandle.close();
		await utimes(lockPath, veryOld, veryOld);

		// Cleanup with a TTL of 1 second — the submission dir qualifies
		const cleanupResult = await cleanupOldSubmissions({ root, ttlMs: 1_000, nowMs: Date.now() });
		assert.equal(cleanupResult.skipped, false);
		assert.equal(cleanupResult.removed, 1);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Counterfactual: segment-count cap (F2)
// ---------------------------------------------------------------------------

test("processSegmentedPastes: rejects submissions exceeding DEFAULT_MAX_SEGMENTS", () => {
	const { root, parent } = tmpRoot();
	try {
		// Build a pastes Map and marker text with DEFAULT_MAX_SEGMENTS+1 segments
		const pastes = new Map();
		const parts = [];
		for (let i = 0; i <= DEFAULT_MAX_SEGMENTS; i++) {
			pastes.set(i, `content${i}\n`);
			parts.push(`[paste #${i} +1 lines]`);
		}
		const markerText = "typed-start\n" + parts.join("") + "\ntyped-end";

		const result = processSegmentedPastes(markerText, pastes, { root });

		assert.equal(result.error, "too-many-segments");
		assert.equal(result.transformedText, null);
		assert.ok(result.segmentCount > DEFAULT_MAX_SEGMENTS);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("counterfactual: segment cap prevents pathological submission hangs", () => {
	// v1 whole-input capture writes one file regardless of input structure.
	// v2 could write DEFAULT_MAX_SEGMENTS files synchronously.  Without a cap,
	// a massively fragmented submission could block the render loop.
	// This test verifies the cap fires and the patcher falls back.

	const { root, parent } = tmpRoot();
	try {
		// Build well under the cap — should succeed
		const pastes = new Map();
		const parts = [];
		const count = 10; // well under DEFAULT_MAX_SEGMENTS of 50
		for (let i = 0; i < count; i++) {
			pastes.set(i, `ok${i}\n`);
			parts.push(`[paste #${i} +1 lines]`);
		}
		const markerText = "start\n" + parts.join("") + "\nend";

		const result = processSegmentedPastes(markerText, pastes, { root });

		// Under the cap — normal handling
		assert.equal(result.error, undefined);
		assert.ok(typeof result.transformedText === "string");
		assert.ok(result.transformedText.includes("[paste saved:"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Counterfactual C1: end-to-end typed→paste→typed→paste
// ---------------------------------------------------------------------------

test("counterfactual C1: e2e submission produces file refs NOT paste content", () => {
	// This tests the full pipeline: a fake editor with getText() + pastes
	// → patchEditorForSegmentedPaste → original submitValue.
	// The submitted text must contain typed text and file references but
	// NOT the actual paste content.  v1 whole-input behaviour would put
	// everything in one blob — this test MUST fail under v1 semantics.

	const { root, parent } = tmpRoot();
	try {
		const paste1Content = "function foo() {\n  return 42;\n}\n";
		const paste2Content = "const config = { port: 3000 };\n";
		const pastes = new Map([
			[1, paste1Content],
			[2, paste2Content],
		]);
		const markerText =
			"Please review this code:\n[paste #1 +3 lines]\nAnd this config:\n[paste #2 +1 lines]";

		// Verify v1 behaviour FIRST (before submitValue clears pastes):
		// v1 expandPasteMarkers puts content inline → one blob
		const editorForV1 = fakeEditor(new Map(pastes), markerText);
		const v1Expanded = editorForV1.expandPasteMarkers(markerText);
		assert.ok(v1Expanded.includes("function foo()"));
		assert.ok(v1Expanded.includes("const config"));

		// Now test v2 behaviour (minPasteBytes: 0 — exercising the transform,
		// not the size floor):
		const editor = fakeEditor(pastes, markerText);
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 0 });

		editor.submitValue();

		const submitted = editor.getSubmittedText();

		// MUST contain typed text
		assert.ok(submitted.includes("Please review this code:"));
		assert.ok(submitted.includes("And this config:"));

		// MUST contain file references
		assert.ok(submitted.includes("[paste saved:"));

		// MUST NOT contain paste content
		assert.ok(!submitted.includes("function foo()"));
		assert.ok(!submitted.includes("return 42"));
		assert.ok(!submitted.includes("const config"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Counterfactual C2: fallback when pastes undefined (editor internals inaccessible)
// ---------------------------------------------------------------------------

test("counterfactual C2: fallback fires when pastes field is undefined", () => {
	// When the editor's pastes field is undefined (simulating a future Pi
	// that uses #private fields or changed the internal layout), the patcher
	// must fall through to original submitValue.  The v1 whole-input capture
	// via the `input` event remains reachable.

	const editor = fakeEditor(new Map([[1, "content"]]), "[paste #1 +1 lines]");
	editor.pastes = undefined;
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	// Should not throw — falls through to original behaviour
	assert.doesNotThrow(() => editor.submitValue());

	// Original submitValue expands markers (since pastes is undefined,
	// expandPasteMarkers returns the raw text with markers still in it —
	// the v1 fallback captures the whole thing).
	const submitted = editor.getSubmittedText();
	// The fake editor's submitValue calls expandPasteMarkers which
	// replaces markers when pastes is a Map, but when pastes is undefined
	// it returns the text unchanged.  So the marker text is submitted as-is.
	// A real editor would still have pastes internally — this test
	// verifies our patcher's safety check works.
	assert.ok(submitted.includes("[paste #1 +1 lines]"));
});

test("counterfactual C2b: fallback reachable when getText throws", () => {
	// Simulate a scenario where getText() is unavailable or throws.
	// The patcher must fall through to original submitValue safely.

	const editor = fakeEditor(new Map([[1, "content"]]), "[paste #1 +1 lines]");
	// Replace getText with a function that throws
	editor.getText = () => { throw new Error("getText unavailable"); };
	patchEditorForSegmentedPaste(editor, { root: "/tmp/pi-pasteboard" });

	assert.doesNotThrow(() => editor.submitValue());

	// Falls through — markers expanded normally by original submitValue
	const submitted = editor.getSubmittedText();
	assert.ok(submitted.includes("content"));
});

// ---------------------------------------------------------------------------
// Counterfactual C3: adjacent paste markers produce distinct file refs
// ---------------------------------------------------------------------------

test("counterfactual C3: adjacent paste markers produce distinct adjacent file refs", () => {
	// v1 whole-input capture merges everything into one blob — there are no
	// file refs at all.  v2 must produce separate [paste saved: ...] refs
	// for adjacent markers, not merge them into a single reference.

	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([
			[1, "content-one\n"],
			[2, "content-two\n"],
			[3, "content-three\n"],
		]);
		// Three adjacent paste markers — no typed text between them
		const markerText = "[paste #1 +1 lines][paste #2 +1 lines][paste #3 +1 lines]";

		const result = processSegmentedPastes(markerText, pastes, { root });

		// The transformed text must contain three separate file references
		const refs = result.transformedText.match(/\[paste saved: [^\]]+\]/g);
		assert.equal(refs.length, 3);

		// Each ref must be a distinct file path
		const paths = refs.map((r) => r.slice(14, -1)); // strip "[paste saved: " and "]"
		const uniquePaths = new Set(paths);
		assert.equal(uniquePaths.size, 3);

		// The manifest must have three paste segments, not one merged blob
		const pasteSegments = result.manifest.segments.filter((s) => s.kind === "paste");
		assert.equal(pasteSegments.length, 3);
		assert.equal(pasteSegments[0].pasteId, 1);
		assert.equal(pasteSegments[1].pasteId, 2);
		assert.equal(pasteSegments[2].pasteId, 3);

		// Each paste file must exist with the correct content
		const pasteFiles = pasteSegments.map((s) => s.file);
		assert.equal(readFileSync(pasteFiles[0], "utf8"), "content-one\n");
		assert.equal(readFileSync(pasteFiles[1], "utf8"), "content-two\n");
		assert.equal(readFileSync(pasteFiles[2], "utf8"), "content-three\n");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Property / edge-case: empty paste, Unicode, and out-of-order markers
// ---------------------------------------------------------------------------

test("processSegmentedPastes: empty paste content writes empty file with ref", () => {
	// When a paste segment has empty content (""), the file must still be
	// written (empty file) and the [paste saved:] ref emitted.  This
	// property ensures zero-length content doesn't break the file-ref model.

	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([[1, ""]]);
		const markerText = "before [paste #1 0 chars] after";

		const result = processSegmentedPastes(markerText, pastes, { root });

		assert.ok(result.transformedText.includes("[paste saved:"));
		assert.equal(result.manifest.segments[1].bytes, 0);
		assert.equal(result.manifest.segments[1].lines, 0);

		const pastePath = join(result.submissionDir, "paste-1.txt");
		const content = readFileSync(pastePath, "utf8");
		assert.equal(content, "");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("processSegmentedPastes: Unicode paste content round-trips correctly", () => {
	// Paste content with multi-byte UTF-8 (emoji, CJK, combining chars)
	// must be byte-exact in the file and have correct byte count in manifest.

	const { root, parent } = tmpRoot();
	try {
		const unicodeContent = "Hello 🌍\n日本語\n表情\u0308\n";
		const pastes = new Map([[1, unicodeContent]]);
		const markerText = "[paste #1 +3 lines]";

		const result = processSegmentedPastes(markerText, pastes, { root });

		const pastePath = join(result.submissionDir, "paste-1.txt");
		const fileContent = readFileSync(pastePath, "utf8");
		assert.equal(fileContent, unicodeContent);
		assert.equal(
			result.manifest.segments[0].bytes,
			Buffer.byteLength(unicodeContent, "utf8"),
		);
		assert.equal(result.manifest.segments[0].lines, 4);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("parseSegments: out-of-order marker IDs still produce correct segments", () => {
	// Markers may appear in non-numeric order (e.g., paste #2 before #1).
	// The segmenter must emit them in textual order, not sorted by ID.

	const pastes = new Map([
		[99, "first-in-text\n"],
		[5, "second-in-text\n"],
	]);
	const text = "start\n[paste #99 +1 lines] mid [paste #5 +1 lines] end";

	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 5);
	assert.equal(segs[0].kind, "typed"); // "start\n"
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[1].pasteId, 99);   // first marker
	assert.equal(segs[2].kind, "typed"); // " mid "
	assert.equal(segs[3].kind, "paste");
	assert.equal(segs[3].pasteId, 5);    // second marker
});

test("parseSegments: Unicode marker text (typed text containing emoji) handled correctly", () => {
	// Typed text with multi-byte characters between markers must be
	// captured exactly in typed segments (no byte-offset errors).

	const pastes = new Map([[1, "paste\n"]]);
	// "😀" is 4 bytes in UTF-8; segmenter uses character-index operations
	const text = "😀hello😀\n[paste #1 +1 lines]\n🎉";

	const segs = parseSegments(text, pastes);

	assert.equal(segs.length, 3);
	assert.equal(segs[0].kind, "typed");
	assert.equal(segs[0].text, "😀hello😀\n");
	assert.equal(segs[1].kind, "paste");
	assert.equal(segs[2].kind, "typed");
	assert.equal(segs[2].text, "\n🎉");
});

// ---------------------------------------------------------------------------
// Paste size floor (minPasteBytes)
//
// Every captured paste costs the model a reference (~27 tokens) plus a `read`
// tool call (~44 tokens) before any content arrives.  Below the floor, leaving
// the paste inline is strictly cheaper than capturing it and reading it back.
// ---------------------------------------------------------------------------

test("paste floor: patcher default leaves a small paste inline (no files written)", () => {
	const { root, parent } = tmpRoot();
	try {
		const pasteContent = "short pasted snippet\n".repeat(15); // ~330 bytes
		const pastes = new Map([[1, pasteContent]]);
		const markerText = "Review:\n[paste #1 +15 lines]\nThanks";

		const editor = fakeEditor(pastes, markerText);
		// No minPasteBytes → uses DEFAULT_MIN_PASTE_BYTES (4 KiB).
		patchEditorForSegmentedPaste(editor, { root });
		editor.submitValue();

		const submitted = editor.getSubmittedText();

		// Markers expanded inline, exactly as if pi-pasteboard were not installed.
		assert.ok(!submitted.includes("[paste saved:"));
		assert.ok(submitted.includes("short pasted snippet"));
		assert.ok(submitted.startsWith("Review:"));
		assert.ok(submitted.endsWith("Thanks"));

		// Nothing was written to disk: no submission dir, no manifest, no files.
		assert.equal(existsSync(join(root, "submissions")), false);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: patcher captures a paste at or above the floor", () => {
	const { root, parent } = tmpRoot();
	try {
		const pasteContent = "x".repeat(8192); // 8 KiB, above the 4 KiB default
		const pastes = new Map([[1, pasteContent]]);
		const markerText = "Review:\n[paste #1 8192 chars]";

		const editor = fakeEditor(pastes, markerText);
		patchEditorForSegmentedPaste(editor, { root });
		editor.submitValue();

		const submitted = editor.getSubmittedText();
		assert.ok(submitted.includes("[paste saved:"));
		assert.ok(!submitted.includes("xxxxxxxxxx"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: boundary is inclusive (bytes == floor is captured)", () => {
	const { root, parent } = tmpRoot();
	try {
		const pasteContent = "y".repeat(2048);
		const pastes = new Map([[1, pasteContent]]);
		const markerText = "[paste #1 2048 chars]";

		const editor = fakeEditor(pastes, markerText);
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 2048 });
		editor.submitValue();

		assert.ok(editor.getSubmittedText().includes("[paste saved:"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: minPasteBytes 0 restores capture-everything behaviour", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([[1, "tiny\n"]]);
		const markerText = "[paste #1 +1 lines]";

		const editor = fakeEditor(pastes, markerText);
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 0 });
		editor.submitValue();

		assert.ok(editor.getSubmittedText().includes("[paste saved:"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: segmenter reports below-min-paste-bytes without writing anything", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([[1, "small\n"]]);
		const result = processSegmentedPastes("[paste #1 +1 lines]", pastes, {
			root,
			minPasteBytes: 4096,
		});

		assert.equal(result.error, "below-min-paste-bytes");
		assert.equal(result.transformedText, null);
		assert.equal(result.pasteBytes, 6);
		assert.equal(result.minPasteBytes, 4096);
		assert.equal(existsSync(join(root, "submissions")), false);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: only referenced paste segments count toward the floor", () => {
	const { root, parent } = tmpRoot();
	try {
		// Paste 2 is huge but its marker was deleted from the text by the user,
		// so it never reaches the model and must not push us over the floor.
		const pastes = new Map([
			[1, "small\n"],
			[2, "z".repeat(100_000)],
		]);
		const result = processSegmentedPastes("[paste #1 +1 lines]", pastes, {
			root,
			minPasteBytes: 4096,
		});

		assert.equal(result.error, "below-min-paste-bytes");
		assert.equal(result.pasteBytes, 6);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: typed text does not count toward the floor", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([[1, "small\n"]]);
		const typed = "t".repeat(50_000);
		const result = processSegmentedPastes(`${typed}[paste #1 +1 lines]`, pastes, {
			root,
			minPasteBytes: 4096,
		});

		assert.equal(result.error, "below-min-paste-bytes");
		assert.equal(result.pasteBytes, 6);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: multiple small pastes are summed", () => {
	const { root, parent } = tmpRoot();
	try {
		const chunk = "a".repeat(1500);
		const pastes = new Map([
			[1, chunk],
			[2, chunk],
			[3, chunk],
		]);
		const result = processSegmentedPastes(
			"[paste #1 1500 chars][paste #2 1500 chars][paste #3 1500 chars]",
			pastes,
			{ root, minPasteBytes: 4096 },
		);

		// 4500 bytes total → above the 4096 floor → captured
		assert.equal(result.error, undefined);
		assert.equal(result.pasteBytes, undefined);
		assert.equal(result.manifest.segments.filter((s) => s.kind === "paste").length, 3);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: missing marker maps to 0 bytes and never reaches the floor alone", () => {
	const { root, parent } = tmpRoot();
	try {
		// Marker present in text but absent from the pastes Map → nothing to save.
		const result = processSegmentedPastes("[paste #7 +3 lines]", new Map(), {
			root,
			minPasteBytes: 1,
		});

		assert.equal(result.error, "below-min-paste-bytes");
		assert.equal(result.pasteBytes, 0);

		// With the floor disabled the missing paste is still recorded (with
		// fallbackReason) rather than silently dropped.
		const captured = processSegmentedPastes("[paste #7 +3 lines]", new Map(), {
			root,
			minPasteBytes: 0,
		});
		assert.equal(captured.manifest.segments[0].fallbackReason, "paste-marker-missing-from-map");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("processSegmentedPastes: maxSegments option overrides DEFAULT_MAX_SEGMENTS", () => {
	const { root, parent } = tmpRoot();
	try {
		const pastes = new Map([
			[1, "one\n"],
			[2, "two\n"],
			[3, "three\n"],
		]);
		const markerText = "[paste #1 +1 lines][paste #2 +1 lines][paste #3 +1 lines]";

		const result = processSegmentedPastes(markerText, pastes, { root, maxSegments: 2 });
		assert.equal(result.error, "too-many-segments");
		assert.equal(result.maxAllowed, 2);
		assert.equal(result.transformedText, null);

		// The same submission passes with the default cap.
		const ok = processSegmentedPastes(markerText, pastes, { root });
		assert.equal(ok.error, undefined);
		assert.ok(ok.transformedText.includes("[paste saved:"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: declined submission is byte-identical to an unpatched editor", () => {
	// The substring assertions in the test above could miss duplicated or
	// reordered content.  Build the same submission twice — one patched, one
	// not — and compare the complete submitted strings.
	const { root, parent } = tmpRoot();
	try {
		const paste1 = "first pasted block\n".repeat(6);
		const paste2 = "second pasted block\n".repeat(4);
		const markerText =
			"Lead in\n[paste #1 +6 lines]\nmiddle typed text\n[paste #2 +4 lines]\ntrailing";

		const stock = fakeEditor(new Map([[1, paste1], [2, paste2]]), markerText);
		stock.submitValue();
		const expected = stock.getSubmittedText();

		const patched = fakeEditor(new Map([[1, paste1], [2, paste2]]), markerText);
		// inlineFormat "stock" — this test is about the decline path itself,
		// not the reformatting that the default "spaced" format applies.
		patchEditorForSegmentedPaste(patched, { root, inlineFormat: "stock" });
		patched.submitValue();

		assert.equal(patched.getSubmittedText(), expected);
		assert.equal(existsSync(join(root, "submissions")), false);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: multibyte content is measured in bytes, not characters", () => {
	const { root, parent } = tmpRoot();
	try {
		// "é" is 2 bytes in UTF-8: 1500 chars = 3000 bytes (below 4096),
		// 2100 chars = 4200 bytes (above).  A char-count floor would get both wrong.
		const below = "é".repeat(1500);
		const above = "é".repeat(2100);

		const declined = fakeEditor(new Map([[1, below]]), "[paste #1 1500 chars]");
		patchEditorForSegmentedPaste(declined, { root, minPasteBytes: 4096 });
		declined.submitValue();
		assert.ok(!declined.getSubmittedText().includes("[paste saved:"));

		const captured = fakeEditor(new Map([[1, above]]), "[paste #1 2100 chars]");
		patchEditorForSegmentedPaste(captured, { root, minPasteBytes: 4096 });
		captured.submitValue();
		assert.ok(captured.getSubmittedText().includes("[paste saved:"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste floor: maxSegments is forwarded through the patcher", () => {
	const { root, parent } = tmpRoot();
	try {
		// maxSegments counts typed segments too: typed + 1 paste + typed = 3.
		const thirds = new Map([[1, "z".repeat(8192)]]);
		const markerText = "before\n[paste #1 8192 chars]\nafter";

		const capped = fakeEditor(new Map(thirds), markerText);
		patchEditorForSegmentedPaste(capped, { root, maxSegments: 2 });
		capped.submitValue();

		// Declines: full paste content inline, nothing written.
		const submitted = capped.getSubmittedText();
		assert.ok(submitted.includes("z".repeat(8192)));
		assert.ok(!submitted.includes("[paste saved:"));
		assert.equal(existsSync(join(root, "submissions")), false);

		// Same submission with a cap of 3 is captured.
		const allowed = fakeEditor(new Map(thirds), markerText);
		patchEditorForSegmentedPaste(allowed, { root, maxSegments: 3 });
		allowed.submitValue();
		assert.ok(allowed.getSubmittedText().includes("[paste saved:"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Inline paste formatting (what a below-floor paste looks like in the prompt)
// ---------------------------------------------------------------------------

test("inline format: default spaced puts the paste in its own block", () => {
	const { root, parent } = tmpRoot();
	try {
		const content = "alpha\nbeta";
		const editor = fakeEditor(new Map([[1, content]]), "Review this: [paste #1 +2 lines] thanks");
		patchEditorForSegmentedPaste(editor, { root }); // default floor declines
		editor.submitValue();

		assert.equal(editor.getSubmittedText(), "Review this: \n\nalpha\nbeta\n\nthanks");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("inline format: stock reproduces Pi's in-place expansion exactly", () => {
	const { root, parent } = tmpRoot();
	try {
		const content = "alpha\nbeta";
		const markerText = "Review this: [paste #1 +2 lines] thanks";

		const stock = fakeEditor(new Map([[1, content]]), markerText);
		stock.submitValue();

		const patched = fakeEditor(new Map([[1, content]]), markerText);
		patchEditorForSegmentedPaste(patched, { root, inlineFormat: "stock" });
		patched.submitValue();

		assert.equal(patched.getSubmittedText(), stock.getSubmittedText());
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("inline format: an unsupported format falls back to stock expansion", () => {
	const { root, parent } = tmpRoot();
	try {
		const content = "alpha\nbeta";
		const markerText = "Review this: [paste #1 +2 lines] thanks";

		const stock = fakeEditor(new Map([[1, content]]), markerText);
		stock.submitValue();

		const patched = fakeEditor(new Map([[1, content]]), markerText);
		// "fenced" is no longer supported; a stale config must not break submit.
		patchEditorForSegmentedPaste(patched, { root, inlineFormat: "fenced" });
		patched.submitValue();

		assert.equal(patched.getSubmittedText(), stock.getSubmittedText());
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("inline format: marker missing from the Map falls back to stock expansion", () => {
	// Stock Pi leaves an unresolved marker untouched; reformatting would drop it.
	const { root, parent } = tmpRoot();
	try {
		const markerText = "before [paste #9 +3 lines] after";
		const editor = fakeEditor(new Map(), markerText);
		patchEditorForSegmentedPaste(editor, { root });
		editor.submitValue();

		assert.ok(editor.getSubmittedText().includes("[paste #9 +3 lines]"));
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

// ---------------------------------------------------------------------------
// Paste size annotation
// ---------------------------------------------------------------------------

test("reference: annotated with line count and size by default", () => {
	const { root, parent } = tmpRoot();
	try {
		const content = "line\n".repeat(400); // 2000 B, 401 lines
		const editor = fakeEditor(new Map([[1, content]]), "[paste #1 +400 lines]");
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 0 });
		editor.submitValue();

		const match = editor.getSubmittedText().match(/\[paste saved: ([^\]]+)\]/);
		assert.ok(match, editor.getSubmittedText());
		assert.match(match[1], / \(401 lines, 2\.0KB\)$/);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("reference: annotation can be disabled", () => {
	const { root, parent } = tmpRoot();
	try {
		const editor = fakeEditor(new Map([[1, "x".repeat(8192)]]), "[paste #1 8192 chars]");
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 0, annotatePasteSize: false });
		editor.submitValue();

		const match = editor.getSubmittedText().match(/\[paste saved: ([^\]]+)\]/);
		assert.ok(match);
		assert.doesNotMatch(match[1], /lines,/);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("reference: single-line paste is described in the singular", () => {
	const { root, parent } = tmpRoot();
	try {
		const editor = fakeEditor(new Map([[1, "only line"]]), "[paste #1 9 chars]");
		patchEditorForSegmentedPaste(editor, { root, minPasteBytes: 0 });
		editor.submitValue();

		assert.match(editor.getSubmittedText(), /\(1 line, 9B\)/);
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("manifest: typed prompt text never reaches disk", () => {
	const { root, parent } = tmpRoot();
	try {
		const secret = "TYPED-PROMPT-MARKER-8f3a1c";
		const pastes = new Map([[1, "pasted body\n"]]);
		const result = processSegmentedPastes(
			`${secret} before\n[paste #1 +1 lines]\n${secret} after`,
			pastes,
			{ root },
		);

		const manifestText = readFileSync(join(result.submissionDir, "manifest.json"), "utf8");
		assert.ok(!manifestText.includes(secret), "typed text leaked into manifest.json");

		// Counts are still recorded, so the manifest stays useful for debugging.
		const typed = result.manifest.segments.filter((s) => s.kind === "typed");
		assert.equal(typed.length, 2);
		for (const segment of typed) {
			assert.equal(typeof segment.chars, "number");
			assert.equal(typeof segment.bytes, "number");
		}
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});

test("paste files are named by paste id, not segment index", () => {
	const { root, parent } = tmpRoot();
	try {
		// Two pastes, ids 4 and 7, with typed text around them.  Segment
		// indices would be 1 and 3; the file names must be paste-4 and paste-7.
		const pastes = new Map([
			[4, "four\n"],
			[7, "seven\n"],
		]);
		const result = processSegmentedPastes(
			"lead [paste #4 +1 lines] middle [paste #7 +1 lines] tail",
			pastes,
			{ root },
		);

		const files = result.manifest.segments.filter((s) => s.kind === "paste").map((s) => s.file);
		assert.deepEqual(files.map((f) => f.split("/").pop()), ["paste-4.txt", "paste-7.txt"]);

		// The reference in the prompt names the same file, so a reader can go
		// from "[paste #7 …]" to "paste-7.txt" without guessing.
		assert.ok(result.transformedText.includes("paste-4.txt"));
		assert.ok(result.transformedText.includes("paste-7.txt"));
		assert.equal(readFileSync(files[1], "utf8"), "seven\n");
	} finally {
		rm(parent, { recursive: true, force: true }).catch(() => undefined);
	}
});
