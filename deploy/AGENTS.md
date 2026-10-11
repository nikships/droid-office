# Deploy

- `aws.sh` is the supported AWS path. The office listens on the box's loopback, the security group opens SSH, and you reach it through the tunnel. Leave the office port closed.
- `provision.sh` is what `aws.sh` runs on the machine. A package, user or unit change goes in the script and in the matching section of [docs/guide.md](../docs/guide.md) ("One command on AWS" or "Running it on a VPS") in the same change.
- `factory-computer.sh` is the repository setup script in a Factory Droid Computer's build steps (`bash deploy/factory-computer.sh`, run from the clone). It sets up a machine to work on this repository (Node 22.8+, git, gh, build tools, the Droid CLI, `npm ci`), not to host an office. Keep it idempotent and its Node floor in step with CI's.
- AWS CLI and bash only. A second deploy tool (Terraform, Docker, a compose file) is a new design, not a tweak to these scripts.
- An EC2 box stays on UTC. A deployed office picks its sky with `DROID_OFFICE_CITY` in `/etc/droid-office/env`, which the guide already tells the operator to set. The scripts do not hard-code a city.
