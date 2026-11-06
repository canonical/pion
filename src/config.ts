/**
 * Configuration resolution for pion.
 *
 * Sources, lowest precedence first:
 *   1. Built-in defaults.
 *   2. `defaults` in the user config file ($XDG_CONFIG_HOME/pi/pion.json).
 *   3. PION_* variables from the process environment (for example loaded by direnv)
 *      or, when the project is trusted, read statically from the nearest `.envrc`.
 *   4. The `projects` entry in the user config file whose path matches the project.
 *
 * The user's own per-path config wins over anything a repository ships, and the
 * repository-controlled sources (3) may only set a safe subset of options.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type MountMode = "ro" | "rw";
export type BackendKind = "lxd" | "none";
export type OnExit = "stop" | "keep" | "delete";

export interface LxdSettings {
	/** CLI binary to drive. Defaults to `lxc`. */
	lxc: string;
	/** LXD remote name (`lxc remote list`). Empty for the default remote. */
	remote: string;
	/** LXD project. Empty for the client's current project. */
	project: string;
	/** Instance name. Derived from the project path when empty. */
	instance: string;
	image: string;
	profiles: string[];
	cpus?: number;
	memory?: string;
	disk?: string;
	storagePool?: string;
	/** Extra instance config keys, applied at creation. User config only. */
	config: Record<string, string>;
	/** What to do with the VM when the last pi session using it exits. */
	onExit: OnExit;
}

export interface SandboxConfig {
	backend: BackendKind;
	/** Host directory mounted into the sandbox. */
	projectDir: string;
	mount: MountMode;
	/** Where the project appears inside the sandbox. Defaults to the same path as on the host. */
	guestPath: string;
	/** Extra environment variables for commands run in the sandbox. */
	env: Record<string, string>;
	/** Shell commands run once as root after provisioning (re-run when they change). */
	setup: string[];
	/** Install ripgrep in the guest when it is missing, so grep and find respect .gitignore. */
	installTools: boolean;
	/** Give the guest user passwordless sudo. */
	sudo: boolean;
	lxd: LxdSettings;
	/** Human-readable list of where settings came from. */
	sources: string[];
}

/** Settings as written in a config source; everything optional. */
export interface PartialSandboxConfig {
	backend?: BackendKind;
	mount?: MountMode;
	guestPath?: string;
	env?: Record<string, string>;
	setup?: string[];
	installTools?: boolean;
	sudo?: boolean;
	lxd?: Partial<LxdSettings>;
}

export interface UserConfigFile {
	defaults?: PartialSandboxConfig;
	projects?: Record<string, PartialSandboxConfig>;
}

export interface ResolveOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Whether pi trusts project-local files. Gates static `.envrc` parsing. */
	projectTrusted: boolean;
	/** Override the user config path (tests). */
	userConfigPath?: string;
	homeDir?: string;
}

export class ConfigError extends Error {}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	const xdg = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
	return path.join(xdg, "pi", "pion.json");
}

function expandHome(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return path.join(home, p.slice(2));
	return p;
}

