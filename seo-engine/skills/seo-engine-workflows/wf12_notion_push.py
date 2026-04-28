#!/usr/bin/env python3
"""
WF12 — Notion Push
Creates or updates Notion database records for the SEO content calendar.
"""
import os
import time
from datetime import date, timedelta
from helpers import (http_post, http_get, http_patch, post_callback, chunked)

WORKFLOW_ID = 'Notion_Push'

NOTION_API_BASE = 'https://api.notion.com/v1'
NOTION_VERSION = '2022-06-28'


def notion_headers(api_key=None):
    key = api_key or os.environ.get('NOTION_API_KEY', '')
    return {
        'Authorization': f'Bearer {key}',
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    }


def calculate_target_date(project_start_date, week_number):
    """
    Calculate target date from project start date + week_number (1-indexed).
    project_start_date: ISO format string YYYY-MM-DD
    """
    try:
        start = date.fromisoformat(project_start_date)
    except (ValueError, TypeError):
        start = date.today()
    # Week 1 = start date, Week 2 = start + 7 days, etc.
    offset_days = (week_number - 1) * 7
    return (start + timedelta(days=offset_days)).isoformat()


def query_database(database_id, headers, filter_dict=None):
    """Query all records from a Notion database."""
    url = f"{NOTION_API_BASE}/databases/{database_id}/query"
    body = {'page_size': 100}
    if filter_dict:
        body['filter'] = filter_dict

    all_results = []
    cursor = None

    while True:
        if cursor:
            body['start_cursor'] = cursor
        try:
            resp = http_post(url, body, headers=headers, timeout=30)
            all_results.extend(resp.get('results', []))
            if resp.get('has_more') and resp.get('next_cursor'):
                cursor = resp['next_cursor']
            else:
                break
        except Exception as e:
            print(f"[WF12] Notion query error: {e}")
            break

    return all_results


def build_page_properties(task, project_name, target_date):
    """
    Build Notion page properties dict from a task dict.
    Adapts to common property names in SEO content calendar databases.
    """
    props = {}

    # Title / Name
    task_name = task.get('task_name') or task.get('name') or task.get('title') or 'Untitled Task'
    props['Name'] = {'title': [{'text': {'content': str(task_name)[:2000]}}]}

    # Project / Campaign
    if project_name:
        props['Project'] = {'rich_text': [{'text': {'content': str(project_name)[:2000]}}]}

    # Status
    status = task.get('status', 'Not Started')
    props['Status'] = {
        'select': {'name': str(status)[:100]}
    }

    # Target date
    if target_date:
        props['Target Date'] = {'date': {'start': target_date}}

    # Due date (alias)
    props['Due Date'] = {'date': {'start': target_date}} if target_date else {}

    # Week number
    if task.get('week_number'):
        props['Week'] = {'number': int(task['week_number'])}

    # Content type
    if task.get('content_type') or task.get('page_type'):
        ct = task.get('content_type') or task.get('page_type')
        props['Content Type'] = {'select': {'name': str(ct)[:100]}}

    # Priority
    if task.get('priority'):
        props['Priority'] = {'select': {'name': str(task['priority'])[:100]}}

    # Cluster ID
    if task.get('cluster_id'):
        props['Cluster ID'] = {'rich_text': [{'text': {'content': str(task['cluster_id'])[:2000]}}]}

    # Primary keyword
    if task.get('primary_keyword'):
        props['Primary Keyword'] = {
            'rich_text': [{'text': {'content': str(task['primary_keyword'])[:2000]}}]
        }

    # URL Slug
    if task.get('url_slug') or task.get('slug'):
        slug = task.get('url_slug') or task.get('slug')
        props['URL Slug'] = {'rich_text': [{'text': {'content': str(slug)[:2000]}}]}

    # Assignee (if text-based)
    if task.get('assignee'):
        props['Assignee'] = {'rich_text': [{'text': {'content': str(task['assignee'])[:2000]}}]}

    # Remove empty date props
    props = {k: v for k, v in props.items() if v}

    return props


