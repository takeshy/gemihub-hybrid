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

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def original_ids():
    return run('docker', 'inspect', '--format', '{{.Id}}', *ORIGINALS,
               capture_output=True, text=True).stdout

def container(image):
    if not image.startswith(IMAGE_PREFIX) or not re.fullmatch(r'[a-zA-Z0-9._-]+', image[len(IMAGE_PREFIX):]):
        raise ValueError('Only the dedicated hybrid image is allowed.')
    before = original_ids()
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
    (ROOT / 'image.env').write_text(f'HYBRID_IMAGE={image}\n')
    for attempt in range(20):
        check = subprocess.run(['docker', 'exec', 'gemihub-hybrid_hybrid_1', 'node', '-e',
            "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if check.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('The new hybrid container did not become healthy.')
    if original_ids() != before:
        raise RuntimeError('An existing dev container changed unexpectedly.')
    print('Hybrid container healthy; all existing container IDs unchanged.')

def route():
    before_ids = original_ids()
    current = Path('/opt/gemihub-dev/Caddyfile')
    original = current.read_bytes()
    addition = (ROOT / 'Caddyfile').read_bytes().strip()
    if b'hybrid.gemihub.net' in original:
        if addition not in original:
            raise RuntimeError('An unexpected hybrid route already exists; refusing to overwrite it.')
        print('Dedicated hybrid route already present.')
        return
    combined = original.rstrip() + b'\n\n' + addition + b'\n'
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
    print('Added only hybrid.gemihub.net; existing containers were not restarted.')

if __name__ == '__main__':
    if Path.cwd().resolve() != ROOT or os.geteuid() != 0:
        raise RuntimeError('Run as root from /opt/gemihub-hybrid only.')
    if sys.argv[1:2] == ['container'] and len(sys.argv) == 3:
        container(sys.argv[2])
    elif sys.argv[1:] == ['route']:
        route()
    else:
        raise SystemExit('Usage: deploy-on-vm.py container IMAGE | route')
