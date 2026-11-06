import { describe, expect, it } from "vitest";
import type { SandboxConfig } from "../src/config.ts";
import { parseWorkshopInfo, renderDefinitions } from "../src/workshop.ts";

describe("parseWorkshopInfo", () => {
	it("extracts status, runtime and pion's plug", () => {
		const info = parseWorkshopInfo(
			[
				"name:      pion",
				"base:      ubuntu@24.04",
				"project:   ~/.local/state/pion/workshop/pion-x",
				"status:    ready",
				"runtime:   lxd-container",
				"notes:     --",
				"sdks:",
				"  system:",
				"    installed:  (2)",
				"  other:",
				"    mounts:",
				"      project:",
				"        host-source:      /wrong",
				"        workshop-target:  /wrong",
				"  pion:",
				"    tracking:   ~/.local/state/pion/workshop/pion-x/.workshop/pion",
				"    mounts:",
				"      project:",
				"        host-source:      ~/work/proj",
				"        workshop-target:  /home/u/work/proj",
			].join("\n"),
			"/home/u",
		);
		expect(info).toEqual({ status: "ready", runtime: "lxd-container", hostSource: "/home/u/work/proj", workshopTarget: "/home/u/work/proj" });
	});

	it("handles a workshop without mounts", () => {
		expect(parseWorkshopInfo("name: x\nstatus:   stopped\n")).toEqual({ status: "stopped" });
	});
});

describe("renderDefinitions", () => {
	const cfg = (mount: "ro" | "rw", runtime: "lxd-container" | "lxd-vm" = "lxd-container") =>
		({
			mount,
			guestPath: "/home/u/my proj",
			workshop: { name: "pion-proj-1234", base: "ubuntu@24.04", runtime, sdks: [{ name: "go", channel: "1.26/stable" }, { name: "uv" }] },
		}) as unknown as SandboxConfig;

	it("renders the workshop and the mount SDK", () => {
		const { workshopYaml, sdkYaml } = renderDefinitions(cfg("ro"));
		expect(workshopYaml).toContain("name: pion-proj-1234\n");
		expect(workshopYaml).toContain('base: "ubuntu@24.04"');
		expect(workshopYaml).not.toContain("runtime:");
		expect(workshopYaml).toContain('  - name: project-pion\n  - name: "go"\n    channel: "1.26/stable"\n  - name: "uv"\n');
		expect(sdkYaml).toContain('workshop-target: "/home/u/my proj"');
		expect(sdkYaml).toContain("read-only: true");
		expect(renderDefinitions(cfg("rw")).sdkYaml).toContain("read-only: false");
		expect(renderDefinitions(cfg("rw", "lxd-vm")).workshopYaml).toContain('runtime: "lxd-vm"');
	});
});