function canonical(p: string): string {
	const resolved = path.resolve(p);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Ancestors of `dir`, starting with `dir` itself. */
function ancestors(dir: string): string[] {
	const out: string[] = [];
	let current = dir;
	for (;;) {
		out.push(current);
		const parent = path.dirname(current);
		if (parent === current) return out;
		current = parent;
	}
}

export interface ProjectMatch {
	key: string;
	projectDir: string;
	config: PartialSandboxConfig;
}

/**
 * Find the user-config project entry for `cwd`.
 *
 * A key is an absolute path (or `~/...`) naming a project directory, which matches that
 * directory and anything below it. A key ending in `/*` matches each direct child of that
 * directory as its own project. The deepest matching project directory wins; for the same
 * directory an exact key beats a `/*` key.
 */
export function matchProject(projects: Record<string, PartialSandboxConfig>, cwd: string, home: string): ProjectMatch | undefined {
	const chain = ancestors(canonical(cwd));
	let best: { depth: number; exact: boolean; match: ProjectMatch } | undefined;
	for (const [key, config] of Object.entries(projects)) {
		const expanded = expandHome(key.trim(), home);
		const wildcard = expanded.endsWith("/*");
		const base = wildcard ? expanded.slice(0, -2) || "/" : expanded;
		if (!path.isAbsolute(base)) continue;
		const target = canonical(base);
		for (let i = 0; i < chain.length; i++) {
			const dir = chain[i]!;
			const hit = wildcard ? path.dirname(dir) === target && dir !== target : dir === target;
			if (!hit) continue;
			const depth = chain.length - i;
			const exact = !wildcard;
			if (!best || depth > best.depth || (depth === best.depth && exact && !best.exact)) {
				best = { depth, exact, match: { key, projectDir: dir, config } };
			}
			break;
		}
	}
	return best?.match;
}

const ENV_PREFIX = "PION_";

/** Keys a repository-controlled source (`.envrc`, environment) may set. */
const ENV_KEYS = new Set([
	"PION_BACKEND",
	"PION_MOUNT",
	"PION_GUEST_PATH",
	"PION_SETUP",
	"PION_INSTALL_TOOLS",
	"PION_SUDO",
	"PION_LXD_IMAGE",
	"PION_LXD_CPUS",
	"PION_LXD_MEMORY",
	"PION_LXD_DISK",
	"PION_LXD_ON_EXIT",
]);

/**
 * Parse literal assignments out of an `.envrc` without executing it.
 *
 * Handles `export KEY=value`, `KEY=value`, single- and double-quoted values (no expansion)
 * and trailing comments. Anything else in the file is ignored.
 */
export function parseEnvrc(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1]!;
		let rest = m[2]!;
		let value: string;
		if (rest.startsWith("'")) {
			const end = rest.indexOf("'", 1);
			if (end < 0) continue;
			value = rest.slice(1, end);
		} else if (rest.startsWith('"')) {
			let i = 1;
			value = "";
			let closed = false;
			while (i < rest.length) {
				const ch = rest[i]!;
				if (ch === "\\" && i + 1 < rest.length && '"\\$`'.includes(rest[i + 1]!)) {
					value += rest[i + 1];
					i += 2;
					continue;
				}
				if (ch === '"') {
					closed = true;
					break;
				}
				if (ch === "$" || ch === "`") {
					// Expansion would need a shell; refuse rather than guess.
					value = "";
					closed = false;
					break;
				}
				value += ch;
				i++;
			}
			if (!closed) continue;
		} else {
			rest = rest.replace(/\s+#.*$/, "");
			if (/[$`\s;&|<>()]/.test(rest)) continue;
			value = rest;
		}
		out[key] = value;
	}
	return out;
}

function parseBool(key: string, value: string): boolean {
	const v = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(v)) return true;
	if (["0", "false", "no", "off", ""].includes(v)) return false;
	throw new ConfigError(`${key}: expected a boolean, got "${value}"`);
}

function parseEnum<T extends string>(key: string, value: string, allowed: readonly T[]): T {
	const v = value.trim().toLowerCase() as T;
	if (!allowed.includes(v)) throw new ConfigError(`${key}: expected one of ${allowed.join(", ")}, got "${value}"`);
	return v;
}

function parseMount(key: string, value: string): MountMode {
	const v = value.trim().toLowerCase();
	if (["ro", "readonly", "read-only"].includes(v)) return "ro";
	if (["rw", "writable", "read-write", "readwrite"].includes(v)) return "rw";
	throw new ConfigError(`${key}: expected ro or rw, got "${value}"`);
}

function parsePositiveInt(key: string, value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${key}: expected a positive integer, got "${value}"`);
	return n;
}

/** Turn PION_* variables into a partial config. Unknown or disallowed PION_* keys are reported. */
export function configFromEnv(vars: Record<string, string | undefined>): { config: PartialSandboxConfig; ignored: string[] } {
	const config: PartialSandboxConfig = {};
	const lxd: Partial<LxdSettings> = {};
	const env: Record<string, string> = {};
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined || !key.startsWith(ENV_PREFIX)) continue;
		if (key.startsWith("PION_ENV_") && key.length > "PION_ENV_".length) {
			env[key.slice("PION_ENV_".length)] = value;
			continue;
		}
		if (!ENV_KEYS.has(key)) {
			ignored.push(key);
			continue;
		}
		switch (key) {
			case "PION_BACKEND":
				config.backend = parseEnum(key, value, ["lxd", "none"] as const);
				break;
			case "PION_MOUNT":
				config.mount = parseMount(key, value);
				break;
			case "PION_GUEST_PATH":
				config.guestPath = value;
				break;
			case "PION_SETUP":
				config.setup = value.trim() ? [value] : [];
				break;
			case "PION_INSTALL_TOOLS":
				config.installTools = parseBool(key, value);
				break;
			case "PION_SUDO":
				config.sudo = parseBool(key, value);
				break;
			case "PION_LXD_IMAGE":
				lxd.image = value;
				break;
			case "PION_LXD_CPUS":
				lxd.cpus = parsePositiveInt(key, value);
				break;
			case "PION_LXD_MEMORY":
				lxd.memory = value;
				break;
			case "PION_LXD_DISK":
				lxd.disk = value;
				break;
			case "PION_LXD_ON_EXIT":
				lxd.onExit = parseEnum(key, value, ["stop", "keep", "delete"] as const);
				break;
		}
	}
	if (Object.keys(lxd).length > 0) config.lxd = lxd;
	if (Object.keys(env).length > 0) config.env = env;
	return { config, ignored };
}

function hasPionVars(vars: Record<string, string | undefined>): boolean {
	return Object.keys(vars).some((k) => k.startsWith(ENV_PREFIX) && vars[k] !== undefined);
}

/** Locate the nearest `.envrc` at or above `cwd`. */
export function findEnvrc(cwd: string): string | undefined {
	for (const dir of ancestors(canonical(cwd))) {
		const candidate = path.join(dir, ".envrc");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** direnv exports DIRENV_DIR as "-/path/to/dir" for the directory whose .envrc is loaded. */
function direnvDir(env: NodeJS.ProcessEnv): string | undefined {
	const raw = env.DIRENV_DIR;
	if (!raw) return undefined;
	const dir = raw.startsWith("-") ? raw.slice(1) : raw;
	return path.isAbsolute(dir) ? canonical(dir) : undefined;
}

function validatePartial(where: string, c: unknown): PartialSandboxConfig {
	if (c === undefined || c === null) return {};
	if (typeof c !== "object" || Array.isArray(c)) throw new ConfigError(`${where}: expected an object`);
	const o = c as Record<string, unknown>;
	const out: PartialSandboxConfig = {};
	const str = (k: string, v: unknown) => {
		if (typeof v !== "string") throw new ConfigError(`${where}.${k}: expected a string`);
		return v;
	};
	const bool = (k: string, v: unknown) => {
		if (typeof v !== "boolean") throw new ConfigError(`${where}.${k}: expected a boolean`);
		return v;
	};
	const strMap = (k: string, v: unknown) => {
		if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${where}.${k}: expected an object`);
		const m: Record<string, string> = {};
		for (const [mk, mv] of Object.entries(v)) m[mk] = str(`${k}.${mk}`, mv);
		return m;
	};
	const strList = (k: string, v: unknown) => {
		if (typeof v === "string") return [v];
		if (!Array.isArray(v)) throw new ConfigError(`${where}.${k}: expected a string or list of strings`);
		return v.map((item, i) => str(`${k}[${i}]`, item));
	};
	for (const [k, v] of Object.entries(o)) {
		switch (k) {
			case "backend":
				out.backend = parseEnum(`${where}.backend`, str(k, v), ["lxd", "none"] as const);
				break;
			case "mount":
				out.mount = parseMount(`${where}.mount`, str(k, v));
				break;
			case "guestPath":
				out.guestPath = str(k, v);
				break;
			case "env":
				out.env = strMap(k, v);
				break;
			case "setup":
				out.setup = strList(k, v);
				break;
			case "installTools":
				out.installTools = bool(k, v);
				break;
			case "sudo":
				out.sudo = bool(k, v);
				break;
			case "lxd": {
				if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${where}.lxd: expected an object`);
				const l: Partial<LxdSettings> = {};
				for (const [lk, lv] of Object.entries(v as Record<string, unknown>)) {
					const lw = `lxd.${lk}`;
					switch (lk) {
						case "lxc":
						case "remote":
						case "project":
						case "instance":
						case "image":
						case "memory":
						case "disk":
						case "storagePool":
							l[lk] = str(lw, lv);
							break;
						case "profiles":
							l.profiles = strList(lw, lv);
							break;
						case "cpus":
							if (typeof lv !== "number" || !Number.isInteger(lv) || lv <= 0)
								throw new ConfigError(`${where}.${lw}: expected a positive integer`);
							l.cpus = lv;
							break;
						case "config":
							l.config = strMap(lw, lv);
							break;
						case "onExit":
							l.onExit = parseEnum(`${where}.${lw}`, str(lw, lv), ["stop", "keep", "delete"] as const);
							break;
						default:
							throw new ConfigError(`${where}.${lw}: unknown option`);
					}
				}
				out.lxd = l;
				break;
			}
			default:
				throw new ConfigError(`${where}.${k}: unknown option`);
		}
	}
	return out;
}

