import { DEFAULT_MIN_BYTES, DEFAULT_ROOT, DEFAULT_TTL_MS, readPositiveIntegerEnv } from "./constants.js";
import { getBypassReason } from "./bypass.js";
import { cleanupOldPasteFiles, writePasteText } from "./pasteboard.js";
import { makeReferenceInstruction } from "./transform.js";

export function extensionOptionsFromEnv() {
	return {
		root: DEFAULT_ROOT,
		minBytes: readPositiveIntegerEnv("PI_PASTEBOARD_MIN_BYTES", DEFAULT_MIN_BYTES),
		ttlMs: readPositiveIntegerEnv("PI_PASTEBOARD_TTL_MS", DEFAULT_TTL_MS),
	};
}

export async function captureInput(input, options = {}) {
	const resolved = {
		root: options.root ?? DEFAULT_ROOT,
		minBytes: options.minBytes ?? DEFAULT_MIN_BYTES,
		ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
	};
	const bypassReason = getBypassReason(input, { minBytes: resolved.minBytes });
	if (bypassReason) {
		return { action: "continue", reason: bypassReason };
	}

	await cleanupOldPasteFiles({ root: resolved.root, ttlMs: resolved.ttlMs });
	const written = await writePasteText(input.text, { root: resolved.root });
	await cleanupOldPasteFiles({ root: resolved.root, ttlMs: resolved.ttlMs });

	return {
		action: "transform",
		text: makeReferenceInstruction(written.path),
		path: written.path,
		hash: written.hash,
		bytes: written.bytes,
		reused: written.reused,
	};
}
