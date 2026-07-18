from __future__ import annotations

import io
import tarfile
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('deploy-release.py')
PRODUCTION_COMPOSE = MODULE_PATH.parent.parent / 'production' / 'compose.yml'
REPOSITORY_ROOT = MODULE_PATH.parents[2]
PRODUCTION_WORKFLOW = REPOSITORY_ROOT / '.github' / 'workflows' / 'production.yml'
PRODUCTION_HEALTH_WORKFLOW = (
    REPOSITORY_ROOT / '.github' / 'workflows' / 'production-health.yml'
)
DEPLOY_WRAPPER = MODULE_PATH.with_name('p2p-transmission-deploy.sh')
DEPLOY_SUDOERS = (
    MODULE_PATH.parent.parent / 'production' / 'sudoers' / 'p2p-transmission-deploy'
)
BOOTSTRAP_HOST = MODULE_PATH.parent.parent / 'production' / 'bootstrap-host.sh'
CONTROL_PLANE_CLI = MODULE_PATH.parent / 'deploy_control_plane' / 'cli.py'


def write_tar_fixture(path: Path, members: dict[str, bytes]) -> None:
    with tarfile.open(path, 'w:gz') as archive:
        for name, payload in members.items():
            member = tarfile.TarInfo(name)
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
