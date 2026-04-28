#!/usr/bin/env python3
"""
WF20 — Google Doc Export
Exports article + LinkedIn posts into a Google Doc via the Docs API.
"""
import os
import re
import json

import requests

from helpers import http_post, http_get, post_callback, claude_message, chunked, get_google_access_token

WORKFLOW_ID = 'Google_Doc_Export'

GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
]


def html_to_doc_text(html):
    """Convert HTML to plain text preserving structural cues."""
    text = html
    # Convert headings
    text = re.sub(r'<h2[^>]*>(.*?)</h2>', r'\n## \1\n', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<h3[^>]*>(.*?)</h3>', r'\n### \1\n', text, flags=re.DOTALL | re.IGNORECASE)
    # Convert list items
    text = re.sub(r'<li[^>]*>(.*?)</li>', r'\n• \1', text, flags=re.DOTALL | re.IGNORECASE)
    # Strip remaining tags
    text = re.sub(r'<[^>]+>', '', text)
    # Clean whitespace
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text


def build_doc_content(payload):
    """Assemble the full document text from payload."""
    title = payload.get('title', '')
    target_keyword = payload.get('target_keyword', '')
    meta_title = payload.get('meta_title', '')
    meta_description = payload.get('meta_description', '')
    body_html = payload.get('body_html', '')
    linkedin_posts = payload.get('linkedin_posts', {}) or {}
    personal_posts = linkedin_posts.get('personal', []) or []
    company_posts_raw = linkedin_posts.get('company', []) or []

    article_body = html_to_doc_text(body_html)

    lines = []
    lines.append(title)
    lines.append(f"{target_keyword} | Meta: {meta_title}")
    lines.append('')
    lines.append('---')
    lines.append('')
    lines.append(article_body)
    lines.append('')
    lines.append('---')
    lines.append('META INFORMATION')
    lines.append(f"Title Tag: {meta_title}")
    lines.append(f"Meta Description: {meta_description}")
    lines.append('')
    lines.append('---')
    lines.append('LINKEDIN POSTS — PERSONAL')
    lines.append('')

    for entry in personal_posts:
        persona = entry.get('persona', {})
        posts = entry.get('posts', [])
        lines.append(f"{persona.get('name', '')}, {persona.get('title', '')}")
        lines.append('')

        labels = ['Post 1 (Hook):', 'Post 2 (Personal Story):', 'Post 3 (Data/List):']
        for idx, post_text in enumerate(posts[:3]):
            label = labels[idx] if idx < len(labels) else f'Post {idx + 1}:'
            lines.append(label)
            lines.append(post_text)
            lines.append('')

    lines.append('---')
    lines.append('LINKEDIN POSTS — COMPANY PAGE')
    lines.append('')

    company_labels = [
        'Post 1 (Educational):',
        'Post 2 (Industry Trend):',
        'Post 3 (Practical Tips):',
    ]

    # company_posts_raw may be a list of strings or a list of objects
    for idx, item in enumerate(company_posts_raw[:3]):
        label = company_labels[idx] if idx < len(company_labels) else f'Post {idx + 1}:'
        post_text = item if isinstance(item, str) else item.get('text', str(item))
        lines.append(label)
        lines.append(post_text)
        lines.append('')

    return '\n'.join(lines)


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { draft_id, title, body_html, linkedin_posts, client_name,
               project_name, target_keyword, meta_title, meta_description, folder_id }
    returns: { draft_id, doc_id, doc_url, title, sections }
    """
    draft_id = payload.get('draft_id', '')
    title = payload.get('title', '')
    client_name = payload.get('client_name', '')
    folder_id = payload.get('folder_id') or None

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF20: Preparing Google Doc export for draft {draft_id}...')

    # Step 1: Build document content
    doc_content = build_doc_content(payload)

    # Step 2: Get Google credentials
    service_account_json_raw = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '')
    service_account_json = None

    if service_account_json_raw:
        try:
            service_account_json = json.loads(service_account_json_raw)
        except json.JSONDecodeError as e:
            print(f'[WF20] Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: {e}')

    if not service_account_json:
        print('[WF20] No Google service account available. Returning partial result.')
        return {
            'draft_id': draft_id,
            'doc_id': None,
            'doc_url': None,
            'title': f"{client_name} — {title}",
            'sections': ['article', 'meta', 'linkedin_personal', 'linkedin_company'],
            'error': 'GOOGLE_SERVICE_ACCOUNT_JSON not set or invalid.',
            'doc_content': doc_content,
        }

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF20: Authenticating with Google and creating document...')

    # Step 3: Get access token
    try:
        access_token = get_google_access_token(service_account_json, GOOGLE_SCOPES)
    except Exception as e:
        print(f'[WF20] Failed to get Google access token: {e}')
        return {
            'draft_id': draft_id,
            'doc_id': None,
            'doc_url': None,
            'title': f"{client_name} — {title}",
            'sections': ['article', 'meta', 'linkedin_personal', 'linkedin_company'],
            'error': f'Google auth failed: {e}',
            'doc_content': doc_content,
        }

    auth_header = {'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'}
    doc_title = f"{client_name} — {title}"

    # Step 4: Create the Google Doc
    try:
        doc_resp = requests.post(
            'https://docs.googleapis.com/v1/documents',
            json={'title': doc_title},
            headers=auth_header,
            timeout=30,
        )
        doc_resp.raise_for_status()
        doc_id = doc_resp.json()['documentId']
    except Exception as e:
        print(f'[WF20] Failed to create Google Doc: {e}')
        return {
            'draft_id': draft_id,
            'doc_id': None,
            'doc_url': None,
            'title': doc_title,
            'sections': ['article', 'meta', 'linkedin_personal', 'linkedin_company'],
            'error': f'Doc creation failed: {e}',
        }

    # Step 5: Insert content via batchUpdate
    try:
        batch_resp = requests.post(
            f'https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate',
            json={'requests': [{'insertText': {'location': {'index': 1}, 'text': doc_content}}]},
            headers=auth_header,
            timeout=30,
        )
        batch_resp.raise_for_status()
    except Exception as e:
        print(f'[WF20] Warning: batchUpdate failed: {e}')
        # Doc was created but content insertion failed — still return partial result

    # Step 6: Move to folder if provided
    if folder_id:
        try:
            move_resp = requests.patch(
                f'https://www.googleapis.com/drive/v3/files/{doc_id}',
                params={'addParents': folder_id, 'fields': 'id,parents'},
                headers={'Authorization': f'Bearer {access_token}'},
                timeout=30,
            )
            move_resp.raise_for_status()
        except Exception as e:
            print(f'[WF20] Warning: could not move doc to folder {folder_id}: {e}')

    doc_url = f'https://docs.google.com/document/d/{doc_id}/edit'

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF20: Google Doc created: {doc_url}')

    return {
        'draft_id': draft_id,
        'doc_id': doc_id,
        'doc_url': doc_url,
        'title': doc_title,
        'sections': ['article', 'meta', 'linkedin_personal', 'linkedin_company'],
    }
