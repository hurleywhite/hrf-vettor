"""
HRF OFF Vettor v2 — AI Vetting Pipeline (Exa.ai Edition)
Two-pass approach: Research first (build person profile), then Judge (make verdict)
"""

import os, sys, json, time, traceback
import urllib.request, urllib.error
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

# --- HTTP helper (stdlib only — no requests/httpx hang on Python 3.14) ---
def http_request(method, url, headers=None, body=None, timeout=120):
    """Pure stdlib HTTP. No third-party deps."""
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='replace')
        raise Exception(f"HTTP {e.code}: {error_body}")

# --- Clients ---
OAI_KEY = os.environ["OPENAI_API_KEY"]
EXA_KEY = os.environ["EXA_API_KEY"]

def openai_chat(model, messages, max_tokens=2000, temperature=None, json_mode=True):
    body = {"model": model, "messages": messages, "max_completion_tokens": max_tokens}
    if temperature is not None:
        body["temperature"] = temperature
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    result = http_request("POST", "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OAI_KEY}", "Content-Type": "application/json"},
        body=body)
    return result["choices"][0]["message"]["content"]

def exa_search(query, num_results=10, text_max_chars=3000, highlights_sentences=5):
    """Exa search via curl subprocess — urllib gets 403 from Exa's bot protection."""
    import subprocess
    body = json.dumps({
        "query": query,
        "numResults": num_results,
        "contents": {
            "text": {"maxCharacters": text_max_chars},
            "highlights": {"numSentences": highlights_sentences}
        }
    })
    result = subprocess.run([
        "curl", "-s", "--max-time", "30",
        "https://api.exa.ai/search",
        "-H", f"x-api-key: {EXA_KEY}",
        "-H", "Content-Type: application/json",
        "-d", body
    ], capture_output=True, text=True, timeout=35)
    if result.returncode != 0:
        raise Exception(f"Exa curl error: {result.stderr}")
    return json.loads(result.stdout)

# --- Supabase REST ---
SB_URL = os.environ["SUPABASE_URL"]
SB_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SB_H = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json", "Prefer": "return=representation"}

class SupabaseREST:
    def select(self, table, params=""):
        return http_request("GET", f"{SB_URL}/rest/v1/{table}?{params}", headers=SB_H, timeout=15)

    def insert(self, table, data):
        return http_request("POST", f"{SB_URL}/rest/v1/{table}", headers=SB_H, body=data, timeout=15)

    def update(self, table, data, match_col, match_val):
        return http_request("PATCH", f"{SB_URL}/rest/v1/{table}?{match_col}=eq.{match_val}", headers=SB_H, body=data, timeout=15)

supabase = SupabaseREST()


# ============================================================
# STAGE 1: SPAM TRIAGE (gpt-4o-mini — fast, cheap)
# ============================================================

SPAM_PROMPT = """You are a spam detector for applications to the Oslo Freedom Forum, a major human rights conference hosted by the Human Rights Foundation.

Your ONLY job is to determine if this application is SPAM or NOT SPAM.

SPAM signals (any ONE is sufficient to mark as spam):
- Gibberish, random characters, or obviously fake names
- Gambling, pornography, or promotional links in any field
- Name matches organization name exactly AND no real content
- Interest statement contains URLs or promotional/commercial language unrelated to human rights
- AI-generated boilerplate that is clearly mass-submitted (templated patterns, generic text with no personal detail)
- Claims previous attendance = "Yes" but lists no specific forum names, or lists a country instead
- Email from known disposable service (tempmail, mailinator, guerrillamail, etc.)
- Mojibake / garbled encoding in interest statement
- Interest statement is fewer than 10 words or a single repeated phrase
- Content is in a non-Latin script AND contains promotional URLs

NOT spam (do NOT flag these):
- Short or simple interest statements (if they seem genuine and personal)
- Non-English text without promotional content
- Bitcoin or cryptocurrency mentions — HRF has a significant Bitcoin freedom program
- Government affiliations — handled by later stages, not spam
- Lack of social media links — handled by later stages
- Names with academic titles or prefixes (Dr., Prof., A/Professor, etc.)
- Long, detailed, personal interest statements — even if they mention government work
- Applications from people at legitimate-sounding NGOs, commissions, or academic institutions
- Applications that include personal website URLs or organizational URLs as evidence of their work
- CRITICAL: If the interest statement is longer than 100 words and discusses specific personal experience, it is NOT spam regardless of other signals. Real spam is short, generic, promotional, or gibberish.

Respond with JSON only:
{"verdict": "SPAM" or "NOT_SPAM", "confidence": 0.0-1.0, "reasoning": "brief explanation"}"""


