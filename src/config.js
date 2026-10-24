import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_ANNOTATE_PASTE_SIZE,
	DEFAULT_INLINE_FORMAT,
	DEFAULT_MAX_SEGMENTS,
	DEFAULT_MIN_BYTES,
	DEFAULT_MIN_PASTE_BYTES,
	DEFAULT_ROOT,
	DEFAULT_TTL_MS,
} from "./constants.js";
import { INLINE_FORMATS } from "./format.js";

export const CONFIG_FILE_NAME = "pi-pasteboard.json";

/**
 * Integer settings, their bounds, and the environment variable that overrides
 * the same setting.  Precedence is always: environment > config file > default.
 */
const INTEGER_FIELDS = {
	minBytes: { env: "PI_PASTEBOARD_MIN_BYTES", min: 1 },
	minPasteBytes: { env: "PI_PASTEBOARD_MIN_PASTE_BYTES", min: 0 },
	maxSegments: { env: "PI_PASTEBOARD_MAX_SEGMENTS", min: 1 },
	ttlMs: { env: "PI_PASTEBOARD_TTL_MS", min: 1 },
};

/** String settings constrained to a fixed set of values. */
const ENUM_FIELDS = {
	inlineFormat: { env: "PI_PASTEBOARD_INLINE_FORMAT", values: INLINE_FORMATS },
};

/** Boolean settings.  `offWords` lets the environment switch a file-set true off. */
const BOOLEAN_FIELDS = {
	debug: { env: "PI_PASTEBOARD_DEBUG" },
	annotatePasteSize: { env: "PI_PASTEBOARD_ANNOTATE_SIZE" },
};

const KNOWN_KEYS = new Set([
	"$schema",
	"root",
	...Object.keys(INTEGER_FIELDS),
	...Object.keys(ENUM_FIELDS),
	...Object.keys(BOOLEAN_FIELDS),
]);

/** Directory holding Pi's per-user state (`PI_CODING_AGENT_DIR`, ~/.pi/agent).
 *
 * Mirrors Pi's own `getAgentDir()`: the environment value goes through tilde
 * expansion (`~`, `~/`, and `~\\` on Windows), so `PI_CODING_AGENT_DIR='~/.pi/agent-dev'`
 * resolves to the same directory Pi uses rather than to a literal `~` path.
 */
export function agentDir(env = process.env) {
	const override = env.PI_CODING_AGENT_DIR;
	if (override) {
		const expanded = expandTilde(override);
		if (expanded !== "") return expanded;
	}
	return join(homedir(), ".pi", "agent");
}

/** Config file location; `PI_PASTEBOARD_CONFIG` overrides the default. */
export function defaultConfigPath(env = process.env) {
	const override = env.PI_PASTEBOARD_CONFIG;
	if (override) {
		const expanded = expandTilde(override);
		if (expanded !== "") return expanded;
	}
	return join(agentDir(env), CONFIG_FILE_NAME);
}

/** Hard-coded defaults.  Everything is overridable by file or environment. */
export function defaultOptions() {
	return {
		root: DEFAULT_ROOT,
		minBytes: DEFAULT_MIN_BYTES,
		minPasteBytes: DEFAULT_MIN_PASTE_BYTES,
		maxSegments: DEFAULT_MAX_SEGMENTS,
		ttlMs: DEFAULT_TTL_MS,
		inlineFormat: DEFAULT_INLINE_FORMAT,
		annotatePasteSize: DEFAULT_ANNOTATE_PASTE_SIZE,
		debug: false,
	};
}

/**
 * Read and validate the config file.
 *
 * Deliberately lenient per field: this extension sits in the submit path of
 * every prompt, so a typo in one setting must not disable paste capture (or
 * take the session down).  Invalid values are reported through `warn` and the
 * affected field falls back to the default; unknown keys are reported and
 * ignored.
 *
 * @param {string} configPath
 * @param {(message:string)=>void} [warn]
 * @returns {{found:boolean, values:object}}
 */
