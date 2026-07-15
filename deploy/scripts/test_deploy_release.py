from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('deploy-release.py')
SPEC = importlib.util.spec_from_file_location('deploy_release', MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
deploy_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_release)


class DeployReleaseTests(unittest.TestCase):
    def test_parses_legacy_env_without_exposing_comments(self) -> None:
        values = deploy_release.parse_env_text(
            '# comment\nTURN_URLS=turn:example.test\nTURN_SHARED_SECRET="secret-value"\n'
        )
        self.assertEqual(values['TURN_URLS'], 'turn:example.test')
        self.assertEqual(values['TURN_SHARED_SECRET'], 'secret-value')

    def test_builds_production_v2_env_from_legacy_turn_settings(self) -> None:
        values = deploy_release.build_v2_env(
            {},
            {
                'TURN_URLS': 'turn:turn.p2p.yxswy.com:3478?transport=udp',
                'TURN_SHARED_SECRET': 'turn-secret-0123456789abcdef',
            },
            '2.0.0-rc.1-abcdef0',
            capability_secret='capability-secret-0123456789abcdef0123456789',
        )
        self.assertEqual(values['P2P_ALLOWED_ORIGINS'], 'https://p2p.yxswy.com')
        self.assertEqual(values['P2P_BIND_IP'], '127.0.0.1')
        self.assertEqual(values['P2P_IMAGE_TAG'], '2.0.0-rc.1-abcdef0')
        self.assertEqual(values['P2P_TURN_SECRET'], 'turn-secret-0123456789abcdef')

    def test_preserves_existing_v2_secrets_during_update(self) -> None:
        values = deploy_release.build_v2_env(
            {
                'P2P_CAPABILITY_SECRET': 'existing-capability-secret-0123456789',
                'P2P_TURN_SECRET': 'existing-turn-secret',
                'P2P_TURN_URLS': 'turns:existing.example:5349',
            },
            {},
            '2.0.0-rc.1-abcdef1',
            capability_secret='unused-capability-secret-0123456789012345',
        )
        self.assertEqual(
            values['P2P_CAPABILITY_SECRET'],
            'existing-capability-secret-0123456789',
        )
        self.assertEqual(values['P2P_TURN_SECRET'], 'existing-turn-secret')

    def test_rejects_newlines_in_env_values(self) -> None:
        with self.assertRaises(ValueError):
            deploy_release.format_env({'P2P_TURN_SECRET': 'secret\ninjected=true'})


if __name__ == '__main__':
    unittest.main()
