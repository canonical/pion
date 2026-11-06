import path from "node:path";
import { isInsideOrEqual } from "./config.ts";

/** Maps host paths under the project to their location inside the sandbox. */
export class PathMap {
	constructor(
		readonly projectDir: string,
		readonly guestPath: string,
	) {}

	get identity(): boolean {
		return this.projectDir === this.guestPath;
	}

	/** Host path → guest path. Paths outside the project are taken to be guest paths already. */
	toGuest(p: string): string {
		const trimmed = p.startsWith("@") ? p.slice(1) : p;
		const abs = path.resolve(trimmed);
		if (this.identity) return abs;
		if (isInsideOrEqual(this.projectDir, abs)) {
			const rel = path.relative(this.projectDir, abs);
			return rel ? path.posix.join(this.guestPath, rel.split(path.sep).join("/")) : this.guestPath;
		}
		return abs;
	}

	/** Whether a host path lies in the mounted project. */
	inProject(p: string): boolean {
		return isInsideOrEqual(this.projectDir, path.resolve(p));
	}
}
