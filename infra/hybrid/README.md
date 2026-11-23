# Dedicated Web demo

The public demo runs at `https://hybrid.gemihub.net` in its own Compose project
on `gemihub-dev` (GCP project `geminihub-486523`). Firebase AI Logic, App Check
and Remote Config use the separate project `gemihub-hybrid-2026`.

`compose.yaml` connects to the existing Caddy network but mounts no upstream
data or credentials. Its only container has a 256 MiB memory limit. The demo
uses fictional shops and in-memory reservations that reset on restart.

Build with `cloudbuild.yaml`, using a new `hybrid` image tag. Copy this
directory's deployment files to `/opt/gemihub-hybrid` on the VM, then run:

```sh
cd /opt/gemihub-hybrid
sudo python3 deploy-on-vm.py container asia-northeast1-docker.pkg.dev/geminihub-486523/gemihub-dev/hybrid:TAG
# After the new DNS A record resolves to the VM:
sudo python3 deploy-on-vm.py route
```

The route step validates and backs up the current Caddyfile, appends only the
new hostname and reloads Caddy without restarting existing containers. It
refuses unexpected existing hybrid configuration. An upstream startup script
can regenerate its Caddyfile, so reapply the `route` step after such a change.
Do not run inherited deployment scripts for this clone.
