#!/usr/bin/env python3
"""
RAINCLOUD SEO Engine — Shared helpers
All workflow modules import from this file.

NOTE: Uses `requests` (not urllib) because the HyperAgent sandbox routes
outbound traffic through an HTTPS proxy (HTTPS_PROXY env var). Python's
stdlib urllib cannot tunnel through HTTPS proxies correctly; `requests`
handles this transparently via environment variables.
"""
import json
import os
import base64
import time
import ssl
import urllib.request
import urllib.parse

try:
    import requests as _requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False


# ---------------------------------------------------------------------------
# HTTP utilities — requests-first, urllib fallback
# ---------------------------------------------------------------------------

def http_post(url, data, headers=None, timeout=60):
    """POST JSON data to URL, return parsed response."""
    merged_headers = {'Content-Type': 'application/json'}
    if headers:
        merged_headers.update(headers)
    if _HAS_REQUESTS:
        resp = _requests.post(url, json=data, headers=merged_headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    # urllib fallback (may fail through HTTPS proxy)
    import ssl, urllib.request
    body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=body)
    for k, v in merged_headers.items():
        req.add_header(k, v)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


def http_get(url, headers=None, timeout=60):
    """GET URL, return parsed response."""
    if _HAS_REQUESTS:
        resp = _requests.get(url, headers=headers or {}, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    import ssl, urllib.request
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


def http_patch(url, data, headers=None, timeout=60):
    """PATCH JSON data to URL, return parsed response."""
    merged_headers = {'Content-Type': 'application/json'}
    if headers:
        merged_headers.update(headers)
    if _HAS_REQUESTS:
        resp = _requests.patch(url, json=data, headers=merged_headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    import ssl, urllib.request
    body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='PATCH')
    for k, v in merged_headers.items():
        req.add_header(k, v)
    ctx = ssl.create_default_context()
    ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


# ---------------------------------------------------------------------------
# DataForSEO auth
# ---------------------------------------------------------------------------

def dfs_auth():
    """Return Basic Auth header dict for DataForSEO."""
    creds = f"{os.environ['DATAFORSEO_LOGIN']}:{os.environ['DATAFORSEO_PASSWORD']}"
    return {'Authorization': 'Basic ' + base64.b64encode(creds.encode()).decode()}


# ---------------------------------------------------------------------------
# Callback helper
# ---------------------------------------------------------------------------

def post_callback(callback_url, job_id, workflow_id, status,
                  result=None, error=None, log_message=None):
    """POST a status update back to the Node.js callback URL."""
    payload = {'job_id': job_id, 'workflow_id': workflow_id, 'status': status}
    if result is not None:
        payload['result'] = result
    if error is not None:
        payload['error'] = error
    if log_message is not None:
        payload['log_message'] = log_message
    try:
        http_post(callback_url, payload, timeout=30)
    except Exception as e:
        print(f"[callback] Failed to send callback: {e}")


# ---------------------------------------------------------------------------
# Google Service Account JWT + token exchange
# ---------------------------------------------------------------------------

def get_google_access_token(service_account_json, scopes):
    """
    Obtain a short-lived Google OAuth2 access token from a service account.

    service_account_json: dict with keys private_key, client_email, token_uri
    scopes: list of OAuth scope strings
    Returns: access_token string
    """
    import time

    client_email = service_account_json['client_email']
    private_key_pem = service_account_json['private_key']
    token_uri = service_account_json.get('token_uri', 'https://oauth2.googleapis.com/token')

    now = int(time.time())
    header = {'alg': 'RS256', 'typ': 'JWT'}
    claim_set = {
        'iss': client_email,
        'scope': ' '.join(scopes),
        'aud': token_uri,
        'exp': now + 3600,
        'iat': now,
    }

    def b64url(data):
        if isinstance(data, dict):
            data = json.dumps(data, separators=(',', ':')).encode('utf-8')
        return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')

    signing_input = f"{b64url(header)}.{b64url(claim_set)}".encode('utf-8')

    # Sign with RS256 using cryptography library
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding as asym_padding
        from cryptography.hazmat.backends import default_backend

        private_key = serialization.load_pem_private_key(
            private_key_pem.encode('utf-8'),
            password=None,
            backend=default_backend()
        )
        signature = private_key.sign(signing_input, asym_padding.PKCS1v15(), hashes.SHA256())
    except ImportError:
        # Fallback: use subprocess openssl
        import subprocess, tempfile
        with tempfile.NamedTemporaryFile(suffix='.pem', delete=False, mode='w') as f:
            f.write(private_key_pem)
            key_path = f.name
        try:
            proc = subprocess.run(
                ['openssl', 'dgst', '-sha256', '-sign', key_path],
                input=signing_input,
                capture_output=True
            )
            if proc.returncode != 0:
                raise RuntimeError(f"openssl failed: {proc.stderr.decode()}")
            signature = proc.stdout
        finally:
            os.unlink(key_path)

    jwt_token = f"{signing_input.decode('ascii')}.{b64url(signature)}"

    # Exchange JWT for access token
    token_data = urllib.parse.urlencode({
        'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        'assertion': jwt_token,
    }).encode('utf-8')

    req = urllib.request.Request(token_uri, data=token_data)
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
        token_resp = json.loads(resp.read().decode('utf-8'))

    if 'access_token' not in token_resp:
        raise RuntimeError(f"Failed to obtain access token: {token_resp}")

    return token_resp['access_token']


# ---------------------------------------------------------------------------
# Exa search helper
# ---------------------------------------------------------------------------

def exa_search(query, num_results=10, include_domains=None, exclude_domains=None,
               search_type='neural', contents=None, use_autoprompt=True):
    """Wrapper around Exa /search endpoint."""
    api_key = os.environ.get('EXA_API_KEY', '')
    payload = {
        'query': query,
        'numResults': num_results,
        'type': search_type,
        'useAutoprompt': use_autoprompt,
    }
    if include_domains:
        payload['includeDomains'] = include_domains
    if exclude_domains:
        payload['excludeDomains'] = exclude_domains
    if contents:
        payload['contents'] = contents

    headers = {
        'x-api-key': api_key,
        'Accept': 'application/json',
    }
    try:
        return http_post('https://api.exa.ai/search', payload, headers=headers, timeout=60)
    except Exception as e:
        print(f"[exa_search] Error: {e}")
        return {'results': []}


# ---------------------------------------------------------------------------
# Claude API helper
# ---------------------------------------------------------------------------

def claude_message(system_prompt, user_message, max_tokens=500,
                   model='claude-sonnet-4-20250514'):
    """Call Anthropic Claude and return the text of the first content block."""
    api_key = os.environ.get('ANTHROPIC_API_KEY', '')
    headers = {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
    }
    payload = {
        'model': model,
        'max_tokens': max_tokens,
        'system': system_prompt,
        'messages': [{'role': 'user', 'content': user_message}],
    }
    resp = http_post('https://api.anthropic.com/v1/messages', payload,
                     headers=headers, timeout=120)
    return resp['content'][0]['text']


# ---------------------------------------------------------------------------
# Domain extraction
# ---------------------------------------------------------------------------

def extract_domain(url):
    """Extract bare domain (no scheme, no path) from a URL string."""
    try:
        parsed = urllib.parse.urlparse(url if '://' in url else 'https://' + url)
        return parsed.netloc.lower().lstrip('www.')
    except Exception:
        return url.lower().lstrip('www.')


# ---------------------------------------------------------------------------
# Slug generation
# ---------------------------------------------------------------------------

def keyword_to_slug(keyword):
    """Convert a keyword string to a URL-friendly slug."""
    import re
    slug = keyword.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'\s+', '-', slug)
    slug = re.sub(r'-+', '-', slug).strip('-')
    return f"/{slug}/"


# ---------------------------------------------------------------------------
# Batch utilities
# ---------------------------------------------------------------------------

def chunked(lst, size):
    """Yield successive chunks of `size` from list."""
    for i in range(0, len(lst), size):
        yield lst[i:i + size]
