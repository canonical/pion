import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import type { BackendInfo, ExecOptions, ExecResult, SandboxBackend } from "../src/backend.ts";
import { bashOps, editOps, executeGrep, findOps, lsOps, type OpsContext, parseGrepZ, parseRgJson, readOps, writeOps } from "../src/ops.ts";
import { PathMap } from "../src/paths.ts";

/** Runs commands on the host, standing in for a sandbox. Exercises the real shell scripts. */
class LocalBackend implements SandboxBackend {
	calls: string[][] = [];
	async start(): Promise<BackendInfo> {
		throw new Error("unused");
	}
	async shutdown() {}
	async stop() {}
	exec(argv: string[], o: ExecOptions = {}): Promise<ExecResult> {
		this.calls.push(argv);
		return new Promise((resolve, reject) => {
			const child = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: { PATH: process.env.PATH, ...o.env }, stdio: "pipe", detached: true });
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let aborted = false;
			let timedOut = false;
			const kill = () => {
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {}
			};
			o.signal?.addEventListener("abort", () => {
				aborted = true;
				kill();
			});
			const t = o.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), o.timeoutMs) : undefined;
			child.stdout.on("data", (d: Buffer) => (o.onStdout ? o.onStdout(d) : out.push(d)));
			child.stderr.on("data", (d: Buffer) => (o.onStderr ? o.onStderr(d) : err.push(d)));
			child.on("error", reject);
			child.on("close", (code) => {
				if (t) clearTimeout(t);
				resolve({ exitCode: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), aborted, timedOut });
			});
			child.stdin.on("error", () => {});
			child.stdin.end(o.stdin ?? "");
		});
	}
}

const hostHasRg = spawnSync("sh", ["-c", "command -v rg"]).status === 0;

let dir: string;
const mk = (rel: string, content: string) => {
	mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	writeFileSync(path.join(dir, rel), content);
};

beforeAll(() => {
	dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pion-ops-")));
	mk("README.md", "# Title\nhello world\n");
	mk("src/a.ts", "export const a = 1;\n// TODO first\nconst b = 2;\n");
	mk("src/deep/b.ts", "line1\nTODO second\nline3\n");
	mk("src/c.txt", "nothing\n");
	mk("node_modules/x/index.ts", "TODO ignored\n");
	mk(".hidden", "TODO hidden\n");
	mk("with space/file name.ts", "TODO spaced\n");
	symlinkSync(path.join(dir, "src"), path.join(dir, "srclink"));
});

const ctxFor = (backend: SandboxBackend, hasRipgrep: boolean, readOnly = false): OpsContext => ({
	backend,
	info: { kind: "test", label: "test", details: [], shell: "/bin/bash", hasRipgrep },
	paths: new PathMap(dir, dir),
	readOnly,
	hostReadDirs: () => [],
});

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
// biome-ignore lint: tests pass no extension context
const noCtx = undefined as any;

describe("file tools through a backend", () => {
	let ctx: OpsContext;
	beforeAll(() => {
		ctx = ctxFor(new LocalBackend(), false);
	});

	it("reads", async () => {
		const tool = createReadToolDefinition(dir, { operations: readOps(ctx) });
		expect(text(await tool.execute("1", { path: "README.md" }, undefined, undefined, noCtx))).toContain("hello world");
		await expect(tool.execute("1", { path: "missing.txt" }, undefined, undefined, noCtx)).rejects.toThrow(/ENOENT|not found/i);
	});

	it("writes, creating directories", async () => {
		const tool = createWriteToolDefinition(dir, { operations: writeOps(ctx) });
		await tool.execute("1", { path: "out/new/file.txt", content: "it's \"quoted\" $HOME `x`\n" }, undefined, undefined, noCtx);
		expect(readFileSync(path.join(dir, "out/new/file.txt"), "utf8")).toBe("it's \"quoted\" $HOME `x`\n");
	});

	it("edits", async () => {
		mk("edit.txt", "alpha\nbeta\n");
		const tool = createEditToolDefinition(dir, { operations: editOps(ctx) });
		await tool.execute("1", { path: "edit.txt", edits: [{ oldText: "beta", newText: "gamma" }] } as never, undefined, undefined, noCtx);
		expect(readFileSync(path.join(dir, "edit.txt"), "utf8")).toBe("alpha\ngamma\n");
	});

	it("lists with a single exec", async () => {
		const backend = new LocalBackend();
		const tool = createLsToolDefinition(dir, { operations: lsOps(ctxFor(backend, false)) });
		const out = text(await tool.execute("1", { path: "." }, undefined, undefined, noCtx));
		expect(out.split("\n")).toEqual(expect.arrayContaining(["README.md", "src/", ".hidden", "srclink/", "with space/", "node_modules/"]));
		expect(backend.calls.length).toBe(1);
		await expect(tool.execute("1", { path: "nope" }, undefined, undefined, noCtx)).rejects.toThrow(/not found/i);
		await expect(tool.execute("1", { path: "README.md" }, undefined, undefined, noCtx)).rejects.toThrow(/Not a directory/);
	});

	for (const rg of hostHasRg ? [false, true] : [false]) {
		it(`finds files (ripgrep=${rg})`, async () => {
			const tool = createFindToolDefinition(dir, { operations: findOps(ctxFor(new LocalBackend(), rg)) });
			const out = text(await tool.execute("1", { pattern: "*.ts" }, undefined, undefined, noCtx)).split("\n");
			expect(out).toEqual(expect.arrayContaining(["src/a.ts", "src/deep/b.ts", "with space/file name.ts"]));
			expect(out.some((l) => l.includes("node_modules"))).toBe(false);
			const nested = text(await tool.execute("1", { pattern: "src/**/*.ts" }, undefined, undefined, noCtx));
			expect(nested).toContain("src/deep/b.ts");
		});

		it(`greps (ripgrep=${rg})`, async () => {
			const c = ctxFor(new LocalBackend(), rg);
			const out = text(await executeGrep(c, { pattern: "TODO" }, dir));
			expect(out).toContain("src/a.ts:2: // TODO first");
			expect(out).toContain("src/deep/b.ts:2: TODO second");
			expect(out).toContain(".hidden:1: TODO hidden");
			expect(out).toContain("with space/file name.ts:1: TODO spaced");
			expect(out).not.toContain("node_modules");

			const ctxOut = text(await executeGrep(c, { pattern: "second", context: 1, path: "src" }, dir));
			expect(ctxOut).toContain("deep/b.ts-1- line1");
			expect(ctxOut).toContain("deep/b.ts:2: TODO second");
			expect(ctxOut).toContain("deep/b.ts-3- line3");

			const globbed = text(await executeGrep(c, { pattern: "todo", ignoreCase: true, glob: "*.ts" }, dir));
			expect(globbed).not.toContain(".hidden");
			expect(globbed).toContain("src/a.ts");

			const limited = await executeGrep(c, { pattern: "TODO", limit: 1 }, dir);
			expect(limited.details?.matchLimitReached).toBe(1);

			expect(text(await executeGrep(c, { pattern: "zzz-nope" }, dir))).toBe("No matches found");
			expect(text(await executeGrep(c, { pattern: "a.b", literal: true }, dir))).toBe("No matches found");
			const single = text(await executeGrep(c, { pattern: "hello", path: "README.md" }, dir));
			expect(single).toBe("README.md:2: hello world");
			await expect(executeGrep(c, { pattern: "x", path: "missing" }, dir)).rejects.toThrow(/Path not found/);
		});
	}
});

