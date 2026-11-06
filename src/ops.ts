/**
 * pi tool operations implemented on top of a SandboxBackend.
 *
 * Every function here only needs `backend.exec`, so it works for any backend.
 */

import { readFile as hostReadFile, access as hostAccess } from "node:fs/promises";
import path from "node:path";
import {
	type BashOperations,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { type BackendInfo, ExecError, execOk, type SandboxBackend } from "./backend.ts";
import { isInsideOrEqual } from "./config.ts";
import { matchesToolGlob } from "./glob.ts";
import type { PathMap } from "./paths.ts";

export interface OpsContext {
	backend: SandboxBackend;
	info: BackendInfo;
	paths: PathMap;
	readOnly: boolean;
	/** Host directories the read tool may read directly (pi skills and docs). */
	hostReadDirs: () => string[];
}

function fsError(code: string, op: string, p: string, hint?: string): Error {
	const messages: Record<string, string> = {
		ENOENT: "no such file or directory",
		EACCES: "permission denied",
		EROFS: "read-only file system",
		EISDIR: "is a directory",
	};
	const err = new Error(`${code}: ${messages[code] ?? code}, ${op} '${p}'${hint ? ` (${hint})` : ""}`) as NodeJS.ErrnoException;
	err.code = code;
	return err;
}

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

function isHostReadable(ctx: OpsContext, p: string): boolean {
	if (ctx.paths.inProject(p)) return false;
	const abs = path.resolve(p);
	return ctx.hostReadDirs().some((dir) => isInsideOrEqual(dir, abs));
}

/** Exit codes of the access probe script. */
const ACCESS_SCRIPT = `
p=$1 mode=$2
[ -e "$p" ] || exit 2
[ -d "$p" ] && exit 5
[ -r "$p" ] || exit 3
if [ "$mode" = rw ] && [ ! -w "$p" ]; then exit 4; fi
exit 0
`;

async function guestAccess(ctx: OpsContext, hostPath: string, mode: "r" | "rw"): Promise<void> {
	const g = ctx.paths.toGuest(hostPath);
	const r = await ctx.backend.exec(["sh", "-c", ACCESS_SCRIPT, "sh", g, mode]);
	switch (r.exitCode) {
		case 0:
			return;
		case 2:
			throw fsError("ENOENT", "access", hostPath);
		case 3:
			throw fsError("EACCES", "access", hostPath);
		case 4:
			if (ctx.readOnly && ctx.paths.inProject(hostPath)) throw fsError("EROFS", "access", hostPath, "the project is mounted read-only in the sandbox");
			throw fsError("EACCES", "access", hostPath);
		case 5:
			throw fsError("EISDIR", "read", hostPath);
		default:
			throw new Error(r.stderr.toString("utf8").trim() || `access check failed for ${hostPath}`);
	}
}

async function guestReadFile(ctx: OpsContext, hostPath: string): Promise<Buffer> {
	const r = await ctx.backend.exec(["cat", "--", ctx.paths.toGuest(hostPath)]);
	if (r.exitCode !== 0) {
		const msg = r.stderr.toString("utf8");
		if (/No such file/i.test(msg)) throw fsError("ENOENT", "open", hostPath);
		if (/Permission denied/i.test(msg)) throw fsError("EACCES", "open", hostPath);
		if (/Is a directory/i.test(msg)) throw fsError("EISDIR", "read", hostPath);
		throw new Error(msg.trim() || `reading ${hostPath} failed`);
	}
	return r.stdout;
}

function writeError(ctx: OpsContext, hostPath: string, e: unknown): Error {
	const msg = e instanceof ExecError ? e.message : String((e as Error)?.message ?? e);
	if (/Read-only file system/i.test(msg)) {
		return fsError("EROFS", "open", hostPath, ctx.readOnly ? "the project is mounted read-only in the sandbox" : undefined);
	}
	if (/Permission denied/i.test(msg)) return fsError("EACCES", "open", hostPath);
	return e instanceof Error ? e : new Error(msg);
}

async function guestWriteFile(ctx: OpsContext, hostPath: string, content: string): Promise<void> {
	try {
		await execOk(ctx.backend, ["sh", "-c", 'cat > "$1"', "sh", ctx.paths.toGuest(hostPath)], { stdin: content });
	} catch (e) {
		throw writeError(ctx, hostPath, e);
	}
}

async function guestMkdir(ctx: OpsContext, hostDir: string): Promise<void> {
	try {
		await execOk(ctx.backend, ["mkdir", "-p", "--", ctx.paths.toGuest(hostDir)]);
	} catch (e) {
		throw writeError(ctx, hostDir, e);
	}
}

export function readOps(ctx: OpsContext): ReadOperations {
	return {
		readFile: (p) => (isHostReadable(ctx, p) ? hostReadFile(p) : guestReadFile(ctx, p)),
		access: (p) => (isHostReadable(ctx, p) ? hostAccess(p) : guestAccess(ctx, p, "r")),
		detectImageMimeType: async (p) => IMAGE_TYPES[path.extname(p).toLowerCase()] ?? null,
	};
}

export function writeOps(ctx: OpsContext): WriteOperations {
	return {
		writeFile: (p, content) => guestWriteFile(ctx, p, content),
		mkdir: (dir) => guestMkdir(ctx, dir),
	};
}

export function editOps(ctx: OpsContext): EditOperations {
	return {
		readFile: (p) => guestReadFile(ctx, p),
		writeFile: (p, content) => guestWriteFile(ctx, p, content),
		access: (p) => guestAccess(ctx, p, "rw"),
	};
}

/**
 * One exec answers exists/stat/readdir for a directory listing. Output is NUL-separated:
 * a kind marker (D, F or N) followed, for directories, by (type, name) pairs.
 */
const LIST_SCRIPT = `
p=$1
if [ -d "$p" ]; then
  printf 'D\\0'
  cd "$p" 2>/dev/null || exit 3
  for f in * .[!.]* ..?*; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      if [ -d "$f" ]; then printf 'd\\0%s\\0' "$f"; else printf 'f\\0%s\\0' "$f"; fi
    fi
  done
elif [ -e "$p" ]; then
  printf 'F\\0'
else
  printf 'N\\0'
fi
`;

interface Listing {
	kind: "D" | "F" | "N";
	entries?: Map<string, boolean>;
	error?: string;
}

export function parseListing(out: Buffer, exitCode: number | null, stderr: string): Listing {
	const parts = out.toString("utf8").split("\0");
	const kind = parts[0] as Listing["kind"];
	if (kind !== "D") return { kind: kind === "F" ? "F" : "N" };
	if (exitCode === 3) return { kind, error: stderr.trim() || "permission denied" };
	const entries = new Map<string, boolean>();
	for (let i = 1; i + 1 < parts.length; i += 2) entries.set(parts[i + 1]!, parts[i] === "d");
	return { kind, entries };
}

export function lsOps(ctx: OpsContext): LsOperations {
	const listings = new Map<string, Promise<Listing>>();
	const list = (hostPath: string) => {
		const g = ctx.paths.toGuest(hostPath);
		let pending = listings.get(g);
		if (!pending) {
			pending = ctx.backend
				.exec(["sh", "-c", LIST_SCRIPT, "sh", g])
				.then((r) => parseListing(r.stdout, r.exitCode, r.stderr.toString("utf8")));
			listings.set(g, pending);
		}
		return pending;
	};
	/** stat of a child answered from its parent's listing, when we have one. */
	const fromParent = async (hostPath: string): Promise<boolean | undefined> => {
		const parent = ctx.paths.toGuest(path.dirname(hostPath));
		const pending = listings.get(parent);
		if (!pending) return undefined;
		return (await pending).entries?.get(path.basename(hostPath));
	};
	return {
		exists: async (p) => (await list(p)).kind !== "N",
		stat: async (p) => {
			const cached = await fromParent(p);
			if (cached !== undefined) return { isDirectory: () => cached };
			const l = await list(p);
			if (l.kind === "N") throw fsError("ENOENT", "stat", p);
			return { isDirectory: () => l.kind === "D" };
		},
		readdir: async (p) => {
			const l = await list(p);
			if (l.kind === "N") throw fsError("ENOENT", "scandir", p);
			if (l.kind === "F") throw new Error(`ENOTDIR: not a directory, scandir '${p}'`);
			if (l.error || !l.entries) throw new Error(l.error ?? "cannot read directory");
			return [...l.entries.keys()];
		},
	};
}

const IGNORED_DIRS = new Set([".git", "node_modules"]);

function underIgnoredDir(rel: string): boolean {
	return rel.split("/").some((seg) => IGNORED_DIRS.has(seg));
}

/** List files below a guest directory as relative paths. Uses ripgrep (respecting .gitignore) when present. */
async function listGuestFiles(ctx: OpsContext, guestDir: string, signal?: AbortSignal): Promise<string[]> {
	const argv = ctx.info.hasRipgrep
		? ["rg", "--no-config", "--files", "--hidden", "--no-messages", "--glob", "!.git"]
		: ["find", ".", "(", "-name", ".git", "-o", "-name", "node_modules", ")", "-prune", "-o", "(", "-type", "f", "-o", "-type", "l", ")", "-print"];
	const r = await ctx.backend.exec(argv, { cwd: guestDir, signal });
	if (r.aborted) throw new Error("Operation aborted");
	// rg exits 1 when there are no files; 2 with partial output on unreadable entries.
	if (r.exitCode !== 0 && r.stdout.length === 0 && !(ctx.info.hasRipgrep && r.exitCode === 1)) {
		throw new Error(r.stderr.toString("utf8").trim() || `listing ${guestDir} failed`);
	}
	return r.stdout
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.replace(/^\.\//, ""));
}

export function findOps(ctx: OpsContext, signal?: AbortSignal): FindOperations {
	return {
		exists: async (p) => {
			const r = await ctx.backend.exec(["test", "-e", ctx.paths.toGuest(p)]);
			return r.exitCode === 0;
		},
		glob: async (pattern, cwd, options) => {
			const files = await listGuestFiles(ctx, ctx.paths.toGuest(cwd), signal);
			const out: string[] = [];
			for (const rel of files) {
				if (underIgnoredDir(rel)) continue;
				if (!matchesToolGlob(rel, pattern)) continue;
				out.push(rel);
				if (out.length >= options.limit) break;
			}
			return out;
		},
	};
}

export interface GrepParams {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

export interface GrepLine {
	file: string;
	line: number;
	text: string;
	match: boolean;
}

/** Parse `rg --json` output lines. */
export function parseRgJson(chunk: string, emit: (l: GrepLine) => void): void {
	for (const raw of chunk.split("\n")) {
		if (!raw.trim()) continue;
		let ev: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string; bytes?: string } } };
		try {
			ev = JSON.parse(raw);
		} catch {
			continue;
		}
		if (ev.type !== "match" && ev.type !== "context") continue;
		const file = ev.data?.path?.text;
		const line = ev.data?.line_number;
		let text = ev.data?.lines?.text;
		if (text === undefined && ev.data?.lines?.bytes) text = Buffer.from(ev.data.lines.bytes, "base64").toString("utf8");
		if (!file || typeof line !== "number") continue;
		emit({ file, line, text: (text ?? "").replace(/\r?\n$/, ""), match: ev.type === "match" });
	}
}