def stage1_spam_check(applicant: dict) -> dict:
    profile_text = f"""Name: {applicant.get('full_name', '')}
Email: {applicant.get('email', '')}
Title: {applicant.get('title', '')}
Organization: {applicant.get('organization', '')}
How heard: {applicant.get('how_heard', '')}
Interest statement: {applicant.get('interest_statement', '')}
Previous attendance: {applicant.get('previous_attendance', False)}
Previous forums: {applicant.get('previous_forums', '')}
Additional comments: {applicant.get('additional_comments', '')}
Social media provided: Twitter={applicant.get('social_twitter','')}, Instagram={applicant.get('social_instagram','')}, LinkedIn={applicant.get('social_linkedin','')}, Facebook={applicant.get('social_facebook','')}, Other={applicant.get('social_other','')}"""

    start = time.time()
    raw = openai_chat("gpt-4o-mini",
        [{"role": "system", "content": SPAM_PROMPT}, {"role": "user", "content": profile_text}],
        max_tokens=300, temperature=0.0)
    latency = int((time.time() - start) * 1000)
    result = json.loads(raw)
    result["latency_ms"] = latency
    result["model"] = "gpt-4o-mini"
    return result


# ============================================================
# STAGE 2a: EXA.AI DEEP RESEARCH
# ============================================================

