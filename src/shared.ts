/** Pieces shared by backends: session accounting, provisioning steps, guest probes. */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecOptions, ExecResult, Progress } from "./backend.ts";
import { shq } from "./backend.ts";
import type { SandboxConfig } from "./config.ts";

/**
 * Tracks which pi processes use a sandbox, so one exiting session does not stop a sandbox
 * another session still uses. One marker file per pid under $XDG_RUNTIME_DIR.
 */
export class SessionRegistry {
	private readonly dir: string;

	constructor(...keyParts: string[]) {
		const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `pion-${os.userInfo().username}`);
		const key = createHash("sha256").update(keyParts.join("\0")).digest("hex").slice(0, 16);
		this.dir = path.join(runtime, "pion", key);
	}

	register(note: string): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(path.join(this.dir, String(process.pid)), note);
		} catch {
			// Best effort; worst case another session's sandbox is stopped on exit.
		}
	}

	/** Remove this process's marker and return how many other live sessions remain. */
	unregister(): number {
		let others = 0;
		try {
			rmSync(path.join(this.dir, String(process.pid)), { force: true });
			for (const entry of readdirSync(this.dir)) {
				const pid = Number(entry);
				if (!Number.isInteger(pid)) continue;
				try {
					process.kill(pid, 0);
					others++;
				} catch {
					rmSync(path.join(this.dir, entry), { force: true });
				}
			}
		} catch {
			// Treat as no other sessions.
		}
		return others;
	}
}

export interface RootRunner {
	(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

const INSTALL_RIPGREP =
	"command -v rg >/dev/null 2>&1 || " +
	"{ if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep; " +
	"elif command -v dnf >/dev/null 2>&1; then dnf install -y -q ripgrep; " +
	"elif command -v apk >/dev/null 2>&1; then apk add -q ripgrep; " +
	"elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm ripgrep; " +
	"elif command -v zypper >/dev/null 2>&1; then zypper -n install ripgrep; fi; } || echo 'pion: could not install ripgrep; falling back to grep/find' >&2";

/** Run `installTools` and user `setup` commands as root, once per distinct set of commands. */
export async function runSetupOnce(cfg: SandboxConfig, runAsRoot: RootRunner, progress: Progress): Promise<void> {
	const steps: string[] = [];
	if (cfg.installTools) steps.push(INSTALL_RIPGREP);
	steps.push(...cfg.setup);
	if (steps.length === 0) return;
	const digest = createHash("sha256").update(JSON.stringify(steps)).digest("hex");
	const marker = "/var/lib/pion/setup.sha256";
	const check = await runAsRoot(["cat", marker]);
	if (check.code === 0 && check.stdout.trim() === digest) return;
	for (const [i, step] of steps.entries()) {
		progress(`setup ${i + 1}/${steps.length}`);
		const r = await runAsRoot(["sh", "-c", step]);
		if (r.code !== 0) {
			throw new Error(`setup command failed (exit ${r.code}): ${step}\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
		}
	}
	await runAsRoot(["sh", "-c", `mkdir -p /var/lib/pion && printf '%s\\n' ${shq(digest)} > ${marker}`]);
}

/** Probe the guest shell and ripgrep, run as the sandbox user. */
export async function probeGuest(runAsUser: RootRunner): Promise<{ shell: string; hasRipgrep: boolean }> {
	const probe = await runAsUser(["sh", "-c", "command -v bash || command -v sh; command -v rg >/dev/null 2>&1 && echo rg=yes || echo rg=no"]);
	const lines = probe.stdout.trim().split("\n");
	return { shell: lines[0]?.startsWith("/") ? lines[0] : "/bin/sh", hasRipgrep: lines.includes("rg=yes") };
}

/** POSIX sh run in the guest as a killable session leader: records its pid, then runs "$@". */
export const SESSION_WRAPPER = `echo $$ > "$PION_PIDFILE"; "$@"; rc=$?; rm -f "$PION_PIDFILE"; exit $rc`;

/** SIGTERM a process group recorded in a pidfile, then SIGKILL after about two seconds. */
export const KILL_GROUP_SCRIPT = `
f=$1
pg=$(cat "$f" 2>/dev/null) || exit 0
kill -TERM "-$pg" 2>/dev/null || exit 0
i=0
while [ $i -lt 20 ]; do kill -0 "-$pg" 2>/dev/null || { rm -f "$f"; exit 0; }; sleep 0.1; i=$((i+1)); done
kill -KILL "-$pg" 2>/dev/null
rm -f "$f"
`;

const KILL_GRACE_MS = 2000;

/**
 * Run a sandbox CLI client (`lxc exec`, `workshop exec`) that executes one command in the
 * guest. On abort or timeout, `killGuest` stops the guest-side process group; the local
 * client is then force-killed if it has not exited on its own.
 */
export function runClient(bin: string, args: string[], options: ExecOptions, killGuest: () => Promise<void>): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, aborted: true });
			return;
		}
		let child: ChildProcess;
		try {
			child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			reject(e);
			return;
		}
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let timedOut = false;
		let aborted = false;
		let killing = false;

		const kill = () => {
			if (killing) return;
			killing = true;
			void killGuest()
				.catch(() => {})
				.finally(() => {
					setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
				});
		};
		const onAbort = () => {
			aborted = true;
			kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer =
			options.timeoutMs && options.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						kill();
					}, options.timeoutMs)
				: undefined;

		child.stdout!.on("data", (d: Buffer) => (options.onStdout ? options.onStdout(d) : out.push(d)));
		child.stderr!.on("data", (d: Buffer) => (options.onStderr ? options.onStderr(d) : err.push(d)));
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(new Error(`failed to run ${bin}: ${e.message}`));
		});
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : null),
				stdout: Buffer.concat(out),
				stderr: Buffer.concat(err),
				timedOut,
				aborted,
			});
		});
		child.stdin!.on("error", () => {});
		child.stdin!.end(options.stdin ?? "");
	});
}

/** Collect output of a short CLI invocation. */
export function runCli(bin: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (d: Buffer) => out.push(d));
		child.stderr.on("data", (d: Buffer) => err.push(d));
		child.on("error", (e) => reject(new Error(`failed to run ${bin}: ${e.message}`)));
		child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
		child.stdin.on("error", () => {});
		child.stdin.end(input ?? "");
	});
}
