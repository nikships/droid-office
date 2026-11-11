# Deploy

- `aws.sh` is the supported AWS deployment path: bind the office to loopback, open only SSH in the security group, and reach the office over an SSH tunnel.
- `provision.sh` sets up the EC2 host (`aws.sh` runs it). Update the matching section of [docs/guide/deployment.md](../docs/guide/deployment.md) whenever packages, users or systemd units change. Keep the host on UTC; operators set `DROID_OFFICE_CITY` in `/etc/droid-office/env` for sky time.
- Stick to bash and AWS CLI (Terraform, Docker or Compose require a new design).
- Factory cloud machines for this repository are configured by the `droid-office-default` Factory Environment (in Factory or via the Environments API), separate from `deploy/`.