def stage2a_exa_research(applicant: dict) -> dict:
    """Use Exa.ai to deep-research the applicant across the entire web."""
    name = applicant.get("full_name", "")
    org = applicant.get("organization", "")
    title = applicant.get("title", "")

    dossier = {
        "applicant": {"full_name": name, "email": applicant.get("email", ""), "org": org, "title": title},
        "exa_results": [],
        "linkedin": {"found": False},
        "twitter": {"found": False},
        "instagram": {"found": False},
        "facebook": {"found": False},
        "org_website": {"found": False},
        "person_articles": [],
        "org_articles": [],
        "scrape_metadata": {"searches_run": [], "errors": [], "total_latency_ms": 0}
    }

    start = time.time()

    def parse_exa_results(data):
        """Parse Exa REST API response into entries."""
        entries = []
        for r in data.get("results", []):
            entries.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "text": (r.get("text", "") or "")[:2000],
                "highlights": r.get("highlights", []),
                "published_date": r.get("publishedDate", ""),
            })
        return entries

    # --- Search 1: Person + Organization (neural search) ---
    print(f"    [Exa] Searching: {name} + {org}", flush=True)
    try:
        data = exa_search(f"{name} {org}", num_results=10)
        dossier["scrape_metadata"]["searches_run"].append("person+org")

        for entry in parse_exa_results(data):
            dossier["exa_results"].append(entry)
            url = entry["url"]
            if "linkedin.com/in/" in url and not dossier["linkedin"]["found"]:
                dossier["linkedin"] = {"found": True, "url": url, "title": entry["title"], "summary": entry["text"][:500]}
            if ("twitter.com/" in url or "x.com/" in url) and not dossier["twitter"]["found"]:
                dossier["twitter"] = {"found": True, "url": url, "summary": entry["text"][:500]}
            if "instagram.com/" in url and not dossier["instagram"]["found"]:
                dossier["instagram"] = {"found": True, "url": url, "summary": entry["text"][:500]}
            if "facebook.com/" in url and not dossier["facebook"]["found"]:
                dossier["facebook"] = {"found": True, "url": url, "summary": entry["text"][:500]}

            text_lower = entry["text"].lower()
            if name.lower().split()[0] in text_lower or (org and org.lower()[:10] in text_lower):
                dossier["person_articles"].append(entry)

    except Exception as e:
        dossier["scrape_metadata"]["errors"].append(f"Person search: {str(e)}")
        print(f"    [Exa] Error in person search: {e}", flush=True)

    # --- Search 2: Organization verification ---
    if org and len(org) > 3:
        print(f"    [Exa] Searching organization: {org}", flush=True)
        try:
            data = exa_search(f"{org} organization", num_results=5, text_max_chars=2000, highlights_sentences=3)
            dossier["scrape_metadata"]["searches_run"].append("org_verification")

            for entry in parse_exa_results(data):
                dossier["org_articles"].append(entry)
                url = entry["url"]
                if not dossier["org_website"]["found"] and "linkedin.com" not in url and "facebook.com" not in url and "twitter.com" not in url:
                    if org.lower().replace(" ", "") in url.lower().replace(" ", "").replace("-", "") or (entry["title"] and org.lower()[:8] in entry["title"].lower()):
                        dossier["org_website"] = {"found": True, "url": url, "title": entry["title"], "content": entry["text"][:1500]}

        except Exception as e:
            dossier["scrape_metadata"]["errors"].append(f"Org search: {str(e)}")

    # --- Search 3: News/media mentions ---
    print(f"    [Exa] Searching news mentions: {name}", flush=True)
    try:
        data = exa_search(f'"{name}" human rights OR activism OR conference OR forum', num_results=5, text_max_chars=1500, highlights_sentences=3)
        dossier["scrape_metadata"]["searches_run"].append("news_mentions")

        existing_urls = {e["url"] for e in dossier["exa_results"]}
        for entry in parse_exa_results(data):
            if entry["url"] not in existing_urls:
                dossier["exa_results"].append(entry)
                dossier["person_articles"].append(entry)

    except Exception as e:
        dossier["scrape_metadata"]["errors"].append(f"News search: {str(e)}")

    # --- Also check any social links the applicant provided ---
    for field, platform in [("social_linkedin", "linkedin"), ("social_twitter", "twitter"),
                            ("social_instagram", "instagram"), ("social_facebook", "facebook")]:
        val = applicant.get(field, "")
        if val and len(str(val).strip()) > 5:
            dossier[platform]["found"] = True
            dossier[platform]["url"] = str(val).strip()
            dossier[platform]["source"] = "applicant_provided"

    # Check additional_comments for URLs too
    comments = str(applicant.get("additional_comments", "") or "")
    for word in comments.split():
        w = word.strip("(),<>\"'")
        if "linkedin.com" in w and not dossier["linkedin"]["found"]:
            dossier["linkedin"] = {"found": True, "url": w, "source": "comments"}
        if ("twitter.com" in w or "x.com/" in w) and not dossier["twitter"]["found"]:
            dossier["twitter"] = {"found": True, "url": w, "source": "comments"}

    dossier["scrape_metadata"]["total_latency_ms"] = int((time.time() - start) * 1000)

    found_count = sum([
        dossier["linkedin"]["found"], dossier["twitter"]["found"],
        dossier["instagram"]["found"], dossier["facebook"]["found"],
        dossier["org_website"]["found"], len(dossier["exa_results"]) > 0,
    ])
    print(f"    [Exa] Done. {len(dossier['exa_results'])} results, {len(dossier['person_articles'])} person articles, {len(dossier['org_articles'])} org articles, {found_count}/6 source types, {len(dossier['scrape_metadata']['errors'])} errors")

    return dossier


# ============================================================
# STAGE 2b: PASS 1 — RESEARCH SYNTHESIS (build person profile)
# ============================================================

RESEARCH_PROMPT = """You are a research analyst building a comprehensive person profile for the Oslo Freedom Forum vetting team.

You will receive an applicant's application data and a dossier of web research results from Exa.ai (full page content, not just snippets).

Your job is to SYNTHESIZE all available evidence into a structured person profile. Every claim must cite a source URL.

Build this profile:

1. **Identity Summary**: Who is this person? Real name confirmed? Photo found? Multiple sources confirm same person?

2. **Professional Background**: Current role, past roles, education, expertise. Cite specific URLs where this info was found.

3. **Organization Verification**: Is the stated organization real? What does it do? Who runs/funds it? Is this person actually affiliated? Cite the org's website or third-party references.

4. **Public Presence & Reputation**: Published articles, media mentions, conference appearances, quotes in press. Include dates and URLs.

5. **Social Media Footprint**: Which platforms found, follower counts if visible, content themes, activity level.

6. **Human Rights Alignment**: Any evidence of human rights work, civil society engagement, activism, journalism, Bitcoin/freedom tech work? Be specific.

7. **Government Connections**: Any government affiliations found? Which government? What role? Is it a ministry-level position? Country's Freedom House status?

8. **Red Flags**: Anything concerning — state propaganda links, authoritarian connections, inconsistencies between application and web evidence, fake credentials.

9. **Information Gaps**: What could NOT be found despite searching? What remains unverified?

IMPORTANT: Cite URLs for every factual claim. Format: [claim](url)
If you found nothing, say so clearly — don't make things up.

Respond with JSON:
{
  "identity_summary": "...",
  "professional_background": "...",
  "organization_verification": "...",
  "public_presence": "...",
  "social_media_footprint": "...",
  "human_rights_alignment": "...",
  "government_connections": "...",
  "red_flags": "...",
  "information_gaps": "...",
  "key_sources": ["url1", "url2", ...]
}"""

