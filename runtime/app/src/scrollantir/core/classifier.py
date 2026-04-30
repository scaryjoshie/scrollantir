"""LLM classifier for window-title → (project, category).

Takes a window title (e.g., "sleep.py — scrollantir") plus the user's
active project list, and returns
`{project_slug: 'scrollantir', category: 'work'}`. category is one of
'work' | 'play' | 'neutral' (the same TopicCategory the dashboard
already uses).

Provider chain: Cerebras first (cheap, fast), Groq fallback (in case
Cerebras is rate-limited or down). Each provider gets one attempt
per call; if both fail, raises and the caller queues retry.

Per-call calling style — no batching. The user's window-change
volume is low enough that one call per title is fine, and the
classifier_queue handles re-attempts on transient failure.

Environment:
  CEREBRAS_API_KEY  required for the primary provider
  GROQ_API_KEY      required for the fallback (optional but
                    recommended; without it, all retries hit the
                    same Cerebras outage)
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger("scrollantir.classifier")


@dataclass(frozen=True)
class ClassificationResult:
    project_slug: str | None  # NULL if title doesn't belong to any project
    category: str             # 'work' | 'play' | 'neutral'
    model: str                # 'cerebras:llama3.1-8b' | 'groq:llama3-8b-8192'


class ClassifierError(Exception):
    """Raised when all providers fail for a single title.
    Caller should re-enqueue with `retries += 1`."""


# The system prompt is shared across providers. Models are
# instruction-tuned and reliably emit JSON for this kind of structured
# call; we still parse defensively.
_SYSTEM_PROMPT = """\
You are classifying a single window/tab title from a personal time-
tracking app. The user has provided their active projects below; pick
the BEST match (or null if none fit) and a productivity category.

Categories:
  work    — coding, writing, research, study, focused productive work
  play    — games, entertainment, social media for fun, relaxation
  neutral — everything else (logistics, life admin, browsing, eating)

Output STRICT JSON with two keys: project_slug (string or null) and
category (one of work/play/neutral). No prose, no markdown, no
explanation. Just the JSON object.
"""

_USER_PROMPT_TEMPLATE = """\
Active projects:
{projects_block}

Window title: {title!r}

Classify."""


def classify(
    title: str,
    project_slugs: list[str],
    *,
    timeout_s: float = 5.0,
) -> ClassificationResult:
    """Classify one title via Cerebras → Groq fallback chain.

    Raises `ClassifierError` if both providers fail. The caller is
    responsible for retry policy (typically `classification_queue`'s
    backoff).
    """
    user_prompt = _USER_PROMPT_TEMPLATE.format(
        projects_block="\n".join(f"  - {s}" for s in project_slugs) or "  (none)",
        title=title,
    )
    last_error: Exception | None = None
    for provider in _provider_chain():
        try:
            return provider(title, _SYSTEM_PROMPT, user_prompt, timeout_s, project_slugs)
        except Exception as exc:  # noqa: BLE001 — we want to fall through
            log.warning("classifier provider failed: %s", exc)
            last_error = exc
    raise ClassifierError(
        f"all providers failed for title {title!r}: {last_error}"
    ) from last_error


def _provider_chain() -> list:
    """Return the providers to try in order, skipping any that lack
    credentials. Cerebras first (primary), Groq fallback."""
    chain: list = []
    if os.environ.get("CEREBRAS_API_KEY"):
        chain.append(_cerebras)
    if os.environ.get("GROQ_API_KEY"):
        chain.append(_groq)
    if not chain:
        raise ClassifierError(
            "no classifier credentials configured "
            "(set CEREBRAS_API_KEY and/or GROQ_API_KEY)"
        )
    return chain


def _cerebras(
    title: str,
    system: str,
    user: str,
    timeout_s: float,
    project_slugs: list[str],
) -> ClassificationResult:
    api_key = os.environ["CEREBRAS_API_KEY"]
    model = os.environ.get("CEREBRAS_MODEL", "llama3.1-8b")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
    }
    resp = httpx.post(
        "https://api.cerebras.ai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=timeout_s,
    )
    resp.raise_for_status()
    payload = resp.json()
    content = payload["choices"][0]["message"]["content"]
    return _parse_response(content, project_slugs, model=f"cerebras:{model}")


def _groq(
    title: str,
    system: str,
    user: str,
    timeout_s: float,
    project_slugs: list[str],
) -> ClassificationResult:
    api_key = os.environ["GROQ_API_KEY"]
    model = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
    }
    resp = httpx.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
        timeout=timeout_s,
    )
    resp.raise_for_status()
    payload = resp.json()
    content = payload["choices"][0]["message"]["content"]
    return _parse_response(content, project_slugs, model=f"groq:{model}")


_VALID_CATEGORIES = {"work", "play", "neutral"}


def _parse_response(
    content: str,
    project_slugs: list[str],
    *,
    model: str,
) -> ClassificationResult:
    """Parse a JSON response from either provider. Defensive against
    LLM drift: invalid project_slug → null, invalid category → neutral.
    Anything that's not parseable JSON raises (caller treats as
    failure → enqueues retry)."""
    parsed: Any = json.loads(content)
    if not isinstance(parsed, dict):
        raise ValueError(f"classifier response is not an object: {parsed!r}")
    project_slug = parsed.get("project_slug")
    category = parsed.get("category")
    # Coerce '' / unknown slug → null (treated as "no project").
    if not isinstance(project_slug, str) or project_slug not in project_slugs:
        project_slug = None
    if category not in _VALID_CATEGORIES:
        category = "neutral"
    return ClassificationResult(
        project_slug=project_slug,
        category=category,
        model=model,
    )
