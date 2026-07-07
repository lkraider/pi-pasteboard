import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { getBypassReason, shouldCaptureInput, utf8ByteLength } from "../src/bypass.js";
import { captureInput } from "../src/capture.js";
import { HASH_FILE_RE } from "../src/constants.js";
import { cleanupOldPasteFiles, ensurePasteboardRoot, PasteboardSafetyError, writePasteText } from "../src/pasteboard.js";
import { makeReferenceInstruction } from "../src/transform.js";

async function withRoot(fn) {
	const parent = await mkdtemp(join(tmpdir(), "pi-pasteboard-test-"));
	const root = join(parent, "root");
	try {
		return await fn(root, parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

function modeBits(stat) {
	return stat.mode & 0o777;
}

test("writePasteText stores exact UTF-8 bytes under sha256 filename with private modes", async () => {
	await withRoot(async (root) => {
		const text = "hello π\nline 2";
		const expectedHash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
		const result = await writePasteText(text, { root });

		assert.equal(result.hash, expectedHash);
		assert.equal(result.path, join(root, `sha256-${expectedHash}.txt`));
		assert.equal(await readFile(result.path, "utf8"), text);
		assert.equal(modeBits(await lstat(root)), 0o700);
		assert.equal(modeBits(await lstat(result.path)), 0o600);
		assert.match(result.path.split("/").at(-1), HASH_FILE_RE);
	});
});

test("duplicate content reuses the same file and refreshes mtime", async () => {
	await withRoot(async (root) => {
		const first = await writePasteText("same content", { root });
		const old = new Date(Date.now() - 60_000);
		await utimes(first.path, old, old);
		const before = (await lstat(first.path)).mtimeMs;

		const second = await writePasteText("same content", { root });
		const after = (await lstat(second.path)).mtimeMs;

		assert.equal(second.path, first.path);
		assert.equal(second.reused, true);
		assert.ok(after > before, `mtime was not refreshed: before=${before} after=${after}`);
	});
});

test("concurrent identical writes converge on one valid final file", async () => {
	await withRoot(async (root) => {
		const text = "concurrent".repeat(1000);
		const results = await Promise.all(Array.from({ length: 12 }, () => writePasteText(text, { root })));
		const paths = new Set(results.map((r) => r.path));
		assert.equal(paths.size, 1);
		assert.equal(await readFile(results[0].path, "utf8"), text);

		const entries = await readdir(root);
		assert.equal(entries.filter((name) => HASH_FILE_RE.test(name)).length, 1);
		assert.equal(entries.filter((name) => name.endsWith(".tmp")).length, 0);
	});
});

test("cleanup removes only old owned sha256 regular files", async () => {
	await withRoot(async (root) => {
		await ensurePasteboardRoot(root);
		const old = new Date(Date.now() - 10_000);
		const oldHash = "a".repeat(64);
		const newHash = "b".repeat(64);
		const oldPath = join(root, `sha256-${oldHash}.txt`);
		const newPath = join(root, `sha256-${newHash}.txt`);
		const otherPath = join(root, "sha256-not-a-real-hash.txt");
		await writeFile(oldPath, "old", { mode: 0o600 });
		await writeFile(newPath, "new", { mode: 0o600 });
		await writeFile(otherPath, "other", { mode: 0o600 });
		await utimes(oldPath, old, old);
		await symlink(oldPath, join(root, `sha256-${"c".repeat(64)}.txt`)).catch(() => undefined);

		const result = await cleanupOldPasteFiles({ root, ttlMs: 1_000, nowMs: Date.now() });
		const entries = await readdir(root);

		assert.equal(result.removed, 1);
		assert.ok(!entries.includes(`sha256-${oldHash}.txt`));
		assert.ok(entries.includes(`sha256-${newHash}.txt`));
		assert.ok(entries.includes("sha256-not-a-real-hash.txt"));
	});
});

test("unsafe roots are rejected", async () => {
	await withRoot(async (root, parent) => {
		await writeFile(root, "not a dir");
		await assert.rejects(() => ensurePasteboardRoot(root), PasteboardSafetyError);
		await rm(root, { force: true });

		const target = join(parent, "target");
		await mkdir(target);
		await symlink(target, root);
		await assert.rejects(() => ensurePasteboardRoot(root), PasteboardSafetyError);
	});
});

test("transform is a short path reference without content preview", () => {
	const path = "/tmp/pi-pasteboard/sha256-" + "d".repeat(64) + ".txt";
	const transformed = makeReferenceInstruction(path);
	assert.equal(transformed, `Large input captured at ${path}. Read that file if needed; do not ask the user to paste it again.`);
	assert.ok(!transformed.includes("first pasted line"));
});

test("bypass behavior is conservative", () => {
	const large = "x".repeat(100);
	const base = { text: large, source: "interactive", mode: "tui" };
	const minBytes = 10;

	assert.equal(getBypassReason({ ...base, source: "extension" }, { minBytes }), "extension-source");
	assert.equal(getBypassReason({ ...base, mode: "rpc" }, { minBytes }), "non-tui");
	assert.equal(getBypassReason({ ...base, source: "rpc" }, { minBytes }), "non-interactive");
	assert.equal(getBypassReason({ ...base, images: [{}] }, { minBytes }), "images");
	assert.equal(getBypassReason({ ...base, attachments: [{}] }, { minBytes }), "attachments");
	assert.equal(getBypassReason({ ...base, text: " /model gpt" }, { minBytes }), "slash-command");
	assert.equal(getBypassReason({ ...base, text: " !!echo hi" }, { minBytes }), "bang-command");
	assert.equal(getBypassReason({ ...base, text: `see @src/index.ts ${large}` }, { minBytes }), "likely-at-ref");
	assert.equal(getBypassReason({ ...base, text: "tiny" }, { minBytes }), "below-threshold");
	assert.equal(getBypassReason(base, { minBytes }), undefined);
	assert.equal(shouldCaptureInput(base, { minBytes }), true);
	assert.equal(utf8ByteLength("π"), 2);
});

test("captureInput writes full eligible input and returns only the reference", async () => {
	await withRoot(async (root) => {
		const text = "large submitted envelope\n" + "payload\n".repeat(20);
		const result = await captureInput({ text, source: "interactive", mode: "tui" }, { root, minBytes: 10, ttlMs: 10_000 });

		assert.equal(result.action, "transform");
		assert.equal(await readFile(result.path, "utf8"), text);
		assert.ok(result.text.includes(result.path));
		assert.ok(!result.text.includes("payload"));
	});
});
