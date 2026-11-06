/**
 * LXD virtual-machine backend, driven through the `lxc` CLI.
 *
 * Facts this relies on (verified against LXD 6.x VMs):
 * - Host directories attach as virtiofs disk devices, can be hot-plugged, and `readonly`
 *   can be flipped on a running VM. Read-only is enforced on the host side, so even guest
 *   root cannot remount the share writable.
 * - virtiofs passes uids through unchanged, so commands run as the guest user that has the
 *   host user's uid; otherwise files written to the share would be owned by host root.
 * - Killing the local `lxc exec` client does not stop the guest process, so each command
 *   runs in its own session and is killed by process group from a second exec.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type BackendInfo, type ExecOptions, type ExecResult, type Progress, type SandboxBackend, shq } from "./backend.ts";
import type { SandboxConfig } from "./config.ts";

export const MOUNT_DEVICE = "pion-project";
const MANAGED_KEY = "user.pion.managed";
const PROJECT_KEY = "user.pion.project";
const KILL_GRACE_MS = 2000;

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface InstanceState {
	status: string;
	config: Record<string, string>;
	devices: Record<string, Record<string, string>>;
}

interface GuestUser {
	uid: number;
	gid: number;
	name: string;
	home: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pattern of a command line that a POSIX sh runs in the guest as a killable session leader. */
const SESSION_WRAPPER = `echo $$ > "$PION_PIDFILE"; "$@"; rc=$?; rm -f "$PION_PIDFILE"; exit $rc`;

export class LxdBackend implements SandboxBackend {
	private readonly cfg: SandboxConfig;
	private user: GuestUser | undefined;
	private info: BackendInfo | undefined;
	private released = false;
	private readonly lockDir: string;

