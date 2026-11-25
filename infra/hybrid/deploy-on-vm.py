#!/usr/bin/env python3
"""Install only the dedicated hybrid stack; keep the existing dev stack running."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path('/opt/gemihub-hybrid')
ORIGINALS = ['gemihub-dev_app_1', 'gemihub-dev_challenge-demo_1', 'gemihub-dev_caddy_1']
IMAGE_PREFIX = 'asia-northeast1-docker.pkg.dev/geminihub-486523/gemihub-dev/hybrid:'
HYBRID_REPOSITORY = IMAGE_PREFIX[:-1]

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def original_ids():
    return run('docker', 'inspect', '--format', '{{.Id}}', *ORIGINALS,
               capture_output=True, text=True).stdout

def last_healthy_image():
    """The image recorded after its last successful health check, if any."""
    try:
        match = re.fullmatch(r'HYBRID_IMAGE=(\S+)\n?', (ROOT / 'image.env').read_text())
    except FileNotFoundError:
        return None
    return match.group(1) if match and match.group(1).startswith(IMAGE_PREFIX) else None

def running_image():
    check = subprocess.run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'gemihub-hybrid_hybrid_1'],
                           capture_output=True, text=True)
    return check.stdout.strip() if check.returncode == 0 else None

def prune_hybrid_images(keep):
    """Remove local images of the hybrid repository only, except `keep`.

    Images of the existing dev stack live in other repositories and are never listed here.
    `docker rmi` without -f also refuses any image a container still uses.
    """
    keep = {image for image in keep if image}
    listed = run('docker', 'images', HYBRID_REPOSITORY, '--format', '{{.Repository}}:{{.Tag}} {{.ID}}',
                 capture_output=True, text=True).stdout
    for line in listed.splitlines():
        if not line.strip():
            continue
        reference, image_id = line.rsplit(' ', 1)
        if not reference.startswith(IMAGE_PREFIX) or reference in keep:
            continue
        target = image_id if reference.endswith(':<none>') else reference
        removed = subprocess.run(['docker', 'rmi', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if removed.returncode == 0:
            print(f'Removed old hybrid image {reference}.')

def container(image):
    if not image.startswith(IMAGE_PREFIX) or not re.fullmatch(r'[a-zA-Z0-9._-]+', image[len(IMAGE_PREFIX):]):
        raise ValueError('Only the dedicated hybrid image is allowed.')
    before = original_ids()
    previous = last_healthy_image()
    # Free space before pulling: a full disk must not stop the new image from starting.
    prune_hybrid_images({previous, running_image(), image})
    request = urllib.request.Request(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(request, timeout=10) as response:
        token = json.load(response)['access_token']
    with tempfile.TemporaryDirectory(prefix='gemihub-hybrid-registry-') as credentials:
        env = {**os.environ, 'DOCKER_CONFIG': credentials, 'HYBRID_IMAGE': image}
        town_env = ROOT / 'town.env'
        if town_env.is_file():
            env['HYBRID_RUNTIME_ENV'] = str(town_env)
        run('docker', 'login', '-u', 'oauth2accesstoken', '--password-stdin',
            'https://asia-northeast1-docker.pkg.dev', input=token.encode(), env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        compose = ['docker-compose']
        if town_env.is_file():
            compose.extend(['--env-file', str(town_env)])
        compose.extend(['-p', 'gemihub-hybrid', '-f', str(ROOT / 'compose.yaml')])
        run(*compose, 'pull', 'hybrid', env=env)
        run(*compose, 'up', '-d', '--no-deps', 'hybrid', env=env)
    # Town administration loads Firestore and rebuilds the town site at start, which can take a minute.
    for attempt in range(120):
        check = subprocess.run(['docker', 'exec', 'gemihub-hybrid_hybrid_1', 'node', '-e',
            "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if check.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('The new hybrid container did not become healthy.')
    # Record only an image that passed the health check, so it stays the rollback target.
    (ROOT / 'image.env').write_text(f'HYBRID_IMAGE={image}\n')
    if original_ids() != before:
        raise RuntimeError('An existing dev container changed unexpectedly.')
    # Keep the new image and the previous healthy one for a rollback.
    prune_hybrid_images({image, previous if previous != image else None})
    print('Hybrid container healthy; all existing container IDs unchanged.')

def site_blocks(text):
    """Top-level Caddy site blocks keyed by their address line."""
    return {m.group(1).decode(): m.group(0).strip()
            for m in re.finditer(rb'(?m)^([A-Za-z0-9.-]+) \{\n(?:.*\n)*?\}', text)}

def route():
    before_ids = original_ids()
    current = Path('/opt/gemihub-dev/Caddyfile')
    original = current.read_bytes()
    wanted = site_blocks((ROOT / 'Caddyfile').read_bytes())
    existing = site_blocks(original)
    missing = []
    for host, block in wanted.items():
        if host in existing:
            if existing[host] != block:
                raise RuntimeError(f'An unexpected {host} route already exists; refusing to overwrite it.')
        elif re.search(rb'(?m)^\s*' + re.escape(host.encode()) + rb'\b', original):
            raise RuntimeError(f'An unexpected {host} route already exists; refusing to overwrite it.')
        else:
            missing.append(block)
    if not missing:
        print('Dedicated hybrid routes already present.')
        return
    combined = original.rstrip() + b'\n\n' + b'\n\n'.join(missing) + b'\n'
    (ROOT / 'Caddyfile.candidate').write_bytes(combined)
    run('docker', 'exec', '-i', ORIGINALS[2], 'caddy', 'validate', '--config', '/dev/stdin',
        '--adapter', 'caddyfile', input=combined)
    (ROOT / f'Caddyfile.before-{time.time_ns()}').write_bytes(original)
    if current.read_bytes() != original:
        raise RuntimeError('Existing Caddy configuration changed during validation; retry safely.')
    # Keep the inode: the original Caddyfile is a read-only file bind mount.
    current.write_bytes(combined)
    try:
        run('docker', 'exec', ORIGINALS[2], 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile',
            '--adapter', 'caddyfile')
    except subprocess.CalledProcessError:
        current.write_bytes(original)
        run('docker', 'exec', ORIGINALS[2], 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile',
            '--adapter', 'caddyfile')
        raise
    if original_ids() != before_ids:
        raise RuntimeError('An existing dev container changed unexpectedly.')
    added = ', '.join(host for host, block in wanted.items() if block in missing)
    print(f'Added only {added}; existing containers were not restarted.')

if __name__ == '__main__':
    if Path.cwd().resolve() != ROOT or os.geteuid() != 0:
        raise RuntimeError('Run as root from /opt/gemihub-hybrid only.')
    if sys.argv[1:2] == ['container'] and len(sys.argv) == 3:
        container(sys.argv[2])
    elif sys.argv[1:] == ['route']:
        route()
    else:
        raise SystemExit('Usage: deploy-on-vm.py container IMAGE | route')
