#!/usr/bin/env python3
"""
WF17 — Plagiarism Check
Checks article text for plagiarism using Quetext API, with a Claude-based fallback.
"""
import os
import re
import json

import requests

from helpers import http_post, http_get, post_callback, claude_message, chunked

WORKFLOW_ID = 'Plagiarism_Check'

WORDS_PER_CHUNK = 1500


def split_into_chunks(text, words_per_chunk=WORDS_PER_CHUNK):
    """Split text into chunks of approximately words_per_chunk words."""
    words = text.split()
    chunks = []
    for i in range(0, len(words), words_per_chunk):
        chunks.append(' '.join(words[i:i + words_per_chunk]))
    return chunks if chunks else [text]


def check_chunk_quetext(chunk, api_key):
    """
    POST a single chunk to Quetext DeepCheck.
    Returns (score_float, flagged_passages_list).
    """
    resp = requests.post(
        'https://quetext.com/api/v1/deepcheck',
        json={'text': chunk, 'maxDelay': 0, 'language': 'en'},
        headers={'x-api-key': api_key},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    inner = data.get('data', {})
    score = float(inner.get('score', 0.0))
    results = inner.get('results', []) or []
    flagged = [
        {
            'text': r.get('text', ''),
            'source': r.get('source', ''),
            'percentMatch': r.get('percentMatch', 0),
        }
        for r in results
    ]
    return score, flagged


def check_via_claude(body_text):
    """
    Fallback: ask Claude to identify potentially plagiarised passages.
    Returns (score_float, flagged_passages_list).
    """
    system_prompt = (
        'You are a plagiarism detection assistant. '
        'Identify passages in the text that appear to be directly copied or closely '
        'paraphrased from common sources. '
        'Return ONLY valid JSON. No preamble.'
    )
    user_message = (
        f'Text to analyse:\n{body_text[:8000]}\n\n'
        'Return JSON: { "score": 0.0-1.0, "flagged_passages": '
        '[{ "text": "...", "likely_source": "...", "confidence": "high|medium|low" }] }'
    )

    try:
        raw = claude_message(system_prompt, user_message, max_tokens=1000)
        raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
        raw = re.sub(r'```\s*$', '', raw.strip())
        parsed = json.loads(raw)
        score = float(parsed.get('score', 0.0))
        flagged = parsed.get('flagged_passages', [])
        # Normalise keys to match Quetext structure
        normalised = [
            {
                'text': p.get('text', ''),
                'source': p.get('likely_source', ''),
                'percentMatch': int(p.get('confidence', 'low') == 'high') * 90
                + int(p.get('confidence', 'low') == 'medium') * 60,
            }
            for p in flagged
        ]
        return score, normalised
    except Exception as e:
        print(f'[WF17] Claude fallback error: {e}')
        return 0.0, []


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { draft_id, body_text, threshold }
    returns: { draft_id, score, score_pct, threshold, passed, flagged_passages,
               chunks_checked, total_words, method }
    """
    draft_id = payload.get('draft_id', '')
    body_text = payload.get('body_text', '')
    threshold = int(payload.get('threshold', 30))

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF17: Starting plagiarism check for draft {draft_id} '
                               f'({len(body_text.split())} words)...')

    api_key = os.environ.get('QUETEXT_API_KEY', '')
    method = 'quetext' if api_key else 'claude_fallback'

    # Step 1: Chunk the text
    chunks = split_into_chunks(body_text, WORDS_PER_CHUNK)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF17: Checking {len(chunks)} chunk(s) via {method}...')

    all_flagged = []
    chunk_scores = []  # (score, word_count)

    if method == 'quetext':
        for idx, chunk in enumerate(chunks):
            try:
                score, flagged = check_chunk_quetext(chunk, api_key)
                chunk_scores.append((score, len(chunk.split())))
                all_flagged.extend(flagged)
                print(f'[WF17] Chunk {idx + 1}/{len(chunks)}: score={score:.3f}, '
                      f'flagged={len(flagged)}')
            except Exception as e:
                print(f'[WF17] Quetext error on chunk {idx + 1}: {e}. '
                      'Falling back to Claude for this chunk.')
                score, flagged = check_via_claude(chunk)
                chunk_scores.append((score, len(chunk.split())))
                all_flagged.extend(flagged)
    else:
        # Claude fallback: process all text at once (truncated)
        score, flagged = check_via_claude(body_text)
        chunk_scores.append((score, len(body_text.split())))
        all_flagged.extend(flagged)

    # Step 3: Weighted average score across chunks
    total_words_checked = sum(wc for _, wc in chunk_scores)
    if total_words_checked > 0:
        overall_score = sum(s * wc for s, wc in chunk_scores) / total_words_checked
    else:
        overall_score = 0.0

    return {
        'draft_id': draft_id,
        'score': round(overall_score, 4),
        'score_pct': round(overall_score * 100, 1),
        'threshold': threshold,
        'passed': overall_score * 100 <= threshold,
        'flagged_passages': all_flagged,
        'chunks_checked': len(chunks),
        'total_words': len(body_text.split()),
        'method': method,
    }
