/**
 * The contract every sandbox backend implements. Tool operations are built only on
 * `exec`, so a new backend (container, SSH host, another hypervisor) needs to provide
 * lifecycle plus process execution and nothing else.
 */

export interface ExecOptions {
	/** Working directory inside the sandbox. */
	cwd?: string;
	/** Extra environment for the process. Host environment is never forwarded implicitly. */
	env?: Record<string, string>;
	/** Data written to the process's stdin, which is then closed. */
	stdin?: Buffer | string;
	signal?: AbortSignal;
	/** Kill the process after this many milliseconds. */
	timeoutMs?: number;
	/** Stream stdout. When set, stdout is not collected in the result. */
	onStdout?: (data: Buffer) => void;
	/** Stream stderr. When set, stderr is not collected in the result. */
	onStderr?: (data: Buffer) => void;
	/** Run as root instead of the sandbox user. */
	asRoot?: boolean;
}

export interface ExecResult {
	/** Exit status, or 128 + signal number, or null when unknown. */
	exitCode: number | null;
	stdout: Buffer;
	stderr: Buffer;
	timedOut: boolean;
	aborted: boolean;
}

export interface BackendInfo {
	kind: string;
	/** Short label for the status line. */
	label: string;
	/** Multi-line description for the status command. */
	details: string[];
	/** Absolute path of a bash (or sh) binary in the guest. */
	shell: string;
	/** Whether ripgrep is available in the guest. */
	hasRipgrep: boolean;
}

export type Progress = (message: string) => void;

export interface SandboxBackend {
	/** Create/start/provision the sandbox. Must be safe to call again after a failure. */
	start(progress: Progress): Promise<BackendInfo>;
	exec(argv: string[], options?: ExecOptions): Promise<ExecResult>;
	/**
	 * Release the sandbox. On "quit" the backend applies its exit policy without blocking
	 * process exit; on "switch" (reload, new or resumed session) it keeps the sandbox for the
	 * replacement runtime. Idempotent.
	 */
	shutdown(progress: Progress, reason: "quit" | "switch"): Promise<void>;
	/** Stop the sandbox now regardless of policy. */
	stop(): Promise<void>;
}

export class ExecError extends Error {
	constructor(
		message: string,
		readonly result: ExecResult,
	) {
		super(message);
	}
}

/** Run and require exit status 0. */
export async function execOk(backend: SandboxBackend, argv: string[], options?: ExecOptions): Promise<ExecResult> {
	const result = await backend.exec(argv, options);
	if (result.aborted) throw new Error("Operation aborted");
	if (result.timedOut) throw new Error("Operation timed out");
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString("utf8").trim();
		throw new ExecError(stderr || `${argv[0]} exited with status ${result.exitCode}`, result);
	}
	return result;
}

/** Quote a string for POSIX sh. */
export function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
