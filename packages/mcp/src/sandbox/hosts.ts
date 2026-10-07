import type { HostProfile } from './policy'

/**
 * What each agent CLI needs to run headless inside the sandbox (docs/sandbox.md, "Host profiles"). Found in a spike on
 * macOS (2026-10-06) by running each installed CLI under `srt` with `$HOME` read-denied and reading the Seatbelt and proxy
 * refusals until a one-line prompt answered, in Talk and in Full mode (a shell command in the working folder succeeding and
 * one outside it refused). Profiles name only the CLI's own state; where the CLI itself is installed comes from
 * `installPathsFor` (index.ts). Telemetry and update hosts are left out on purpose (D17): they are refused, and the
 * opt-out variables below keep the CLI from trying.
 */

/** The macOS Keychain. A CLI that keeps its login there runs `security`/SecItem, which reads the keychain files itself and asks securityd. */
const KEYCHAIN_FILES = '~/Library/Keychains'
const KEYCHAIN_SERVICE = 'com.apple.SecurityServer'

/** Skills the user installed for every agent (`npx skills add`): codex, copilot, pi and opencode all look here. Text only. */
const SHARED_SKILLS = '~/.agents/skills'

/** GitHub Copilot's model API: one host per plan. Listed one by one, because `*.githubcopilot.com` also lets telemetry through. */
const COPILOT_API = ['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com']

/** Claude Code's files that run code or steer later sessions (settings hold hooks, MCP servers and permissions). */
const CLAUDE_DENY = ['settings.json', 'settings.local.json', 'hooks', 'plugins', 'skills', 'commands', 'agents', 'output-styles', 'CLAUDE.md'].map((f) => `~/.claude/${f}`)

/** Common providers for the multi-provider CLIs (pi, opencode). Owners add any other one in the agent's allowed websites. */
const COMMON_PROVIDERS = ['api.anthropic.com', 'api.openai.com', ...COPILOT_API, 'api.github.com']

/** Replace the value after the first `flag` (the builder puts it before the prompt, which may itself contain the flag). */
const replaceAfter = (args: readonly string[], flag: string, value: string): string[] => {
  const at = args.indexOf(flag)
  return at < 0 ? [...args] : args.map((a, i) => (i === at + 1 ? value : a))
}

