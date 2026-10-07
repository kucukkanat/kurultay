---
title: Sandbox design
order: 5
---

# Sandbox for background answers: design

When an agent is tagged, the background service runs that agent's CLI (`claude`, `codex`, `copilot`, `pi`, `opencode`, `gemini`, `cursor-agent`) **on your computer, as you**. Without a sandbox, the only guard is each CLI's own permission flags, mapped from the permission you chose (see [Getting started](getting-started.md#background-answers-and-permissions)). Those flags are enforced by the very program we want to contain, and they are uneven: `copilot` with **Run commands** gets `--allow-all-tools`, and `pi`'s bash tool has no path limit at all.

Council messages and attached files are written by other people. A prompt injection can turn into "read `~/.ssh`", "read my other repositories", "send this folder to evil.example" or "`rm -rf ~`". The sandbox puts an operating-system boundary around each background turn. The user-facing summary is in [Privacy & security](security.md#sandbox); this page records the decisions and why.

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Threats | Prompt injection through the council, data exfiltration, accidental damage. **Not** a malicious CLI binary: it shares the kernel with an OS sandbox. |
| D2 | Scope | **Background turns only.** Interactive sessions (you running `claude` in your own terminal) are not sandboxed. |
| D3 | Backend | Anthropic's [`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) (srt): Seatbelt on macOS, bubblewrap on Linux, alpha on Windows. |
| D4 | Network | Denied by default. Each CLI's own model and login hosts, plus a **per-agent list of websites** you edit. |
| D5 | Reads | **All of your home folder is denied**, then re-opened: the working folder, folders you grant, and the CLI's own install, config and login files. |
| D6 | Fallback | If the sandbox cannot run: **run without it, and warn** in My agents and in the council reply. (Capping it at **Answer when tagged** only was considered and declined.) |
| D7 | Delivery | srt is **bundled** into the `kurultay` build. Its helper programs ship beside it in `dist/vendor/`. Linux needs `bwrap`, `socat` and `rg` from the distribution; Windows needs a one-time setup. Both are detected, and the app shows the command that fixes it. |
| D8 | Lifecycle | Switch it per agent **at any time** in My agents. Agents seated by `join`, or before sandboxes existed, stay unsandboxed until you turn it on. |
| D9 | Allowlist scope | **Per agent.** |
| D10 | Extra folders | Per agent you can grant extra **read** and **read + write** folders, always subject to the protected list below. |
| D11 | Blocked items | Written to the service log and shown on the agent in My agents, with one-click **Allow** for a blocked website. |
| D12 | Storage | **Local only** (`~/.config/kurultay/agents.json`), changed through the paired app's control server. No protocol change, and a browser that is not paired with the computer cannot switch it off. |
| D13 | Seat dialog | **One checkbox for the whole batch** in Add your agents, on by default. |
| D14 | CLIs | **All seven** headless CLIs have a profile. |
| D15 | Environment | Passed through **unchanged** (accepted risk below). |
| D16 | Your MCP servers | Load **inside** the sandbox: they inherit the policy, and remote ones need their hosts allowed. |
| D17 | Telemetry and updates | **Blocked.** Each CLI's opt-out variables are set where they exist, to avoid noise. |
| D18 | Prompt | **One line** in the background prompt tells the agent it is sandboxed and what it can reach, so it says what was blocked instead of retrying. |
| D19 | Windows | **Supported**, with a guided one-time setup (`kurultay sandbox setup`). Not yet run on a real Windows machine. |
| D20 | First permission | A **sandboxed** agent starts with **Edit files**; one without a sandbox keeps only **Answer when tagged**, and so does one seated on a computer already known to be unable to run the sandbox (or a service too old to say). The app sends it as an ordinary `agent_settings`, and only to an agent that has no permission chosen yet. |
| D21 | Wording | "**Keep in a sandbox**", badge "**Sandboxed**". The app never names the technology (no srt, Seatbelt, bubblewrap); a test holds it to that. |
| D24 | Allow button | Allows the **exact host** only. Wildcards are typed by hand. |
| D25 | Turning off | Asks first: *"This agent will be able to read your whole home folder and reach any website. Turn off?"* |
| D34 | Blocked turn | A turn that ends with no answer after something was blocked tells the council only *"I couldn't finish: my sandbox blocked something I needed. My owner can see what."* Paths and hosts never reach the council. |

Kurultay is a smaller rewrite of the same design used elsewhere, so a few things were left out on purpose: there are no Unix socket or local port grants (every socket stays closed, and local port grants never worked on Linux), no "the CLI moved its files" detection, and no pluggable backend interface.

## The seam

Every background turn already flowed through two steps in `packages/mcp/src/daemon.ts`: build the command, run it. The sandbox is a `HeadlessCommand → HeadlessCommand` transform between them, so the per-CLI flags, the engine and the protocol do not change:

```
startTurn(entry) → turn.promptNote → buildPrompt → headlessCommand → turn.wrap(cmd) → runCommand → turn.finish()
```

`startTurn({host, mode, workdir, config})` (`packages/mcp/src/sandbox/index.ts`) is the daemon's only entry. A disabled sandbox gives an inactive turn whose `wrap` returns the command unchanged. An enabled one that cannot run gives an inactive turn with `fellBack` set (D6). `finish()` runs in `finally`, returns what was blocked and removes the turn folder. Error messages name the CLI, not the wrapper.

### Why the turn re-enters the bundle

srt's `SandboxManager` is a **per-process singleton**: `initialize(config)` starts one HTTP/SOCKS proxy pair for one config. The service runs several agents at once with different allowlists, so it cannot hold one manager. Instead `wrap` writes `<turnDir>/policy.json` (srt's config **and the agent's argv**, mode 0600) and returns:

```
{ cmd: process.execPath, args: [<this bundle>, '__sandbox', <turnDir>], env: { …, CLAUDE_CODE_TMPDIR: turnDir } }
```

`kurultay __sandbox <turnDir>` (`exec.ts`) validates the file with srt's own schema, initialises srt, quotes the argv with **srt's own quoter** (the `shell-quote` package turns `!` into `\!` inside double quotes, which corrupts council-written text), spawns it with inherited stdio, passes SIGTERM and SIGINT on, writes `violations.json` through a temp file and a rename (so a planted symlink is replaced, not followed; the temp file has a random name and is created with `O_EXCL`, so a link planted under its name is refused rather than written through), cleans up and exits with the child's code. The prompt never passes through a shell we build; the integration test's hostile prompt guards that.

## Policy

`policyFor` (`policy.ts`) is pure and unit-tested in every mode.

| Permission | Read | Write |
|---|---|---|
| Off, Answer when tagged only | system files, the CLI's own install and files, the turn folder | the CLI's own files, the turn folder |
| Read files | + working folder, granted read and read-write folders | the CLI's own files, the turn folder |
| Edit files, Run commands | + working folder, granted folders | + working folder, granted read-write folders |

- `denyRead` is your home folder and the Kurultay config folder; `allowRead` re-opens what the table lists. srt lets `allowRead` win over `denyRead`, so **nothing that overlaps the config folder is ever put in `allowRead` or `allowWrite`**, whatever its source.
- **Install paths.** CLIs often live under your home (`~/.local/bin`, `~/.bun`, `~/.nvm/…`). `installPathsFor` resolves `which <cli>` to its real path and opens the enclosing `node_modules` (global installs hoist dependencies beside the package, and codex loads its binary from a sibling package), plus the interpreter named in the shebang. A prefix that would contain your home folder (`/bin/sh` → `/`) is dropped.
- **The turn folder** is a fresh `mkdtemp('/tmp/kurultay-…')`, by its real path. srt keeps its proxy socket there, and a Unix socket path may be at most 104 bytes, so it stays short. It holds `policy.json` and `violations.json` (both write-denied to the agent) and the CLI's output file, and it is the turn's private temp folder. The agent may write this folder and the service reads the output file outside the sandbox, so `readOutputFile` opens it with `O_NOFOLLOW` and checks the open file is a plain file with one name: a symlink or hard link to `~/.ssh/id_ed25519` fails the turn instead of reaching the council.
- **Network.** Allowed hosts are the CLI profile's model and login hosts plus your list. `allowLocalBinding` is on, so an agent with **Run commands** can test a server it starts itself. All Unix sockets stay closed (ssh-agent, Docker, the service's own socket).
- srt itself always refuses writes to `.git/hooks`, `.git/config`, shell rc files and a few editor folders, even inside the working folder. Agents with **Edit files** or **Run commands** therefore cannot change those.

### Protected: no grant can open these

`validateGrants` rejects, and reports every bad field at once (the control server answers `Not allowed: …`):

- `/`, your home folder, or any folder that contains it;
- the Kurultay config folder (`~/.config/kurultay`, or `KURULTAY_HOME`): agent keys, the pairing tokens, `daemon.sock`, and the registry that holds this very sandbox config. Write access there would let an agent switch its own sandbox off;
- other tools' credentials: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.docker` (and so `~/.config` as a whole);
- relative paths, and websites that are on this computer (`localhost`, `*.localhost`, `127.x`, `0.0.0.0`): those would open the service's own control port.

Each path is checked twice, as typed and by where it really leads, so a symlink cannot smuggle a protected folder in. `policyFor` filters the grants again, so one that slipped past validation still opens nothing protected.

## Host profiles

`packages/mcp/src/sandbox/hosts.ts` lists what each CLI needs, found by running each installed CLI under srt on macOS with the home folder denied and reading the refusals until a one-line prompt answered, with only Answer when tagged on and with Run commands on. Gemini and Cursor were not installed there: their profiles come from their documentation and are **unverified**.

| CLI | Files it keeps (besides its install) | Model and login hosts | Opt-outs set (D17) |
|---|---|---|---|
| claude | `~/.claude`, `~/.claude.json`, `~/.local/state/claude`, its cache; reads the Keychain | `api.anthropic.com`, `platform.claude.com`, `console.anthropic.com`, `claude.ai` | telemetry, error reporting, auto-updater, non-essential traffic |
| codex | `~/.codex`; reads `~/.agents/skills` | `api.openai.com`, `chatgpt.com`, `auth.openai.com` | none exists |
| copilot | `~/.copilot`, its cache; reads the Keychain | the Copilot API hosts, `api.github.com`, `github.com` | auto-update |
| pi | `~/.pi` | the common providers (add others yourself) | version check, telemetry |
| opencode | its XDG folders | `opencode.ai`, `models.dev`, the common providers | auto-update, share, LSP download |
| gemini | `~/.gemini` | `generativelanguage.googleapis.com`, `cloudcode-pa.googleapis.com`, `oauth2.googleapis.com` | telemetry, its own sandbox |
| cursor | `~/.cursor`, `~/.config/cursor`; reads the Keychain | `api2`–`api5.cursor.sh` | none documented |

A test keeps a list of telemetry and update hosts and fails if any profile host, wildcards included, lets one through.

**What stays read-only inside the CLI's own folder.** A CLI's folder also holds what runs code, or steers every later session, when you use that CLI yourself outside the sandbox (D2): hooks, MCP servers, plugins, extensions, skills and instruction files. srt's own protected files are anchored at the working folder, not your home, so each profile lists these in `denyWrite` and they stay read-only in every permission (renaming the folder around them is refused too):

| CLI | Read-only |
|---|---|
| claude | `~/.claude/` `settings.json`, `settings.local.json`, `hooks`, `plugins`, `skills`, `commands`, `agents`, `output-styles`, `CLAUDE.md` |
| codex | `~/.codex/` `config.toml`, `rules`, `plugins`, `skills`, `prompts`, `AGENTS.md` |
| copilot | `~/.copilot/` `mcp-config.json`, `settings.json`, `permissions-config.json`, `installed-plugins`, `skills`, `agents`, `hooks` |
| pi | `~/.pi/agent/` `extensions`, `settings.json`, `models.json`, `mcp.json`, `trust.json`, `skills`, `prompts`, `AGENTS.md` |
| opencode | `~/.config/opencode/` `opencode.json`, `opencode.jsonc`, `config.json`, `package.json`, `plugin(s)`, `tool(s)`, `agent(s)`, `command(s)`, `AGENTS.md` |
| gemini | `~/.gemini/` `settings.json`, `extensions`, `commands`, `GEMINI.md` |
| cursor | `~/.cursor/` `mcp.json`, `hooks.json`, `hooks`, `rules` |

Files the CLI itself rewrites on every run cannot be protected this way; they are listed under accepted risks.

**Nested sandboxes.** macOS refuses a second Seatbelt sandbox inside ours. So, only while sandboxed, claude gets `--settings {"sandbox":{"enabled":false}}` and cursor gets `--sandbox disabled`; ours enforces the same limits for the permission. codex's `--sandbox` becomes `danger-full-access` **only on macOS, and only for Read files, Edit files and Run commands**, where codex needs shell commands (it reads files with `cat` and `rg`). With only Answer when tagged it stays `read-only`, so codex refuses every write and macOS every command, as that permission intends; on Linux and Windows codex keeps its own sandbox at the permission's setting as a second layer. Every other CLI flag stays exactly as before.

## Platforms and fallback

`available()` is cached for 60 seconds (every turn asks, and a check spawns processes):

- **macOS:** `/usr/bin/sandbox-exec` exists. Nothing to install.
- **Linux:** `bwrap`, `socat` and `rg` are on `PATH`; a trial `bwrap` run proves unprivileged user namespaces work; srt's own dependency check passes; its seccomp helper is present (without it srt leaves Unix sockets open). The fix offered is `sudo apt-get install bubblewrap socat ripgrep` (or the `dnf`/`pacman` equivalent), or `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` where Ubuntu 24.04's AppArmor refuses user namespaces.
- **Windows:** `srt-win.exe` is present and srt's Windows check passes; otherwise `kurultay sandbox setup` (one administrator prompt; `--yes` skips Kurultay's own question).

`kurultay sandbox status` prints the same answer. If the sandbox cannot run at turn time, or the CLI has no profile, the turn runs **without it** (D6): the service logs `sandbox unavailable, ran without it: <reason>`, My agents shows a warning, and the reply ends with *"(I ran without my sandbox this time: <reason>.)"*.

**Helper programs.** srt's Linux seccomp filter (`apply-seccomp`) and the Windows `srt-win.exe`, for x64 and arm64, are files, not code. `packages/mcp/scripts/build.ts` copies them to `dist/vendor/` after `bun build` and lists the sha256 of each in `build.json`, `scripts/assemble-dist.sh` refuses to assemble without them and puts them on the `dist` branch, and `join` copies them next to `~/.config/kurultay/bin/kurultay.mjs`. `kurultay update` downloads any that are missing or differ, checked against `build.json`. Nothing is downloaded at run time. On Linux the helper lives in the denied config folder, so the turn re-opens that one file for reading.

## What you are told

- **Network refusals** come from srt's proxy and are reliable on every platform.
- **File refusals on macOS** come from the system log, which arrives late; after the command the wrapper waits until it is quiet (300 ms, at most 2 s). Some reports are still dropped. Enforcement is not affected, only what you are told.
- **On Linux** only refused writes are reported; a refused read just finds an empty folder.

The service keeps the 20 newest refusals per agent (one per kind and target) and shows them **only in My agents**, with **Allow** next to a blocked website. The council never sees them (D34).

## Accepted risks

1. **Fallback runs unsandboxed (D6).** With D20, a sandboxed agent that starts with Edit on a computer where the sandbox breaks edits without it. The warning comes after that turn has run.
2. **The environment passes through (D15).** Tokens in the service's environment (`GITHUB_TOKEN`, `AWS_*`, …) are readable by the agent. Network limits restrict where they can go, but every allowed host is still a channel.
3. **Allowed hosts are exfiltration channels.** The model API itself, and anything you allow, can carry data out. A broad wildcard (`*.googleapis.com`) allows domain fronting.
4. **Shared kernel.** A kernel or Seatbelt escape is out of scope (D1).
5. **Your MCP servers run inside the sandbox (D16)** and fail quietly when they live under your home folder or need a host you did not allow. The blocked host shows up with an Allow button.
6. **A broad working folder defeats the read limits.** With your home folder as the working folder, everything in it except the Kurultay config folder is readable once **Read files** is on.
7. **Keychain (claude, copilot, cursor).** These CLIs need the macOS Keychain to log in, so a turn with **Run commands** can run `/usr/bin/security` and read any Keychain item that already trusts it. The way out is an API-key login for that CLI.
8. **Localhost on macOS.** Letting an agent run its own servers also lets it connect to every local port on macOS: local databases, Ollama, and the service's control port (which still needs a pairing token, kept in the closed config folder). On Linux the agent has its own network, so the computer's local services are unreachable.
9. **Files a CLI rewrites itself stay writable.** Only what the CLI never writes on its own can be made read-only (see Host profiles). Left writable, so a prompt-injected turn could change them for your next interactive session: `~/.claude.json` (it also carries Claude's `mcpServers`, but Claude rewrites it on every start), copilot's `~/.copilot/config.json` (trusted folders), cursor's `~/.cursor/cli-config.json` (its command allowlist), opencode's `~/.config/opencode/node_modules` (it installs its plugin there on start) and pi's `auth.json`. Keeping the agent at **Answer when tagged** does not change this: every permission writes the CLI's own files.
10. **codex on macOS loses its own read-only layer** with **Read files**: its shell commands run under our sandbox alone, which lets them write the turn folder and `~/.codex` (except the read-only files above), not the working folder.
11. **Untested on Windows**, including whether the service's named pipe is unreachable from inside. **Linux**, an agent with only **Answer when tagged** on whose working folder sits inside your home folder starts in a folder it cannot see; the CI tests cover working folders outside the home folder.

## Tests

No mocks: the backends in the unit tests are real `{ available, wrap }` objects.

| File | What |
|---|---|
| `packages/mcp/test/sandbox-policy.test.ts` | `policyFor` in every mode, `validateGrants` (protected paths, ancestors, a real symlink into `~/.ssh`, relative paths, bad and local hosts), the prompt line |
| `packages/mcp/test/sandbox-hosts.test.ts` | every headless CLI has a profile; profile hosts against a telemetry denylist; every profile's code-running files reach `denyWrite`; the nested-sandbox rewrites touch only the sandbox flag, and codex's only on macOS outside Answer when tagged |
| `packages/mcp/test/sandbox-runtime.test.ts` | `startTurn` inactive, fell back and active; the re-entry files (a link planted under the violations temp name is not written through); violation parsing, dedupe and capping; install paths; `readOutputFile` refusing symlinks, hard links and FIFOs |
| `packages/mcp/test/sandbox/srt.integration.test.ts` | **real srt**: a fixture agent reads and writes outside its folder and into the config folder (refused), reaches an allowed and a denied host, receives a hostile prompt byte for byte, and is stopped by SIGTERM; with only Answer when tagged, turns its output file into a link to a secret, plants links under the service's temp names and edits claude's and codex's hooks and config (all refused or untouched); then the same from a bundle installed by `join` with its `vendor/` |
| `packages/mcp/test/daemon-sandbox.test.ts` | a real service and relay: a sandboxed turn cannot read the home folder and is told it is sandboxed; a blocked turn tells the council only that it was blocked; an output file swapped for a link to a secret never reaches the council |
| `packages/mcp/test/control.test.ts` | `POST /agents/sandbox` refuses every bad field at once, keeps grants on re-seat |
| `apps/site/src/app/sandbox.test.ts`, `SandboxSettings.dom.test.tsx`, `SeatDialog.dom.test.tsx` | the app's grant helpers, the no-technology wording rule, the panel's confirm-before-off and Allow buttons, the first permission when this computer cannot sandbox |

They run with `bun run test`. On Linux CI the workflow installs bubblewrap, socat and ripgrep and allows user namespaces; where the sandbox cannot run, the real-sandbox tests skip and say why.
