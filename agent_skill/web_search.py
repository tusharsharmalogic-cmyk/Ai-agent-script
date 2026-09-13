#!/usr/bin/env python3
"""
Web search + download helper for the Termux AI Agent.

Search backend : DuckDuckGo HTML (via lynx text browser — no API key).
Download       : streaming HTTP(S) with live progress callback.

Usage (via agent.py endpoints — do not call directly from shell):
    search(query, num=10)                  -> list of {title, url, snippet}
    download(url, dest, overwrite=False)   -> {status, path, size, ...}
"""

import os
import re
import subprocess
import shutil
import urllib.parse
import requests


# ── Search ────────────────────────────────────────────────────────────────

LYNX = shutil.which('lynx') or 'lynx'


def _clean_ws(s):
    return re.sub(r'\s+', ' ', s).strip()


def _fetch_ddg_html(query, num=10):
    """Fetch DDG HTML search results via lynx text browser."""
    encoded = urllib.parse.quote_plus(query)
    url = f'https://html.duckduckgo.com/html/?q={encoded}'
    try:
        out = subprocess.run(
            [LYNX, '-dump', '-nolist', '-width=200', url],
            capture_output=True, text=True, timeout=25,
        )
    except subprocess.TimeoutExpired:
        return None, '❌ Search timeout (25s)'
    if out.returncode != 0 and not out.stdout.strip():
        return None, f'❌ lynx failed (exit {out.returncode}): {out.stderr[:200]}'
    return out.stdout, None


# Result link line looks like:
#    wiki.termux.com/wiki/Getting_started
# Followed by the snippet, indented.
_URL_LINE_RE = re.compile(
    r'^\s{3,}(https?://[^\s]+|[a-z0-9][a-z0-9\-.]*\.[a-z]{2,}[^\s]*)\s*$',
    re.IGNORECASE,
)


def _parse_results(text):
    """
    Parse lynx-dump of DDG HTML into a list of dicts.

    DDG HTML in text form looks like:
        Getting started - Termux Wiki

           wiki.termux.com/wiki/Getting_started
           When following tutorial examples...

        A Simple Termux Tutorial for Beginners · Ivon's Blog

           ivonblog.com/en-us/posts/how-to-use-termux/
           How to use the Termux App? ...
    """
    lines = text.splitlines()
    results = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i].rstrip()

        # A title line: non-empty, not indented, not the DDG header lines
        if (line and not line.startswith(' ')
                and not line.startswith('#')
                and not line.startswith('_')
                and 'DuckDuckGo' not in line
                and 'Submit' not in line
                and not line.startswith('[')
                and len(line) > 3):
            title = _clean_ws(line)

            # Look ahead for a URL line
            j = i + 1
            url = None
            while j < n and j < i + 6:
                cand = lines[j]
                m = _URL_LINE_RE.match(cand)
                if m:
                    url = m.group(1)
                    break
                if cand.strip() and not cand.startswith(' '):
                    break
                j += 1

            if url:
                # Snippet is subsequent indented non-empty lines until blank
                snippet_lines = []
                k = j + 1
                while k < n and k < j + 12:
                    s = lines[k].rstrip()
                    if not s.strip():
                        if snippet_lines:
                            break
                        k += 1
                        continue
                    if not s.startswith(' '):
                        break
                    snippet_lines.append(_clean_ws(s))
                    k += 1

                # Normalize URL (add scheme for bare domains)
                if not url.startswith('http'):
                    url = 'https://' + url

                results.append({
                    'title':   title,
                    'url':     url,
                    'snippet': ' '.join(snippet_lines)[:300],
                })
                i = k
                if len(results) >= 50:
                    break
                continue
        i += 1

    return results


def search(query, num=10):
    """DDG search, returns (results_list, error_or_None)."""
    if not query.strip():
        return [], '❌ Query khali hai'

    text, err = _fetch_ddg_html(query, num)
    if err:
        return [], err

    results = _parse_results(text)
    if not results:
        return [], '🔍 No results mile'
    return results[:num], None


# ── Download ──────────────────────────────────────────────────────────────

UA = ('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')


def download(url, dest, overwrite=False, progress_cb=None, timeout=60):
    """
    Stream-download a URL to dest with live progress.

    progress_cb(bytes_done, total_bytes_or_0) is called periodically.
    Returns dict: {status, path, size, message, error}.
    """
    if not url.strip():
        return {'status': 'error', 'message': '❌ URL khali hai'}

    dest = os.path.expanduser(dest)
    os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)

    if os.path.exists(dest) and not overwrite:
        return {
            'status': 'error',
            'message': f'❌ File already exists: {dest} (overwrite=true use karo)',
        }

    try:
        with requests.get(url, stream=True, timeout=timeout,
                          headers={'User-Agent': UA}, allow_redirects=True) as r:
            r.raise_for_status()
            total = int(r.headers.get('Content-Length') or 0)
            done  = 0
            last_report = 0
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(chunk_size=32 * 1024):
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    if progress_cb:
                        # report roughly every 64KB
                        if done - last_report >= 64 * 1024:
                            progress_cb(done, total)
                            last_report = done
            if progress_cb:
                progress_cb(done, total)

        size = os.path.getsize(dest)
        return {
            'status': 'ok',
            'path':   dest,
            'size':   size,
            'message': f'✅ Downloaded: {dest} ({size} bytes)',
        }
    except requests.exceptions.HTTPError as e:
        return {'status': 'error', 'message': f'❌ HTTP {e.response.status_code} — {url}'}
    except requests.exceptions.Timeout:
        return {'status': 'error', 'message': f'❌ Timeout ({timeout}s) — {url}'}
    except Exception as e:
        return {'status': 'error', 'message': f'❌ Download fail: {e}'}