/** Parse GNU `grep -rnH -Z` output: `file\0NUM:text` for matches, `file\0NUM-text` for context. */
export function parseGrepZ(chunk: string, emit: (l: GrepLine) => void): void {
	for (const raw of chunk.split("\n")) {
		const nul = raw.indexOf("\0");
		if (nul < 0) continue;
		const m = /^(\d+)([:-])(.*)$/s.exec(raw.slice(nul + 1));
		if (!m) continue;
		emit({ file: raw.slice(0, nul), line: Number(m[1]), text: m[3]!, match: m[2] === ":" });
	}
}

/** Feed complete lines to `parse`, buffering any partial trailing line. */
function lineSplitter(parse: (chunk: string) => void) {
	let pending = "";
	return {
		push(data: Buffer) {
			pending += data.toString("utf8");
			const cut = pending.lastIndexOf("\n");
			if (cut < 0) return;
			parse(pending.slice(0, cut + 1));
			pending = pending.slice(cut + 1);
		},
		flush() {
			if (pending) parse(pending);
			pending = "";
		},
	};
}

const DEFAULT_GREP_LIMIT = 100;

export async function executeGrep(
	ctx: OpsContext,
	params: GrepParams,
	hostCwd: string,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
	const hostRoot = path.resolve(hostCwd, (params.path || ".").replace(/^@/, ""));
	const guestRoot = ctx.paths.toGuest(hostRoot);
	const kind = await ctx.backend.exec(["sh", "-c", '[ -d "$1" ] && echo d || { [ -e "$1" ] && echo f || echo n; }', "sh", guestRoot]);
	const k = kind.stdout.toString("utf8").trim();
	if (k === "n") throw new Error(`Path not found: ${hostRoot}`);
	const rootIsDir = k === "d";
	const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const contextLines = params.context && params.context > 0 ? Math.floor(params.context) : 0;
	const hostGlobFilter = params.glob && (params.glob.includes("/") || !ctx.info.hasRipgrep) ? params.glob : undefined;

	const display = (file: string) => {
		if (rootIsDir) {
			const rel = path.posix.relative(guestRoot, file);
			if (rel && !rel.startsWith("..")) return rel;
		}
		return path.posix.basename(file);
	};

	const run = async (argv: string[], parse: (chunk: string, emit: (l: GrepLine) => void) => void) => {
		const outputLines: string[] = [];
		let matchCount = 0;
		let limitReached = false;
		let linesTruncated = false;
		const stop = new AbortController();
		const onAbort = () => stop.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const emit = (l: GrepLine) => {
			if (limitReached) return;
			const rel = display(l.file);
			if (rootIsDir && underIgnoredDir(rel)) return;
			if (hostGlobFilter && !matchesToolGlob(rel, hostGlobFilter)) return;
			const { text, wasTruncated } = truncateLine(l.text.replace(/\r/g, ""));
			if (wasTruncated) linesTruncated = true;
			outputLines.push(l.match ? `${rel}:${l.line}: ${text}` : `${rel}-${l.line}- ${text}`);
			if (l.match && ++matchCount >= limit) {
				limitReached = true;
				stop.abort();
			}
		};
		const splitter = lineSplitter((chunk) => parse(chunk, emit));
		try {
			const r = await ctx.backend.exec(argv, { signal: stop.signal, onStdout: (d) => splitter.push(d) });
			if (!limitReached) splitter.flush();
			if (signal?.aborted) throw new Error("Operation aborted");
			return { r, outputLines, matchCount, limitReached, linesTruncated };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	};

	let result: Awaited<ReturnType<typeof run>>;
	if (ctx.info.hasRipgrep) {
		const argv = ["rg", "--no-config", "--json", "--line-number", "--color=never", "--hidden"];
		if (params.ignoreCase) argv.push("--ignore-case");
		if (params.literal) argv.push("--fixed-strings");
		if (params.glob && !hostGlobFilter) argv.push("--glob", params.glob);
		if (contextLines) argv.push("--context", String(contextLines));
		argv.push("--", params.pattern, guestRoot);
		result = await run(argv, parseRgJson);
		if (result.r.exitCode === 2 && result.matchCount === 0 && !result.limitReached) {
			throw new Error(result.r.stderr.toString("utf8").trim() || "ripgrep failed");
		}
	} else {
		const base = ["grep", "-rnHI", "-Z", "--color=never", "--exclude-dir=.git", "--exclude-dir=node_modules"];
		if (params.ignoreCase) base.push("-i");
		if (params.glob && !params.glob.includes("/")) base.push(`--include=${params.glob}`);
		if (contextLines) base.push(`-C${contextLines}`);
		const withDialect = (flag: string) => [...base, flag, "-e", params.pattern, "--", guestRoot];
		// Prefer PCRE, which is closest to ripgrep's syntax; fall back to ERE where grep lacks -P.
		result = await run(withDialect(params.literal ? "-F" : "-P"), parseGrepZ);
		if (!params.literal && result.r.exitCode === 2 && result.matchCount === 0 && /-P|perl|PCRE/i.test(result.r.stderr.toString("utf8"))) {
			result = await run(withDialect("-E"), parseGrepZ);
		}
		if (result.r.exitCode === 2 && result.matchCount === 0 && !result.limitReached) {
			throw new Error(result.r.stderr.toString("utf8").trim() || "grep failed");
		}
	}

	if (result.matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

	const truncation = truncateHead(result.outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	let output = truncation.content;
	if (result.limitReached) {
		details.matchLimitReached = limit;
		notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
	}
	if (result.linesTruncated) {
		details.linesTruncated = true;
		notices.push("Some lines truncated");
	}
	if (truncation.truncated) {
		details.truncation = truncation;
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/** Host environment variables forwarded into the sandbox: pi's own session metadata only. */
export function forwardedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env ?? {})) {
		if (typeof v === "string" && k.startsWith("PI_")) out[k] = v;
	}
	return out;
}

export function bashOps(ctx: OpsContext): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const r = await ctx.backend.exec([ctx.info.shell, "-l", "-c", command], {
				cwd: ctx.paths.toGuest(cwd),
				env: forwardedEnv(env),
				signal,
				timeoutMs: timeout && timeout > 0 ? timeout * 1000 : undefined,
				onStdout: onData,
				onStderr: onData,
			});
			if (r.aborted || signal?.aborted) throw new Error("aborted");
			if (r.timedOut) throw new Error(`timeout:${timeout}`);
			return { exitCode: r.exitCode };
		},
	};
}
