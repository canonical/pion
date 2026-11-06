/**
 * pion: run pi's tools inside a per-project sandbox.
 *
 * When the project is configured (see config.ts), the built-in read, write, edit, bash, ls,
 * find and grep tools, and user `!` commands, execute inside the sandbox instead of on the
 * host. The project directory is mounted into the sandbox read-only or writable.
 *
 * When the project is not configured, every tool behaves exactly like the built-in one.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getDocsPath,
	getExamplesPath,
	getReadmePath,
} from "@earendil-works/pi-coding-agent";
import type { BackendInfo, SandboxBackend } from "./backend.ts";
import { ConfigError, type SandboxConfig, resolveConfig } from "./config.ts";
import { LxdBackend } from "./lxd.ts";
import { bashOps, editOps, executeGrep, findOps, lsOps, type OpsContext, readOps, writeOps } from "./ops.ts";
import { PathMap } from "./paths.ts";

const STATUS_KEY = "pion";

interface Sandbox {
	cfg: SandboxConfig;
	backend: SandboxBackend;
	paths: PathMap;
	info?: BackendInfo;
	starting?: Promise<BackendInfo>;
	error?: Error;
}

type State = { kind: "off"; cfg?: SandboxConfig } | { kind: "error"; error: Error } | { kind: "on"; sandbox: Sandbox };

function createBackend(cfg: SandboxConfig): SandboxBackend {
	switch (cfg.backend) {
		case "lxd":
			return new LxdBackend(cfg);
		default:
			throw new ConfigError(`unsupported backend: ${cfg.backend}`);
	}
}

function applyFlag(cfg: SandboxConfig, flag: string | undefined): SandboxConfig {
	if (!flag) return cfg;
	const v = flag.trim().toLowerCase();
	if (v === "none" || v === "off") return { ...cfg, backend: "none", sources: [...cfg.sources, `--pion ${flag}`] };
	if (v === "ro" || v === "rw") {
		return { ...cfg, backend: cfg.backend === "none" ? "lxd" : cfg.backend, mount: v, sources: [...cfg.sources, `--pion ${flag}`] };
	}
	if (v === "lxd") return { ...cfg, backend: "lxd", sources: [...cfg.sources, `--pion ${flag}`] };
	throw new ConfigError(`--pion: expected none, lxd, ro or rw, got "${flag}"`);
}

export default function pion(pi: ExtensionAPI) {
	pi.registerFlag("pion", {
		description: "pion sandbox override: none (run tools on the host), lxd, ro or rw",
		type: "string",
	});

	const hostCwd = process.cwd();
	const local = {
		read: createReadToolDefinition(hostCwd),
		write: createWriteToolDefinition(hostCwd),
		edit: createEditToolDefinition(hostCwd),
		bash: createBashToolDefinition(hostCwd),
		ls: createLsToolDefinition(hostCwd),
		find: createFindToolDefinition(hostCwd),
		grep: createGrepToolDefinition(hostCwd),
	};

	let state: State = { kind: "off" };
	let skillDirs: string[] = [];
	const piDocs = [getDocsPath(), getExamplesPath(), getReadmePath()];

	const setStatus = (ctx: ExtensionContext | undefined, text: string | undefined, tone: "accent" | "muted" | "error" = "accent") => {
		if (!ctx?.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text === undefined ? undefined : ctx.ui.theme.fg(tone, text));
	};

	function startSandbox(sb: Sandbox, ctx: ExtensionContext | undefined): Promise<BackendInfo> {
		if (sb.info) return Promise.resolve(sb.info);
		if (sb.starting) return sb.starting;
		sb.error = undefined;
		sb.starting = sb.backend
			.start((msg) => setStatus(ctx, `pion: ${msg}`, "muted"))
			.then((info) => {
				sb.info = info;
				setStatus(ctx, info.label);
				if (ctx?.hasUI) ctx.ui.notify(`pion: tools run in ${info.label}`, "info");
				return info;
			})
			.catch((e: unknown) => {
				const err = e instanceof Error ? e : new Error(String(e));
				sb.error = err;
				setStatus(ctx, "pion: sandbox failed (see /pion)", "error");
				if (ctx?.hasUI) ctx.ui.notify(`pion: ${err.message}`, "error");
				throw err;
			})
			.finally(() => {
				sb.starting = undefined;
			});
		return sb.starting;
	}

	/**
	 * The ops context when the sandbox is on, `undefined` when it is off. Throws when the
	 * sandbox is configured but unusable, so tools never silently fall back to the host.
	 */
	async function active(ctx: ExtensionContext | undefined): Promise<OpsContext | undefined> {
		if (state.kind === "off") return undefined;
		if (state.kind === "error") throw new Error(`pion sandbox configuration error: ${state.error.message}`);
		const sb = state.sandbox;
		if (sb.error && !sb.starting && !sb.info) {
			throw new Error(`pion sandbox is not available: ${sb.error.message}. Run /pion start to retry.`);
		}
		const info = await startSandbox(sb, ctx);
		return {
			backend: sb.backend,
			info,
			paths: sb.paths,
			readOnly: sb.cfg.mount === "ro",
			hostReadDirs: () => [...skillDirs, ...piDocs],
		};
	}

	pi.registerTool({
		...local.read,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.read.execute(id, params, signal, onUpdate, ctx);
			return createReadToolDefinition(hostCwd, { operations: readOps(ops) }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...local.write,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.write.execute(id, params, signal, onUpdate, ctx);
			return createWriteToolDefinition(hostCwd, { operations: writeOps(ops) }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...local.edit,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.edit.execute(id, params, signal, onUpdate, ctx);
			return createEditToolDefinition(hostCwd, { operations: editOps(ops) }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...local.bash,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.bash.execute(id, params, signal, onUpdate, ctx);
			return createBashToolDefinition(hostCwd, { operations: bashOps(ops) }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...local.ls,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.ls.execute(id, params, signal, onUpdate, ctx);
			return createLsToolDefinition(hostCwd, { operations: lsOps(ops) }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...local.find,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.find.execute(id, params, signal, onUpdate, ctx);
			return createFindToolDefinition(hostCwd, { operations: findOps(ops, signal) }).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...local.grep,
		async execute(id, params, signal, onUpdate, ctx) {
			const ops = await active(ctx);
			if (!ops) return local.grep.execute(id, params, signal, onUpdate, ctx);
			return executeGrep(ops, params, ctx?.cwd || hostCwd, signal);
		},
	});

	pi.on("user_bash", async (_event, ctx) => {
		const ops = await active(ctx);
		if (!ops) return undefined;
		return { operations: bashOps(ops) };
	});

	pi.on("before_agent_start", async (event) => {
		skillDirs = event.systemPromptOptions.skills.map((s) => s.baseDir);
		if (state.kind !== "on") return;
		const { cfg, paths } = state.sandbox;
		const opts = event.systemPromptOptions;
		const hostCwdLine = opts.cwd;
		if (!paths.identity) opts.cwd = paths.toGuest(opts.cwd);
		const lines = [
			`Your tools (read, write, edit, bash, ls, find, grep) run inside an isolated ${cfg.backend.toUpperCase()} virtual machine, not on the user's host.`,
			`The project directory is mounted at ${cfg.guestPath}${paths.identity ? "" : ` (host path ${hostCwdLine})`} and is ${
				cfg.mount === "ro"
					? "READ-ONLY: you cannot modify project files. Writes, edits and commands that change files in the project will fail; explain proposed changes instead, or write scratch output outside the project (for example /tmp)."
					: "writable: changes you make there are written to the user's host."
			}`,
			"Paths outside the project refer to the virtual machine's own filesystem. Software you install there does not affect the host.",
		];
		if (cfg.sudo) lines.push("You have passwordless sudo inside the virtual machine.");
		opts.sections.sandbox = lines.join("\n");
		return undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		let cfg: SandboxConfig;
		try {
			cfg = applyFlag(resolveConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }), pi.getFlag("pion") as string | undefined);
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e));
			state = { kind: "error", error };
			setStatus(ctx, "pion: config error (see /pion)", "error");
			if (ctx.hasUI) ctx.ui.notify(`pion: ${error.message}. Tools are disabled; fix the config or run pi --pion none.`, "error");
			return;
		}
		if (cfg.backend === "none") {
			state = { kind: "off", cfg };
			setStatus(ctx, undefined);
			return;
		}
		const sandbox: Sandbox = { cfg, backend: createBackend(cfg), paths: new PathMap(cfg.projectDir, cfg.guestPath) };
		state = { kind: "on", sandbox };
		// Start in the background so the UI is usable while the VM boots; tools wait for it.
		startSandbox(sandbox, ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (state.kind !== "on") return;
		const sb = state.sandbox;
		state = { kind: "off" };
		await sb.starting?.catch(() => {});
		try {
			await sb.backend.shutdown((msg) => setStatus(ctx, `pion: ${msg}`, "muted"), event.reason === "quit" ? "quit" : "switch");
		} finally {
			setStatus(ctx, undefined);
		}
	});

	pi.registerCommand("pion", {
		description: "Show or control the pion sandbox: /pion [status|start|stop]",
		getArgumentCompletions: (prefix) =>
			["status", "start", "stop"].filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			if (sub === "status") {
				const lines: string[] = [];
				if (state.kind === "error") lines.push(`Configuration error: ${state.error.message}`);
				else if (state.kind === "off") {
					lines.push("Sandbox: off (tools run on the host)");
					if (state.cfg?.sources.length) lines.push(`Config sources: ${state.cfg.sources.join("; ")}`);
				} else {
					const sb = state.sandbox;
					if (sb.info) lines.push(...sb.info.details);
					else if (sb.starting) lines.push(`Sandbox: starting ${sb.cfg.lxd.instance}`);
					else if (sb.error) lines.push(`Sandbox failed: ${sb.error.message}`);
					else lines.push(`Sandbox: not started (${sb.cfg.lxd.instance})`);
					lines.push(`Config sources: ${sb.cfg.sources.join("; ") || "built-in defaults"}`);
				}
				ctx.ui.notify(lines.join("\n"), state.kind === "error" ? "error" : "info");
				return;
			}
			if (state.kind !== "on") {
				ctx.ui.notify("pion: no sandbox is configured for this project", "warning");
				return;
			}
			const sb = state.sandbox;
			if (sub === "start") {
				await startSandbox(sb, ctx).catch(() => {});
				return;
			}
			if (sub === "stop") {
				await sb.starting?.catch(() => {});
				sb.info = undefined;
				await sb.backend.stop();
				setStatus(ctx, "pion: stopped (starts again on next tool call)", "muted");
				ctx.ui.notify("pion: sandbox stopped", "info");
				return;
			}
			ctx.ui.notify(`pion: unknown subcommand "${sub}"`, "warning");
		},
	});
}
