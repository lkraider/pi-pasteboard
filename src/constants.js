export const DEFAULT_ROOT = "/tmp/pi-pasteboard";
export const DEFAULT_MIN_BYTES = 32 * 1024;
// v2 segmented capture floor.  Each captured paste costs the model a
// `[paste saved: <path>]` reference (~27 tokens) plus a `read` tool call
// (~44 tokens) before any content arrives, so capturing a small paste is a net
// token loss versus leaving it inline.  Pi itself only creates a paste marker
// above 10 lines / 1000 chars, which can be as little as ~50 tokens of content.
// 4 KiB (~1100 tokens) leaves enough headroom for the read to come in well
// under the paste's own cost, including a selective `grep` instead of a full
// `read`.  Overridable via PI_PASTEBOARD_MIN_PASTE_BYTES or the config file;
// 0 captures every paste.
export const DEFAULT_MIN_PASTE_BYTES = 4 * 1024;
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SEGMENTS = 50;
// How an inline (below-floor) paste appears in the submitted prompt.
//   "stock"  — Pi's own expansion: content substituted in place, no spacing.
//   "spaced" — paste on its own block, one blank line either side.
export const DEFAULT_INLINE_FORMAT = "spaced";
// Append "812 lines, 45.6KB" to [paste saved: …] so the model can choose
// between grep and a full read.
export const DEFAULT_ANNOTATE_PASTE_SIZE = true;
export const STALE_LOCK_MS = 10 * 60 * 1000;
export const HASH_FILE_RE = /^sha256-[a-f0-9]{64}\.txt$/;
export const SUBMISSIONS_SUBDIR = "submissions";
export const PASTE_MARKER_RE = /\[paste #(\d+)(?: \+(\d+) lines| (\d+) chars)?\]/g;
export const HAS_PASTE_MARKER_RE = /\[paste #\d+/;