def stage2b_research_synthesis(applicant: dict, dossier: dict) -> dict:
    """GPT-5 synthesizes web research into a structured person profile."""

    # Build rich input with full article content
    articles_text = ""
    for i, article in enumerate(dossier.get("exa_results", [])[:15]):
        articles_text += f"\n--- Source {i+1}: {article.get('title', 'Untitled')} ---\nURL: {article.get('url', '')}\n"
        if article.get("highlights"):
            articles_text += f"Key excerpts: {' | '.join(article['highlights'][:3])}\n"
        if article.get("text"):
            articles_text += f"Content: {article['text'][:1500]}\n"

    org_text = ""
    for article in dossier.get("org_articles", [])[:5]:
        org_text += f"\n--- Org Source: {article.get('title', '')} ---\nURL: {article.get('url', '')}\n"
        if article.get("text"):
            org_text += f"Content: {article['text'][:1000]}\n"

    input_text = f"""## Application Data
Name: {applicant.get('full_name', '')}
Email: {applicant.get('email', '')}
Title: {applicant.get('title', '')}
Organization: {applicant.get('organization', '')}
Interest statement: {applicant.get('interest_statement', '')}
Previous attendance: {applicant.get('previous_attendance', False)}
Previous forums: {applicant.get('previous_forums', '')}
Additional comments: {applicant.get('additional_comments', '')}

## Social Media Found
LinkedIn: {json.dumps(dossier.get('linkedin', {}))}
Twitter/X: {json.dumps(dossier.get('twitter', {}))}
Instagram: {json.dumps(dossier.get('instagram', {}))}
Facebook: {json.dumps(dossier.get('facebook', {}))}
Org Website: {json.dumps(dossier.get('org_website', {}))}

## Web Research Results ({len(dossier.get('exa_results', []))} results)
{articles_text}

## Organization Research
{org_text if org_text else 'No organization-specific results found.'}
"""

    start = time.time()
    raw = openai_chat("gpt-5",
        [{"role": "system", "content": RESEARCH_PROMPT}, {"role": "user", "content": input_text}],
        max_tokens=3000)
    latency = int((time.time() - start) * 1000)

    if "```json" in raw:
        raw = raw.split("```json")[1].split("```")[0]
    elif "```" in raw:
        raw = raw.split("```")[1].split("```")[0]
    result = json.loads(raw.strip() or "{}")
    result["latency_ms"] = latency
    result["model"] = "gpt-5"
    return result


# ============================================================
# STAGE 2c: PASS 2 — VERDICT (judge based on profile)
# ============================================================

