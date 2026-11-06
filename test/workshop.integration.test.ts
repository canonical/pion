/**
 * End-to-end test against a real workshop installation. Launches and removes a workshop.
 * Run with: npm run test:workshop
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { defaultWorkshopName, type SandboxConfig } from "../src/config.ts";
import { bashOps, executeGrep, lsOps, type OpsContext, readOps, writeOps } from "../src/ops.ts";
import { PathMap } from "../src/paths.ts";
import { WorkshopBackend } from "../src/workshop.ts";

const enabled = process.env.PION_WORKSHOP_TEST === "1";
const base = path.join(os.homedir(), ".cache", "pion-workshop-test");
mkdirSync(base, { recursive: true });
const root = realpathSync(mkdtempSync(path.join(base, "run-")));
const project = path.join(root, "proj");
const stateDir = path.join(root, "state");
mkdirSync(project);
writeFileSync(path.join(project, "hello.txt"), "hello from host\nTODO find me\n");
const name = defaultWorkshopName(project);

const cfg = (mount: "ro" | "rw", sudo = true): SandboxConfig => ({
	backend: "workshop",
	projectDir: project,
	mount,
	guestPath: project,
	env: { PION_TEST: "yes" },
	setup: ["touch /var/lib/pion-setup-ran"],
	installTools: true,
	sudo,
	lxd: { lxc: "lxc", remote: "", project: "", instance: "unused", image: "unused", profiles: [], config: {}, onExit: "stop" },
	workshop: { cli: "workshop", name, base: "ubuntu@24.04", runtime: "lxd-container", sdks: [], onExit: "delete", stateDir },
	sources: ["test"],
});

const noCtx = undefined as never;
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const log = (m: string) => console.log(`  [workshop] ${m}`);
const projectRoot = path.join(stateDir, name);

describe.skipIf(!enabled)("workshop backend", () => {
	let backend: WorkshopBackend;
	let ctx: OpsContext;
	const restart = async (c: SandboxConfig) => {
		await backend.shutdown(log, "switch");
		backend = new WorkshopBackend(c);
		const info = await backend.start(log);
		ctx = { backend, info, paths: new PathMap(project, project), readOnly: c.mount === "ro", hostReadDirs: () => [] };
	};

	afterAll(() => {
		spawnSync("workshop", ["remove", "-p", projectRoot, name]);
	});

	it("launches the workshop with a read-only project mount", async () => {
		backend = new WorkshopBackend(cfg("ro"));
		const info = await backend.start(log);
		ctx = { backend, info, paths: new PathMap(project, project), readOnly: true, hostReadDirs: () => [] };
		expect(info.hasRipgrep).toBe(true);
		const read = createReadToolDefinition(project, { operations: readOps(ctx) });
		expect(text(await read.execute("1", { path: "hello.txt" }, undefined, undefined, noCtx))).toContain("hello from host");
		const ls = createLsToolDefinition(project, { operations: lsOps(ctx) });
		expect(text(await ls.execute("1", {}, undefined, undefined, noCtx))).toContain("hello.txt");
		// Nothing was written into the user's project.
		expect(spawnSync("ls", ["-A", project]).stdout.toString().trim()).toBe("hello.txt");
	}, 900_000);

	it("refuses writes to the read-only project, even as root", async () => {
		const write = createWriteToolDefinition(project, { operations: writeOps(ctx) });
		await expect(write.execute("1", { path: "nope.txt", content: "x" }, undefined, undefined, noCtx)).rejects.toThrow(/EROFS/);
		const r = await bashOps(ctx).exec(`sudo sh -c 'mount -o remount,rw ${project}; echo x > ${project}/nope.txt'`, project, { onData: () => {} });
		expect(r.exitCode).not.toBe(0);
		expect(() => statSync(path.join(project, "nope.txt"))).toThrow();
	}, 60_000);

	it("runs commands as the workshop user with a clean environment", async () => {
		const chunks: Buffer[] = [];
		const r = await bashOps(ctx).exec(
			"touch ~/.pion-home-ok && echo home-ok; id -un; echo $PION_TEST; echo ${ANTHROPIC_API_KEY:-unset}; test -f /var/lib/pion-setup-ran && echo setup-ok; pwd",
			project,
			{ onData: (d) => chunks.push(d), env: { ...process.env, ANTHROPIC_API_KEY: "secret" } },
		);
		expect(r.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString().split("\n")).toEqual(expect.arrayContaining(["home-ok", "workshop", "yes", "unset", "setup-ok", project]));
	}, 60_000);

	it("greps inside the guest", async () => {
		expect(text(await executeGrep(ctx, { pattern: "TODO" }, project))).toBe("hello.txt:2: TODO find me");
	}, 60_000);

	it("kills the guest process group on abort and timeout", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 1500);
		const started = Date.now();
		await expect(bashOps(ctx).exec("sleep 600 & sleep 601; echo done", project, { onData: () => {}, signal: ac.signal })).rejects.toThrow("aborted");
		await expect(bashOps(ctx).exec("sleep 602", project, { onData: () => {}, timeout: 1 })).rejects.toThrow("timeout:1");
		expect(Date.now() - started).toBeLessThan(20_000);
		const left = await backend.exec(["sh", "-c", "pgrep -f 'sleep 60[012]' || true"]);
		expect(left.stdout.toString().trim()).toBe("");
	}, 60_000);

	it("switches to a writable mount, keeping host ownership", async () => {
		await restart(cfg("rw"));
		const write = createWriteToolDefinition(project, { operations: writeOps(ctx) });
		await write.execute("1", { path: "sub/out.txt", content: "from guest\n" }, undefined, undefined, noCtx);
		expect(readFileSync(path.join(project, "sub/out.txt"), "utf8")).toBe("from guest\n");
		expect(statSync(path.join(project, "sub/out.txt")).uid).toBe(process.getuid?.());
		expect(statSync(path.join(project, "sub")).uid).toBe(process.getuid?.());
	}, 300_000);

	it("can take sudo away", async () => {
		await restart(cfg("rw", false));
		expect((await bashOps(ctx).exec("sudo -n true", project, { onData: () => {} })).exitCode).not.toBe(0);
		await restart(cfg("rw", true));
		expect((await bashOps(ctx).exec("sudo -n true", project, { onData: () => {} })).exitCode).toBe(0);
	}, 300_000);

	it("installs configured SDKs", async () => {
		const sdkProject = path.join(root, "sdkproj");
		mkdirSync(sdkProject);
		const c = cfg("ro");
		const sdkCfg: SandboxConfig = {
			...c,
			projectDir: sdkProject,
			guestPath: sdkProject,
			installTools: false,
			setup: [],
			workshop: { ...c.workshop, name: defaultWorkshopName(sdkProject), sdks: [{ name: "go" }] },
		};
		const b = new WorkshopBackend(sdkCfg);
		try {
			const info = await b.start(log);
			const chunks: Buffer[] = [];
			const r = await bashOps({ backend: b, info, paths: new PathMap(sdkProject, sdkProject), readOnly: true, hostReadDirs: () => [] }).exec("go version", sdkProject, {
				onData: (d) => chunks.push(d),
			});
			expect(Buffer.concat(chunks).toString()).toMatch(/go version go1\./);
			expect(r.exitCode).toBe(0);
		} finally {
			spawnSync("workshop", ["remove", "-p", b.projectRoot, sdkCfg.workshop.name]);
		}
	}, 900_000);

	it("removes the workshop on quit", async () => {
		await backend.shutdown(log, "quit");
		for (let i = 0; i < 90; i++) {
			const r = spawnSync("workshop", ["info", "-p", projectRoot, name]);
			if (/not launched/.test(r.stderr.toString())) return;
			await new Promise((r) => setTimeout(r, 1000));
		}
		throw new Error("workshop still launched");
	}, 120_000);
});
