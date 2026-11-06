import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigError, defaultInstanceName, defaultWorkshopName, matchProject, parseEnvrc, resolveConfig, userConfigPath, validInstanceName, validWorkshopName } from "../src/config.ts";

let root: string;
let home: string;
let project: string;
let configFile: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pion-config-")));
	home = path.join(root, "home");
	project = path.join(home, "work", "proj");
	mkdirSync(path.join(project, "sub", "deeper"), { recursive: true });
	mkdirSync(path.join(home, ".config", "pi"), { recursive: true });
	configFile = path.join(home, ".config", "pi", "pion.json");
});

const writeUser = (obj: unknown) => writeFileSync(configFile, JSON.stringify(obj));
const resolve = (cwd: string, opts: { env?: NodeJS.ProcessEnv; trusted?: boolean } = {}) =>
	resolveConfig({ cwd, env: opts.env ?? {}, projectTrusted: opts.trusted ?? true, homeDir: home, userConfigPath: configFile });

describe("parseEnvrc", () => {
	it("reads literal assignments and ignores anything needing a shell", () => {
		const vars = parseEnvrc(
			[
				"# comment",
				"export PION_MOUNT=rw",
				"PION_LXD_IMAGE='ubuntu:22.04'",
				'export PION_LXD_MEMORY="4GiB" # trailing',
				"export PION_LXD_DISK=20GiB # comment",
				'export PION_GUEST_PATH="$HOME/x"',
				"export PION_SETUP=$(curl evil)",
				"use flake",
				'export ESCAPED="a\\"b"',
			].join("\n"),
		);
		expect(vars).toEqual({
			PION_MOUNT: "rw",
			PION_LXD_IMAGE: "ubuntu:22.04",
			PION_LXD_MEMORY: "4GiB",
			PION_LXD_DISK: "20GiB",
			ESCAPED: 'a"b',
		});
	});
});

describe("matchProject", () => {
	it("prefers the deepest match and exact keys over wildcards", () => {
		const projects = { "~/work/*": { mount: "ro" as const }, "~/work/proj": { mount: "rw" as const }, [`${home}/work/proj/sub`]: {} };
		expect(matchProject(projects, path.join(project, "sub", "deeper"), home)?.projectDir).toBe(path.join(project, "sub"));
		const m = matchProject({ "~/work/*": {}, "~/work/proj": { mount: "rw" } }, project, home);
		expect(m?.key).toBe("~/work/proj");
		const w = matchProject({ "~/work/*": {} }, path.join(project, "sub"), home);
		expect(w?.projectDir).toBe(project);
		expect(matchProject({ "~/work/*": {} }, path.join(home, "work"), home)).toBeUndefined();
	});
});

describe("resolveConfig", () => {
	it("is off with no project-specific config", () => {
		writeUser({ defaults: { lxd: { image: "ubuntu:22.04" } } });
		expect(resolve(project).backend).toBe("none");
	});

	it("activates lxd from a user config path match, mounting the matched dir", () => {
		writeUser({ projects: { "~/work/proj": { mount: "rw", lxd: { cpus: 4 } } } });
		const cfg = resolve(path.join(project, "sub"));
		expect(cfg.backend).toBe("lxd");
		expect(cfg.projectDir).toBe(project);
		expect(cfg.guestPath).toBe(project);
		expect(cfg.mount).toBe("rw");
		expect(cfg.lxd.cpus).toBe(4);
		expect(cfg.lxd.instance).toBe(defaultInstanceName(project));
	});

	it("activates from a trusted .envrc and defaults to read-only", () => {
		writeFileSync(path.join(project, ".envrc"), "export PION_LXD_IMAGE=debian/12\n");
		const cfg = resolve(path.join(project, "sub", "deeper"));
		expect(cfg.backend).toBe("lxd");
		expect(cfg.mount).toBe("ro");
		expect(cfg.projectDir).toBe(project);
		expect(cfg.lxd.image).toBe("debian/12");
	});

	it("skips a static .envrc when the project is not trusted", () => {
		writeFileSync(path.join(project, ".envrc"), "export PION_MOUNT=rw\n");
		const cfg = resolve(project, { trusted: false });
		expect(cfg.backend).toBe("none");
		expect(cfg.sources.join()).toMatch(/not trusted/);
	});

	it("uses direnv-loaded environment and DIRENV_DIR for the project root", () => {
		const cfg = resolve(path.join(project, "sub"), { env: { PION_MOUNT: "rw", DIRENV_DIR: `-${project}` }, trusted: false });
		expect(cfg.backend).toBe("lxd");
		expect(cfg.mount).toBe("rw");
		expect(cfg.projectDir).toBe(project);
	});

	it("lets the user's per-path config override the repository's .envrc", () => {
		writeFileSync(path.join(project, ".envrc"), "export PION_MOUNT=rw\nexport PION_LXD_CPUS=8\n");
		writeUser({ projects: { [project]: { mount: "ro" } } });
		const cfg = resolve(project);
		expect(cfg.mount).toBe("ro");
		expect(cfg.lxd.cpus).toBe(8);
	});

	it("does not let .envrc pick instances, profiles, remotes or raw config", () => {
		writeFileSync(path.join(project, ".envrc"), "export PION_LXD_INSTANCE=canonical-vpn\nexport PION_LXD_PROFILES=privileged\nexport PION_MOUNT=ro\n");
		const cfg = resolve(project);
		expect(cfg.lxd.instance).toBe(defaultInstanceName(project));
		expect(cfg.lxd.profiles).toEqual([]);
		expect(cfg.sources.join()).toMatch(/ignored.*PION_LXD_INSTANCE/);
	});

	it("passes PION_ENV_* through as guest environment", () => {
		const cfg = resolve(project, { env: { PION_ENV_FOO: "bar", PION_BACKEND: "lxd" } });
		expect(cfg.env).toEqual({ FOO: "bar" });
	});

	it("respects backend none", () => {
		writeUser({ projects: { [project]: { backend: "none" } } });
		expect(resolve(project).backend).toBe("none");
	});

	it("rejects unknown options and bad values", () => {
		writeUser({ projects: { [project]: { mount: "sideways" } } });
		expect(() => resolve(project)).toThrow(ConfigError);
		writeUser({ projects: { [project]: { lxd: { cpu: 2 } } } });
		expect(() => resolve(project)).toThrow(/lxd.cpu: unknown option/);
		writeUser({});
		expect(() => resolve(project, { env: { PION_LXD_CPUS: "lots" } })).toThrow(/positive integer/);
	});

	it("supports a different guest path", () => {
		writeUser({ projects: { [project]: { guestPath: "/workspace" } } });
		expect(resolve(project).guestPath).toBe("/workspace");
	});
});

