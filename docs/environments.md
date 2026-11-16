# T3 Code environments

An environment is the machine where T3 Code runs providers, terminals and your checkout. Put an
environment on a home desktop or a cloud box and work from your laptop, web browser or phone.
The remote machine's Claude Code and Codex settings send inference to your home hub. The hub
holds your subscription logins and talks to the providers.

Using subscriptions through a hub may violate provider terms, and accounts can be suspended or
banned. Never serve other people's traffic with your subscriptions. Use Claude subscriptions
only through Claude Code. Keep subscription authorization on the residential hub. A cloud box
can run your agents with the hub's access key.

## Before you start

- Have a working [hub](setup.md), its Tailscale HTTPS URL and a client access key.
- Install Tailscale on the environment and your connecting devices, joined to your tailnet.
  Tailnet access rules must allow the hub and environment ports.
- Install Git, the tools your project needs, Claude Code and Codex on the environment machine.
  Run everything as the same user that owns the checkouts and client configuration.
- Install a current T3 CLI on the environment. The commands below were checked against installed
  `t3 v0.1.9`. Read `t3 --help` and subcommand help on machines with another release.
- Keep the environment awake and connected. Linux needs systemd user services for background
  service installation. Tailscale HTTPS needs MagicDNS, HTTPS certificates and permission for
  your user to manage Serve.

Install the T3 CLI on Linux or macOS with its official installer.

```sh
curl -fsSL https://t3.codes/install.sh | sh
t3 --version
t3 serve --help
```

On Windows, use PowerShell.

```powershell
irm https://t3.codes/install.ps1 | iex
t3 --version
```

T3 Code's [installation guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md)
lists provider installation requirements. [Box setup](box-setup.md) gives the full order.

## Point the environment's providers at the hub

