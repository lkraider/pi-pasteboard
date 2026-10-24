import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import test from "node:test";

import {
	CONFIG_FILE_NAME,
	agentDir,
	defaultConfigPath,
	defaultOptions,
	loadConfigFile,
	resolveOptions,
} from "../src/config.js";
import {
	DEFAULT_MAX_SEGMENTS,
	DEFAULT_MIN_BYTES,
	DEFAULT_MIN_PASTE_BYTES,
	DEFAULT_ROOT,
	DEFAULT_TTL_MS,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pasteboard-config-"));
}

/** Write a config file into a fresh temp dir and return its path. */
function configWith(contents) {
	const dir = tmpDir();
	const path = join(dir, CONFIG_FILE_NAME);
	writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
	return { dir, path };
}

/** resolveOptions against an explicit config path and env, collecting warnings. */
function resolve(configPath, env = {}) {
	const warnings = [];
	const result = resolveOptions({ configPath, env, warn: (m) => warnings.push(m) });
	return { ...result, warnings };
}

const missingPath = () => join(tmpDir(), "does-not-exist.json");

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("config: defaults match the documented constants", () => {
	const options = defaultOptions();
	assert.equal(options.root, DEFAULT_ROOT);
	assert.equal(options.minBytes, DEFAULT_MIN_BYTES);
	assert.equal(options.minPasteBytes, DEFAULT_MIN_PASTE_BYTES);
	assert.equal(options.maxSegments, DEFAULT_MAX_SEGMENTS);
	assert.equal(options.ttlMs, DEFAULT_TTL_MS);
	assert.equal(options.debug, false);

	// The thresholds themselves are documented in the README.
	assert.equal(DEFAULT_MIN_BYTES, 32768);
	assert.equal(DEFAULT_MIN_PASTE_BYTES, 4096);
	assert.equal(DEFAULT_MAX_SEGMENTS, 50);
});