export const HOST_PROFILES: Readonly<Record<string, HostProfile | undefined>> = {
  // verified: answered in Talk and Full, the Bash tool worked in the working folder and was refused outside it.
  claude: {
    // the OAuth login is in the Keychain: without the keychain files `security` cannot find it and the turn fails to log in
    readPaths: [KEYCHAIN_FILES],
    // ~/.local/state/claude holds the version lock; ~/Library/Caches/claude-cli-nodejs the per-project cache
    // (~/.cache/claude-cli-nodejs on Linux, unverified)
    writePaths: ['~/.claude', '~/.claude.json', '~/.local/state/claude', '~/Library/Caches/claude-cli-nodejs', '~/.cache/claude-cli-nodejs'],
    // hooks and plugins run code; skills, commands, agents and CLAUDE.md steer every later session. ~/.claude.json also
    // carries mcpServers, but Claude rewrites it on every start: it stays writable (docs/sandbox.md, accepted risks)
    denyWrite: CLAUDE_DENY,
    // only api.anthropic.com was used with a fresh token; the others refresh an expired OAuth login.
    // mcp-proxy.anthropic.com (claude.ai connectors) is the owner's MCP servers (D16): allowed per agent, not here
    domains: ['api.anthropic.com', 'platform.claude.com', 'console.anthropic.com', 'claude.ai'],
    machLookup: [KEYCHAIN_SERVICE],
    env: {
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // Claude's tools keep their temp files in /tmp/claude-<uid>, which the sandbox refuses: the Bash tool then fails on
      // every call. /private/tmp/claude is the one temp folder srt always keeps writable (and it points TMPDIR there too)
      CLAUDE_CODE_TMPDIR: '/private/tmp/claude',
    },
    // Claude's own Bash sandbox (settings `sandbox.enabled`) is Seatbelt too: it cannot start inside ours, so Claude asks to
    // retry without it. Ours already sets the same limits, so turn it off for wrapped turns instead of losing a tool call
    nested: (args) => [...args, '--settings', '{"sandbox":{"enabled":false}}'],
  },

  // verified: answered in Talk and Full; with the rewrite below, shell commands ran in the working folder and were refused outside it.
  codex: {
    // ~/.cache/codex-runtimes holds the bundled plugins' marketplace; without it codex only logs a warning
    readPaths: [SHARED_SKILLS, '~/.cache/codex-runtimes'],
    // auth.json (ChatGPT login or API key), sessions, sqlite state and logs all live in CODEX_HOME
    writePaths: ['~/.codex'],
    // config.toml holds `notify` and MCP server commands; rules/ allows commands without asking
    denyWrite: ['~/.codex/config.toml', '~/.codex/rules', '~/.codex/plugins', '~/.codex/skills', '~/.codex/prompts', '~/.codex/AGENTS.md'],
    // ab.chatgpt.com (analytics) is refused; codex has no environment opt-out for it, only config.toml
    domains: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
    // On macOS `--sandbox read-only|workspace-write` runs commands under sandbox-exec, which cannot nest
    // (`forbidden-sandbox-reinit`): every shell command failed. Where the mode needs commands (reading files is `cat` and
    // `rg` for codex) ours enforces the mode's limits instead. Talk needs none, so it keeps read-only and its commands
    // fail, as they should; other platforms keep codex's own sandbox as a second layer (docs/sandbox.md, accepted risks)
    nested: (args, { mode, platform }) => (platform === 'darwin' && mode !== 'talk' && mode !== 'off' ? replaceAfter(args, '--sandbox', 'danger-full-access') : [...args]),
  },

  // verified: answered in Talk and Full, shell commands ran in the working folder and were refused outside it.
  copilot: {
    // the GitHub login is in the Keychain (otherwise it falls back to `gh`, whose folder stays closed)
    readPaths: [KEYCHAIN_FILES, SHARED_SKILLS],
    // the npm loader unpacks the native CLI into ~/Library/Caches/copilot/pkg on every version (~/.cache/copilot on Linux, unverified)
    writePaths: ['~/.copilot', '~/Library/Caches/copilot', '~/.cache/copilot'],
    // config.json (trusted folders, written by the CLI itself) stays writable: accepted risk
    denyWrite: ['~/.copilot/mcp-config.json', '~/.copilot/settings.json', '~/.copilot/permissions-config.json', '~/.copilot/installed-plugins', '~/.copilot/skills', '~/.copilot/agents', '~/.copilot/hooks'],
    // telemetry.enterprise.githubcopilot.com and cafe.github.com are refused, and it answers without them
    domains: [...COPILOT_API, 'api.github.com', 'github.com'],
    // trustd: without it every TLS connection logs "failed to copy trust settings of system certificate"
    machLookup: [KEYCHAIN_SERVICE, 'com.apple.trustd.agent'],
    // there is no telemetry switch short of COPILOT_OFFLINE, which also turns off the login
    env: { COPILOT_AUTO_UPDATE: 'false' },
  },

  // verified with the github-copilot provider: answered in Talk and Full; its bash tool has no sandbox of its own.
  pi: {
    readPaths: [SHARED_SKILLS],
    // ~/.pi/agent holds auth.json, settings, models and sessions
    writePaths: ['~/.pi'],
    // extensions are TypeScript pi loads; settings.json lists packages it installs and loads; models.json and mcp.json may
    // name commands. auth.json is refreshed by pi itself
    denyWrite: ['~/.pi/agent/extensions', '~/.pi/agent/settings.json', '~/.pi/agent/models.json', '~/.pi/agent/mcp.json', '~/.pi/agent/trust.json', '~/.pi/agent/skills', '~/.pi/agent/prompts', '~/.pi/agent/AGENTS.md'],
    // provider-dependent: the common providers; owners add any other one in the allowed websites
    domains: COMMON_PROVIDERS,
    // the version check goes to pi.dev; PI_OFFLINE would also stop it but freezes the model catalogue
    env: { PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  },

  // verified up to the model: it reached opencode.ai, whose free tier refused this machine's opencode version, with and
  // without the sandbox alike. It walks up from --dir loading opencode.json files, so a parent folder's config applies.
  opencode: {
    readPaths: [SHARED_SKILLS],
    // XDG folders on macOS too; it installs its plugins into ~/.config/opencode/node_modules, so that one is written as well
    writePaths: ['~/.config/opencode', '~/.local/share/opencode', '~/.local/state/opencode', '~/.cache/opencode'],
    // config (MCP servers), plugins and custom tools are code. node_modules stays writable: opencode installs into it on
    // start (accepted risk)
    denyWrite: ['opencode.json', 'opencode.jsonc', 'config.json', 'package.json', 'plugin', 'plugins', 'tool', 'tools', 'agent', 'agents', 'command', 'commands', 'AGENTS.md'].map((f) => `~/.config/opencode/${f}`),
    // opencode.ai is its own provider (Zen) and models.dev the model catalogue; the rest is provider-dependent, as pi
    domains: ['opencode.ai', 'models.dev', ...COMMON_PROVIDERS],
    env: { OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_SHARE: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true' },
  },

  // unverified: from docs, not run (not installed). geminicli.com docs and the gemini-cli sources.
  gemini: {
    // settings.json, oauth_creds.json, google_accounts.json, installation_id and tmp/ (shell history)
    readPaths: [],
    writePaths: ['~/.gemini'],
    // settings.json holds hooks and MCP servers; extensions are code
    denyWrite: ['~/.gemini/settings.json', '~/.gemini/extensions', '~/.gemini/commands', '~/.gemini/GEMINI.md'],
    // generativelanguage: API keys; cloudcode-pa: Google login (Code Assist); oauth2: token refresh.
    // play.googleapis.com (Clearcut usage statistics) is refused: there is no environment switch for it
    domains: ['generativelanguage.googleapis.com', 'cloudcode-pa.googleapis.com', 'oauth2.googleapis.com'],
    env: {
      GEMINI_TELEMETRY_ENABLED: 'false',
      // its own sandbox (sandbox-exec on macOS; on by default with --yolo, our Full mode) cannot nest inside ours, and
      // GEMINI_SANDBOX overrides both the flag and the settings, so it is switched off here rather than in the arguments
      GEMINI_SANDBOX: 'false',
    },
  },

  // unverified: from docs, not run (not installed). cursor.com/docs/cli.
  cursor: {
    readPaths: [KEYCHAIN_FILES],
    // cli-config.json (partly written by the CLI itself) and its state
    writePaths: ['~/.cursor', '~/.config/cursor'],
    // cli-config.json (its command allowlist) is written by the CLI itself, so it stays writable: accepted risk
    denyWrite: ['~/.cursor/mcp.json', '~/.cursor/hooks.json', '~/.cursor/hooks', '~/.cursor/rules'],
    // api2: most requests, login refresh included; api3/api4/api5: agent and model traffic per Cursor's network guide
    domains: ['api2.cursor.sh', 'api3.cursor.sh', 'api4.cursor.sh', '*.api5.cursor.sh'],
    // the login is in the Keychain on macOS (CURSOR_API_KEY bypasses it)
    machLookup: [KEYCHAIN_SERVICE],
    // its own command sandbox is Seatbelt on macOS too; ours sets the same limits
    nested: (args) => [...args, '--sandbox', 'disabled'],
  },
}