	constructor(cfg: SandboxConfig) {
		this.cfg = cfg;
		const runtime = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `pion-${os.userInfo().username}`);
		const key = createHash("sha256").update(`${cfg.lxd.remote}\0${cfg.lxd.project}\0${cfg.lxd.instance}`).digest("hex").slice(0, 16);
		this.lockDir = path.join(runtime, "pion", key);
	}

	/** `remote:instance` or `instance`. */
	private get target(): string {
		return this.cfg.lxd.remote ? `${this.cfg.lxd.remote}:${this.cfg.lxd.instance}` : this.cfg.lxd.instance;
	}

	private globalArgs(): string[] {
		return this.cfg.lxd.project ? ["--project", this.cfg.lxd.project] : [];
	}

	/** Run the lxc CLI and collect output. */
	private run(args: string[], input?: string): Promise<RunResult> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.cfg.lxd.lxc, [...this.globalArgs(), ...args], { stdio: ["pipe", "pipe", "pipe"] });
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout.on("data", (d: Buffer) => out.push(d));
			child.stderr.on("data", (d: Buffer) => err.push(d));
			child.on("error", (e) => reject(new Error(`failed to run ${this.cfg.lxd.lxc}: ${e.message}`)));
			child.on("close", (code) =>
				resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }),
			);
			child.stdin.end(input ?? "");
		});
	}

	private async runOk(args: string[], what: string): Promise<string> {
		const r = await this.run(args);
		if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
		return r.stdout;
	}

	private async getState(): Promise<InstanceState | undefined> {
		const remotePrefix = this.cfg.lxd.remote ? `${this.cfg.lxd.remote}:` : "";
		const r = await this.run(["query", `${remotePrefix}/1.0/instances/${encodeURIComponent(this.cfg.lxd.instance)}`]);
		if (r.code !== 0) {
			if (/not found/i.test(r.stderr)) return undefined;
			throw new Error(`querying LXD instance ${this.target} failed: ${r.stderr.trim()}`);
		}
		const data = JSON.parse(r.stdout) as { status: string; type: string; config: Record<string, string>; devices: InstanceState["devices"] };
		if (data.type !== "virtual-machine") {
			throw new Error(`LXD instance ${this.target} exists but is a ${data.type}, not a virtual machine`);
		}
		return { status: data.status, config: data.config ?? {}, devices: data.devices ?? {} };
	}

	private async create(progress: Progress): Promise<void> {
		const l = this.cfg.lxd;
		const args = ["init", l.image, this.target, "--vm"];
		for (const p of l.profiles) args.push("--profile", p);
		if (l.storagePool) args.push("--storage", l.storagePool);
		const config: Record<string, string> = {
			...l.config,
			[MANAGED_KEY]: "true",
			[PROJECT_KEY]: this.cfg.projectDir,
		};
		if (l.cpus) config["limits.cpu"] = String(l.cpus);
		if (l.memory) config["limits.memory"] = l.memory;
		for (const [k, v] of Object.entries(config)) args.push("--config", `${k}=${v}`);
		if (l.disk) args.push("--device", `root,size=${l.disk}`);
		progress(`creating VM ${this.target} from ${l.image}`);
		await this.runOk(args, `creating LXD VM ${this.target}`);
	}

	/** Refuse to touch instances pion did not create, or that belong to another project. */
	private checkOwnership(state: InstanceState): void {
		if (state.config[MANAGED_KEY] !== "true") {
			throw new Error(
				`LXD instance ${this.target} already exists and was not created by pion; refusing to modify it. ` +
					`Pick another name with lxd.instance, or set ${MANAGED_KEY}=true on it if you really want pion to manage it.`,
			);
		}
		const owner = state.config[PROJECT_KEY];
		if (owner && owner !== this.cfg.projectDir) {
			throw new Error(`LXD instance ${this.target} belongs to project ${owner}, not ${this.cfg.projectDir}`);
		}
	}

	private desiredMount(): Record<string, string> {
		return {
			type: "disk",
			source: this.cfg.projectDir,
			path: this.cfg.guestPath,
			readonly: this.cfg.mount === "ro" ? "true" : "false",
		};
	}

	private async ensureMount(state: InstanceState, progress: Progress): Promise<void> {
		const want = this.desiredMount();
		const have = state.devices[MOUNT_DEVICE];
		if (!have) {
			progress(`mounting ${this.cfg.projectDir} (${this.cfg.mount})`);
			await this.runOk(
				[
					"config",
					"device",
					"add",
					this.target,
					MOUNT_DEVICE,
					want.type!,
					...Object.entries(want)
						.filter(([k]) => k !== "type")
						.map(([k, v]) => `${k}=${v}`),
				],
				"adding project mount",
			);
			return;
		}
		if (have.type !== "disk") throw new Error(`device ${MOUNT_DEVICE} on ${this.target} is not a disk device`);
		const haveReadonly = ["true", "1", "yes", "on"].includes((have.readonly ?? "").toLowerCase()) ? "true" : "false";
		const changes: string[] = [];
		if (have.source !== want.source) changes.push(`source=${want.source}`);
		if (have.path !== want.path) changes.push(`path=${want.path}`);
		if (haveReadonly !== want.readonly) changes.push(`readonly=${want.readonly}`);
		if (changes.length === 0) return;
		progress(`updating project mount (${changes.join(", ")})`);
		await this.runOk(["config", "device", "set", this.target, MOUNT_DEVICE, ...changes], "updating project mount");
	}

	/** Plain exec without the session wrapper, for readiness probes and provisioning. */
	private async rawExec(argv: string[], opts: { asRoot?: boolean; stdin?: string } = {}): Promise<RunResult> {
		const args = ["exec", this.target, "-T"];
		if (!opts.asRoot && this.user) args.push("--user", String(this.user.uid), "--group", String(this.user.gid));
		args.push("--", ...argv);
		return this.run(args, opts.stdin);
	}

	private async waitForAgent(progress: Progress, timeoutMs = 180_000): Promise<void> {
		progress("waiting for the VM agent");
		const deadline = Date.now() + timeoutMs;
		let last = "";
		while (Date.now() < deadline) {
			const r = await this.rawExec(["true"], { asRoot: true });
			if (r.code === 0) return;
			last = r.stderr.trim();
			await sleep(1000);
		}
		throw new Error(`VM ${this.target} did not become ready: ${last}`);
	}

	private async waitForMount(progress: Progress, timeoutMs = 60_000): Promise<void> {
		progress(`waiting for ${this.cfg.guestPath} to be mounted`);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const r = await this.rawExec(
				["sh", "-c", 'mountpoint -q "$1" 2>/dev/null || awk -v p="$1" \'$2 == p { f = 1 } END { exit !f }\' /proc/mounts', "sh", this.cfg.guestPath],
				{ asRoot: true },
			);
			if (r.code === 0) return;
			await sleep(500);
		}
		throw new Error(`project mount ${this.cfg.guestPath} did not appear inside ${this.target}`);
	}

	/**
	 * Let cloud-init finish first: it creates the image's default user (often uid 1000, which
	 * pion then reuses) and holds the package manager lock while it runs.
	 */
	private async waitForCloudInit(progress: Progress): Promise<void> {
		const has = await this.rawExec(["sh", "-c", "command -v cloud-init"], { asRoot: true });
		if (has.code !== 0) return;
		progress("waiting for cloud-init");
		// Exit status 2 means "done with recoverable errors", which is fine here.
		await this.rawExec(["sh", "-c", "if command -v timeout >/dev/null; then timeout 600 cloud-init status --wait; else cloud-init status --wait; fi >/dev/null 2>&1 || true"], {
			asRoot: true,
		});
	}

	/** Find or create the guest account whose uid matches the host user, so writes keep host ownership. */
	private async provisionUser(progress: Progress): Promise<GuestUser> {
		const uid = process.getuid?.() ?? 1000;
		const gid = process.getgid?.() ?? 1000;
		const name = os.userInfo().username.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "pion";
		const script = `
set -e
uid=$1 gid=$2 name=$3 sudo=$4
existing=$(getent passwd "$uid" | cut -d: -f1 || true)
if [ -z "$existing" ]; then
  if ! getent group "$gid" >/dev/null; then
    groupadd -g "$gid" "$name" 2>/dev/null || addgroup -g "$gid" "$name"
  fi
  group=$(getent group "$gid" | cut -d: -f1)
  if getent passwd "$name" >/dev/null; then name="pion-$uid"; fi
  shell=/bin/sh; [ -x /bin/bash ] && shell=/bin/bash
  useradd -m -u "$uid" -g "$group" -s "$shell" "$name" 2>/dev/null || adduser -D -u "$uid" -G "$group" -s "$shell" "$name"
  existing=$name
fi
if [ "$sudo" = "true" ] && [ -d /etc/sudoers.d ]; then
  echo "$existing ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-pion
  chmod 0440 /etc/sudoers.d/90-pion
elif [ -f /etc/sudoers.d/90-pion ]; then
  rm -f /etc/sudoers.d/90-pion
fi
home=$(getent passwd "$uid" | cut -d: -f6)
gid=$(getent passwd "$uid" | cut -d: -f4)
# The home directory may already exist root-owned, for example when LXD created it as a
# parent of the project mount path. Take ownership of the directory itself, not its contents.
mkdir -p "$home"
[ "$(stat -c %u "$home" 2>/dev/null)" = "$uid" ] || chown "$uid:$gid" "$home"
printf '%s\\n%s\\n%s\\n' "$existing" "$home" "$gid"
`;
		progress(`preparing guest user for uid ${uid}`);
		const r = await this.rawExec(["sh", "-c", script, "sh", String(uid), String(gid), name, String(this.cfg.sudo)], { asRoot: true });
		if (r.code !== 0) throw new Error(`creating guest user failed: ${r.stderr.trim()}`);
		const [guestName, home, guestGid] = r.stdout.trim().split("\n");
		return { uid, gid: Number(guestGid) || gid, name: guestName || name, home: home || "/" };
	}

	/** Run `installTools` and user `setup` commands once per distinct set of commands. */
	private async provisionSetup(progress: Progress): Promise<void> {
		const steps: string[] = [];
		if (this.cfg.installTools) {
			steps.push(
				"command -v rg >/dev/null 2>&1 || " +
					"{ if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep; " +
					"elif command -v dnf >/dev/null 2>&1; then dnf install -y -q ripgrep; " +
					"elif command -v apk >/dev/null 2>&1; then apk add -q ripgrep; " +
					"elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm ripgrep; " +
					"elif command -v zypper >/dev/null 2>&1; then zypper -n install ripgrep; fi; } || echo 'pion: could not install ripgrep; falling back to grep/find' >&2",
			);
		}
		steps.push(...this.cfg.setup);
		if (steps.length === 0) return;
		const digest = createHash("sha256").update(JSON.stringify(steps)).digest("hex");
		const marker = "/var/lib/pion/setup.sha256";
		const check = await this.rawExec(["cat", marker], { asRoot: true });
		if (check.code === 0 && check.stdout.trim() === digest) return;
		for (const [i, step] of steps.entries()) {
			progress(`setup ${i + 1}/${steps.length}`);
			const r = await this.rawExec(["sh", "-c", step], { asRoot: true });
			if (r.code !== 0) {
				throw new Error(`setup command failed (exit ${r.code}): ${step}\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
			}
		}
		await this.rawExec(["sh", "-c", `mkdir -p /var/lib/pion && printf '%s\\n' ${shq(digest)} > ${marker}`], { asRoot: true });
	}

	async start(progress: Progress): Promise<BackendInfo> {
		if (this.info) return this.info;
		this.released = false;
		let state = await this.getState();
		if (!state) {
			await this.create(progress);
			state = await this.getState();
			if (!state) throw new Error(`LXD VM ${this.target} disappeared after creation`);
		} else {
			this.checkOwnership(state);
		}
		await this.ensureMount(state, progress);
		if (state.status !== "Running") {
			progress(`starting VM ${this.target}`);
			await this.runOk(["start", this.target], `starting LXD VM ${this.target}`);
		}
		this.registerSession();
		await this.waitForAgent(progress);
		await this.waitForMount(progress);
		this.user = undefined;
		await this.waitForCloudInit(progress);
		const user = await this.provisionUser(progress);
		await this.provisionSetup(progress);
		this.user = user;

		const probe = await this.rawExec(["sh", "-c", "command -v bash || command -v sh; command -v rg >/dev/null 2>&1 && echo rg=yes || echo rg=no"]);
		const lines = probe.stdout.trim().split("\n");
		const shell = lines[0]?.startsWith("/") ? lines[0] : "/bin/sh";
		const hasRipgrep = lines.includes("rg=yes");

		this.info = {
			kind: "lxd",
			label: `LXD ${this.target} (${this.cfg.mount})`,
			details: [
				`Backend: LXD virtual machine ${this.target}${this.cfg.lxd.project ? ` (project ${this.cfg.lxd.project})` : ""}`,
				`Image: ${this.cfg.lxd.image}`,
				`Mount: ${this.cfg.projectDir} -> ${this.cfg.guestPath} (${this.cfg.mount === "ro" ? "read-only" : "writable"})`,
				`Guest user: ${user.name} (uid ${user.uid}), home ${user.home}${this.cfg.sudo ? ", passwordless sudo" : ""}`,
				`Shell: ${shell}; ripgrep: ${hasRipgrep ? "yes" : "no (using grep/find)"}`,
				`On exit: ${this.cfg.lxd.onExit}`,
			],
			shell,
			hasRipgrep,
		};
		return this.info;
	}

	exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
		const user = this.user;
		if (!user && !options.asRoot) return Promise.reject(new Error("sandbox is not started"));
		const pidfile = `/tmp/.pion-${randomUUID()}.pid`;
		const env: Record<string, string> = {
			LANG: "C.UTF-8",
			...(user && !options.asRoot ? { HOME: user.home, USER: user.name, LOGNAME: user.name } : { HOME: "/root", USER: "root", LOGNAME: "root" }),
			...this.cfg.env,
			...options.env,
			PION_PIDFILE: pidfile,
		};
		const args = [...this.globalArgs(), "exec", this.target, "-T"];
		if (!options.asRoot && user) args.push("--user", String(user.uid), "--group", String(user.gid));
		if (options.cwd) args.push("--cwd", options.cwd);
		for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
		args.push("--", "setsid", "-w", "sh", "-c", SESSION_WRAPPER, "sh", ...argv);

		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) {
				resolve({ exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, aborted: true });
				return;
			}
			let child: ChildProcess;
			try {
				child = spawn(this.cfg.lxd.lxc, args, { stdio: ["pipe", "pipe", "pipe"] });
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
				void this.killGroup(pidfile).finally(() => {
					// The client normally exits once the guest process is gone; make sure.
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
				reject(new Error(`failed to run ${this.cfg.lxd.lxc}: ${e.message}`));
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

	/** SIGTERM the command's process group in the guest, then SIGKILL after a grace period. */
	private async killGroup(pidfile: string): Promise<void> {
		const script = `
f=$1
pg=$(cat "$f" 2>/dev/null) || exit 0
kill -TERM "-$pg" 2>/dev/null || exit 0
i=0
while [ $i -lt 20 ]; do kill -0 "-$pg" 2>/dev/null || { rm -f "$f"; exit 0; }; sleep 0.1; i=$((i+1)); done
kill -KILL "-$pg" 2>/dev/null
rm -f "$f"
`;
		try {
			await this.rawExec(["sh", "-c", script, "sh", pidfile], { asRoot: true });
		} catch {
			// Best effort; the local client is killed regardless.
		}
	}

	// --- Session accounting so concurrent pi sessions share one VM safely. ---

	private registerSession(): void {
		try {
			mkdirSync(this.lockDir, { recursive: true });
			writeFileSync(path.join(this.lockDir, String(process.pid)), this.cfg.projectDir);
		} catch {
			// Accounting is best effort; worst case another session's VM is stopped on exit.
		}
	}

	/** Remove this session's marker and return how many other live sessions use the VM. */
	private unregisterSession(): number {
		let others = 0;
		try {
			rmSync(path.join(this.lockDir, String(process.pid)), { force: true });
			for (const entry of readdirSync(this.lockDir)) {
				const pid = Number(entry);
				if (!Number.isInteger(pid)) continue;
				try {
					process.kill(pid, 0);
					others++;
				} catch {
					rmSync(path.join(this.lockDir, entry), { force: true });
				}
			}
		} catch {
			// Treat as no other sessions.
		}
		return others;
	}

	async shutdown(progress: Progress, reason: "quit" | "switch"): Promise<void> {
		if (this.released) return;
		this.released = true;
		const wasStarted = this.info !== undefined;
		this.info = undefined;
		this.user = undefined;
		const others = this.unregisterSession();
		const policy = this.cfg.lxd.onExit;
		if (reason !== "quit" || policy === "keep" || !wasStarted) return;
		if (others > 0) {
			progress(`leaving ${this.target} running for ${others} other pi session(s)`);
			return;
		}
		const args = policy === "delete" ? ["delete", this.target, "--force"] : ["stop", this.target];
		progress(`${policy === "delete" ? "deleting" : "stopping"} ${this.target}`);
		// Detached so pi can exit while the VM shuts down.
		const child = spawn(this.cfg.lxd.lxc, [...this.globalArgs(), ...args], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	}

	async stop(): Promise<void> {
		this.info = undefined;
		this.user = undefined;
		const r = await this.run(["stop", this.target]);
		if (r.code !== 0 && !/already stopped|not running/i.test(r.stderr)) throw new Error(`stopping ${this.target} failed: ${r.stderr.trim()}`);
	}
}