test("config: missing file is not a warning and yields defaults", () => {
	const path = missingPath();
	const { options, configFound, warnings } = resolve(path);
	assert.deepEqual(options, defaultOptions());
	assert.equal(configFound, false);
	assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

test("config: file values are applied", () => {
	const { dir, path } = configWith({
		root: "/tmp/custom-pasteboard",
		minBytes: 1024,
		minPasteBytes: 8192,
		maxSegments: 5,
		ttlMs: 60_000,
		inlineFormat: "stock",
		annotatePasteSize: false,
		debug: true,
	});
	try {
		const { options, configFound, warnings } = resolve(path);
		assert.equal(configFound, true);
		assert.deepEqual(warnings, []);
		assert.deepEqual(options, {
			root: "/tmp/custom-pasteboard",
			minBytes: 1024,
			minPasteBytes: 8192,
			maxSegments: 5,
			ttlMs: 60_000,
			inlineFormat: "stock",
			annotatePasteSize: false,
			debug: true,
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: minPasteBytes 0 is honoured (floor disabled)", () => {
	const { dir, path } = configWith({ minPasteBytes: 0 });
	try {
		assert.equal(resolve(path).options.minPasteBytes, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: $schema key is accepted silently", () => {
	const { dir, path } = configWith({
		$schema: "./pi-pasteboard.schema.json",
		minPasteBytes: 100,
	});
	try {
		const { options, warnings } = resolve(path);
		assert.deepEqual(warnings, []);
		assert.equal(options.minPasteBytes, 100);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: unknown keys warn but do not discard valid siblings", () => {
	const { dir, path } = configWith({ minPasteBytes: 2048, minPasteByte: 999 });
	try {
		const { options, warnings } = resolve(path);
		assert.equal(options.minPasteBytes, 2048);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /unknown option "minPasteByte"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: invalid JSON warns and falls back to defaults", () => {
	const { dir, path } = configWith("{ not json");
	try {
		const { options, configFound, warnings } = resolve(path);
		assert.equal(configFound, true);
		assert.deepEqual(options, defaultOptions());
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /not valid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: non-object JSON warns and falls back to defaults", () => {
	for (const body of ["[]", "null", "42", '"str"']) {
		const { dir, path } = configWith(body);
		try {
			const { options, warnings } = resolve(path);
			assert.deepEqual(options, defaultOptions(), `body: ${body}`);
			assert.equal(warnings.length, 1, `body: ${body}`);
			assert.match(warnings[0], /must contain a JSON object/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("config: wrong-typed fields warn individually and keep other values", () => {
	const { dir, path } = configWith({
		root: "",
		debug: "yes",
		minBytes: "4096",
		minPasteBytes: -1,
		maxSegments: 0,
		ttlMs: 1.5,
	});
	try {
		const { options, warnings } = resolve(path);
		assert.deepEqual(options, defaultOptions());
		assert.equal(warnings.length, 6);
		for (const key of ["root", "debug", "minBytes", "minPasteBytes", "maxSegments", "ttlMs"]) {
			assert.ok(
				warnings.some((w) => w.includes(`"${key}"`)),
				`expected a warning for ${key}`,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: unreadable path (EISDIR) warns instead of throwing", () => {
	const dir = tmpDir();
	try {
		// A directory where the file should be → readFileSync throws, not ENOENT.
		const warnings = [];
		const { found } = loadConfigFile(dir, (m) => warnings.push(m));
		assert.equal(found, false);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /could not read/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Precedence: environment > config file > defaults
// ---------------------------------------------------------------------------

test("config: environment overrides the config file", () => {
	const { dir, path } = configWith({
		root: "/tmp/from-file",
		minPasteBytes: 1024,
		maxSegments: 5,
		ttlMs: 1000,
		debug: false,
	});
	try {
		const { options, warnings } = resolve(path, {
			PI_PASTEBOARD_ROOT: "/tmp/from-env",
			PI_PASTEBOARD_MIN_PASTE_BYTES: "4096",
			PI_PASTEBOARD_MAX_SEGMENTS: "20",
			PI_PASTEBOARD_TTL_MS: "5000",
			PI_PASTEBOARD_DEBUG: "1",
		});
		assert.deepEqual(warnings, []);
		assert.equal(options.root, "/tmp/from-env");
		assert.equal(options.minPasteBytes, 4096);
		assert.equal(options.maxSegments, 20);
		assert.equal(options.ttlMs, 5000);
		assert.equal(options.debug, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: unset env vars leave config-file values intact", () => {
	const { dir, path } = configWith({ minPasteBytes: 1024, minBytes: 4096 });
	try {
		const { options } = resolve(path, {});
		assert.equal(options.minPasteBytes, 1024);
		assert.equal(options.minBytes, 4096);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: invalid env value falls back to the config file, not the default", () => {
	const { dir, path } = configWith({ minPasteBytes: 1024 });
	try {
		const { options, warnings } = resolve(path, { PI_PASTEBOARD_MIN_PASTE_BYTES: "abc" });
		assert.equal(options.minPasteBytes, 1024);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /PI_PASTEBOARD_MIN_PASTE_BYTES/);
		assert.match(warnings[0], /using 1024/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: invalid env values are rejected", () => {
	for (const bad of ["-1", "abc", "1.5", "0x10", "Infinity"]) {
		const { options, warnings } = resolve(missingPath(), { PI_PASTEBOARD_MIN_PASTE_BYTES: bad });
		assert.equal(options.minPasteBytes, DEFAULT_MIN_PASTE_BYTES, `input: ${bad}`);
		assert.equal(warnings.length, 1, `input: ${bad}`);
	}
});

test("config: PI_PASTEBOARD_MIN_PASTE_BYTES=0 disables the floor", () => {
	const { options } = resolve(missingPath(), { PI_PASTEBOARD_MIN_PASTE_BYTES: "0" });
	assert.equal(options.minPasteBytes, 0);
});

test("config: v1 and v2 thresholds are independent in both layers", () => {
	const { dir, path } = configWith({ minBytes: 1000, minPasteBytes: 2000 });
	try {
		const fromFile = resolve(path).options;
		assert.equal(fromFile.minBytes, 1000);
		assert.equal(fromFile.minPasteBytes, 2000);

		const fromEnv = resolve(path, {
			PI_PASTEBOARD_MIN_BYTES: "65536",
			PI_PASTEBOARD_MIN_PASTE_BYTES: "1024",
		}).options;
		assert.equal(fromEnv.minBytes, 65536);
		assert.equal(fromEnv.minPasteBytes, 1024);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Debug flag semantics
// ---------------------------------------------------------------------------

test("config: PI_PASTEBOARD_DEBUG=0 turns off file-enabled debugging", () => {
	const { dir, path } = configWith({ debug: true });
	try {
		assert.equal(resolve(path).options.debug, true);
		for (const off of ["0", "false", "no", "off", "FALSE"]) {
			assert.equal(resolve(path, { PI_PASTEBOARD_DEBUG: off }).options.debug, false, `input: ${off}`);
		}
		for (const on of ["1", "true", "yes"]) {
			assert.equal(resolve(path, { PI_PASTEBOARD_DEBUG: on }).options.debug, true, `input: ${on}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test("config: config path honours PI_CODING_AGENT_DIR then PI_PASTEBOARD_CONFIG", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
	assert.match(agentDir({}), /\.pi\/agent$/);

	assert.equal(
		defaultConfigPath({ PI_CODING_AGENT_DIR: "/custom/agent" }),
		join("/custom/agent", CONFIG_FILE_NAME),
	);
	// PI_PASTEBOARD_CONFIG wins over the agent dir.
	assert.equal(
		defaultConfigPath({
			PI_CODING_AGENT_DIR: "/custom/agent",
			PI_PASTEBOARD_CONFIG: "/etc/pi-pasteboard.json",
		}),
		"/etc/pi-pasteboard.json",
	);
});

test("config: resolveOptions without a configPath consults the environment path", () => {
	const { dir, path } = configWith({ minPasteBytes: 1234 });
	try {
		const warnings = [];
		const { options, configPath, configFound } = resolveOptions({
			env: { PI_PASTEBOARD_CONFIG: path },
			warn: (m) => warnings.push(m),
		});
		assert.equal(configPath, path);
		assert.equal(configFound, true);
		assert.equal(options.minPasteBytes, 1234);
		assert.deepEqual(warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Agent-directory normalization (regression: Pi expands tildes, so must we)
// ---------------------------------------------------------------------------

test("config: PI_CODING_AGENT_DIR tilde is expanded like Pi's getAgentDir()", () => {
	const home = homedir();

	// Verbose form and bare "~" both resolve under the home directory.
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/.pi/agent-dev" }), join(home, ".pi/agent-dev"));
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~" }), home);
	assert.equal(
		defaultConfigPath({ PI_CODING_AGENT_DIR: "~/custom-agent" }),
		join(home, "custom-agent", CONFIG_FILE_NAME),
	);

	// Absolute and relative paths are passed through unchanged.
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/abs/agent" }), "/abs/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "rel/agent" }), "rel/agent");
});

test("config: PI_PASTEBOARD_CONFIG tilde is expanded", () => {
	assert.equal(
		defaultConfigPath({ PI_PASTEBOARD_CONFIG: "~/configs/pi-pasteboard.json" }),
		join(homedir(), "configs/pi-pasteboard.json"),
	);
});

test("config: tilde-prefixed config path is actually read, not silently missed", () => {
	// Regression: before normalization this path resolved to a literal "~/..."
	// directory, the ENOENT was swallowed, and valid settings were ignored.
	const home = homedir();
	const dirName = `.pi-pasteboard-test-${process.pid}-${Date.now()}`;
	const dir = join(home, dirName);
	mkdirSync(dir, { recursive: true });
	const relPath = `~/${dirName}/${CONFIG_FILE_NAME}`;
	writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ minPasteBytes: 777 }));
	try {
		const warnings = [];
		const { options, configFound } = resolveOptions({
			env: { PI_PASTEBOARD_CONFIG: relPath },
			warn: (m) => warnings.push(m),
		});
		assert.equal(configFound, true);
		assert.equal(options.minPasteBytes, 777);
		assert.deepEqual(warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Presentation settings: inlineFormat, annotatePasteSize
// ---------------------------------------------------------------------------

test("config: presentation defaults", () => {
	const options = defaultOptions();
	assert.equal(options.inlineFormat, "spaced");
	assert.equal(options.annotatePasteSize, true);
});

test("config: inlineFormat accepts the supported formats from file and env", () => {
	for (const format of ["stock", "spaced"]) {
		const { dir, path } = configWith({ inlineFormat: format });
		try {
			assert.equal(resolve(path).options.inlineFormat, format);
			assert.equal(resolve(path, { PI_PASTEBOARD_INLINE_FORMAT: format }).options.inlineFormat, format);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("config: invalid inlineFormat warns and keeps the previous value", () => {
	const { dir, path } = configWith({ inlineFormat: "yaml" });
	try {
		const { options, warnings } = resolve(path);
		assert.equal(options.inlineFormat, "spaced");
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /"inlineFormat" must be one of stock, spaced/);

		// Environment invalid → falls back to the file value, not the default.
		const fromFile = configWith({ inlineFormat: "stock" });
		try {
			const envWarn = [];
			const { options: opts } = resolveOptions({
				configPath: fromFile.path,
				env: { PI_PASTEBOARD_INLINE_FORMAT: "yaml" },
				warn: (m) => envWarn.push(m),
			});
			assert.equal(opts.inlineFormat, "stock");
			assert.equal(envWarn.length, 1);
		} finally {
			rmSync(fromFile.dir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: annotatePasteSize accepts booleans and env off-words", () => {
	const { dir, path } = configWith({ annotatePasteSize: false });
	try {
		assert.equal(resolve(path).options.annotatePasteSize, false);
		// Env can switch a file-set false back on.
		assert.equal(resolve(path, { PI_PASTEBOARD_ANNOTATE_SIZE: "1" }).options.annotatePasteSize, true);

		const on = configWith({ annotatePasteSize: true });
		try {
			for (const off of ["0", "false", "no", "off"]) {
				assert.equal(
					resolve(on.path, { PI_PASTEBOARD_ANNOTATE_SIZE: off }).options.annotatePasteSize,
					false,
					`input: ${off}`,
				);
			}
		} finally {
			rmSync(on.dir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config: non-boolean annotatePasteSize warns and keeps the default", () => {
	const { dir, path } = configWith({ annotatePasteSize: "yes" });
	try {
		const { options, warnings } = resolve(path);
		assert.equal(options.annotatePasteSize, true);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /"annotatePasteSize" must be a boolean/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
