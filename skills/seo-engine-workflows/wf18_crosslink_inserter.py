#!/usr/bin/env python3
"""
WF18 — CrossLink Inserter
Inserts internal cross-links into article body HTML without duplicating links.
"""
import re

from helpers import http_post, http_get, post_callback, claude_message, chunked

WORKFLOW_ID = 'CrossLink_Inserter'


def insert_link(html, anchor_text, destination_url, already_linked):
    """
    Find first occurrence of anchor_text in html text nodes (not already in <a> tags).
    Wrap with <a href="{destination_url}">{anchor_text}</a>.
    Only insert ONCE per anchor — avoid duplicate links to same destination.
    """
    if destination_url in already_linked:
        return html, False

    # Pattern: anchor text NOT preceded by href=" and NOT inside a tag
    pattern = rf'(?<!href=")(?<![<>a-zA-Z/])\b({re.escape(anchor_text)})\b(?![^<]*>)'

    inserted = [False]

    def replace_first(m):
        if not inserted[0]:
            inserted[0] = True
            already_linked.add(destination_url)
            return f'<a href="{destination_url}">{m.group(1)}</a>'
        return m.group(0)

    new_html = re.sub(pattern, replace_first, html, flags=re.IGNORECASE)
    return new_html, inserted[0]


def try_shorter_anchor(html, anchor_text, destination_url, already_linked):
    """
    If the full anchor phrase wasn't found, try the longest sub-phrase
    by progressively dropping the first word until a match is found.
    """
    words = anchor_text.split()
    # Try dropping one word from the front each time
    for start in range(1, len(words)):
        shorter = ' '.join(words[start:])
        if len(shorter) < 4:
            continue
        new_html, success = insert_link(html, shorter, destination_url, already_linked)
        if success:
            return new_html, True, shorter
    return html, False, None


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { draft_id, body_html, cross_links }
    returns: { draft_id, body_html_with_links, links_inserted, insert_count, not_found }
    """
    draft_id = payload.get('draft_id', '')
    body_html = payload.get('body_html', '')
    cross_links = payload.get('cross_links', []) or []

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF18: Inserting {len(cross_links)} cross-link(s) into draft {draft_id}...')

    already_linked = set()
    links_inserted = []
    not_found = []
    modified_html = body_html

    for link in cross_links:
        anchor = link.get('anchor', '')
        destination = link.get('destination', '')

        if not anchor or not destination:
            continue

        # Step 1: Try the full anchor text
        new_html, success = insert_link(modified_html, anchor, destination, already_linked)

        if success:
            modified_html = new_html
            links_inserted.append({'anchor': anchor, 'destination': destination, 'inserted': True})
        else:
            # Step 2: Try shorter sub-phrases
            new_html, success, used_anchor = try_shorter_anchor(
                modified_html, anchor, destination, already_linked
            )
            if success:
                modified_html = new_html
                links_inserted.append({
                    'anchor': used_anchor,
                    'destination': destination,
                    'inserted': True,
                    'original_anchor': anchor,
                })
            else:
                links_inserted.append({'anchor': anchor, 'destination': destination, 'inserted': False})
                not_found.append(anchor)

    insert_count = sum(1 for l in links_inserted if l.get('inserted'))

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF18: Inserted {insert_count}/{len(cross_links)} link(s). '
                               f'Not found: {len(not_found)}.')

    return {
        'draft_id': draft_id,
        'body_html_with_links': modified_html,
        'links_inserted': links_inserted,
        'insert_count': insert_count,
        'not_found': not_found,
    }
