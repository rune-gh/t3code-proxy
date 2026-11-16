# Set up a box

Use this checklist when you have SSH access to a new machine that should run agents. The result
is a T3 Code environment with Claude Code and Codex sending inference to your existing home
hub. A home desktop or cloud box can be an environment. Subscription logins belong on the
always-on residential hub.

Read [setup](setup.md) if this machine will also be the hub. [Providers](providers.md) covers all
supported subscriptions and upstreams. [Environments](environments.md) covers platform services,
pairing and Windows plus WSL 2.

## 1. Confirm the job and stop conditions

- Establish the machine, OS, SSH user, hub URL and which projects should run here. Confirm which
  accounts and clients the user authorized you to configure.
- Disclose that subscription proxying may violate provider terms and can lead to suspension or
  a ban. Stop if the user does not accept that risk.
- Keep Theo's hard rules. Never serve other people's traffic with the subscriptions. Use Claude
  subscription models only through Claude Code.
- If this is the hub, inspect its public network and sleep state with
  `t3code-proxy doctor -config <config path>` once installed. Before installing, use the checks
  in [agents](agents.md#check-the-environment). Stop before subscription authorization if the
  egress belongs to a datacenter, a cloud host or a VPN. A cloud environment can use the hub's
  access key.
- Stop unattended handoff while the hub or environment can sleep. Apply the OS sleep settings
  from [setup](setup.md#4-run-it-always-on), then verify again.
- Resolve existing services, occupied ports or an existing configuration with another endpoint
  before replacing them. If you need a credential only the user holds, use your tool's secret
  input facility or have the user enter it in a private local prompt.

## 2. Inspect and install base tools

Run as the user who will own the repositories and T3 Code state. On Linux or macOS, inspect the
OS and available tools.

```sh
uname -a
git --version
curl --version
ssh -V
node --version
npm --version
```

Install missing Git, curl, CA certificates and SSH tools using the OS package manager. Install
a current Node.js LTS with npm if you use the npm provider installs below. Add the project's
compiler, runtime and package manager. On Windows, use Windows builds of the base tools. Check
the non-interactive SSH user's `PATH` as well as an interactive shell. Keep checkouts and home
directories owned by that user.

## 3. Join Tailscale and check the hub

Install Tailscale using its [platform instructions](https://tailscale.com/download). Authorize
the machine into the user's tailnet. Check that the hub is online and the tailnet access rules
allow port 8317.

```sh
tailscale status
curl -s https://<hub>.<tailnet>.ts.net:8317/v1/models \
  -H "Authorization: Bearer <your access key>"
```

The response should contain a model list. In automation, inject the access key privately and
redact the command record. Resolve DNS, certificate and 401 errors before installing an agent
service. A failed hub connection makes every later provider test inconclusive.

## 4. Install Claude Code and Codex

Use an existing supported installation when present. For a fresh user-owned npm setup, these
commands install the provider packages. The script approvals are for their own install hooks.

```sh
npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
npm install -g --allow-scripts=@openai/codex @openai/codex
claude --version
codex --version
```

If that npm prefix requires root, use a user-owned Node/npm installation or the provider's
installer linked from T3 Code's
[provider setup](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md#providers).
Use the provider versions recommended by the installed T3 Code release. Confirm `claude` and
`codex` resolve for the eventual background-service user.

## 5. Back up and merge client config

Before writing, make a backup of every existing file you will edit in a unique directory. On Linux
or macOS, this copies only files that exist and gives the backups private permissions.

```sh
umask 077
backup_dir=$(mktemp -d "$HOME/.hub-config-backup.XXXXXX")
for config_file in "$HOME/.claude/settings.json" "$HOME/.codex/config.toml"; do
  if [ -f "$config_file" ]; then
    cp -p "$config_file" "$backup_dir/"
    chmod 600 "$backup_dir/$(basename "$config_file")"
  fi
done
```

On Windows, make equivalent protected copies under the same user's profile before editing.
Keep those copies outside the project repository.

Merge the complete client settings from [providers](providers.md#point-clients-at-the-hub).
Preserve existing JSON fields and TOML tables. Check for conflicting `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `model_provider`, provider tables and project-local overrides. Use
`https://<hub>.<tailnet>.ts.net:8317` for Claude Code and append `/v1` for Codex.

### Optional second config directories

Create `~/.claude-hub/settings.json` and `~/.codex-hub/config.toml` with the hub settings if the
user wants separate client instances. Start them explicitly for verification.

```sh
CLAUDE_CONFIG_DIR=~/.claude-hub claude
CODEX_HOME=~/.codex-hub codex
```

In T3 Code, assign these directories to the corresponding provider instances. A shell variable
used for one CLI invocation only applies to that invocation. The environment server must launch
its providers with the same directories. See [T3 Code](t3code.md).

## 6. Install and expose the T3 Code environment

Use the official CLI installer on Linux or macOS.

```sh
curl -fsSL https://t3.codes/install.sh | sh
t3 --version
t3 serve --help
```

For Windows, use the PowerShell installer in [environments](environments.md#before-you-start).
Choose the access method already authorized for this machine. For a Tailscale-only background
server, set the listener in `~/.t3/service.env` as described in
[environments](environments.md#connect-and-run-in-the-background), then run as the normal user.

```sh
t3 service install
t3 pair --tailscale --tailscale-serve-port 443
t3 service status
tailscale serve status
```

For T3 Connect account access, use `t3 connect --headless` and let the user approve the URL and
code. It sets up the background service too. Keep the Tailscale path from the environment to the
hub working in either case.

On Linux, verify linger with `loginctl show-user "$(id -un)" -p Linger`. On macOS and Windows,
keep the service's user logged in. For WSL, choose the launcher in
[Windows and WSL 2](environments.md#windows-and-wsl-2-as-two-environments) and test it with every
terminal closed.

## 7. Verify through the normal entry points

1. From this box, request `/v1/models` with the access key again. Check only enough response data
   to establish connectivity.
2. Start Claude Code in a trusted checkout and send a small prompt using a hub model. Do the
   same with Codex. Confirm both requests appear in the hub's activity view.
3. Pair the desktop, web or mobile client with this environment. Create a thread in the remote
   checkout. Confirm its terminal OS, user and path belong to this box.
4. Under **Settings → Providers**, select the remote environment and its configured Claude
   instance. Select **Use existing CLI** for Codex. Send a small prompt through each.
5. If requested, add the hub usage provider with the management secret and review its pooled
   limits. The provider [capability table](providers.md#capability-table) gives current coverage.
6. Disconnect SSH and close the laptop's client, then reconnect from another device. Check that
   the service and thread are still available. Reboot the box and check its startup behavior.

## 8. Hand back a record without secrets

Report the box's role, service status, CLI versions, config and backup paths, environment URL,
verification results and any pending human sign-in. Record whether the normal or second config
directories are in use and which provider instance uses each.

Never print, log, paste or commit account JSON, access keys, management secrets, pairing links
or authorization codes. Use placeholders in notes. Protect client configs and backups with
owner-only access or the corresponding Windows ACL. Subscription OAuth files and their refresh
journal stay on the hub. See [Codex refresh recovery](codex-refresh-recovery.md) for backups of
that journal.
