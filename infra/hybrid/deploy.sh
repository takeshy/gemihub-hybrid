#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help && $# -eq 1 ]]; then
  echo 'Usage: bash infra/hybrid/deploy.sh'
  echo 'Build and deploy the current Git commit to the Hybrid demo.'
  exit 0
fi
if [[ $# -ne 0 ]]; then
  echo 'Usage: bash infra/hybrid/deploy.sh' >&2
  exit 2
fi

for command in git gcloud ssh tar curl; do
  if ! command -v "$command" >/dev/null; then
    echo "Required command missing: $command" >&2
    exit 1
  fi
done

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  echo 'Commit tracked changes before deploying. The build uses committed files.' >&2
  exit 1
fi
commit=$(git rev-parse --verify HEAD)
project=geminihub-486523
region=asia-northeast1
vm=(gcloud compute ssh gemihub-dev "--project=$project" "--billing-project=$project"
  "--zone=${region}-b" --tunnel-through-iap)

work=$(mktemp -d "${TMPDIR:-/tmp}/gemihub-hybrid-build.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
tag="${commit:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-${work##*.}"
image="$region-docker.pkg.dev/$project/gemihub-dev/hybrid:$tag"
mkdir "$work/source"
git archive "$commit" | tar -xf - -C "$work/source"
tar -cf "$work/vm.tar" -C "$work/source/infra/hybrid" compose.yaml deploy-on-vm.py

echo 'Checking IAP SSH access and sudo on gemihub-dev.'
if ! "${vm[@]}" --command='sudo -n test -r /opt/gemihub-hybrid/town.env && sudo -n test -d /var/lib/gemihub-hybrid'; then
  echo 'Check IAP and sudo access and the Hybrid runtime setup on the VM.' >&2
  exit 1
fi

echo "Building $image"
gcloud builds submit "$work/source" \
  "--project=$project" "--billing-project=$project" "--region=$region" \
  --config="$work/source/infra/hybrid/cloudbuild.yaml" \
  --gcs-source-staging-dir="gs://${project}_cloudbuild/source" \
  --substitutions="_IMAGE=$image" --suppress-logs

echo 'Updating the Hybrid container.'
# SSH carries the two committed VM files on stdin. Hold the same VM lock for
# installing both files and replacing the container, even from different clients.
vm_update='
set -euo pipefail
stage=$(mktemp -d)
trap "rm -rf -- \"$stage\"" EXIT
tar -xf - -C "$stage"
cd /opt/gemihub-hybrid
exec 9>.deploy.lock
flock 9
install -m 0644 "$stage/compose.yaml" "$stage/deploy-on-vm.py" .
python3 deploy-on-vm.py container "$1"
'
"${vm[@]}" --ssh-flag=-T --command="sudo -n bash -c '$vm_update' -- '$image'" < "$work/vm.tar"

for host in hybrid.gemihub.net shop.hybrid.gemihub.net; do
  response=$(curl -fsS --retry 3 --connect-timeout 10 --max-time 20 "https://$host/healthz")
  if [[ "$response" != ok ]]; then
    echo "Unexpected health response from $host" >&2
    exit 1
  fi
  echo "$host: healthy"
done