export function loadConfigFile(configPath, warn = () => {}) {
	let text;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (error) {
		// A missing file is the normal case — not a warning.
		if (error?.code !== "ENOENT") {
			warn(`could not read ${configPath}: ${errorMessage(error)}; using defaults`);
		}
		return { found: false, values: {} };
	}

	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		warn(`${configPath} is not valid JSON: ${errorMessage(error)}; using defaults`);
		return { found: true, values: {} };
	}

	if (!isRecord(parsed)) {
		warn(`${configPath} must contain a JSON object; using defaults`);
		return { found: true, values: {} };
	}

	for (const key of Object.keys(parsed)) {
		if (!KNOWN_KEYS.has(key)) warn(`${configPath}: unknown option "${key}" ignored`);
	}

	const values = {};

	if (parsed.root !== undefined) {
		if (typeof parsed.root === "string" && parsed.root.trim() !== "") {
			values.root = parsed.root;
		} else {
			warn(`${configPath}: "root" must be a non-empty string; ignoring`);
		}
	}

	for (const key of Object.keys(BOOLEAN_FIELDS)) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (typeof value === "boolean") {
			values[key] = value;
		} else {
			warn(`${configPath}: "${key}" must be a boolean; ignoring`);
		}
	}

	for (const [key, spec] of Object.entries(ENUM_FIELDS)) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (typeof value === "string" && spec.values.includes(value)) {
			values[key] = value;
		} else {
			warn(`${configPath}: "${key}" must be one of ${spec.values.join(", ")}; ignoring`);
		}
	}

	for (const [key, spec] of Object.entries(INTEGER_FIELDS)) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (isValidInteger(value, spec.min)) {
			values[key] = value;
		} else {
			warn(`${configPath}: "${key}" must be an integer >= ${spec.min}; ignoring`);
		}
	}

	return { found: true, values };
}

/**
 * Resolve effective options: defaults, overlaid by the config file, overlaid by
 * environment variables.
 *
 * @param {{env?:Record<string,string|undefined>, warn?:(message:string)=>void, configPath?:string}} [overrides]
 *   `env`/`warn`/`configPath` exist for tests; production callers pass nothing.
 * @returns {{options:ReturnType<typeof defaultOptions>, configPath:string, configFound:boolean}}
 */
export function resolveOptions(overrides = {}) {
	const env = overrides.env ?? process.env;
	const warn = overrides.warn ?? (() => {});
	const configPath = overrides.configPath ?? defaultConfigPath(env);

	const file = loadConfigFile(configPath, warn);
	const options = { ...defaultOptions(), ...file.values };

	for (const [key, spec] of Object.entries(INTEGER_FIELDS)) {
		const raw = env[spec.env];
		if (raw === undefined) continue;
		const text = raw.trim();
		if (text === "") continue;
		// Digits only: `Number()` would otherwise accept "0x10", "1e3" and
		// "Infinity", which are not useful spellings for a byte/time limit.
		const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
		if (isValidInteger(value, spec.min)) {
			options[key] = value;
		} else {
			warn(`${spec.env}=${JSON.stringify(raw)} is not an integer >= ${spec.min}; using ${options[key]}`);
		}
	}

	if (env.PI_PASTEBOARD_ROOT) options.root = env.PI_PASTEBOARD_ROOT;

	// `0`/false/off turn a boolean off again, so the environment can override
	// `true` in the config file in both directions.  Bare presence (the
	// historical `PI_PASTEBOARD_DEBUG=1`) still means on.
	for (const [key, spec] of Object.entries(BOOLEAN_FIELDS)) {
		const raw = env[spec.env];
		if (raw === undefined) continue;
		const text = raw.trim();
		if (text === "") continue;
		options[key] = !/^(0|false|no|off)$/i.test(text);
	}

	for (const [key, spec] of Object.entries(ENUM_FIELDS)) {
		const raw = env[spec.env];
		if (raw === undefined) continue;
		const text = raw.trim();
		if (text === "") continue;
		if (spec.values.includes(text)) {
			options[key] = text;
		} else {
			warn(`${spec.env}=${JSON.stringify(raw)} must be one of ${spec.values.join(", ")}; using ${options[key]}`);
		}
	}

	return { options, configPath, configFound: file.found };
}

function expandTilde(input) {
	const home = homedir();
	if (input === "~") return home;
	if (input.startsWith("~/")) return join(home, input.slice(2));
	if (process.platform === "win32" && input.startsWith("~\\")) return join(home, input.slice(2));
	return input;
}

function isValidInteger(value, min) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
