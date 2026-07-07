export const DEFAULT_ROOT = "/tmp/pi-pasteboard";
export const DEFAULT_MIN_BYTES = 32 * 1024;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STALE_LOCK_MS = 10 * 60 * 1000;
export const HASH_FILE_RE = /^sha256-[a-f0-9]{64}\.txt$/;
export const SUBMISSIONS_SUBDIR = "submissions";
export const PASTE_MARKER_RE = /\[paste #(\d+)(?: \+(\d+) lines| (\d+) chars)?\]/g;
export const HAS_PASTE_MARKER_RE = /\[paste #\d+/;

export function readPositiveIntegerEnv(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) return fallback;
	return value;
}