describe("names and paths", () => {
	it("derives valid LXD instance names", () => {
		for (const dir of ["/a/My_Project.v2", "/a/---", "/", `/x/${"long".repeat(30)}`]) {
			expect(validInstanceName(defaultInstanceName(dir))).toBe(true);
		}
		expect(defaultInstanceName("/a/b")).not.toBe(defaultInstanceName("/c/b"));
	});

	it("honours XDG_CONFIG_HOME", () => {
		expect(userConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/pi/pion.json");
		expect(userConfigPath({}, "/home/u")).toBe("/home/u/.config/pi/pion.json");
	});
});

describe("workshop backend config", () => {
	it("reads workshop settings from the user config", () => {
		writeUser({
			projects: {
				[project]: {
					backend: "workshop",
					mount: "rw",
					workshop: { base: "ubuntu@22.04", runtime: "lxd-vm", sdks: ["go/1.26/stable", { name: "uv", channel: "latest/edge" }, "node"], onExit: "delete" },
				},
			},
		});
		const cfg = resolve(project);
		expect(cfg.backend).toBe("workshop");
		expect(cfg.workshop.base).toBe("ubuntu@22.04");
		expect(cfg.workshop.runtime).toBe("lxd-vm");
		expect(cfg.workshop.sdks).toEqual([{ name: "go", channel: "1.26/stable" }, { name: "uv", channel: "latest/edge" }, { name: "node" }]);
		expect(cfg.workshop.onExit).toBe("delete");
		expect(cfg.workshop.name).toBe(defaultWorkshopName(project));
		expect(cfg.workshop.stateDir).toBe(path.join(home, ".local", "state", "pion", "workshop"));
	});

	it("reads workshop settings from .envrc", () => {
		writeFileSync(
			path.join(project, ".envrc"),
			"export PION_BACKEND=workshop\nexport PION_WORKSHOP_SDKS=go,uv/latest/stable\nexport PION_WORKSHOP_BASE=ubuntu@26.04\nexport PION_WORKSHOP_RUNTIME=lxd-container\n",
		);
		const cfg = resolve(project);
		expect(cfg.backend).toBe("workshop");
		expect(cfg.workshop.sdks).toEqual([{ name: "go" }, { name: "uv", channel: "latest/stable" }]);
		expect(cfg.workshop.base).toBe("ubuntu@26.04");
	});

	it("rejects bad workshop values", () => {
		expect(() => resolve(project, { env: { PION_BACKEND: "workshop", PION_WORKSHOP_BASE: "debian@12" } })).toThrow(/ubuntu@24.04/);
		expect(() => resolve(project, { env: { PION_BACKEND: "workshop", PION_WORKSHOP_SDKS: "project-foo" } })).toThrow(/in-project SDKs/);
		expect(() => resolve(project, { env: { PION_BACKEND: "workshop", PION_WORKSHOP_SDKS: "Go" } })).toThrow(/invalid SDK name/);
		expect(() => resolve(project, { env: { PION_BACKEND: "workshop", PION_GUEST_PATH: "/project/x" } })).toThrow(/reserved by workshop/);
		writeUser({ projects: { [project]: { backend: "workshop", workshop: { name: "Bad--Name" } } } });
		expect(() => resolve(project)).toThrow(/invalid workshop name/);
	});

	it("keeps the workshop name and state dir out of reach of .envrc", () => {
		writeFileSync(path.join(project, ".envrc"), "export PION_BACKEND=workshop\nexport PION_WORKSHOP_NAME=evil\n");
		const cfg = resolve(project);
		expect(cfg.workshop.name).toBe(defaultWorkshopName(project));
		expect(cfg.sources.join()).toMatch(/ignored.*PION_WORKSHOP_NAME/);
	});

	it("derives valid workshop names", () => {
		for (const dir of ["/a/My_Project.v2", "/a/---", "/", "/a/x--y", `/x/${"long".repeat(30)}`, "/a/9lives"]) {
			const name = defaultWorkshopName(dir);
			expect(validWorkshopName(name), name).toBe(true);
		}
	});
});
