# pion

[![pion](https://snapcraft.io/pion/badge.svg)](https://snapcraft.io/pion)

A [pi](https://github.com/earendil-works/pi) extension that runs the agent's tools inside a
per-project sandbox instead of on your host. Two backends are available:

- **`lxd`** runs a plain LXD virtual machine that pion creates and manages itself.
- **`workshop`** uses [Canonical Workshop](https://github.com/canonical/workshop), which
  creates the LXD container (or VM) and installs SDKs such as Go or uv into it.

When a project is configured, pi's built-in `read`, `write`, `edit`, `bash`, `ls`, `find` and
`grep` tools, and your `!` shell commands, execute inside the sandbox. The project directory is
mounted into the sandbox **read-only** (default) or **writable**. Everything else the agent
sees, such as `/etc`, `$HOME` and installed packages, belongs to the sandbox.

Projects without configuration are untouched: the tools behave exactly like pi's built-ins.

## Install

### From the snap

1. Install pi from the pi-coding-agent snap, if you don't have it:

   ```bash
   sudo snap install pi-coding-agent --classic
   ```

2. Install a sandbox backend. You only need the one you plan to use:

   ```bash
   sudo snap install lxd && sudo lxd init --auto   # lxd backend
   sudo usermod -aG lxd "$USER"                    # then log out and back in
   sudo snap install workshop --classic            # workshop backend
   ```

3. Install pion:

   ```bash
   sudo snap install pion
   ```

4. Add the extension to pi:

   ```bash
   pi install /snap/pion/current/pi/extensions/pion
   ```

5. Check that pi loaded it. Start pi and run `/pion`. In a project you have not configured
   yet, it reports `Sandbox: off (tools run on the host)`.

pi records the path through the snap's `current` symlink, so you don't need to install it again
when the snap refreshes. Restart running pi sessions to pick up a new version.

To install a locally built snap instead of the store one, build it with `snapcraft pack` and use
`sudo snap install --dangerous ./pion_<version>_all.snap` in step 3.

To remove pion:

```bash
pi remove /snap/pion/current/pi/extensions/pion
sudo snap remove pion
```

Remove it from pi first. Otherwise pi keeps a stale entry for the removed path in `pi list`.

### From a checkout

```bash
pi install /path/to/pion          # or: pi -e /path/to/pion for one run
```

### Requirements

- **lxd backend:** the `lxc` CLI talking to an LXD server that can run VMs
  (`lxc launch --vm` works), and your user in the `lxd` group.
- **workshop backend:** the `workshop` CLI. Tested with workshop 0.9.9.

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
    "~/work/api": {
      "backend": "workshop",
      "mount": "rw",
      "workshop": { "sdks": ["go/1.26/stable", "uv"] }
    },
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
export PION_ENV_GOFLAGS=-mod=mod      # becomes GOFLAGS inside the sandbox
```

Or, for the workshop backend:

```bash
# .envrc
export PION_BACKEND=workshop
export PION_WORKSHOP_SDKS=go,uv/latest/stable
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
could reach outside the sandbox boundary, such as instance name, profiles, remote and raw LXD
config, are only honoured from your user config. pion reports any other `PION_*` variables it
ignored in `/pion status`.

### Options

| JSON (`pion.json`) | `.envrc` variable | Default | Meaning |
|---|---|---|---|
| `backend` | `PION_BACKEND` | `lxd` when configured | `lxd`, `workshop` or `none` |
| `mount` | `PION_MOUNT` | `ro` | `ro` or `rw` project mount |
| `guestPath` | `PION_GUEST_PATH` | same as host path | Where the project appears in the sandbox |
| `env` | `PION_ENV_<NAME>` | `{}` | Extra environment for commands in the sandbox |
| `setup` | `PION_SETUP` | `[]` | Commands run as root once, and again whenever they change |
| `installTools` | `PION_INSTALL_TOOLS` | `true` | Install ripgrep in the sandbox if missing |
| `sudo` | `PION_SUDO` | `true` | Passwordless sudo for the sandbox user |
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
| `workshop.base` | `PION_WORKSHOP_BASE` | `ubuntu@24.04` | `ubuntu@22.04`, `ubuntu@24.04` or `ubuntu@26.04` |
| `workshop.runtime` | `PION_WORKSHOP_RUNTIME` | `lxd-container` | `lxd-container` or the experimental `lxd-vm` |
| `workshop.sdks` | `PION_WORKSHOP_SDKS` | `[]` | Store SDKs, as `name`, `name/channel` or `{ "name", "channel" }`. In `.envrc`, comma-separated |
| `workshop.onExit` | `PION_WORKSHOP_ON_EXIT` | `stop` | `stop`, `keep` or `delete` (`workshop remove`) when pi quits |
| `workshop.name` | user config only | `pion-<dir>-<hash>` | Workshop name |
| `workshop.stateDir` | user config only | `$XDG_STATE_HOME/pion/workshop` | Where pion keeps its private workshop projects |
| `workshop.cli` | user config only | `workshop` | CLI binary |

Override for a single run with `pi --pion none`, which runs tools on the host. `--pion lxd` and
`--pion workshop` pick a backend, and `--pion ro` and `--pion rw` force the mount mode.

## What happens at startup: lxd

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

## What happens at startup: workshop

Workshop always mounts its own project directory read-write at `/project`. pion therefore does
not use your repository as the workshop project, because that would rule out read-only mounts
and put workshop's `.workshop.lock` file in your repository.

1. pion writes a private workshop project to
   `~/.local/state/pion/workshop/<name>/`. It holds a generated `workshop.yaml` with your base,
   runtime and SDKs, and an in-project SDK named `pion` with one mount plug.
2. It runs `workshop launch` the first time. Later it starts a stopped workshop, and runs
   `workshop refresh` when the generated definition changed, for example after switching
   between `ro` and `rw` or adding an SDK.
3. It points the plug at your project with `workshop remount`, stopping the workshop briefly
   because the directory is not empty. The remount survives refreshes and restarts.
4. It applies the `sudo` setting, then runs `installTools` and `setup`.

Commands run as workshop's own `workshop` user. Changing `workshop.runtime` after launch is
refused, because workshop fixes the runtime at launch. pion prints the `workshop remove`
command to run instead.

Inspect the workshop yourself with `workshop info -p ~/.local/state/pion/workshop/<name> <name>`.

## Shared behaviour

Startup runs in the background. Tools called before it finishes wait for it. The status line
shows progress, and `/pion` shows details.

When pi quits, the sandbox is stopped by default. A sandbox shared by several pi sessions keeps
running until the last one exits. Reloads and session switches leave it running.

## Commands

- `/pion` or `/pion status` shows the backend, mount, sandbox user and config sources.
- `/pion start` retries after a failed start.
- `/pion stop` stops the sandbox. The next tool call starts it again.

## Security notes

- **Read-only is enforced outside the guest.** LXD's virtiofs share refuses writes even if
  root in the VM remounts it, verified on LXD 6.10. Workshop's read-only mount plug refuses
  writes and remounts by root in the container, verified on workshop 0.9.9.
- **Host environment is not forwarded.** Commands in the sandbox get only `PI_*` session variables
  plus the `env` you configure. Provider API keys in pi's environment stay on the host.
- **pi itself still runs on the host.** Other extensions' tools, MCP servers, and pi's
  resource loading are not sandboxed.
- **The read tool may read pi skills and docs from the host.** The system prompt points the
  model at these files, and they do not exist in the VM. Reads are limited to the loaded
  skills' directories and pi's own docs.
- **A writable mount is a real write path to your host.** In an LXD VM, root, for example via
  `sudo`, creates root-owned files there. Set `"sudo": false` to prevent that. In a workshop
  container, root's files appear on the host as an unprivileged mapped uid instead.
- **`"sudo": false` on workshop** adds a sudoers rule that denies the `workshop` user running
  commands as anyone else. Workshop grants that sudo itself, so pion overrides it on every start.
- **Tool failures never fall back to the host.** If the sandbox is configured but broken,
  tools fail until you fix it or run `pi --pion none`.

## Limitations

- **Remote LXD servers:** the mount source is a path on the LXD server, so a remote only works
  when the project exists at the same path there.
- **`find` lists files only:** directories are not included.
- **grep without ripgrep:** pion falls back to GNU grep `-P`, then `-E`, which does not
  respect `.gitignore`.
- **Latency:** each file operation is one `lxc exec` or `workshop exec`, about 100 to 130 ms.
  `ls` uses a single exec.
- **Workshop refreshes are slow and reset the root filesystem.** A refresh takes about 20
  seconds, and `installTools` and `setup` run again afterwards.
- **Workshop in-project SDKs are not supported.** pion's workshop runs from its own private
  project, so `project-*` SDKs from your repository's `.workshop/` directory cannot resolve.
  Your repository's own `workshop.yaml` is ignored.
- **Workshop's user is uid 1000.** Host ownership of written files was verified with a host
  uid of 1000.

## Adding a backend

Backends implement `SandboxBackend` in `src/backend.ts`: `start`, `exec`, `shutdown` and `stop`.
All tool behaviour in `src/ops.ts` is built on `exec`. `src/shared.ts` has the session
accounting, provisioning steps and killable exec client that both backends use. Add the backend
to `createBackend` in `src/index.ts` and give it a `backend` value in `src/config.ts`.

## Development

```bash
npm install
npm run check        # type-check
npm test             # unit tests; shell scripts run against a local exec double
npm run test:lxd       # end-to-end: creates and deletes a real LXD VM
npm run test:workshop  # end-to-end: launches and removes real workshops
snapcraft pack         # builds pion_<version>_all.snap; runs the type-check and unit tests
```