describe("bash through a backend", () => {
	it("streams output and reports exit codes", async () => {
		const ops = bashOps(ctxFor(new LocalBackend(), false));
		const chunks: Buffer[] = [];
		const r = await ops.exec("echo out; echo err >&2; pwd; echo $PI_X:$SECRET; exit 3", path.join(dir, "src"), {
			onData: (d) => chunks.push(d),
			env: { PI_X: "fwd", SECRET: "leak" },
		});
		expect(r.exitCode).toBe(3);
		const out = Buffer.concat(chunks).toString();
		expect(out).toContain("out");
		expect(out).toContain("err");
		expect(out).toContain(path.join(dir, "src"));
		expect(out).toContain("fwd:\n");
	});

	it("times out and aborts", async () => {
		const ops = bashOps(ctxFor(new LocalBackend(), false));
		await expect(ops.exec("sleep 5", dir, { onData: () => {}, timeout: 0.2 })).rejects.toThrow("timeout:0.2");
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		await expect(ops.exec("sleep 5", dir, { onData: () => {}, signal: ac.signal })).rejects.toThrow("aborted");
	});
});

describe("read-only errors", () => {
	it("reports EROFS for writes the sandbox refuses", async () => {
		const backend: SandboxBackend = {
			start: async () => ({}) as BackendInfo,
			shutdown: async () => {},
			stop: async () => {},
			exec: async () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("sh: 1: cannot create x: Read-only file system"), aborted: false, timedOut: false }),
		};
		const tool = createWriteToolDefinition(dir, { operations: writeOps(ctxFor(backend, false, true)) });
		await expect(tool.execute("1", { path: "x", content: "y" }, undefined, undefined, noCtx)).rejects.toThrow(/EROFS.*read-only/);
	});
});

describe("parsers", () => {
	it("parses rg --json", () => {
		const lines: unknown[] = [];
		parseRgJson(
			[
				'{"type":"begin","data":{"path":{"text":"/p/a"}}}',
				'{"type":"context","data":{"path":{"text":"/p/a"},"lines":{"text":"ctx\\n"},"line_number":1}}',
				'{"type":"match","data":{"path":{"text":"/p/a"},"lines":{"bytes":"aGk="},"line_number":2}}',
			].join("\n"),
			(l) => lines.push(l),
		);
		expect(lines).toEqual([
			{ file: "/p/a", line: 1, text: "ctx", match: false },
			{ file: "/p/a", line: 2, text: "hi", match: true },
		]);
	});

	it("parses grep -Z", () => {
		const lines: unknown[] = [];
		parseGrepZ("/p/a:b\x0012:x:y\n/p/a:b\x0013-ctx\n--\n", (l) => lines.push(l));
		expect(lines).toEqual([
			{ file: "/p/a:b", line: 12, text: "x:y", match: true },
			{ file: "/p/a:b", line: 13, text: "ctx", match: false },
		]);
	});
});
