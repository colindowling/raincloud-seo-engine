#!/usr/bin/env python3
"""
WF15 — Voice Guide Index
Reads brand voice documents and synthesizes a structured JSON voice profile via Claude.
"""
import os
import re
import json

from helpers import http_post, http_get, post_callback, claude_message, chunked

WORKFLOW_ID = 'Voice_Guide_Index'


def read_txt(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def read_pdf(path):
    try:
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            return '\n'.join(page.extract_text() or '' for page in pdf.pages)
    except ImportError:
        pass
    try:
        import PyPDF2
        with open(path, 'rb') as f:
            reader = PyPDF2.PdfReader(f)
            return '\n'.join(
                page.extract_text() or '' for page in reader.pages
            )
    except ImportError:
        pass
    # Binary fallback: strip non-printable chars
    with open(path, 'rb') as f:
        raw = f.read()
    text = raw.decode('utf-8', errors='replace')
    text = re.sub(r'[^\x20-\x7e\n\t]', ' ', text)
    text = re.sub(r' {4,}', ' ', text)
    return text


def read_docx(path):
    try:
        from docx import Document
        doc = Document(path)
        return '\n'.join(p.text for p in doc.paragraphs)
    except ImportError:
        pass
    # ZIP fallback: extract word/document.xml
    try:
        import zipfile
        with zipfile.ZipFile(path, 'r') as z:
            with z.open('word/document.xml') as xml_file:
                xml_content = xml_file.read().decode('utf-8', errors='replace')
        # Strip XML tags
        text = re.sub(r'<[^>]+>', ' ', xml_content)
        text = re.sub(r'\s{2,}', ' ', text).strip()
        return text
    except Exception:
        return ''


def read_html(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    return re.sub(r'<[^>]+>', ' ', content)


def read_document(doc, project_slug):
    filename = doc.get('filename', '')
    doc_type = doc.get('type', '').lower()

    # Primary path
    primary_path = os.path.join('/data/projects', project_slug, 'voice-guide', filename)
    # Sandbox fallback path
    fallback_path = os.path.join(
        '/home/vercel-sandbox/workspace/seo-engine/data/projects',
        project_slug, 'voice-guide', filename
    )

    path = None
    for candidate in (primary_path, fallback_path):
        if os.path.exists(candidate):
            path = candidate
            break

    if path is None:
        print(f'[WF15] File not found: {filename}')
        return ''

    try:
        ext = os.path.splitext(filename)[1].lower()
        if ext in ('.txt', '.md') or doc_type in ('txt', 'md'):
            return read_txt(path)
        elif ext == '.pdf' or doc_type == 'pdf':
            return read_pdf(path)
        elif ext == '.docx' or doc_type == 'docx':
            return read_docx(path)
        elif ext in ('.html', '.htm') or doc_type in ('html', 'htm'):
            return read_html(path)
        else:
            # Default: try plain text
            return read_txt(path)
    except Exception as e:
        print(f'[WF15] Error reading {filename}: {e}')
        return ''


FALLBACK_VOICE = {
    'tone': 'Professional and authoritative with a focus on clarity.',
    'style_rules': ['Use active voice', 'Be concise', 'Lead with value'],
    'example_phrases': ['Proven results', 'Drive growth', 'Built for teams like yours'],
    'avoid': ['Jargon without explanation', 'Overly casual language'],
    'grammar_rules': ['Sentence case for headings', 'Oxford comma'],
    'persona_voices': {
        'ceo': 'Strategic and visionary, speaks to industry trends.',
        'vp_sales': 'Outcome-focused, empathetic to buyer pain points.',
        'company_page': 'Educational, third-person, data-led.',
    },
    'key_topics': [],
    'document_count': 0,
    'confidence': 'low',
}


def run(job_id, callback_url, project_slug, payload):
    """
    payload: { documents, project_slug, client_name, industry, brand_voice }
    returns: { voice_index, document_count, text_length, files_read }
    """
    documents = payload.get('documents', []) or []
    client_name = payload.get('client_name', '')
    industry = payload.get('industry', '')
    brand_voice = payload.get('brand_voice', 'Professional')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF15: Reading {len(documents)} voice guide document(s)...')

    # Step 1: Read all documents
    texts = []
    files_read = []
    for doc in documents:
        text = read_document(doc, project_slug)
        if text.strip():
            texts.append(text)
            files_read.append(doc.get('filename', ''))

    combined_text = '\n\n'.join(texts)

    # Cap at 12,000 words
    words = combined_text.split()
    if len(words) > 12000:
        combined_text = ' '.join(words[:12000])
        print(f'[WF15] Trimmed combined text to 12,000 words.')

    post_callback(callback_url, job_id, WORKFLOW_ID, 'running',
                  log_message=f'WF15: {len(files_read)} file(s) read ({len(combined_text)} chars). Calling Claude to synthesize voice profile...')

    # Step 2: Call Claude to synthesize voice profile
    doc_types = list({d.get('type', 'unknown') for d in documents})
    doc_types_str = ', '.join(doc_types) if doc_types else 'unknown'

    system_prompt = (
        'You are a brand voice analyst. Given documents that describe a brand\'s writing style, '
        'analyze them and produce a structured JSON voice profile.\n'
        'Return ONLY valid JSON. No preamble.'
    )

    user_message = f"""Client: {client_name}
Industry: {industry}
Brand voice type: {brand_voice}
Document types: {doc_types_str}

Documents content:
{combined_text[:10000]}

Produce a JSON object with exactly these fields:
{{
  "tone": "2-3 sentence description of the brand's tone",
  "style_rules": ["rule 1", "rule 2", "... up to 10 rules"],
  "example_phrases": ["phrase 1", "... up to 8 phrases the brand would naturally use"],
  "avoid": ["thing to avoid 1", "... up to 8 things to avoid"],
  "grammar_rules": ["rule 1", "... up to 6 grammar/formatting rules"],
  "persona_voices": {{
    "ceo": "How the CEO should sound in LinkedIn posts (1-2 sentences)",
    "vp_sales": "How VP Sales should sound (1-2 sentences)",
    "company_page": "How the company page should sound (1-2 sentences)"
  }},
  "key_topics": ["topic 1", "... up to 6 key topics/themes from the documents"],
  "document_count": {len(documents)},
  "confidence": "high|medium|low (based on how much content was available)"
}}"""

    voice_index = FALLBACK_VOICE.copy()
    voice_index['document_count'] = len(documents)

    try:
        raw = claude_message(system_prompt, user_message, max_tokens=1500)

        # Strip markdown fences if present
        raw = re.sub(r'^```(?:json)?\s*', '', raw.strip())
        raw = re.sub(r'```\s*$', '', raw.strip())

        parsed = json.loads(raw)
        voice_index = parsed
    except json.JSONDecodeError as e:
        print(f'[WF15] JSON parse error: {e}. Using fallback defaults.')
        voice_index['confidence'] = 'low'
    except Exception as e:
        print(f'[WF15] Claude API error: {e}. Using fallback defaults.')

    return {
        'voice_index': voice_index,
        'document_count': len(documents),
        'text_length': len(combined_text),
        'files_read': files_read,
    }
