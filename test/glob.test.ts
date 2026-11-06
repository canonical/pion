import { describe, expect, it } from "vitest";
import { matchesToolGlob } from "../src/glob.ts";

describe("matchesToolGlob", () => {
	it.each([
		["src/a.ts", "*.ts", true],
		["src/a.tsx", "*.ts", false],
		["a.ts", "**/*.ts", true],
		["src/deep/a.spec.ts", "**/*.spec.ts", true],
		["src/deep/a.ts", "src/*.ts", false],
		["src/deep/a.ts", "src/**/*.ts", true],
		["x/src/a.ts", "src/*.ts", true],
		["README.md", "*.{md,txt}", true],
		["a.txt", "?.txt", true],
		["ab.txt", "?.txt", false],
		["file1", "file[0-9]", true],
		["filex", "file[!x]", false],
		["a.b", "a.b", true],
		["axb", "a.b", false],
	])("%s vs %s", (p, g, want) => {
		expect(matchesToolGlob(p, g)).toBe(want);
	});
});
