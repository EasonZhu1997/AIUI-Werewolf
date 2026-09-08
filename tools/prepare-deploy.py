#!/usr/bin/env python3
"""Prepare a local runtime archive and reviewed plan. Does not contact any server."""
import argparse
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, type=Path, help='Deployment plan copied from deploy/plan.example.json and configured for your host')
    parser.add_argument('--vhost-sha256', required=True, help='SHA-256 obtained by read-only inspection of the target vhost')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{64}', args.vhost_sha256):
        parser.error('--vhost-sha256 must be 64 lowercase hexadecimal characters')
    spec = importlib.util.spec_from_file_location('werewolf_deploy', ROOT / 'tools/deploy-remote.py')
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    output = ROOT / 'verification/deploy-ready'
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'werewolf-runtime.tar.gz'
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode='w', format=tarfile.USTAR_FORMAT) as bundle:
        for name in sorted(deploy.RUNTIME_FILES):
            source = ROOT / name
            if source.is_symlink() or not source.is_file():
                raise RuntimeError('Runtime source must be a regular file: ' + name)
            data = source.read_bytes()
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o640
            bundle.addfile(info, io.BytesIO(data))
    archive.write_bytes(gzip.compress(payload.getvalue(), mtime=0))
    archive_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    _, version = deploy.load_archive(archive, archive_hash)
    plan.update(status='PREPARED_NOT_DEPLOYED', archiveSha256=archive_hash,
                expectedVhostSha256=args.vhost_sha256)
    plan_file = output / 'werewolf-deploy.json'
    plan_file.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    deploy.read_plan(plan_file)
    print(json.dumps({'status': 'PREPARED_NOT_DEPLOYED', 'version': version,
                      'archive': str(archive), 'archiveSha256': archive_hash,
                      'plan': str(plan_file), 'remoteWrites': False}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
