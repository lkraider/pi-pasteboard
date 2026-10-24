import { DEFAULT_MIN_BYTES, DEFAULT_ROOT, DEFAULT_TTL_MS } from "./constants.js";
import { getBypassReason } from "./bypass.js";
import { cleanupOldPasteFiles, writePasteText } from "./pasteboard.js";

export function makeReferenceInstruction(path) {
	return `Large input captured at ${path}. Read that file if needed; do not ask the user to paste it again.`;
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

	return {
		action: "transform",
		text: makeReferenceInstruction(written.path),
		path: written.path,
		hash: written.hash,
		bytes: written.bytes,
		reused: written.reused,
	};
}