VERDICT_PROMPT = """You are a vetting decision-maker for the Oslo Freedom Forum (OFF), hosted by the Human Rights Foundation (HRF).

You will receive a structured person profile that was built from web research. Your job is to make a vetting decision based on the evidence.

## Decision Rules

APPROVE if ANY of these are true:
- Person or organization appears in web search results with legitimate context (even 1-2 relevant results is enough)
- Bitcoin/crypto involvement is a STRONG POSITIVE signal — HRF runs a major Bitcoin freedom program. Bitcoin founders, educators, community builders should be APPROVED.
- Students, academics, early-career professionals are welcome — thin web presence is normal for them
- Organization verified as legitimate NGO/civil society/media/startup
- Interest statement shows genuine personal knowledge of human rights issues
- Person provided working URLs to real websites/profiles in their application
- Refugee support, anti-slavery, press freedom, digital rights, financial inclusion work = APPROVE
- When in doubt between APPROVE and FLAG, lean toward APPROVE if there are no red flags

REJECT if:
- Current employee of government ministry or state security in a Not Free country
  Not Free: Afghanistan, Belarus, China, Cuba, Egypt, Eritrea, Ethiopia, Iran, Myanmar, North Korea, Russia, Saudi Arabia, Somalia, South Sudan, Sudan, Syria, Tajikistan, Turkmenistan, UAE, Uzbekistan, Venezuela, Yemen
- Purpose involves promoting government agenda, state propaganda, or surveillance
- Evidence of association with human rights abuses or authoritarian enforcement
- EXCEPTION: documented pro-democracy dissent by a government official → FLAG instead

FLAG if:
- Government official from a Partly Free state (needs human review)
  Partly Free: Bangladesh, Colombia, Georgia, Guatemala, Hungary, India, Indonesia, Kenya, Mexico, Nigeria, Pakistan, Philippines, Senegal, Serbia, Sri Lanka, Tanzania, Turkey, Uganda, Ukraine, Zimbabwe
- Cannot verify identity AND affiliations are vague or concerning
- Conflicting signals (state university in Not Free country but researches human rights)
- Confidence below 70%

## Output Format

Respond with JSON:
{
  "verdict": "APPROVED" or "FLAGGED" or "REJECTED",
  "confidence_breakdown": {
    "identity": 0.0-1.0,
    "organization": 0.0-1.0,
    "alignment": 0.0-1.0,
    "risk": 0.0-1.0
  },
  "overall_confidence": 0.0-1.0,
  "headline_decision": "One sentence explaining the decision, leading with what was confirmed",
  "verification_scorecard": {
    "confirmed": ["list of verified facts with source URLs"],
    "not_found": ["what was searched but not found"],
    "concerning": ["any red flags with evidence"]
  },
  "recommended_next_step": "Specific, actionable instruction for the human reviewer. What exactly should they do next? Be precise.",
  "reasoning": "2-4 sentence detailed reasoning"
}"""

def stage2c_verdict(applicant: dict, profile: dict, dossier: dict) -> dict:
    """GPT-5 renders a verdict based on the research profile."""

    input_text = f"""## Applicant
Name: {applicant.get('full_name', '')}
Title: {applicant.get('title', '')}
Organization: {applicant.get('organization', '')}

## Research Profile
Identity Summary: {profile.get('identity_summary', 'N/A')}
Professional Background: {profile.get('professional_background', 'N/A')}
Organization Verification: {profile.get('organization_verification', 'N/A')}
Public Presence: {profile.get('public_presence', 'N/A')}
Social Media: {profile.get('social_media_footprint', 'N/A')}
Human Rights Alignment: {profile.get('human_rights_alignment', 'N/A')}
Government Connections: {profile.get('government_connections', 'N/A')}
Red Flags: {profile.get('red_flags', 'N/A')}
Information Gaps: {profile.get('information_gaps', 'N/A')}
Key Sources: {json.dumps(profile.get('key_sources', []))}
"""

    start = time.time()
    raw = openai_chat("gpt-5",
        [{"role": "system", "content": VERDICT_PROMPT}, {"role": "user", "content": input_text}],
        max_tokens=2000)
    latency = int((time.time() - start) * 1000)

    if "```json" in raw:
        raw = raw.split("```json")[1].split("```")[0]
    elif "```" in raw:
        raw = raw.split("```")[1].split("```")[0]
    result = json.loads(raw.strip() or "{}")
    result["latency_ms"] = latency
    result["model"] = "gpt-5"
    return result


# ============================================================
# STAGE 3: DEEP REVIEW (flagged cases only)
# ============================================================

DEEP_REVIEW_PROMPT = """You are a senior vetting analyst doing a deep review of a flagged applicant for the Oslo Freedom Forum.

The initial AI review flagged this case. You have the full research profile and initial assessment.

Your job:
1. Look more carefully at the evidence
2. Try to resolve the ambiguity
3. Either upgrade to APPROVED, confirm FLAGGED (needs human), or downgrade to REJECTED

Key rules:
- Bitcoin/crypto is POSITIVE (HRF Bitcoin program)
- Government ministry in Not Free country = REJECT (unless documented dissent)
- Students and early-career professionals should generally be approved if identity checks out
- If you can't resolve it, keep it FLAGGED with a VERY specific next step

Respond with JSON:
{"verdict": "APPROVED" or "FLAGGED" or "REJECTED", "confidence": 0.0-1.0, "reasoning": "detailed analysis", "recommended_next_step": "specific action for human reviewer"}"""


