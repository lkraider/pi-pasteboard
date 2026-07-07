import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ROOT, PASTE_MARKER_RE, SUBMISSIONS_SUBDIR } from "./constants.js";

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
 * @param {{root?:string}} [options]
 * @returns {{transformedText:string, submissionId:string, submissionDir:string, manifest:object}}
 */
export function processSegmentedPastes(markerText, pastes, options = {}) {
	const root = options.root ?? DEFAULT_ROOT;
	const segments = parseSegments(markerText, pastes);
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
			manifest.segments.push({
				index: i,
				kind: "typed",
				text: seg.text,
			});
		} else {
			// paste — write to file, replace marker with reference
			const pasteFile = join(submissionDir, `paste-${i}.txt`);
			const content = seg.text || "";
			const bytes = Buffer.byteLength(content, "utf8");
			const lines = content ? content.split("\n").length : 0;

			writeFileSync(pasteFile, content, { mode: 0o600 });

			transformedParts.push(`[paste saved: ${pasteFile}]`);

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
