import json
import logging
import re
import time

import httpx

import config

log = logging.getLogger("llm")


class LLMError(RuntimeError):
    pass


def chat(messages, model=None, json_mode=False, temperature=0.2, max_tokens=None, timeout=900) -> str:
    if not config.OPENROUTER_API_KEY:
        raise LLMError("OPENROUTER_API_KEY не задано в .env")
    body = {"model": model or config.LLM_MODEL, "messages": messages, "temperature": temperature}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if max_tokens:
        body["max_tokens"] = max_tokens
    headers = {
        "Authorization": f"Bearer {config.OPENROUTER_API_KEY}",
        "HTTP-Referer": config.APP_URL,
        "X-Title": "LessonAI",
    }
    last_err = None
    for attempt in range(4):
        try:
            r = httpx.post(f"{config.OPENROUTER_BASE_URL}/chat/completions", json=body, headers=headers, timeout=timeout)
            if r.status_code in (408, 429, 500, 502, 503, 504):
                raise LLMError(f"OpenRouter {r.status_code}: {r.text[:300]}")
            if r.status_code >= 400:
                # Client errors (bad key, unknown model) will not get better with retries.
                raise LLMError(f"OpenRouter {r.status_code}: {r.text[:500]}")
            data = r.json()
            if data.get("error"):
                raise LLMError(f"OpenRouter: {data['error']}")
            content = data["choices"][0]["message"].get("content") or ""
            if isinstance(content, list):
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
            return content
        except (httpx.HTTPError, LLMError, KeyError, ValueError) as e:
            last_err = e
            msg = str(e)
            if isinstance(e, LLMError) and re.match(r"OpenRouter 4(0[0-7]|1\d)\b", msg):
                raise
            wait = 5 * (2 ** attempt)
            log.warning("LLM call failed (%s), retry in %ss", msg[:200], wait)
            time.sleep(wait)
    raise LLMError(f"OpenRouter недоступний: {last_err}")


def parse_json(text: str):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        start, end = t.find("{"), t.rfind("}")
        if start >= 0 and end > start:
            return json.loads(t[start:end + 1])
        raise
