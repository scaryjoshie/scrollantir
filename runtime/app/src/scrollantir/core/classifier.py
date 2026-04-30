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
You are classifying a single window/tab title from a personal time-tracking
app. The user has provided their active projects below; pick the BEST match
or none.

Return TWO INDEPENDENT FIELDS:

  project_slug — which project this title belongs to, OR null if it doesn't
                 belong to any of the listed projects. Pick a slug ONLY if
                 the title clearly references that project (its repo, files,
                 domain, named entities). When in doubt, return null.

  category     — what kind of activity the title represents:
                   work    — coding, writing, research, study, focused
                             productive effort (whether or not it maps to a
                             project — learning guitar without a "guitar"
                             project listed is still work=true, slug=null).
                             Communication tools (Slack, Discord, Zoom)
                             default to WORK when the conversation /
                             channel context looks work-shaped (DM with
                             a colleague, a project channel, a meeting).
                             Discord is often work calls, NOT play.
                   play    — entertainment media consumption, games,
                             reading content that's clearly not productive.
                             Examples: YouTube videos for fun (not lectures),
                             TikTok / Reels / Shorts, Netflix, Spotify
                             leisure listening, video games, non-productive
                             reddit (humor, drama, trends), non-productive
                             twitter (memes, drama). Use your intuition —
                             a Karpathy lecture on YouTube is work; a
                             cat-fail compilation is play.
                   neutral — system admin, lock screen, settings, generic
                             web search, file management, life logistics,
                             eating, brief context-switches, communication
                             tools when context is unclear (a Slack
                             notification glance, an unread DM badge).

THE TWO AXES ARE INDEPENDENT. A non-null project_slug does NOT force
category to 'work', and category='work' does NOT require a project_slug.
Examples of valid combinations:

  ("scrollantir",  "work")    — editing scrollantir's source files
  ("scrollantir",  "neutral") — editing the .env on a scrollantir branch;
                                project-adjacent admin still belongs under
                                the project, but isn't focused work
  ("school",       "work")    — reading a course PDF, writing a problem set
  (null,           "work")    — focused effort on something not in the
                                project list (one-off research deep-dive)
  (null,           "play")    — Reels, YouTube entertainment, games
  (null,           "neutral") — system settings, lock screen, generic search

Do NOT invent slugs. If no listed project is a clear match, return null —
that's the honest answer.

Output STRICT JSON with exactly two keys: project_slug (string OR null) and
category (one of "work", "play", "neutral"). No prose, no markdown, no
explanation. Just the JSON object.
"""

_USER_PROMPT_TEMPLATE = """\
Active projects (slug — description):
{projects_block}

Window title: {title!r}

Classify."""


def _format_projects(projects: list[tuple[str, str | None]]) -> str:
    if not projects:
        return "  (none)"
    lines: list[str] = []
    for slug, desc in projects:
        if desc:
            lines.append(f"  - {slug} — {desc}")
        else:
            lines.append(f"  - {slug}")
    return "\n".join(lines)


def classify(
    title: str,
    projects: list[tuple[str, str | None]] | list[str],
    *,
    timeout_s: float = 5.0,
) -> ClassificationResult:
    """Classify one title via Cerebras → Groq fallback chain.

    `projects` is a list of `(slug, description)` tuples. Bare-string
    slugs are accepted for backward compatibility (description=None).
    Description plumbs into the LLM prompt so the model can
    disambiguate between similarly-shaped slugs.

    Raises `ClassifierError` if both providers fail. Caller handles
    retry policy via `classification_queue`'s backoff.
    """
    # Normalize string-only input.
    normalized: list[tuple[str, str | None]] = [
        (p, None) if isinstance(p, str) else p for p in projects
    ]
    project_slugs = [slug for slug, _ in normalized]
    user_prompt = _USER_PROMPT_TEMPLATE.format(
        projects_block=_format_projects(normalized),
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
    """Parse a JSON response from either provider.

    Coerce-vs-raise per Tenet 2 ("investigate before patching"):

      RAISE (caller re-enqueues; LLM re-samples):
        - JSON parse failure
        - response is not an object
        - missing project_slug or category key
        - category is junk (not in {work, play, neutral})

        These are model-output noise that re-sampling can fix.

      COERCE (silent fix; re-sampling won't help):
        - project_slug is a non-empty string but not in the active project
          list → coerce to None. Re-sampling won't help: the project list
          is fixed for this call. The honest answer is "no project."

    The two axes (project_slug, category) are independent — we do NOT
    reconcile them. (slug + non-work) and (null + work) are both valid
    under the soft tree model.
    """
    try:
        parsed: Any = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ClassifierError(f"classifier emitted non-JSON: {content!r}") from exc

    if not isinstance(parsed, dict):
        raise ClassifierError(f"classifier response is not an object: {parsed!r}")

    if "project_slug" not in parsed or "category" not in parsed:
        raise ClassifierError(
            f"classifier response missing required keys: {parsed!r}"
        )

    project_slug = parsed["project_slug"]
    category = parsed["category"]

    # Category: junk means re-sample. Don't silently default to 'neutral' —
    # that masked classifier drift in the previous version.
    if category not in _VALID_CATEGORIES:
        raise ClassifierError(
            f"classifier emitted invalid category {category!r} "
            f"(expected one of {sorted(_VALID_CATEGORIES)})"
        )

    # project_slug: coerce. Empty string / null → None; unknown slug → None.
    # Re-sampling won't help; the active-project list doesn't change between
    # retries, so we accept the honest "no project" answer.
    if project_slug == "" or project_slug is None:
        project_slug = None
    elif not isinstance(project_slug, str):
        raise ClassifierError(
            f"classifier emitted non-string project_slug: {project_slug!r}"
        )
    elif project_slug not in project_slugs:
        log.info(
            "classifier emitted unknown project_slug %r — coercing to None "
            "(active=%s)",
            project_slug,
            project_slugs,
        )
        project_slug = None

    return ClassificationResult(
        project_slug=project_slug,
        category=category,
        model=model,
    )
