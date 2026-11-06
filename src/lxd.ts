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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { type BackendInfo, type ExecOptions, type ExecResult, type Progress, type SandboxBackend, shq } from "./backend.ts";
import type { SandboxConfig } from "./config.ts";
import { KILL_GROUP_SCRIPT, probeGuest, runCli, runClient, runSetupOnce, SESSION_WRAPPER, SessionRegistry } from "./shared.ts";

export const MOUNT_DEVICE = "pion-project";
const MANAGED_KEY = "user.pion.managed";
const PROJECT_KEY = "user.pion.project";

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

export class LxdBackend implements SandboxBackend {
	private readonly cfg: SandboxConfig;
	private user: GuestUser | undefined;
	private info: BackendInfo | undefined;
	private released = false;
	private readonly sessions: SessionRegistry;

	constructor(cfg: SandboxConfig) {
		this.cfg = cfg;
		this.sessions = new SessionRegistry("lxd", cfg.lxd.remote, cfg.lxd.project, cfg.lxd.instance);
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
		return runCli(this.cfg.lxd.lxc, [...this.globalArgs(), ...args], input);
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
		this.sessions.register(this.cfg.projectDir);
		await this.waitForAgent(progress);
		await this.waitForMount(progress);
		this.user = undefined;
		await this.waitForCloudInit(progress);
		const user = await this.provisionUser(progress);
		await runSetupOnce(this.cfg, (argv) => this.rawExec(argv, { asRoot: true }), progress);
		this.user = user;

		const { shell, hasRipgrep } = await probeGuest((argv) => this.rawExec(argv));

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

		return runClient(this.cfg.lxd.lxc, args, options, () => this.killGroup(pidfile));
	}

	/** SIGTERM the command's process group in the guest, then SIGKILL after a grace period. */
	private async killGroup(pidfile: string): Promise<void> {
		try {
			await this.rawExec(["sh", "-c", KILL_GROUP_SCRIPT, "sh", pidfile], { asRoot: true });
		} catch {
			// Best effort; the local client is killed regardless.
		}
	}

	async shutdown(progress: Progress, reason: "quit" | "switch"): Promise<void> {
		if (this.released) return;
		this.released = true;
		const wasStarted = this.info !== undefined;
		this.info = undefined;
		this.user = undefined;
		const others = this.sessions.unregister();
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
