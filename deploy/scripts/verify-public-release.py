#!/usr/bin/env python3
"""Verify the public application shell and every asset needed to boot it."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from html.parser import HTMLParser
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit, urlunsplit


HASHED_APP_JS_RE = re.compile(r'^/assets/p2p-web-[A-Za-z0-9_-]+\.js$')
WASM_REFERENCE_RE = re.compile(r'''["']([^"']+\.wasm(?:\?[^"']*)?)["']''')
HASHED_WASM_RE = re.compile(r'^/assets/[A-Za-z0-9_.-]+-dxh[0-9a-f]+\.wasm$')
REQUIRED_STYLESHEET = '/shell/app-shell.css'
REQUIRED_SCRIPTS = {'/shell/room-restore.js', '/shell/app-shell.js'}
REQUIRED_ROOT_SHELL_MARKERS = {
    'transfer document title': '<title>点对点传输</title>',
    'transfer shell root': 'class="transfer-layout"',
    'transfer top bar': 'class="topbar mono"',
    'boot fallback': 'id="boot-fallback"',
}
REMOVED_PUBLIC_PATHS = (
    '/app',
    '/app/',
    '/index.html',
    '/shell/app.css',
    '/internal/metrics',
)


class PublicVerificationError(RuntimeError):
    """Raised when a public release is not complete enough to finalize."""


class ShellReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stylesheets: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == 'link' and 'stylesheet' in (values.get('rel') or '').lower().split():
            if href := values.get('href'):
                self.stylesheets.append(href)
        elif tag == 'script' and (src := values.get('src')):
            self.scripts.append(src)


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: object,
        code: int,
        message: str,
        headers: object,
        new_url: str,
    ) -> None:
        return None


def canonical_base_url(raw_url: str) -> str:
    parsed = urlsplit(raw_url)
    if (
        parsed.scheme != 'https'
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise PublicVerificationError('public verification base URL must be a plain HTTPS origin')
    return urlunsplit((parsed.scheme, parsed.netloc, '/', '', ''))


def normalized_path(url: str) -> str:
    raw_path = unquote(urlsplit(url).path)
    keep_trailing_slash = raw_path.endswith('/') and raw_path != '/'
    path = posixpath.normpath(raw_path)
    if not path.startswith('/'):
        path = f'/{path}'
    if keep_trailing_slash:
        path += '/'
    return path


def same_origin_url(base_url: str, reference: str) -> str:
    candidate = urljoin(base_url, reference)
    base = urlsplit(base_url)
    parsed = urlsplit(candidate)
    if (
        parsed.scheme.lower() != base.scheme.lower()
        or parsed.netloc.lower() != base.netloc.lower()
        or parsed.fragment
    ):
        raise PublicVerificationError(
            f'application shell contains an unsafe asset URL: {reference}'
        )
    path = normalized_path(candidate)
    return urlunsplit((base.scheme, base.netloc, path, parsed.query, ''))


def has_release_fingerprint(url: str, release_version: str) -> bool:
    return parse_qsl(urlsplit(url).query, keep_blank_values=True) == [
        ('v', release_version)
    ]


def fetch_200(url: str, *, timeout: int = 5) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'User-Agent': 'p2p-transmission-release-verifier',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            final_url = response.geturl()
            body = response.read()
    except OSError as error:
        raise PublicVerificationError(f'public request failed for {url}: {error}') from error
    if status != 200:
        raise PublicVerificationError(f'public resource returned HTTP {status}: {url}')
    if final_url != url:
        raise PublicVerificationError(f'public resource redirected from {url} to {final_url}')
    if not body:
        raise PublicVerificationError(f'public resource is empty: {url}')
    return body


def require_direct_404(url: str, *, timeout: int = 5) -> None:
    request = urllib.request.Request(
        url,
        headers={
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'User-Agent': 'p2p-transmission-release-verifier',
        },
    )
    opener = urllib.request.build_opener(NoRedirects)
    try:
        with opener.open(request, timeout=timeout) as response:
            status = response.status
            response.read()
    except urllib.error.HTTPError as error:
        error.read()
        if error.code == 404 and error.geturl() == url:
            return
        raise PublicVerificationError(
            f'removed public path returned HTTP {error.code} instead of 404: {url}'
        ) from error
    except OSError as error:
        raise PublicVerificationError(f'public request failed for {url}: {error}') from error
    raise PublicVerificationError(
        f'removed public path returned HTTP {status} instead of 404: {url}'
    )


def verify_removed_public_paths(
    base_url: str,
    verify: Callable[[str], None] = require_direct_404,
) -> list[str]:
    urls = [same_origin_url(base_url, path) for path in REMOVED_PUBLIC_PATHS]
    for url in urls:
        verify(url)
    return urls


def readiness_matches(payload: object, app_version: str, release_version: str) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get('status') == 'ready'
        and payload.get('service') == 'p2p-server'
        and payload.get('version') == app_version
        and payload.get('release') == release_version
    )


def wait_for_public_readiness(
    base_url: str,
    app_version: str,
    release_version: str,
    *,
    attempts: int = 30,
    interval: int = 2,
) -> dict[str, object]:
    health_url = same_origin_url(base_url, '/health/ready')
    last_error = 'readiness payload did not match the staged release'
    for attempt in range(attempts):
        try:
            payload = json.loads(fetch_200(health_url).decode('utf-8'))
            if readiness_matches(payload, app_version, release_version):
                return payload
            last_error = 'readiness payload did not match the staged release'
        except (PublicVerificationError, UnicodeDecodeError, json.JSONDecodeError) as error:
            last_error = str(error)
        if attempt + 1 < attempts:
            time.sleep(interval)
    raise PublicVerificationError(f'public readiness check failed: {last_error}')


def verify_root_application_shell(index_html: str) -> None:
    missing = [
        label
        for label, marker in REQUIRED_ROOT_SHELL_MARKERS.items()
        if marker not in index_html
    ]
    if missing:
        raise PublicVerificationError(
            f'public root application shell is missing: {", ".join(missing)}'
        )


def verify_shell_assets(
    base_url: str,
    index_html: str,
    release_version: str,
    fetch: Callable[[str], bytes] = fetch_200,
) -> list[str]:
    references = ShellReferences()
    references.feed(index_html)
    stylesheet_urls = [same_origin_url(base_url, ref) for ref in references.stylesheets]
    script_urls = [same_origin_url(base_url, ref) for ref in references.scripts]
    scripts_by_path = {normalized_path(url): url for url in script_urls}

    def require_one(urls: list[str], path: str) -> str:
        matches = [url for url in urls if normalized_path(url) == path]
        if len(matches) != 1:
            raise PublicVerificationError(
                f'public shell must reference {path} exactly once; found {len(matches)}'
            )
        return matches[0]

    versioned_shell_urls = {
        REQUIRED_STYLESHEET: require_one(stylesheet_urls, REQUIRED_STYLESHEET),
        **{path: require_one(script_urls, path) for path in REQUIRED_SCRIPTS},
    }
    for path, url in versioned_shell_urls.items():
        if not has_release_fingerprint(url, release_version):
            raise PublicVerificationError(
                f'public shell asset does not match release {release_version}: {path}'
            )
    hashed_scripts = {
        path: url for path, url in scripts_by_path.items() if HASHED_APP_JS_RE.fullmatch(path)
    }
    if not hashed_scripts:
        raise PublicVerificationError('public shell does not reference a hashed application script')

    required_urls = {
        *versioned_shell_urls.values(),
        same_origin_url(base_url, '/sw.js'),
    }
    fetched = set(required_urls)
    for url in sorted(required_urls):
        fetch(url)

    wasm_urls: set[str] = set()
    for script_url in sorted(hashed_scripts.values()):
        source = fetch(script_url).decode('utf-8')
        fetched.add(script_url)
        for reference in WASM_REFERENCE_RE.findall(source):
            wasm_url = same_origin_url(script_url, reference)
            path = normalized_path(wasm_url)
            if HASHED_WASM_RE.fullmatch(path):
                wasm_urls.add(wasm_url)
    if not wasm_urls:
        raise PublicVerificationError(
            'hashed application script does not reference a WebAssembly asset'
        )
    for url in sorted(wasm_urls):
        fetch(url)
        fetched.add(url)
    return sorted(fetched)


def verify_public_release(
    base_url: str,
    app_version: str,
    release_version: str,
) -> dict[str, object]:
    base_url = canonical_base_url(base_url)
    readiness = wait_for_public_readiness(base_url, app_version, release_version)
    index_url = same_origin_url(base_url, '/')
    try:
        index_html = fetch_200(index_url).decode('utf-8')
    except UnicodeDecodeError as error:
        raise PublicVerificationError('public application shell is not UTF-8') from error
    verify_root_application_shell(index_html)
    assets = verify_shell_assets(base_url, index_html, release_version)
    removed_paths = verify_removed_public_paths(base_url)
    return {'readiness': readiness, 'assets': assets, 'removed_paths': removed_paths}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='https://p2p.yxswy.com/')
    parser.add_argument('--app-version', required=True)
    parser.add_argument('--release-version', required=True)
    args = parser.parse_args()
    try:
        result = verify_public_release(args.base_url, args.app_version, args.release_version)
    except PublicVerificationError as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