def stage3_deep_review(applicant: dict, profile: dict, verdict_result: dict) -> dict:
    input_text = f"""## Applicant: {applicant.get('full_name', '')} at {applicant.get('organization', '')}

## Research Profile
{json.dumps(profile, indent=2)}

## Initial Verdict
Verdict: {verdict_result.get('verdict', '')}
Confidence: {verdict_result.get('overall_confidence', '')}
Reasoning: {verdict_result.get('reasoning', '')}
Confirmed: {verdict_result.get('verification_scorecard', {}).get('confirmed', [])}
Not found: {verdict_result.get('verification_scorecard', {}).get('not_found', [])}
Concerning: {verdict_result.get('verification_scorecard', {}).get('concerning', [])}
"""

    start = time.time()
    raw = openai_chat("o3-mini",
        [{"role": "system", "content": DEEP_REVIEW_PROMPT}, {"role": "user", "content": input_text}],
        max_tokens=1500)
    latency = int((time.time() - start) * 1000)

    if "```json" in raw:
        raw = raw.split("```json")[1].split("```")[0]
    elif "```" in raw:
        raw = raw.split("```")[1].split("```")[0]
    result = json.loads(raw.strip() or "{}")
    result["latency_ms"] = latency
    result["model"] = "o3-mini"
    return result


# ============================================================
# PIPELINE ORCHESTRATOR
# ============================================================

