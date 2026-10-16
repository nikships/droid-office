# Deployment

## One command on AWS

This is a developer-only source deployment, not a supported production install. Production users should use the [Mac app release](getting-started.md#the-mac-app). If you want to experiment with a checkout on EC2 and have the AWS CLI logged in:

```bash
git clone https://github.com/nikships/droid-office && cd droid-office
deploy/aws.sh up
```

After that, the whole lifecycle is four more commands:

```bash
deploy/aws.sh open      # tunnel to the office and open it in your browser
deploy/aws.sh pause     # stop the machine to save money (asks first); only the disk and IP are billed
deploy/aws.sh resume    # start it again: same address, same files, then open it
deploy/aws.sh destroy   # delete the machine, disk, IP, security group and key pair (asks first)
```

What `up` does, in about 2 minutes:

1. Creates an SSH key pair (kept in `~/.config/droid-office/aws/<name>/`).
2. Creates a security group that opens **only SSH (port 22), and only to your current IP**. The office itself is never on the internet.
3. Gives the machine a fixed Elastic IP and launches a **t3.xlarge** (4 vCPU, 16 GiB) Ubuntu 24.04 instance with a 50 GiB disk.
4. Installs Node 22, git, the GitHub CLI and the **Droid CLI**. It clones the latest droid-office from GitHub and runs `npm i`. It also installs the system libraries for the Whiteboard's Chromium (`playwright-core install-deps chromium`), downloads that browser as the office user, and adds an AppArmor profile that lets it use user namespaces for its sandbox (see [Chromium for the Whiteboard](getting-started.md#chromium-for-the-whiteboard)); if one of those fails it says so and the office is set up anyway. The office keeps its data in `~/droid-office` on the machine and clones projects into `~/workspace/<owner>/<repo>`.
5. Runs the office under systemd with `Restart=always`, so it comes back after a crash or a reboot, and `KillMode=process`, so restarting it leaves the workers running. It listens on `127.0.0.1:4600` on the machine, so the only way in is an SSH tunnel.
6. Opens an SSH tunnel and your browser at `http://localhost:4600`. The tunnel lands on the machine's loopback, which the office trusts, so you walk straight in: no login, no token, nothing to write down.
7. The office opens on its elevator with no floors yet. It lists every repository your GitHub token can see: pick one and it becomes the first floor.

Everything goes through SSH, so there are no certificate warnings. Keep the terminal open while you use the office; Ctrl-C closes the tunnel. Next time, run `deploy/aws.sh open`. If port 4600 is taken on your machine, it picks the next free one.

If your IP keeps changing, `deploy/aws.sh allow anywhere` opens SSH to every IP. That's a reasonable trade: SSH only accepts your key, and the office stays behind the tunnel.

```bash
deploy/aws.sh open                 # tunnel + open the office in your browser
deploy/aws.sh allow 203.0.113.7    # let an IP reach SSH (CIDR ok; "me", "anywhere")
deploy/aws.sh revoke 203.0.113.7   # …and take it back
deploy/aws.sh status               # instance, address, office up?, allowed IPs
deploy/aws.sh resize t3.2xlarge    # bigger or smaller machine; same address, ~1-2 min of downtime
deploy/aws.sh update               # install the latest droid-office and restart
deploy/aws.sh ssh | logs           # get on the box / follow the office logs
```

**Upgrading from the office.** **⬆️ Upgrade the office** in the **☰** menu checks GitHub for new commits on the branch the office was installed from. When there are any, an orange **⬆️ Update** button shows up on the top bar, and it lists them. **Upgrade now** builds the new version next to the running one. Meanwhile the office keeps working and a banner says so. A failed build changes nothing. Once the build succeeds, the office swaps it in and restarts, and you get an *Upgrading the office* dialog, which you can close. The page still reloads onto the new version a few seconds after the office comes back. Workers keep working through it: their terminals run in a process of their own, which the new version picks back up. (An office set up before this lets them keep running from its next upgrade on; the first one resumes them with *continue*. One upgrade that does restart the terminals is the move to the Droid-only office: its terminal-host protocol changed, so every worker's terminal is ended once by the new version and each worker is resumed where it left off.)

An office created before the SSH tunnel served HTTPS on port 443 with a self-signed certificate. Run `deploy/aws.sh up` once to move it over: 443 closes and the office moves behind the tunnel.

**Machines from before.** Offices set up before this release had teammate SSH users, extra keys and a restricted tunnel user. Source changes never touch running hosts, so audit an old machine yourself before removing anything: check `~/.ssh/authorized_keys` and any `office` user, the sudoers entries and the SSH config the old provisioner wrote, confirm nothing you still use tunnels through them, and only then remove the keys and users you no longer want.

Useful options for `up`:

- `--project owner/repo` also clones that repo as the office's first floor. Without it, you pick projects in the elevator. (Before, the office was started in the GitHub origin of the directory you ran `up` from, which is usually droid-office itself. An office set up that way keeps its data in that checkout after `up`, and you can take droid-office off the building in the elevator.)
- `--instance-type`, `--disk` and `--region` set the machine size, disk size and region.
- `--allow <ip>` lets more IPs reach SSH from the start.
- `--name <name>` runs several offices side by side.

**Droid sign-in.** Workers run Droid on the machine, so it has to be signed in there. You can do this either way:

- Pass `--factory-api-key <key>`, which writes it to `/etc/droid-office/env` for Droid's sessions.
- Do nothing, and the first worker waits for sign-in. Get on the box with `deploy/aws.sh ssh` (or open the worker's terminal in the office), run `droid`, and log in.

**GitHub.** By default, your local `gh auth token` is used to sign in the GitHub CLI on the machine. It's needed for private repos, the issue and PR boards, and for workers to push branches and open PRs. Anyone who reaches the office can use that token, so pass `--github-token <fine-grained token>` or `--no-github-token` if that's too much.

## Running it on a VPS

This section is for developer checkouts only, not supported production hosting. The simplest private setup needs no certificates at all. Run `droid-office --host 127.0.0.1` from your checkout and connect with `ssh -L 4600:localhost:4600 you@server`, then open http://localhost:4600. The tunnel lands on loopback, so you walk straight in with no login.

To serve it on a real domain instead, put the office behind HTTPS. The simplest setup is Caddy, which gets certificates automatically:

```caddy
# /etc/caddy/Caddyfile
office.example.com {
    reverse_proxy 127.0.0.1:4600
}
```

```bash
droid-office setup --projects ~/workspace --project owner/repo   # once; or pick projects in the office
droid-office --host 127.0.0.1 --trust-proxy
```

Caddy proxies WebSockets out of the box. With nginx, forward the Host and Upgrade headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:4600;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1d;
}
```

To keep the office running, use a systemd unit:

```ini
# /etc/systemd/system/droid-office.service
[Unit]
Description=Droid Office
After=network.target

[Service]
User=dev
WorkingDirectory=/home/dev
ExecStart=/usr/bin/node /home/dev/droid-office/bin/droid-office.js --host 127.0.0.1 --trust-proxy
Restart=on-failure
# Restarting the office leaves the workers' terminals running for the next one to pick up.
KillMode=process

[Install]
WantedBy=multi-user.target
```

If you don't have a domain, `--self-signed` serves HTTPS directly. Browsers will warn once before trusting it.
