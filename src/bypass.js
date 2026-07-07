import { DEFAULT_MIN_BYTES } from "./constants.js";

const LIKELY_AT_REF_RE = /(?:^|\s)@\S+/;

export function utf8ByteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

export function getBypassReason(input, options = {}) {
	const text = typeof input.text === "string" ? input.text : "";
	const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;

	if (input.source === "extension") return "extension-source";
	if (input.mode !== "tui") return "non-tui";
	if (input.source !== "interactive") return "non-interactive";
	if ((input.images?.length ?? 0) > 0) return "images";
	if ((input.attachments?.length ?? 0) > 0) return "attachments";

	const trimmed = text.trimStart();
	if (trimmed.startsWith("/")) return "slash-command";
	if (trimmed.startsWith("!")) return "bang-command";
	if (LIKELY_AT_REF_RE.test(text)) return "likely-at-ref";
	if (utf8ByteLength(text) < minBytes) return "below-threshold";

	return undefined;
}

export function shouldCaptureInput(input, options = {}) {
	return getBypassReason(input, options) === undefined;
}
