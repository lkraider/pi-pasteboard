import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_ANNOTATE_PASTE_SIZE,
	DEFAULT_MAX_SEGMENTS,
	DEFAULT_ROOT,
	PASTE_MARKER_RE,
	SUBMISSIONS_SUBDIR,
} from "./constants.js";
import { describePaste } from "./format.js";

/**
 * Parse paste-marker-bearing text into ordered segments.
 *
 * Each segment is either "typed" (user-typed text between paste markers) or
 * "paste" (content looked up from the runtime pastes Map).  Markers that are
 * present in the text but missing from the Map are still emitted as paste
 * segments with `missing: true` and empty content — the caller can decide
 * whether to treat them as typed fallback text.
 *
 * @param {string} markerText  Raw editor text with unexpanded paste markers.
 * @param {Map<number,string>} pastes  Runtime paste-id → content Map.
 * @returns {Array<{kind:string,text:string,pasteId?:number,missing?:boolean}>}
 */
export function parseSegments(markerText, pastes) {
	const segments = [];
	let lastIndex = 0;

	for (const match of markerText.matchAll(PASTE_MARKER_RE)) {
		// Typed text before this marker
		if (match.index > lastIndex) {
			segments.push({
				kind: "typed",
				text: markerText.slice(lastIndex, match.index),
			});
		}

		const pasteId = parseInt(match[1], 10);
		const pasteContent = pastes.get(pasteId);

		segments.push({
			kind: "paste",
			text: pasteContent ?? "",
			pasteId,
			missing: pasteContent === undefined,
		});

		lastIndex = match.index + match[0].length;
	}

	// Trailing typed text after last marker
	if (lastIndex < markerText.length) {
		segments.push({
			kind: "typed",
			text: markerText.slice(lastIndex),
		});
	}

	return segments;
}

/**
 * Process segmented paste data: save each paste to a private file, build a
 * manifest, and return transformed text with file references.
 *
 * Runs synchronously (called inside the editor's submitValue which is
 * synchronous).  Writes are atomic enough for temp files — a crash between
 * writes leaves orphaned submission dirs which cleanup handles.
 *
 * @param {string} markerText  Raw editor text with unexpanded paste markers.
 * @param {Map<number,string>} pastes  Runtime paste-id → content Map.
 * @param {{root?:string, minPasteBytes?:number, maxSegments?:number, annotatePasteSize?:boolean}} [options]
 *   `minPasteBytes` is a size floor below which no files are written (returns
 *   `error: "below-min-paste-bytes"`); it defaults to 0 because the floor is a
 *   policy decision owned by the caller, not by segmenting itself.
 *   `maxSegments` bounds the synchronous writes this call performs and defaults
 *   to DEFAULT_MAX_SEGMENTS.  `annotatePasteSize` appends "812 lines, 45.6KB"
 *   to each reference so the model can choose grep over a full read.
 * @returns {{transformedText:string, submissionId:string, submissionDir:string, manifest:object}}
 */
export function processSegmentedPastes(markerText, pastes, options = {}) {
	const root = options.root ?? DEFAULT_ROOT;
	const minPasteBytes = options.minPasteBytes ?? 0;
	const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
	const annotatePasteSize = options.annotatePasteSize ?? DEFAULT_ANNOTATE_PASTE_SIZE;
	const segments = parseSegments(markerText, pastes);

	// Guardrail: refuse to write an excessive number of segment files
	// synchronously (which would block the terminal render loop).
	// Past the cap the editor patcher falls back to v1 whole-input capture.
	if (segments.length > maxSegments) {
		return {
			transformedText: null,
			error: "too-many-segments",
			segmentCount: segments.length,
			maxAllowed: maxSegments,
			segments,
		};
	}

	// Optional size floor: below it, writing a file and handing the model a
	// reference costs more tokens than leaving the paste inline.  Only
	// referenced paste segments count — a paste whose marker the user deleted
	// never reaches the model, so it is not worth a file either.
	const pasteBytes = segments.reduce(
		(sum, seg) => sum + (seg.kind === "paste" ? Buffer.byteLength(seg.text ?? "", "utf8") : 0),
		0,
	);
	if (pasteBytes < minPasteBytes) {
		return {
			transformedText: null,
			error: "below-min-paste-bytes",
			pasteBytes,
			minPasteBytes,
			segmentCount: segments.length,
			segments,
		};
	}

	const submissionId = randomUUID();
	const submissionDir = join(root, SUBMISSIONS_SUBDIR, submissionId);

	mkdirSync(submissionDir, { recursive: true, mode: 0o700 });

	const manifest = {
		submissionId,
		timestamp: new Date().toISOString(),
		segments: [],
	};

	const transformedParts = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];

		if (seg.kind === "typed") {
			transformedParts.push(seg.text);
			// Metadata only: the manifest is a sidecar, and duplicating the
			// user's typed prompt onto disk (beyond the paste files they asked
			// to save) is not part of the bargain.
			manifest.segments.push({
				index: i,
				kind: "typed",
				chars: seg.text.length,
				bytes: Buffer.byteLength(seg.text, "utf8"),
			});
		} else {
			// paste — write to file, replace marker with reference
			// Named by paste id, not segment index: the marker the user sees is
			// "[paste #3 …]", so the file it becomes should say 3.  Segment
			// indices skip numbers (typed segments occupy 0, 2, 4 …), which made
			// references look like they were missing files.
			const pasteFile = join(submissionDir, `paste-${seg.pasteId}.txt`);
			const content = seg.text || "";
			const bytes = Buffer.byteLength(content, "utf8");
			const lines = content ? content.split("\n").length : 0;

			writeFileSync(pasteFile, content, { mode: 0o600 });

			const reference = annotatePasteSize
				? `[paste saved: ${pasteFile} (${describePaste(bytes, lines)})]`
				: `[paste saved: ${pasteFile}]`;
			transformedParts.push(reference);

			const entry = {
				index: i,
				kind: "paste",
				pasteId: seg.pasteId,
				file: pasteFile,
				bytes,
				lines,
			};

			if (seg.missing) {
				entry.fallbackReason = "paste-marker-missing-from-map";
			}

			manifest.segments.push(entry);
		}
	}

	// Write manifest
	const manifestPath = join(submissionDir, "manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

	return {
		transformedText: transformedParts.join(""),
		submissionId,
		submissionDir,
		manifest,
	};
}
