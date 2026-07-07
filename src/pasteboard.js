import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ROOT, DEFAULT_TTL_MS, HASH_FILE_RE, STALE_LOCK_MS } from "./constants.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class PasteboardSafetyError extends Error {
	constructor(message) {
		super(message);
		this.name = "PasteboardSafetyError";
	}
}

export function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function pastePathForHash(root, hash) {
	return join(root, `sha256-${hash}.txt`);
}

function currentUid() {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function safeStatRoot(root) {
	let stat;
	try {
		stat = await lstat(root);
	} catch (error) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
	if (stat.isSymbolicLink()) {
		throw new PasteboardSafetyError(`${root} is a symlink; refusing to use pasteboard root`);
	}
	if (!stat.isDirectory()) {
		throw new PasteboardSafetyError(`${root} is not a directory; refusing to use pasteboard root`);
	}
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) {
		throw new PasteboardSafetyError(`${root} is owned by uid ${stat.uid}, not current uid ${uid}`);
	}
	return stat;
}

export async function ensurePasteboardRoot(root = DEFAULT_ROOT) {
	try {
		await mkdir(root, { mode: DIR_MODE });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}
	await safeStatRoot(root);
	await chmod(root, DIR_MODE);
	await safeStatRoot(root);
	return root;
}

async function fsyncFileHandle(handle) {
	try {
		await handle.sync();
	} catch {
		// Best effort only: some filesystems do not support fsync in temp dirs.
	}
}

async function fsyncDirectory(root) {
	let handle;
	try {
		handle = await open(root, fsConstants.O_RDONLY);
		await handle.sync();
	} catch {
		// Best effort only: opening/fsyncing directories is platform dependent.
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function writeTempFile(root, bytes, hash) {
	const tempPath = join(root, `.sha256-${hash}.${process.pid}.${randomUUID()}.tmp`);
	const handle = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE);
	try {
		await handle.writeFile(bytes);
		await fsyncFileHandle(handle);
	} finally {
		await handle.close();
	}
	return tempPath;
}

async function assertExistingContent(finalPath, bytes) {
	const stat = await lstat(finalPath);
	if (!stat.isFile()) {
		throw new PasteboardSafetyError(`${finalPath} already exists but is not a regular file`);
	}
	const uid = currentUid();
	if (uid !== undefined && stat.uid !== uid) {
		throw new PasteboardSafetyError(`${finalPath} is owned by uid ${stat.uid}, not current uid ${uid}`);
	}
	if (stat.size !== bytes.length) {
		throw new PasteboardSafetyError(`${finalPath} hash collision or corrupt file: size mismatch`);
	}
	const existing = await readFile(finalPath);
	if (!existing.equals(bytes)) {
		throw new PasteboardSafetyError(`${finalPath} hash collision or corrupt file: content mismatch`);
	}
	await chmod(finalPath, FILE_MODE);
}

export async function writePasteText(text, options = {}) {
	const root = await ensurePasteboardRoot(options.root ?? DEFAULT_ROOT);
	const bytes = Buffer.from(text, "utf8");
	const hash = sha256Hex(bytes);
	const path = pastePathForHash(root, hash);
	const tempPath = await writeTempFile(root, bytes, hash);
	let linked = false;

	try {
		try {
			await link(tempPath, path);
			linked = true;
			await fsyncDirectory(root);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			await assertExistingContent(path, bytes);
		}

		if (linked) {
			await chmod(path, FILE_MODE);
		} else {
			const now = new Date();
			await utimes(path, now, now);
		}
		return { root, path, hash, bytes: bytes.length, reused: !linked };
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
}

export async function cleanupOldPasteFiles(options = {}) {
	const root = await ensurePasteboardRoot(options.root ?? DEFAULT_ROOT);
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const nowMs = options.nowMs ?? Date.now();
	const lockPath = join(root, ".cleanup.lock");
	let lock;
	try {
		lock = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE);
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		let lockStat;
		try {
			lockStat = await lstat(lockPath);
		} catch (statError) {
			if (statError?.code === "ENOENT") {
				lock = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE).catch(() => null);
				if (!lock) return { root, removed: 0, skipped: true };
			} else {
				throw statError;
			}
		}
		if (lockStat && nowMs - lockStat.mtimeMs >= STALE_LOCK_MS) {
			await unlink(lockPath).catch(() => undefined);
			lock = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE).catch(() => null);
			if (!lock) return { root, removed: 0, skipped: true };
		} else if (lockStat) {
			return { root, removed: 0, skipped: true };
		}
	}

	let removed = 0;
	try {
		const uid = currentUid();
		const entries = await readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (!HASH_FILE_RE.test(entry.name)) continue;
			const path = join(root, entry.name);
			let stat;
			try {
				stat = await lstat(path);
			} catch (error) {
				if (error?.code === "ENOENT") continue;
				throw error;
			}
			if (!stat.isFile()) continue;
			if (uid !== undefined && stat.uid !== uid) continue;
			if (nowMs - stat.mtimeMs < ttlMs) continue;
			try {
				await unlink(path);
				removed += 1;
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
		}
		return { root, removed, skipped: false };
	} finally {
		await lock.close().catch(() => undefined);
		await unlink(lockPath).catch(() => undefined);
	}
}