def process_applicant(applicant: dict) -> dict:
    applicant_id = applicant["id"]
    name = applicant.get("full_name", "Unknown")

    print(f"\n{'='*60}")
    print(f"Processing: {name} (ID: {applicant_id})")
    print(f"  Org: {applicant.get('organization', 'N/A')}")
    print(f"{'='*60}")

    result = {
        "applicant_id": applicant_id,
        "stage1_verdict": None, "stage1_reasoning": None, "stage1_confidence": None,
        "stage2_verdict": None, "stage2_confidence": None, "stage2_reasoning": None,
        "stage3_verdict": "skipped", "stage3_reasoning": None, "stage3_confidence": None,
        "ai_final_verdict": None, "ai_confidence": None,
        "dossier_json": None,
        "linkedin_found": False, "linkedin_url": None,
        "twitter_found": False, "twitter_url": None,
        "instagram_found": False, "instagram_url": None,
        "facebook_found": False, "facebook_url": None,
        "org_website_found": False, "org_website_url": None,
        "model_used_stage1": None, "model_used_stage2": None, "model_used_stage3": None,
        "apify_actors_run": [], "total_latency_ms": 0,
    }

    pipeline_start = time.time()

    # --- Stage 1: Spam Check ---
    print(f"  [Stage 1] Spam check...")
    try:
        spam = stage1_spam_check(applicant)
        result["stage1_verdict"] = spam["verdict"].lower()
        result["stage1_reasoning"] = spam["reasoning"]
        result["stage1_confidence"] = spam["confidence"]
        result["model_used_stage1"] = spam["model"]

        if spam["verdict"] == "SPAM" and spam["confidence"] >= 0.95:
            print(f"  [Stage 1] -> SPAM (confidence: {spam['confidence']})")
            result["ai_final_verdict"] = "spam"
            result["ai_confidence"] = spam["confidence"]
            result["total_latency_ms"] = int((time.time() - pipeline_start) * 1000)
            return result
        print(f"  [Stage 1] -> NOT SPAM (confidence: {spam['confidence']})")
    except Exception as e:
        print(f"  [Stage 1] ERROR: {e}")
        result["stage1_verdict"] = "error"
        result["stage1_reasoning"] = str(e)

    # --- Stage 2a: Exa.ai Research ---
    print(f"  [Stage 2a] Exa.ai deep research...")
    try:
        dossier = stage2a_exa_research(applicant)
        result["dossier_json"] = dossier
        result["linkedin_found"] = dossier["linkedin"]["found"]
        result["linkedin_url"] = dossier["linkedin"].get("url")
        result["twitter_found"] = dossier["twitter"]["found"]
        result["twitter_url"] = dossier["twitter"].get("url")
        result["instagram_found"] = dossier["instagram"]["found"]
        result["instagram_url"] = dossier["instagram"].get("url")
        result["facebook_found"] = dossier["facebook"]["found"]
        result["facebook_url"] = dossier["facebook"].get("url")
        result["org_website_found"] = dossier["org_website"]["found"]
        result["org_website_url"] = dossier["org_website"].get("url")
        result["google_results_summary"] = f"{len(dossier['exa_results'])} Exa results, {len(dossier['person_articles'])} person articles"
        result["scrape_errors"] = dossier["scrape_metadata"]["errors"]
        result["apify_actors_run"] = dossier["scrape_metadata"]["searches_run"]
    except Exception as e:
        print(f"  [Stage 2a] ERROR: {e}")
        traceback.print_exc()
        dossier = {"exa_results": [], "linkedin": {"found": False}, "twitter": {"found": False},
                   "instagram": {"found": False}, "facebook": {"found": False}, "org_website": {"found": False},
                   "person_articles": [], "org_articles": [],
                   "scrape_metadata": {"searches_run": [], "errors": [str(e)]}}
        result["dossier_json"] = dossier

    # --- Stage 2b: Research Synthesis (build profile) ---
    print(f"  [Stage 2b] Research synthesis (building person profile)...")
    try:
        profile = stage2b_research_synthesis(applicant, dossier)
        # Store profile in dossier for the dashboard
        result["dossier_json"]["person_profile"] = profile
        print(f"  [Stage 2b] Profile built. Key sources: {len(profile.get('key_sources', []))}")
    except Exception as e:
        print(f"  [Stage 2b] ERROR: {e}")
        traceback.print_exc()
        profile = {"identity_summary": f"Error building profile: {e}", "key_sources": []}
        result["dossier_json"]["person_profile"] = profile

    # --- Stage 2c: Verdict ---
    print(f"  [Stage 2c] Rendering verdict...")
    try:
        verdict = stage2c_verdict(applicant, profile, dossier)
        result["stage2_verdict"] = verdict["verdict"].lower()
        result["stage2_confidence"] = verdict.get("overall_confidence", 0)
        result["stage2_reasoning"] = verdict.get("reasoning", "")
        result["recommended_next_step"] = verdict.get("recommended_next_step", "")
        result["model_used_stage2"] = verdict["model"]

        # Store detailed verdict data
        result["dossier_json"]["verdict_detail"] = verdict

        scorecard = verdict.get("verification_scorecard", {})
        result["scorecard_confirmed"] = scorecard.get("confirmed", [])
        result["scorecard_not_found"] = scorecard.get("not_found", [])
        result["scorecard_concerning"] = scorecard.get("concerning", [])
        result["identity_verified"] = verdict.get("confidence_breakdown", {}).get("identity", 0) > 0.6
        result["org_verified"] = verdict.get("confidence_breakdown", {}).get("organization", 0) > 0.6

        gov = profile.get("government_connections", "")
        if gov and gov.lower() not in ["none", "n/a", "no government connections found", "none found", "none found."]:
            result["government_affiliation"] = gov

        print(f"  [Stage 2c] -> {verdict['verdict']} (confidence: {verdict.get('overall_confidence', 0)})")
        print(f"  [Stage 2c] Headline: {verdict.get('headline_decision', '')}")

        # Decide if we need Stage 3
        flag_threshold = 0.70
        conf = verdict.get("overall_confidence", 0)
        if verdict["verdict"] in ("APPROVED", "REJECTED") and conf >= flag_threshold:
            result["ai_final_verdict"] = verdict["verdict"].lower()
            result["ai_confidence"] = conf
            result["stage3_verdict"] = "skipped"
            result["total_latency_ms"] = int((time.time() - pipeline_start) * 1000)
            return result

    except Exception as e:
        print(f"  [Stage 2c] ERROR: {e}")
        traceback.print_exc()
        result["stage2_verdict"] = "error"
        result["stage2_reasoning"] = str(e)
        result["ai_final_verdict"] = "flagged"
        result["ai_confidence"] = 0
        result["total_latency_ms"] = int((time.time() - pipeline_start) * 1000)
        return result

    # --- Stage 3: Deep Review (flagged only) ---
    print(f"  [Stage 3] Deep review (flagged or low confidence)...")
    try:
        deep = stage3_deep_review(applicant, profile, verdict)
        result["stage3_verdict"] = deep["verdict"].lower()
        result["stage3_confidence"] = deep["confidence"]
        result["stage3_reasoning"] = deep["reasoning"]
        result["model_used_stage3"] = deep["model"]

        if deep["verdict"] in ("APPROVED", "REJECTED") and deep["confidence"] >= 0.80:
            result["ai_final_verdict"] = deep["verdict"].lower()
            result["ai_confidence"] = deep["confidence"]
        else:
            result["ai_final_verdict"] = "flagged"
            result["ai_confidence"] = deep.get("confidence", 0)
            if deep.get("recommended_next_step"):
                result["recommended_next_step"] = deep["recommended_next_step"]

        print(f"  [Stage 3] -> {deep['verdict']} (confidence: {deep['confidence']})")
    except Exception as e:
        print(f"  [Stage 3] ERROR: {e}")
        result["stage3_verdict"] = "error"
        result["stage3_reasoning"] = str(e)
        result["ai_final_verdict"] = "flagged"
        result["ai_confidence"] = 0

    result["total_latency_ms"] = int((time.time() - pipeline_start) * 1000)
    return result