def find_existing_record(existing_records, task):
    """Find an existing Notion record matching this task by cluster_id or name."""
    task_name = task.get('task_name') or task.get('name') or task.get('title') or ''
    cluster_id = task.get('cluster_id', '')

    for record in existing_records:
        # Match by cluster_id in properties
        props = record.get('properties', {})
        for prop_name, prop_val in props.items():
            if prop_name.lower() in ('cluster id', 'cluster_id'):
                rt = prop_val.get('rich_text', [])
                if rt and rt[0].get('plain_text', '') == cluster_id:
                    return record

        # Match by title
        title_prop = props.get('Name') or props.get('Title') or {}
        title_items = title_prop.get('title', [])
        if title_items:
            existing_name = title_items[0].get('plain_text', '')
            if existing_name == task_name:
                return record

    return None


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { notion_database_id, project_name, project_start_date, calendar_tasks,
               notion_api_key (optional — overrides env var) }
    returns: { records_created, records_updated, records_failed, notion_database_url, errors }
    """
    database_id = payload.get('notion_database_id', '')
    project_name = payload.get('project_name', project_slug or '')
    project_start_date = payload.get('project_start_date', date.today().isoformat())
    calendar_tasks = payload.get('calendar_tasks', []) or []

    # Support per-project Notion API key override
    notion_api_key = payload.get('notion_api_key') or os.environ.get('NOTION_API_KEY', '')
    headers = notion_headers(notion_api_key)

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF12: Pushing {len(calendar_tasks)} tasks to Notion database...')

    if not database_id:
        return {
            'records_created': 0, 'records_updated': 0, 'records_failed': 0,
            'notion_database_url': '',
            'errors': ['notion_database_id is required'],
        }

    # -----------------------------------------------------------------------
    # Step 1: Calculate target dates
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF12: Calculating target dates...')

    for task in calendar_tasks:
        week_num = int(task.get('week_number', 1))
        task['_target_date'] = calculate_target_date(project_start_date, week_num)

    # -----------------------------------------------------------------------
    # Step 2: Query existing records
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message='WF12: Querying existing Notion records...')

    existing_records = query_database(database_id, headers)
    print(f"[WF12] Found {len(existing_records)} existing records")

    # -----------------------------------------------------------------------
    # Step 3: Create or update in batches of 10
    # -----------------------------------------------------------------------
    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF12: Processing {len(calendar_tasks)} tasks in batches...')

    records_created = 0
    records_updated = 0
    records_failed = 0
    errors = []

    for batch_idx, batch in enumerate(chunked(calendar_tasks, 10)):
        for task in batch:
            target_date = task.get('_target_date', '')
            existing = find_existing_record(existing_records, task)
            properties = build_page_properties(task, project_name, target_date)

            if existing:
                # Update existing record
                page_id = existing['id']
                try:
                    http_patch(
                        f"{NOTION_API_BASE}/pages/{page_id}",
                        {'properties': properties},
                        headers=headers,
                        timeout=30
                    )
                    records_updated += 1
                    print(f"[WF12] Updated: {task.get('task_name', '')[:50]}")
                except Exception as e:
                    records_failed += 1
                    err = f"Update failed for '{task.get('task_name', '')[:40]}': {str(e)[:100]}"
                    errors.append(err)
                    print(f"[WF12] {err}")
            else:
                # Create new record
                try:
                    create_body = {
                        'parent': {'database_id': database_id},
                        'properties': properties,
                    }
                    # Add content block if task has a description
                    description = task.get('description') or task.get('brief_narrative') or ''
                    if description:
                        create_body['children'] = [{
                            'object': 'block',
                            'type': 'paragraph',
                            'paragraph': {
                                'rich_text': [{'type': 'text', 'text': {'content': description[:2000]}}]
                            }
                        }]
                    http_post(
                        f"{NOTION_API_BASE}/pages",
                        create_body,
                        headers=headers,
                        timeout=30
                    )
                    records_created += 1
                    print(f"[WF12] Created: {task.get('task_name', '')[:50]}")
                except Exception as e:
                    records_failed += 1
                    err = f"Create failed for '{task.get('task_name', '')[:40]}': {str(e)[:100]}"
                    errors.append(err)
                    print(f"[WF12] {err}")

        # 200ms delay between batches
        time.sleep(0.2)

    notion_url = f"https://notion.so/{database_id.replace('-', '')}"

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF12: Complete. Created: {records_created}, '
                               f'Updated: {records_updated}, Failed: {records_failed}.')

    return {
        'records_created': records_created,
        'records_updated': records_updated,
        'records_failed': records_failed,
        'notion_database_url': notion_url,
        'errors': errors[:20],
    }