export function loadUserConfig(file: string): UserConfigFile | undefined {
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		throw new ConfigError(`${file}: ${(e as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ConfigError(`${file}: expected an object`);
	const o = parsed as Record<string, unknown>;
	const out: UserConfigFile = {};
	for (const k of Object.keys(o)) {
		if (k !== "defaults" && k !== "projects" && k !== "$schema") throw new ConfigError(`${file}: unknown top-level key "${k}"`);
	}
	if (o.defaults !== undefined) out.defaults = validatePartial("defaults", o.defaults);
	if (o.projects !== undefined) {
		if (typeof o.projects !== "object" || o.projects === null || Array.isArray(o.projects))
			throw new ConfigError(`${file}: projects must be an object keyed by path`);
		out.projects = {};
		for (const [key, value] of Object.entries(o.projects)) out.projects[key] = validatePartial(`projects["${key}"]`, value);
	}
	return out;
}

function merge(base: PartialSandboxConfig, over: PartialSandboxConfig): PartialSandboxConfig {
	return {
		...base,
		...over,
		env: { ...base.env, ...over.env },
		lxd: { ...base.lxd, ...over.lxd, config: { ...base.lxd?.config, ...over.lxd?.config } },
	};
}

/** LXD instance names: 1-63 chars, letters, digits and hyphens, starting with a letter. */
export function defaultInstanceName(projectDir: string): string {
	const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 8);
	const base = path
		.basename(projectDir)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `pion-${base ? `${base}-` : ""}${hash}`;
}

export function validInstanceName(name: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(name) && !name.endsWith("-");
}

export const DEFAULT_IMAGE = "ubuntu:24.04";

/**
 * Resolve the effective sandbox config for `cwd`. Returns a config with `backend: "none"`
 * when nothing asks for a sandbox.
 */
export function resolveConfig(opts: ResolveOptions): SandboxConfig {
	const env = opts.env ?? process.env;
	const home = opts.homeDir ?? os.homedir();
	const cwd = canonical(opts.cwd);
	const sources: string[] = [];

	const userFile = opts.userConfigPath ?? userConfigPath(env, home);
	const user = loadUserConfig(userFile);
	let merged: PartialSandboxConfig = {};
	if (user?.defaults) {
		merged = merge(merged, user.defaults);
		sources.push(`${userFile} (defaults)`);
	}

	// Repository-controlled layer: the live environment if direnv (or the user) set PION_*,
	// otherwise a static read of the nearest .envrc when pi trusts the project.
	let repoDir: string | undefined;
	let repoConfig: PartialSandboxConfig | undefined;
	const ignored: string[] = [];
	if (hasPionVars(env)) {
		const r = configFromEnv(env);
		repoConfig = r.config;
		ignored.push(...r.ignored);
		repoDir = direnvDir(env);
		sources.push(repoDir ? `environment (direnv: ${path.join(repoDir, ".envrc")})` : "environment");
	} else {
		const envrc = findEnvrc(cwd);
		if (envrc) {
			const vars = parseEnvrc(readFileSync(envrc, "utf8"));
			if (hasPionVars(vars)) {
				if (!opts.projectTrusted) {
					sources.push(`${envrc} (skipped: project not trusted; use direnv or pi --approve)`);
				} else {
					const r = configFromEnv(vars);
					repoConfig = r.config;
					ignored.push(...r.ignored);
					repoDir = path.dirname(envrc);
					sources.push(envrc);
				}
			}
		}
	}
	if (ignored.length > 0) sources.push(`ignored (not allowed outside the user config): ${ignored.join(", ")}`);
	if (repoConfig) merged = merge(merged, repoConfig);

	const match = user?.projects ? matchProject(user.projects, cwd, home) : undefined;
	if (match) {
		merged = merge(merged, match.config);
		sources.push(`${userFile} (projects["${match.key}"])`);
	}

	// A project-specific source turns the sandbox on unless it says otherwise.
	const projectSpecific = Boolean(match || repoConfig);
	const backend: BackendKind = merged.backend ?? (projectSpecific ? "lxd" : "none");

	const projectDir = match?.projectDir ?? repoDir ?? cwd;
	if (!isDir(projectDir)) throw new ConfigError(`project directory does not exist: ${projectDir}`);
	if (!isInsideOrEqual(projectDir, cwd)) {
		throw new ConfigError(`working directory ${cwd} is outside the configured project ${projectDir}`);
	}

	const guestPath = merged.guestPath ? path.posix.normalize(merged.guestPath) : projectDir;
	if (!path.posix.isAbsolute(guestPath)) throw new ConfigError(`guestPath must be absolute: ${guestPath}`);

	const l = merged.lxd ?? {};
	const instance = l.instance || defaultInstanceName(projectDir);
	if (!validInstanceName(instance)) throw new ConfigError(`invalid LXD instance name: ${instance}`);

	return {
		backend,
		projectDir,
		mount: merged.mount ?? "ro",
		guestPath,
		env: merged.env ?? {},
		setup: merged.setup ?? [],
		installTools: merged.installTools ?? true,
		sudo: merged.sudo ?? true,
		lxd: {
			lxc: l.lxc || "lxc",
			remote: l.remote ?? "",
			project: l.project ?? "",
			instance,
			image: l.image || DEFAULT_IMAGE,
			profiles: l.profiles ?? [],
			cpus: l.cpus,
			memory: l.memory,
			disk: l.disk,
			storagePool: l.storagePool,
			config: l.config ?? {},
			onExit: l.onExit ?? "stop",
		},
		sources,
	};
}

export function isInsideOrEqual(root: string, p: string): boolean {
	const rel = path.relative(root, p);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
