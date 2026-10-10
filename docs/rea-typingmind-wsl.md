# REA in TypingMind through WSL and Tailscale

REA runs on the home PC as a stdio MCP server. TypingMind connects through the
Private MCP Connector running in WSL. Mobile TypingMind uses the same connector;
the home PC must stay on and awake, and Tailscale must be connected on both devices.

This guide describes the configured Ubuntu WSL installation. The paths below
use its existing managed REA runtime; change them if your installation differs.

## Connect TypingMind

1. Open **Settings → Advanced Settings → Model Context Protocol → Private MCP Connector**.
2. Enter the connector URL: `https://amainpc-wsl.tail04e78.ts.net`.
   This is the configured PC's private Tailscale address. For another PC, use the
   HTTPS URL reported by `tailscale serve status`.
3. Enter your connector authentication token, then connect. The configured token
   is stored locally in `~/.config/typingmind-mcp/connector.env`, with permissions
   `600`; it is not included in this repository.
4. Open **Edit Servers**, paste the following JSON, and save:

```json
{
  "mcpServers": {
    "rea": {
      "command": "/home/user/.local/share/rea/runtime/node_modules/node/bin/node",
      "args": [
        "/home/user/.local/share/rea/runtime/node_modules/rea-agents/scripts/rea.mjs",
        "mcp"
      ]
    }
  }
}
```

These commands execute inside WSL, including when TypingMind is open on mobile.
The installed copy of this JSON is `~/.config/typingmind-mcp/servers.json`.
REA is also initialized automatically when the connector service starts.

## Tailscale settings and connection errors

In the [Tailscale DNS settings](https://login.tailscale.com/admin/dns), enable
**MagicDNS** and **HTTPS Certificates → Enable HTTPS**. The HTTPS confirmation
publishes the device hostname in certificate transparency records; access to
the connector remains private to the tailnet.

On each device running TypingMind, connect Tailscale to the same tailnet and
enable **Use Tailscale DNS**. On Windows, the equivalent CLI setting is:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" set --accept-dns=true
```

If TypingMind reports **Connection failed: Failed to fetch**, check those DNS
and HTTPS settings, then reload TypingMind and reconnect. They caused the initial
failure on this installation. The HTTPS connector URL uses port 443; do not append
the internal port `51889`.

The configured Serve proxy forwards HTTPS to `http://127.0.0.1:51889` inside WSL.
It runs in the background and is private to the tailnet; Funnel is not configured.
See [Tailscale's HTTPS setup](https://tailscale.com/docs/how-to/set-up-https-certificates)
and [TypingMind's Private MCP Connector guide](https://docs.typingmind.com/model-context-protocol-(mcp)-in-typingmind/use-mcp-with-private-mcp-connector).

## Installed runtime and startup

- Connector: pinned `@typingmind/mcp` version `1.4.1` in `~/.local/share/typingmind-mcp`.
- Listener: `127.0.0.1:51889`; authentication settings are in `connector.env`.
- WSL service: `~/.config/systemd/user/typingmind-mcp.service`, enabled with user linger.
- Windows scheduled task: **TypingMind WSL Connector**, starts Ubuntu at this
  Windows user's sign-in and keeps WSL running when terminals close.

Startup before Windows sign-in is not configured. The systemd service alone does
not keep WSL alive; the Windows task holds a foreground WSL process open.

Manage the connector from WSL:

```bash
systemctl --user status typingmind-mcp.service
systemctl --user restart typingmind-mcp.service
journalctl --user -u typingmind-mcp.service -n 50
tailscale serve status
```

Service restart and REA initialization were tested. HTTPS certificate validation,
authentication, CORS preflight, a REA status call, and static JavaScript analysis
passed; the connector exposed 139 REA tools at setup. Windows DNS and HTTPS
preflight also passed. Tool availability depends on installed engine prerequisites.
Windows reboot and the TypingMind mobile browser connection have not been tested.