def save_result(result: dict):
    db_result = {k: v for k, v in result.items() if v is not None}
    supabase.insert("vetting_results", db_result)
    status = "complete" if result.get("ai_final_verdict") else "error"
    supabase.update("applicants", {"status": status, "updated_at": datetime.now(timezone.utc).isoformat()}, "id", result["applicant_id"])


def run_pipeline(limit: int = 5, applicant_ids: list = None):
    if applicant_ids:
        ids_str = ",".join(str(i) for i in applicant_ids)
        applicants = supabase.select("applicants", f"select=*&id=in.({ids_str})")
    else:
        applicants = supabase.select("applicants", f"select=*&status=eq.queued&limit={limit}&order=id.asc")
    print(f"\n{'#'*60}")
    print(f"HRF OFF Vettor v2 Pipeline (Exa.ai Edition)")
    print(f"Processing {len(applicants)} applicants")
    print(f"{'#'*60}")

    results = []
    for i, applicant in enumerate(applicants):
        print(f"\n[{i+1}/{len(applicants)}]", end="")
        supabase.update("applicants", {"status": "processing"}, "id", applicant["id"])

        try:
            result = process_applicant(applicant)
            save_result(result)
            results.append(result)

            verdict = result.get("ai_final_verdict", "error")
            gt = applicant.get("hrf_ground_truth", "")
            match = "MATCH" if verdict.lower() == gt.lower() or (verdict == "spam" and gt.lower() == "rejected") else "MISS"
            print(f"\n  FINAL: {verdict.upper()} (AI) vs {gt} (HRF) -> {match}")

        except Exception as e:
            print(f"\n  PIPELINE ERROR: {e}")
            traceback.print_exc()
            supabase.update("applicants", {"status": "error"}, "id", applicant["id"])

    # Summary
    print(f"\n\n{'='*60}")
    print(f"BATCH COMPLETE: {len(results)} processed")
    if results:
        verdicts = [r.get("ai_final_verdict", "error") for r in results]
        print(f"  Approved: {verdicts.count('approved')}")
        print(f"  Flagged: {verdicts.count('flagged')}")
        print(f"  Rejected: {verdicts.count('rejected')}")
        print(f"  Spam: {verdicts.count('spam')}")

        matches = 0
        for r in results:
            app = next((a for a in applicants if a["id"] == r["applicant_id"]), {})
            gt = app.get("hrf_ground_truth", "").lower()
            ai = r.get("ai_final_verdict", "").lower()
            if ai == gt or (ai == "spam" and gt == "rejected"):
                matches += 1
        print(f"  Accuracy: {matches}/{len(results)} ({matches/len(results)*100:.0f}%)")

    return results


if __name__ == "__main__":
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    run_pipeline(limit=limit)