Merge the Claude Code and Codex settings from [providers](providers.md#point-clients-at-the-hub)
into this machine's config files. Back up each file first. Windows uses the signed-in user's
`%USERPROFILE%\.claude` and `%USERPROFILE%\.codex`. Linux and macOS use `~/.claude` and
`~/.codex`.

In T3 Code, select this environment under **Settings → Providers**. Claude uses its Claude Code
settings. For Codex, choose **Use existing CLI** so it reads `config.toml`. If you use second
config directories, select those directories on the provider instances as described in
[T3 Code](t3code.md). Restart provider sessions after changing their settings.

Check the hub from the environment machine, then send one prompt from each configured client.

```sh
curl -s https://<hub>.<tailnet>.ts.net:8317/v1/models \
  -H "Authorization: Bearer <your access key>"
claude --version
codex --version
```

## Serve the environment over Tailscale

For a foreground server, run this on the environment machine.

```sh
t3 serve --host 127.0.0.1 --port 3773 --tailscale-serve --tailscale-serve-port 443
```

`serve` runs the HTTP/WebSocket backend, keeps it in the terminal and prints pairing details.
`--host` and `--port` set its listener. The Tailscale flags publish that listener at
`https://<box>.<tailnet>.ts.net` through Serve. Leave this process running while you test.
Port 443 for T3 Code and port 8317 for the hub can share a machine.

For an existing server, create a fresh pairing link with HTTPS on the same port.

```sh
t3 pair --tailscale --tailscale-serve-port 443
```

The Serve mapping persists across server restarts. `tailscale serve status` shows its target.
Use a different HTTPS port if 443 already belongs to another service.

## Connect and run in the background

`t3 connect` configures T3 Connect account access and the background service. It is equivalent to
`t3 up --connect`. On an SSH host, use the headless flow and approve the printed URL and code
from another device.

```sh
t3 connect --headless
t3 status
t3 service status
```

T3 Connect provides an account-based route to the environment. Tailscale also remains the path
from this machine's provider clients to the hub. You can add a Tailscale HTTPS route for direct
client access with `t3 pair --tailscale`.

For a Tailscale-only environment, stop your foreground test server and install the built-in
background service as your normal user.

```sh
t3 service install
t3 pair --tailscale --tailscale-serve-port 443
t3 service status
```

The service reads `service.env` in its T3 home, normally `~/.t3/service.env`, or
`%USERPROFILE%\.t3\service.env` on Windows. For the listener used above, merge these entries
into that file. Values are literal and require absolute paths
when you add path settings.

```dotenv
T3CODE_HOST=127.0.0.1
T3CODE_PORT=3773
```

After a change, restart the service. Keep the Serve target's port aligned with `T3CODE_PORT`.

```sh
t3 service restart
t3 service status
```

### Linux

The installer creates `t3code.service` as a systemd user unit and enables linger. Check it and
enable linger if setup reports that it needs administrator access.

```sh
systemctl --user status t3code.service
loginctl show-user "$(id -un)" -p Linger
sudo loginctl enable-linger "$(id -un)"
```

Linger starts the user manager at boot and keeps it after logout. Verify access again after an
SSH logout and a reboot. Apply the [hub sleep settings](setup.md#4-run-it-always-on) to any box
that must stay available.

### Windows

`t3 service install` registers a Scheduled Task named `t3code-<domain>-<user name>`. It starts at
that user's logon, runs without a window and restarts after failure. Keep that user signed in,
lock the screen and disable sleep on AC power. Installing through SSH while the user is signed
out can leave the task waiting for the next interactive logon. Use `t3 service status` for its
actual task name and log path.

### macOS

The service is a launchd agent in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`. It starts at login and stops at logout.
Keep the user logged in and the Mac awake. Installing through SSH before a GUI login can leave
the final start pending until that login. `t3 service status` reports the log location.

These service behaviors and the `service.env` format are documented in T3 Code's
[background-service guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md).

## Add it from desktop, web or mobile

On the environment, run `t3 pair --tailscale` to get a fresh QR code and pairing URL. In the
receiving app, open **Settings → Environments → Add environment** and paste the URL, or scan the
QR code on mobile. A desktop can also open the printed `t3code://pair` link. Use a new pairing
link for each device and keep it private. The hosted web client at `https://app.t3.codes` needs
an HTTPS endpoint.

If you chose T3 Connect, sign into the same account on your desktop, web or mobile client and
select the environment. T3 Code's
[remote-access guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
covers both routes.

Add a project whose path is on that box and select it when starting a thread. A terminal in the
thread should show that machine's hostname, OS and checkout. A laptop can disconnect while the
server keeps the work running.

### Let an agent use another environment

Client pairing lets you operate a remote environment yourself. To let agents on one environment
start work on another, enable **Linked environments** in **Settings → Labs** on both and use
**Settings → Environments → Linked environments → Link**. Choose the target and access mode.
The terminal equivalent runs on the originating environment.

```sh
t3 environment link https://<box>.<tailnet>.ts.net \
  --pairing-code "<pairing code>" --access read-only
t3 environment list
```

Supply the target's fresh code privately. Use the app's pairing field to keep it out of shell
history. Choose the access level required for the task. You can revoke the target's session in its
sharing/access settings. See T3 Code's linked-environment section in the remote-access guide.

## Windows and WSL 2 as two environments

Windows and a WSL distribution have separate users, files, provider installs and T3 home
directories. Install and configure Claude Code, Codex and `t3` in each. Keep Linux checkouts in
the Linux filesystem for Linux tools. Give the environments clear names in the client, such as
`Windows` and `Ubuntu`. Confirm which environment owns each project before you start work.

T3 Code's Windows desktop can also manage a distro from **Settings → Sharing & access**. The
steps here set up an independently reachable Linux server. Pick one owner for the distro's T3
home to avoid two servers trying to open the same state.

### Enable systemd in the distro

In PowerShell, check WSL and the distro version. Systemd support requires WSL 0.67.6 or later.

```powershell
wsl --version
wsl --list --verbose
```

Merge this into `/etc/wsl.conf` inside the selected WSL 2 distro.

```ini
[boot]
systemd=true
```

Save work in every distro, then apply it from PowerShell.

```powershell
wsl --shutdown
```

Reopen the distro and check `systemctl status`. Microsoft explicitly states that systemd
services do not keep a WSL instance alive. Linger covers the Linux user manager's lifetime.
WSL still needs a running instance and Windows still needs to stay awake. See Microsoft's
[systemd guide](https://learn.microsoft.com/en-us/windows/wsl/systemd) and
[WSL configuration reference](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).

### Choose the Tailscale path and distinct ports

Tailscale recommends running it on the Windows host only. WSL then uses the host's networking
to reach tailnet services. Running Tailscale inside WSL gives Linux its own node identity, but
Tailscale documents failures when WSL's encrypted traffic is carried over the Windows host's
Tailscale connection. Check that limitation before choosing a second node. See
[Tailscale on WSL 2](https://tailscale.com/docs/install/windows/wsl2).

With host-only Tailscale, use this port layout.

| Process | Local listener | Windows Tailscale HTTPS port |
| --- | --- | --- |
| Windows T3 Code | `127.0.0.1:3773` | `443` |
| WSL T3 Code | `127.0.0.1:3774` in WSL | `8443` |
| Hub, if on this PC | `127.0.0.1:8317` on Windows | `8317` |

Run the Linux T3 server inside WSL.

```sh
t3 serve --host 127.0.0.1 --port 3774
```

WSL's default NAT networking forwards Linux localhost services to Windows localhost. Test
`http://127.0.0.1:3774` in a Windows browser before publishing it. In Windows PowerShell, set the
second Serve mapping.

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:3774
tailscale serve status
```

Pair the WSL environment using a link created in its sharing/access settings with the reachable
address `https://<box>.<tailnet>.ts.net:8443`. Windows uses
`https://<box>.<tailnet>.ts.net`. Distinct ports avoid the host's localhost forwarding and Serve
mappings selecting the wrong server. If you use a Tailscale daemon inside WSL instead, configure
Serve on that Linux node and pair its own hostname.

### Keep WSL running without a terminal

Create a Windows Scheduled Task under the Windows user that owns the distro. Trigger it at
logon, enable restart on failure and remove the execution-time limit. Select **Run whether user
is logged on or not** for a background task, and supply any password through Task Scheduler's
own prompt. Use `wsl.exe` as the program and this argument line, replacing the distro, user and path.

```text
--distribution Ubuntu --user <linux-user> --exec /home/<linux-user>/.local/bin/t3 serve --host 127.0.0.1 --port 3774
```

This task keeps a foreground Linux server attached to `wsl.exe` while Windows Task Scheduler
owns its lifetime. Use it as the distro's T3 launcher. If you previously installed a T3 systemd
service there, remove that service with `t3 service uninstall` before enabling this task. Other
Linux services can still use systemd. Test the task after closing every terminal and after a
Windows reboot and logon. `wsl --list --verbose` should show the distro running.

The WSL command options are described in Microsoft's
[command reference](https://learn.microsoft.com/en-us/windows/wsl/basic-commands).

### Reach a hub on the Windows host from WSL

First try the normal hub URL, `https://<hub>.<tailnet>.ts.net:8317`, from WSL. Use that URL in
both Linux provider configs once it works. This preserves the certificate name and access-key
check used by every other environment.

With default NAT, Linux `127.0.0.1` addresses Linux itself. Windows' address as seen from Linux
is the default route's gateway, which you can inspect with `ip route show`. A Windows service
bound only to Windows loopback cannot be reached through that gateway address. Keep the hub on
loopback and use its Tailscale Serve endpoint.

On Windows 11 22H2 or later, mirrored networking lets Linux connect to Windows services on
`127.0.0.1`. Enable it in `%USERPROFILE%\.wslconfig` if you need that path, then restart WSL.

```ini
[wsl2]
networkingMode=mirrored
```

In that mode, a same-PC hub can also be reached at `http://127.0.0.1:8317` inside WSL. The client
still sends the access key. Windows/Hyper-V firewall rules and VPN software can affect these
paths. Microsoft's [networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking)
explains NAT, localhost forwarding and mirrored mode.

### Failure modes

- A healthy Linux systemd unit disappears after closing terminals. Check whether the WSL distro
  stopped, then start the Windows launcher task. Linger alone cannot keep WSL alive.
- WSL's URL opens the Windows environment. Check both local ports and Serve targets, then make
  a fresh pairing link for the Linux environment.
- Linux has the wrong provider settings. Check the Linux user's home and CLI paths. Windows
  provider settings do not configure Linux clients.
- WSL can reach the internet but cannot reach the hub. Check MagicDNS, the hub's Serve port,
  Windows firewall and the dual-Tailscale limitation above.
- A server reports its data directory is busy. Stop the duplicate foreground, systemd or
  desktop-managed server before starting the chosen launcher.
- Everything vanishes after sleep, sign-out or `wsl --shutdown`. Wake Windows, sign into the
  task's user and start the task again. Shutdown terminates all running WSL distributions.

See [troubleshooting](troubleshooting.md) for hub and environment checks.
