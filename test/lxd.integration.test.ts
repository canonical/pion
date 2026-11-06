/**
 * End-to-end test against a real LXD server. Creates and deletes a VM.
 * Run with: npm run test:lxd
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { defaultInstanceName, type SandboxConfig } from "../src/config.ts";
import { LxdBackend } from "../src/lxd.ts";
import { bashOps, executeGrep, lsOps, type OpsContext, readOps, writeOps } from "../src/ops.ts";
import { PathMap } from "../src/paths.ts";

const enabled = process.env.PION_LXD_TEST === "1";
// The project lives under $HOME rather than /tmp so the test also covers a typical path.
const base = path.join(os.homedir(), ".cache", "pion-test");
spawnSync("mkdir", ["-p", base]);
const project = realpathSync(mkdtempSync(path.join(base, "proj-")));
writeFileSync(path.join(project, "hello.txt"), "hello from host\nTODO find me\n");
const instance = `${defaultInstanceName(project)}-it`.slice(0, 63);

const cfg = (mount: "ro" | "rw"): SandboxConfig => ({
	backend: "lxd",
	projectDir: project,
	mount,
	guestPath: project,
	env: { PION_TEST: "yes" },
	setup: ["touch /var/lib/pion-setup-ran"],
	installTools: true,
	sudo: true,
	lxd: { lxc: "lxc", remote: "", project: "", instance, image: process.env.PION_LXD_TEST_IMAGE || "ubuntu:24.04", profiles: [], config: {}, onExit: "delete", cpus: 2, memory: "2GiB" },
	workshop: { cli: "workshop", name: "unused", base: "ubuntu@24.04", runtime: "lxd-container", sdks: [], onExit: "stop", stateDir: "/nonexistent" },
	sources: ["test"],
});

const noCtx = undefined as never;
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const log = (m: string) => console.log(`  [lxd] ${m}`);

describe.skipIf(!enabled)("LXD backend", () => {
	let backend: LxdBackend;
	let ctx: OpsContext;

	afterAll(() => {
		spawnSync("lxc", ["delete", instance, "--force"]);
	});

	it("creates the VM with a read-only mount", async () => {
		backend = new LxdBackend(cfg("ro"));
		const info = await backend.start(log);
		ctx = { backend, info, paths: new PathMap(project, project), readOnly: true, hostReadDirs: () => [] };
		expect(info.hasRipgrep).toBe(true);
		const read = createReadToolDefinition(project, { operations: readOps(ctx) });
		expect(text(await read.execute("1", { path: "hello.txt" }, undefined, undefined, noCtx))).toContain("hello from host");
		const ls = createLsToolDefinition(project, { operations: lsOps(ctx) });
		expect(text(await ls.execute("1", {}, undefined, undefined, noCtx))).toContain("hello.txt");
	}, 600_000);

	it("refuses writes to the read-only project, even as root", async () => {
		const write = createWriteToolDefinition(project, { operations: writeOps(ctx) });
		await expect(write.execute("1", { path: "nope.txt", content: "x" }, undefined, undefined, noCtx)).rejects.toThrow(/EROFS/);
		const chunks: Buffer[] = [];
		const r = await bashOps(ctx).exec(`sudo sh -c 'mount -o remount,rw ${project}; echo x > ${project}/nope.txt'`, project, { onData: (d) => chunks.push(d) });
		expect(r.exitCode).not.toBe(0);
		expect(() => statSync(path.join(project, "nope.txt"))).toThrow();
	}, 60_000);

	it("runs commands as the host uid with a clean environment", async () => {
		const chunks: Buffer[] = [];
		const r = await bashOps(ctx).exec("touch ~/.pion-home-ok && echo home-ok; id -u; echo $PION_TEST; echo ${ANTHROPIC_API_KEY:-unset}; test -f /var/lib/pion-setup-ran && echo setup-ok; pwd", project, {
			onData: (d) => chunks.push(d),
			env: { ...process.env, ANTHROPIC_API_KEY: "secret" },
		});
		expect(r.exitCode).toBe(0);
		const out = Buffer.concat(chunks).toString().split("\n");
		expect(out).toEqual(expect.arrayContaining(["home-ok", String(process.getuid?.()), "yes", "unset", "setup-ok", project]));
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

	it("switches the running VM to a writable mount, keeping host ownership", async () => {
		await backend.shutdown(log, "switch");
		backend = new LxdBackend(cfg("rw"));
		const info = await backend.start(log);
		ctx = { backend, info, paths: new PathMap(project, project), readOnly: false, hostReadDirs: () => [] };
		const write = createWriteToolDefinition(project, { operations: writeOps(ctx) });
		await write.execute("1", { path: "sub/out.txt", content: "from guest\n" }, undefined, undefined, noCtx);
		expect(readFileSync(path.join(project, "sub/out.txt"), "utf8")).toBe("from guest\n");
		expect(statSync(path.join(project, "sub/out.txt")).uid).toBe(process.getuid?.());
		expect(statSync(path.join(project, "sub")).uid).toBe(process.getuid?.());
	}, 300_000);

	it("refuses to adopt an instance pion did not create", async () => {
		const other = new LxdBackend({ ...cfg("ro"), lxd: { ...cfg("ro").lxd, instance: `${instance.slice(0, 50)}-foreign` } });
		spawnSync("lxc", ["init", cfg("ro").lxd.image, `${instance.slice(0, 50)}-foreign`, "--vm"]);
		try {
			await expect(other.start(log)).rejects.toThrow(/not created by pion/);
		} finally {
			spawnSync("lxc", ["delete", `${instance.slice(0, 50)}-foreign`, "--force"]);
		}
	}, 300_000);

	it("deletes the VM on quit", async () => {
		await backend.shutdown(log, "quit");
		for (let i = 0; i < 60; i++) {
			if (spawnSync("lxc", ["info", instance]).status !== 0) return;
			await new Promise((r) => setTimeout(r, 1000));
		}
		throw new Error("VM still exists");
	}, 90_000);
});
