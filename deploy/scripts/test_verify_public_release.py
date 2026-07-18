from __future__ import annotations

import importlib.util
import sys
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('verify-public-release.py')
SPEC = importlib.util.spec_from_file_location('verify_public_release', MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
verify_public_release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = verify_public_release
SPEC.loader.exec_module(verify_public_release)


class VerifyPublicReleaseTests(unittest.TestCase):
    def test_readiness_requires_the_exact_public_build(self) -> None:
        payload = {
            'status': 'ready',
            'service': 'p2p-server',
            'version': '2.0.1',
            'release': '2.0.1-abcdef0',
        }
        self.assertTrue(
            verify_public_release.readiness_matches(payload, '2.0.1', '2.0.1-abcdef0')
        )
        self.assertFalse(
            verify_public_release.readiness_matches(payload, '2.0.1', '2.0.1-abcdef1')
        )
        self.assertFalse(
            verify_public_release.readiness_matches(payload, '2.0.2', '2.0.1-abcdef0')
        )

    def test_shell_verification_fetches_css_scripts_service_worker_and_wasm(self) -> None:
        index = '''
            <!doctype html>
            <link rel="stylesheet" href="/shell/app-shell.css?v=2.0.1-abcdef0">
            <script src="/shell/room-restore.js?v=2.0.1-abcdef0"></script>
            <script src="/shell/app-shell.js?v=2.0.1-abcdef0" defer></script>
            <script type="module" src="/./assets/p2p-web-dxh778fd993dcd1d7b.js"></script>
        '''
        requested: list[str] = []

        def fetch(url: str) -> bytes:
            requested.append(url)
            if url.endswith('p2p-web-dxh778fd993dcd1d7b.js'):
                return (
                    b'new URL("p2p-web_bg.wasm", import.meta.url);'
                    b'init({module_or_path:"/./assets/'
                    b'p2p-web_bg-dxh5ece83cd412cb753.wasm"})'
                )
            return b'fixture'

        assets = verify_public_release.verify_shell_assets(
            'https://p2p.yxswy.com/', index, '2.0.1-abcdef0', fetch
        )

        expected = {
            'https://p2p.yxswy.com/shell/app-shell.css?v=2.0.1-abcdef0',
            'https://p2p.yxswy.com/shell/room-restore.js?v=2.0.1-abcdef0',
            'https://p2p.yxswy.com/shell/app-shell.js?v=2.0.1-abcdef0',
            'https://p2p.yxswy.com/sw.js',
            'https://p2p.yxswy.com/assets/p2p-web-dxh778fd993dcd1d7b.js',
            'https://p2p.yxswy.com/assets/p2p-web_bg-dxh5ece83cd412cb753.wasm',
        }
        self.assertEqual(set(requested), expected)
        self.assertEqual(set(assets), expected)

    def test_shell_verification_rejects_a_script_without_wasm(self) -> None:
        index = '''
            <link rel="stylesheet" href="/shell/app-shell.css?v=2.0.1-abcdef0">
            <script src="/shell/room-restore.js?v=2.0.1-abcdef0"></script>
            <script src="/shell/app-shell.js?v=2.0.1-abcdef0"></script>
            <script type="module" src="/assets/p2p-web-build123.js"></script>
        '''

        with self.assertRaises(verify_public_release.PublicVerificationError):
            verify_public_release.verify_shell_assets(
                'https://p2p.yxswy.com/',
                index,
                '2.0.1-abcdef0',
                lambda url: (
                    b'new URL("p2p-web_bg.wasm", import.meta.url)'
                    if url.endswith('.js')
                    else b'fixture'
                ),
            )

    def test_shell_verification_rejects_cross_origin_boot_assets(self) -> None:
        index = '''
            <link rel="stylesheet" href="https://assets.example/app-shell.css">
            <script src="/shell/room-restore.js?v=2.0.1-abcdef0"></script>
            <script src="/shell/app-shell.js?v=2.0.1-abcdef0"></script>
            <script type="module" src="/assets/p2p-web-build123.js"></script>
        '''

        with self.assertRaises(verify_public_release.PublicVerificationError):
            verify_public_release.verify_shell_assets(
                'https://p2p.yxswy.com/',
                index,
                '2.0.1-abcdef0',
                lambda _url: b'fixture',
            )

    def test_shell_verification_rejects_missing_or_stale_release_fingerprints(self) -> None:
        for fingerprint in ('', '?v=2.0.1-abcdef1'):
            with self.subTest(fingerprint=fingerprint):
                index = f'''
                    <link rel="stylesheet" href="/shell/app-shell.css{fingerprint}">
                    <script src="/shell/room-restore.js{fingerprint}"></script>
                    <script src="/shell/app-shell.js{fingerprint}"></script>
                    <script type="module" src="/assets/p2p-web-build123.js"></script>
                '''
                with self.assertRaises(verify_public_release.PublicVerificationError):
                    verify_public_release.verify_shell_assets(
                        'https://p2p.yxswy.com/',
                        index,
                        '2.0.1-abcdef0',
                        lambda _url: b'fixture',
                    )

    def test_shell_verification_rejects_duplicate_release_references(self) -> None:
        index = '''
            <link rel="stylesheet" href="/shell/app-shell.css?v=2.0.1-abcdef0">
            <link rel="stylesheet" href="/shell/app-shell.css?v=2.0.1-abcdef1">
            <script src="/shell/room-restore.js?v=2.0.1-abcdef0"></script>
            <script src="/shell/app-shell.js?v=2.0.1-abcdef0"></script>
            <script type="module" src="/assets/p2p-web-build123.js"></script>
        '''

        with self.assertRaisesRegex(
            verify_public_release.PublicVerificationError,
            'app-shell.css exactly once',
        ):
            verify_public_release.verify_shell_assets(
                'https://p2p.yxswy.com/',
                index,
                '2.0.1-abcdef0',
                lambda _url: b'fixture',
            )

    def test_base_url_must_be_a_plain_https_origin(self) -> None:
        self.assertEqual(
            verify_public_release.canonical_base_url('https://p2p.yxswy.com'),
            'https://p2p.yxswy.com/',
        )
        for invalid in (
            'http://p2p.yxswy.com/',
            'https://user@example.com/',
            'https://p2p.yxswy.com/?preview=1',
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(verify_public_release.PublicVerificationError):
                    verify_public_release.canonical_base_url(invalid)

    def test_removed_public_paths_are_all_verified_as_direct_404s(self) -> None:
        requested: list[str] = []
        paths = verify_public_release.verify_removed_public_paths(
            'https://p2p.yxswy.com/', requested.append
        )
        self.assertEqual(
            paths,
            [
                'https://p2p.yxswy.com/app',
                'https://p2p.yxswy.com/app/',
                'https://p2p.yxswy.com/index.html',
                'https://p2p.yxswy.com/shell/app.css',
                'https://p2p.yxswy.com/internal/metrics',
            ],
        )
        self.assertEqual(requested, paths)

    def test_removed_path_check_accepts_only_a_direct_404(self) -> None:
        url = 'https://p2p.yxswy.com/app'

        class ErrorOpener:
            def __init__(self, status: int) -> None:
                self.status = status

            def open(self, request: object, *, timeout: int) -> object:
                raise urllib.error.HTTPError(
                    url,
                    self.status,
                    'fixture',
                    {},
                    BytesIO(b'fixture'),
                )

        with patch.object(
            verify_public_release.urllib.request,
            'build_opener',
            return_value=ErrorOpener(404),
        ):
            verify_public_release.require_direct_404(url)

        with patch.object(
            verify_public_release.urllib.request,
            'build_opener',
            return_value=ErrorOpener(307),
        ):
            with self.assertRaises(verify_public_release.PublicVerificationError):
                verify_public_release.require_direct_404(url)


if __name__ == '__main__':
    unittest.main()
