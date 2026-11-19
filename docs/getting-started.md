# From installation to your first chat

[README](../README.md) · [User guide](user-guide.md) · [Server administration](deployment.md)

This guide is for a first installation. By the end, you will have a running Workspace, a connected Codex or Claude Code account, and a file created in your first chat. If Workspace is already installed, start at [sign in](#3-sign-in-and-connect-an-agent).

AI Workspace is a web interface that you run on your own computer or server. It starts the official agent tools in containers and keeps their files and conversation history. The AI models run through OpenAI or Anthropic; they are not downloaded to your server.

[Choose an installation](#1-choose-your-installation) · [Local setup](#2a-install-on-your-computer) · [VPS setup](#2b-install-on-a-vps) · [Installer prompts](#installer-prompts) · [Sign in](#3-sign-in-and-connect-an-agent) · [First chat](#4-start-your-first-chat) · [Troubleshooting](#if-something-does-not-work)

## 1. Choose your installation

| | On your computer | On a VPS |
| --- | --- | --- |
| Best for | Trying Workspace or using it from that computer | Access from other devices and continuous operation |
| Where commands run | Your local terminal; WSL on Windows | An SSH terminal connected to the server |
| Browser address | `http://localhost:8080` | The HTTPS domain or public IP printed by the installer |
| What must stay on | Your computer and Docker | The VPS |
| Domain needed? | No | No; a static public IP works |

Choose **one** installation route below. Use separate checkout directories if you later set up another installation. Switching an existing installation between local and server modes requires the [configuration migration steps](deployment.md#3-configuration).

Have these ready:

- An account that can use **Codex or Claude Code through its official CLI**. One service is enough. Workspace does not provide a subscription, remove provider limits or guarantee access to every listed model.
- An authenticator app that supports six-digit time-based codes (TOTP), such as the one you already use for two-factor authentication.
- Internet access. The first build downloads dependencies and can take several minutes.
- Free storage for images, projects, attachments and backups. The suggested server starting point is 4 vCPU, 8 GB RAM and 40+ GB free SSD space. For light work on 4 GB RAM, start with one task at a time; large builds may need more.

You do not need a GitHub project, an API key, or both agent providers to try your first chat. Installing Workspace with Docker does not require Node.js or PostgreSQL on the host.

## 2a. Install on your computer

### Prepare your system

**macOS:** install and launch [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/). Install Git and Python 3 if they are missing; check OpenSSL too. [Git installation](https://git-scm.com/download/mac) and [Python downloads](https://www.python.org/downloads/macos/) describe the prerequisites. If you already use Homebrew, `brew install git python openssl` provides them. Run the commands below in Terminal. Keep your checkout in a folder shared with Docker, with no spaces in its path.

**Windows:** use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install) with an Ubuntu distribution and [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Enable Docker Desktop integration for that distribution. Open the **Ubuntu/WSL terminal**, run `sudo apt-get update` followed by `sudo apt-get install -y git python3 openssl`, and work inside your Linux home directory (`cd ~`). Run the installation commands in that terminal, not PowerShell or Command Prompt.

**Linux:** install [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/) for your distribution. Compose **v2.24.4 or newer** is required. On Ubuntu/Debian, install the other tools with `sudo apt-get update` followed by `sudo apt-get install -y git python3 openssl`. Start Docker. If your user needs administrator access to Docker, prefix the Docker checks and installation command with `sudo`.

In that terminal, check the tools:

```bash
git --version
python3 --version
openssl version
docker compose version
docker info
```

**Expected result:** every command prints version or service information. `docker info` must show server information without a connection error. If a command is missing, install that tool before continuing. On Docker Desktop, allow approximately 8 GB RAM for three concurrent agents; a smaller allocation needs a lower task limit.

### Run the installer

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
./ops/install.sh --local
```

The commands download the source, enter its directory and start installation. Use this same directory for later maintenance commands. You do not need to copy `.env.example` or edit configuration for a normal first installation; the installer creates `.env` for you.

Follow the [installer prompts](#installer-prompts), then open **[http://localhost:8080](http://localhost:8080)** on this computer. Continue to [sign in](#3-sign-in-and-connect-an-agent).

## 2b. Install on a VPS

This route is for a dedicated Ubuntu 24.04 or Debian 12 server with administrator access. A VPS is a rented Linux machine; get its public IP and SSH login from your hosting provider. For a first deployment, a public IPv4 address avoids the additional IPv6 networking checks described in the [deployment guide](deployment.md#access-without-a-domain).

### Prepare the server

1. In the hosting provider's firewall, allow inbound TCP **80** and **443** to this server. Keep your SSH port allowed so you can administer it. Check the server's own firewall too. Do not expose PostgreSQL or the application's internal port.
2. If using a domain, point its A record to the server's public IPv4 address. Only add an AAAA record if IPv6 is configured and reachable. Skip DNS setup when using the IP directly.
3. Connect from your computer's terminal. Replace both placeholders with the values from your provider:

   ```bash
   ssh USER@YOUR_SERVER_IP
   ```

4. In this **server terminal**, install Git:

   ```bash
   sudo apt-get update
   sudo apt-get install -y git
   ```

If you are already logged in as `root`, omit `sudo` from these commands and the installation command below. If your server already hosts a website, confirm ports 80 and 443 are available; the standard installation expects to manage them.

### Run the installer

```bash
git clone https://github.com/qavitalii/ai_workspace.git
cd ai_workspace
sudo ./ops/install.sh --server
```

The installer installs Docker if missing and prepares the other maintenance tools. You do not need to install a web server, database or agent CLI yourself.

When asked for the address, enter **the actual public IP assigned to your VPS** or your domain. Do not paste `https://`, a port, or a path. An address such as `192.168.1.10` is a private LAN address and will be rejected. IPv6 can be entered with or without square brackets, but requires the network checks in the deployment guide.

Follow the prompts below. When services have started, open the printed **HTTPS** address in your computer or phone browser. Certificate issuance can take a few minutes. A browser security warning is not a successful installation; use [troubleshooting](#if-something-does-not-work) instead of bypassing it.

## Installer prompts

Both installation routes ask you to:

1. **Create an owner password** of at least 14 characters and repeat it. Nothing appears while you type the password; this is normal terminal behavior. This password belongs to your Workspace, not OpenAI, Anthropic or the server's SSH account.
2. **Add the QR code to your authenticator.** Choose the authenticator's option to add an account and scan the terminal QR code. If scanning is difficult, manually enter the setup key printed below it and choose a time-based code.
3. **Save the setup key securely**, then press Enter when ready. Treat it like a password: do not include the QR code or key in screenshots or issue reports. It lets you restore the authenticator if you lose your phone.

The installer creates the owner once. Rerunning it after a failed build preserves existing data and does not reset the password or show a new owner setup. This version has no self-service password/2FA recovery screen, so save your sign-in details before closing the terminal.

**Expected result:** installation prints `Workspace services started:` followed by the address. This means the services started; on a VPS it does not yet prove that a public certificate was issued. The next check is opening the sign-in page in the browser.

## 3. Sign in and connect an agent

There are two separate sign-ins: one for your Workspace, then one for each agent account you choose to connect.

1. Open the Workspace address and enter your **owner password** plus the current **six-digit authenticator code**. There is no separate username to register.
2. Open **Agent accounts**, or select **Connect your first agent** on the empty home screen.
3. Enter an **Account label**, such as `Personal`, choose **Codex** or **Claude Code** under **Service**, and select **Add account**. This creates a label in Workspace; it does not create a provider subscription.
4. Select **Connect** beside the new account.
5. Complete the service's sign-in flow:
   - **Codex:** copy the displayed device code, open the official OpenAI sign-in page provided by the app and enter the code there. Confirm that you are using the intended account.
   - **Claude Code:** open the official sign-in link shown by the app. If the provider returns a code to paste back, submit it in Workspace.
6. Return to Workspace and wait for the account to show **Connected**.

Enter your provider password only on its official sign-in page. The account's local sign-in state stays on the machine running Workspace. No manual API key entry is required for this flow. If sign-in or model access fails, follow [provider verification](provider-verification.md); adding an account label alone does not authenticate it.

## 4. Start your first chat

For a 4 GB RAM server, first open **Settings → Resources** and set **Maximum concurrent tasks** to **1**. More open chats do not require more active tasks: queued tasks can run one after another.

1. Select **New chat**.
2. Leave **Project** set to **Personal chat**. Choose your connected agent account. Leave model and reasoning at their defaults for the first try, and keep approval prompts enabled.
3. Select **Create chat**. A title is generated from the first message; you do not need to name it first.
4. Send:

   > Create a file named hello.txt containing “Hello from AI Workspace”. Tell me where you saved it.

5. If the agent asks permission, read the proposed action and approve only what you intend. Wait for the task to finish.
6. Open **Files** and inspect `hello.txt`.

**Success looks like:** a connected account, a completed reply, and the expected file in the chat's working folder. Reload the page to confirm the conversation remains. This small task uses your provider account and its normal quota.

### Add your own files or a project

- Use the paperclip for an attachment to a message. The original stays separate; ask the agent to save edited output in the working folder.
- Use **Files** to upload a working file directly into the chat/project folder.
- Choose **Add project → Files only** to share documents across project chats without GitHub.
- For code on GitHub, add the repository by `owner/repository` or URL. Private repositories and publishing need a project-specific GitHub token; follow the [token setup](deployment.md#4-github-and-agent-accounts). Never paste that token into a chat.

Continue with the [user guide](user-guide.md) for working copies, reviews, publishing, SSH, AWS and skills.

## 5. Stop, restart and back up

Use your original terminal (or reconnect over SSH for a VPS), then enter the cloned `ai_workspace` directory. For a server installed with `sudo`, prefix these commands with `sudo` too.

```bash
./ops/compose.sh ps                  # check service status
./ops/compose.sh stop                # stop the app without deleting data
./ops/compose.sh up -d --wait         # start the existing installation
./ops/backup.sh                      # create an encrypted backup
```

You do not need to rerun the installer for a normal restart. Closing the browser leaves tasks running; stopping the app, Docker or the host interrupts them. Review any file changes or external actions before resuming an interrupted task.

A root VPS installation schedules backups daily at 03:17 in the server's timezone. Backups temporarily interrupt active work. Copy the `.backup-key` and encrypted archives from `backups/` to secure storage outside the server. Local installations need manual or separately scheduled backups. [Backup and restore instructions](deployment.md#6-backups).

## If something does not work

Run diagnostic commands from the installation directory; add `sudo` on a root-installed VPS.

| Symptom | First action |
| --- | --- |
| `git`, `python3`, `openssl` or `docker` is not found | Complete the platform prerequisites, reopen the correct terminal and repeat the version checks. |
| Docker cannot connect | Start Docker Desktop/Engine and wait until `docker info` succeeds. Check WSL integration on Windows or Docker permissions on Linux. |
| `Port 8080 is already allocated` | Stop the other service or follow the port-change instructions in [troubleshooting](deployment.md#8-troubleshooting). |
| Build/download failed | Check connectivity and free disk space. Rerun the same installation command; do not delete volumes or `.env`. |
| Local page will not open | Confirm you are on the same computer, use `http://localhost:8080`, then run `./ops/compose.sh ps`. |
| Phone cannot open `localhost` | That address points to the phone itself. Use the VPS HTTPS address for access from another device. |
| VPS HTTPS fails or shows a certificate warning | Confirm the address, DNS if used, and ports 80/443. Inspect `./ops/compose.sh logs --tail=100 caddy`. |
| Password/code rejected | Use the Workspace owner password, check automatic time on your phone/server and wait for a new authenticator code. A successfully used code cannot be reused. |
| Account exists but tasks will not start | In **Agent accounts**, complete **Connect** and confirm **Connected**. Check the account's quota and model access. |
| A task is queued | The account, folder or execution capacity may be busy. Stop or finish the other task, or choose an available account/folder. |
| `Origin not allowed` | Open the exact address printed by the installer. `localhost`, `127.0.0.1`, a domain and a public IP are different addresses. |

For application errors, inspect `./ops/compose.sh logs --tail=100 server`. See the [full troubleshooting guide](deployment.md#8-troubleshooting) for recovery and configuration changes. Before sharing a log or screenshot, remove account details, prompts, file contents and credentials. Do not share `.env`, the authenticator QR/setup key, provider sign-in codes or resolved Compose configuration.
