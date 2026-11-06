/** Minimal glob matching for find/grep filters: `**`, `*`, `?`, `[...]`, `{a,b}`. */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
	const cached = cache.get(glob);
	if (cached) return cached;
	let re = "";
	let braceDepth = 0;
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const atStart = i === 0 || glob[i - 1] === "/";
				const next = glob[i + 2];
				if (atStart && next === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else if (atStart && next === undefined) {
					re += ".*";
					i += 1;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else if (ch === "[") {
			const end = glob.indexOf("]", i + 2);
			if (end < 0) {
				re += "\\[";
				continue;
			}
			let cls = glob.slice(i + 1, end);
			if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
			re += `[${cls.replace(/\\/g, "\\\\")}]`;
			i = end;
		} else if (ch === "{") {
			braceDepth++;
			re += "(?:";
		} else if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			re += ")";
		} else if (ch === "," && braceDepth > 0) {
			re += "|";
		} else if (ch === "\\" && i + 1 < glob.length) {
			re += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
			i++;
		} else {
			re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
		}
	}
	while (braceDepth-- > 0) re += ")";
	const compiled = new RegExp(`^${re}$`);
	cache.set(glob, compiled);
	return compiled;
}

/**
 * Match a path relative to the search root the way pi's find/grep tools do: a pattern
 * without `/` matches the basename at any depth; a pattern with `/` matches the whole
 * relative path, optionally preceded by any directories.
 */
export function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const p = pattern.replace(/^\.\//, "");
	if (p.includes("/")) {
		return globToRegExp(p).test(relativePath) || globToRegExp(`**/${p}`).test(relativePath);
	}
	const base = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	return globToRegExp(p).test(base);
}
