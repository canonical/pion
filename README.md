# pion

A [pi](https://github.com/earendil-works/pi) extension that runs the agent's tools inside a
per-project sandbox instead of on your host. The first backend is **LXD virtual machines**.

When a project is configured, pi's built-in `read`, `write`, `edit`, `bash`, `ls`, `find` and
`grep` tools, and your `!` shell commands, execute inside a VM. The project directory is
mounted into the VM **read-only** (default) or **writable**. Everything else the agent sees,
such as `/etc`, `$HOME` and installed packages, belongs to the VM.

Projects without configuration are untouched: the tools behave exactly like pi's built-ins.

## Install

```bash
pi install /path/to/pion          # or: pi -e /path/to/pion for one run
```

Requirements: the `lxc` CLI talking to an LXD server that can run VMs (`lxc launch --vm` works),
and your user in the `lxd` group.

## Configure a project

Configuration comes from two places. Either is enough to turn the sandbox on for a project.

### 1. Your user config, matched by project path

`$XDG_CONFIG_HOME/pi/pion.json` (usually `~/.config/pi/pion.json`):

```json
{
  "defaults": {
    "lxd": { "image": "ubuntu:24.04", "cpus": 4, "memory": "8GiB" }
  },
  "projects": {
    "~/work/pion": { "mount": "rw" },
    "~/src/untrusted/*": { "mount": "ro", "lxd": { "onExit": "delete" } },
    "/srv/build": { "backend": "none" }
  }
}
```

- A key names a project directory. It matches that directory and anything below it. The
  matched directory is what gets mounted.
- A key ending in `/*` makes each direct child of that directory its own project.
- The deepest match wins. For the same directory, an exact key beats a `/*` key.
- `defaults` fill in values for every project but do not turn the sandbox on by themselves.

### 2. `.envrc` in the project

```bash
# .envrc
export PION_MOUNT=rw
export PION_LXD_IMAGE=ubuntu:24.04
export PION_LXD_MEMORY=4GiB
export PION_SETUP="apt-get install -y build-essential"
export PION_ENV_GOFLAGS=-mod=mod      # becomes GOFLAGS inside the VM
```

The directory containing `.envrc` is the project that gets mounted. pion reads these variables
in one of two ways:

- **direnv loaded them.** pion uses the environment pi was started with, and `DIRENV_DIR`
  names the project root. This follows direnv's own `direnv allow` trust.
- **direnv is not in use.** pion reads literal `export KEY=value` lines from the nearest
  `.envrc` without executing it. It only does this when pi trusts the project, either from a
  trust prompt or `pi --approve`. Lines that need a shell, such as `$VAR` or `$(...)`, are
  ignored.

### Precedence

Lowest to highest: built-in defaults, user `defaults`, `.envrc` or environment, then the user
`projects` entry. Your own per-path config always wins over what a repository ships.

A repository's `.envrc` may only set the options in the table marked "envrc". Settings that
could reach outside the VM boundary, such as instance name, profiles, remote and raw LXD
config, are only honoured from your user config. pion reports any other `PION_*` variables it
ignored in `/pion status`.

### Options

| JSON (`pion.json`) | `.envrc` variable | Default | Meaning |
|---|---|---|---|
| `backend` | `PION_BACKEND` | `lxd` when configured | `lxd` or `none` |
| `mount` | `PION_MOUNT` | `ro` | `ro` or `rw` project mount |
| `guestPath` | `PION_GUEST_PATH` | same as host path | Where the project appears in the VM |
| `env` | `PION_ENV_<NAME>` | `{}` | Extra environment for commands in the VM |
| `setup` | `PION_SETUP` | `[]` | Commands run as root once, and again whenever they change |
| `installTools` | `PION_INSTALL_TOOLS` | `true` | Install ripgrep in the VM if missing |
| `sudo` | `PION_SUDO` | `true` | Passwordless sudo for the VM user |
| `lxd.image` | `PION_LXD_IMAGE` | `ubuntu:24.04` | Image for new VMs |
| `lxd.cpus` | `PION_LXD_CPUS` | LXD default | `limits.cpu` |
| `lxd.memory` | `PION_LXD_MEMORY` | LXD default | `limits.memory` |
| `lxd.disk` | `PION_LXD_DISK` | LXD default | Root disk size |
| `lxd.onExit` | `PION_LXD_ON_EXIT` | `stop` | `stop`, `keep` or `delete` when pi quits |
| `lxd.instance` | user config only | `pion-<dir>-<hash>` | VM name |
| `lxd.profiles` | user config only | LXD default | Profiles for new VMs |
| `lxd.remote` | user config only | default remote | LXD remote name |
| `lxd.project` | user config only | current project | LXD project |
| `lxd.storagePool` | user config only | profile default | Storage pool for new VMs |
| `lxd.config` | user config only | `{}` | Extra instance config for new VMs |
| `lxd.lxc` | user config only | `lxc` | CLI binary |

Override for a single run with `pi --pion none`, which runs tools on the host. `--pion ro` and
`--pion rw` force the mount mode.

## What happens at startup

1. pion resolves the config for pi's working directory. The sandbox is off if nothing matches.
2. It creates the VM if needed. The VM is tagged `user.pion.managed=true` and records its
   project path. pion refuses to touch an existing instance without that tag, or one tagged
   for another project.
3. It attaches the project as a virtiofs disk device named `pion-project`. If you changed
   `mount` since last time, it updates the device on the running VM.
4. It starts the VM and waits for the LXD agent, the mount, and cloud-init if the image uses it.
5. It finds or creates a VM user with **your host uid**, so files written to a writable mount
   stay owned by you on the host. On Ubuntu images that is the built-in `ubuntu` user.
6. It runs `installTools` and `setup` the first time, and again after they change.

Startup runs in the background. Tools called before it finishes wait for it. The status line
shows progress, and `/pion` shows details.

When pi quits, the VM is stopped by default. A VM shared by several pi sessions keeps running
until the last one exits. Reloads and session switches leave it running.

## Commands

- `/pion` or `/pion status` shows the backend, mount, VM user and config sources.
- `/pion start` retries after a failed start.
- `/pion stop` stops the VM. The next tool call starts it again.

## Security notes

- **Read-only is enforced by the host.** LXD's virtiofs share refuses writes even if root in
  the VM remounts it. This was verified on LXD 6.10.
- **Host environment is not forwarded.** Commands in the VM get only `PI_*` session variables
  plus the `env` you configure. Provider API keys in pi's environment stay on the host.
- **pi itself still runs on the host.** Other extensions' tools, MCP servers, and pi's
  resource loading are not sandboxed.
- **The read tool may read pi skills and docs from the host.** The system prompt points the
  model at these files, and they do not exist in the VM. Reads are limited to the loaded
  skills' directories and pi's own docs.
- **A writable mount is a real write path to your host.** Root in the VM, for example via
  `sudo`, creates root-owned files there. Set `"sudo": false` to prevent that.
- **Tool failures never fall back to the host.** If the sandbox is configured but broken,
  tools fail until you fix it or run `pi --pion none`.

## Limitations

- **Remote LXD servers:** the mount source is a path on the LXD server, so a remote only works
  when the project exists at the same path there.
- **`find` lists files only:** directories are not included.
- **grep without ripgrep:** pion falls back to GNU grep `-P`, then `-E`, which does not
  respect `.gitignore`.
- **Latency:** each file operation is one `lxc exec`, about 100 ms. `ls` uses a single exec.

## Adding a backend

Backends implement `SandboxBackend` in `src/backend.ts`: `start`, `exec`, `shutdown` and `stop`.
All tool behaviour in `src/ops.ts` is built on `exec`. Add the backend to `createBackend` in
`src/index.ts` and give it a `backend` value in `src/config.ts`.

## Development

```bash
npm install
npm run check        # type-check
npm test             # unit tests; shell scripts run against a local exec double
npm run test:lxd     # end-to-end: creates and deletes a real LXD VM
```
