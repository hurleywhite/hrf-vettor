/**
 * HRF OFF Vettor v2 — Google Apps Script Edition
 * 3-stage AI vetting pipeline for Oslo Freedom Forum applicants
 *
 * Stage 1: Spam detection (gpt-4o-mini)
 * Stage 2: Exa.ai web research + GPT-5 reasoning verdict
 * Stage 3: Deep review for ambiguous cases (o3-mini)
 *
 * Setup:
 * 1. Open Script Properties (Project Settings > Script Properties)
 * 2. Add: OPENAI_API_KEY = your OpenAI key
 * 3. Add: EXA_API_KEY = your Exa.ai key
 * 4. Run setupSheet() once to create the output columns
 * 5. Use the "HRF Vettor" menu to run the pipeline
 */

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  // Sheet names
  INPUT_SHEET: 'Applicants',

  // Input columns (letters) — these match the original spreadsheet
  // NOTE: No email column — removed for privacy
  COL_NAME: 'A',
  COL_TITLE: 'B',
  COL_ORG: 'C',
  COL_HOW_HEARD: 'D',
  COL_INTEREST: 'E',
  COL_PREV_ATTENDANCE: 'F',
  COL_PREV_FORUMS: 'G',
  COL_COMMENTS: 'H',
  COL_TWITTER: 'I',
  COL_INSTAGRAM: 'J',
  COL_LINKEDIN: 'K',
  COL_FACEBOOK: 'L',
  COL_OTHER_SOCIAL: 'M',

  // Output columns (start after input)
  COL_HRF_TRUTH: 'N',        // HRF ground truth (for testing)
  COL_STATUS: 'O',           // Processing status
  COL_AI_VERDICT: 'P',       // Final AI verdict
  COL_CONFIDENCE: 'Q',       // Overall confidence
  COL_HEADLINE: 'R',         // One-line decision headline
  COL_REASONING: 'S',        // Detailed reasoning
  COL_NEXT_STEP: 'T',        // Recommended next step
  COL_CONFIRMED: 'U',        // Scorecard: confirmed facts
  COL_NOT_FOUND: 'V',        // Scorecard: not found
  COL_CONCERNING: 'W',       // Scorecard: concerning
  COL_IDENTITY: 'X',         // Identity summary from research
  COL_PROFESSIONAL: 'Y',     // Professional background
  COL_ORG_VERIFICATION: 'Z', // Organization verification
  COL_PUBLIC_PRESENCE: 'AA',  // Public presence
  COL_HR_ALIGNMENT: 'AB',    // Human rights alignment
  COL_GOVT_CONNECTIONS: 'AC', // Government connections
  COL_RED_FLAGS: 'AD',       // Red flags
  COL_INFO_GAPS: 'AE',       // Information gaps
  COL_LINKEDIN_URL: 'AF',    // LinkedIn URL found
  COL_TWITTER_URL: 'AG',     // Twitter URL found
  COL_KEY_SOURCES: 'AH',     // Key source URLs
  COL_STAGE1_VERDICT: 'AI',  // Stage 1 result
  COL_STAGE3_VERDICT: 'AJ',  // Stage 3 result (if run)
  COL_LATENCY: 'AK',         // Total processing time
  COL_REVIEWER_NOTE: 'AL',   // Human reviewer notes

  // Models
  MODEL_SPAM: 'gpt-4o-mini',
  MODEL_RESEARCH: 'gpt-5',
  MODEL_VERDICT: 'gpt-5',
  MODEL_DEEP: 'o3-mini',

  // Processing limits
  BATCH_SIZE: 3,  // Process 3 per run (6-min Apps Script limit)
  SPAM_CONFIDENCE_THRESHOLD: 0.95,
  FLAG_THRESHOLD: 0.70,
  DEEP_RESOLVE_THRESHOLD: 0.80,
};


// ============================================================
// MENU & SETUP
// ============================================================

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🔍 HRF Vettor')
    .addItem('▶️ Run Pipeline (next batch)', 'runNextBatch')
    .addItem('▶️ Run Pipeline (ALL remaining)', 'runAllRemaining')
    .addItem('🔄 Run Single Row (selected)', 'runSelectedRow')
    .addSeparator()
    .addItem('⏹️ Stop Auto-Processing', 'stopAutoProcessing')
    .addSeparator()
    .addItem('📊 Show Summary', 'showSummary')
    .addItem('🔧 Setup Output Columns', 'setupOutputColumns')
    .addItem('⚙️ Set API Keys', 'promptForApiKeys')
    .addToUi();
}

function setupOutputColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) {
    sheet = ss.getActiveSheet();
    sheet.setName(CONFIG.INPUT_SHEET);
  }

  // Set header row for output columns
  const headers = {
    [CONFIG.COL_HRF_TRUTH]: 'HRF Ground Truth',
    [CONFIG.COL_STATUS]: 'Status',
    [CONFIG.COL_AI_VERDICT]: 'AI Verdict',
    [CONFIG.COL_CONFIDENCE]: 'Confidence',
    [CONFIG.COL_HEADLINE]: 'Headline Decision',
    [CONFIG.COL_REASONING]: 'Reasoning',
    [CONFIG.COL_NEXT_STEP]: 'Recommended Next Step',
    [CONFIG.COL_CONFIRMED]: 'Confirmed Facts',
    [CONFIG.COL_NOT_FOUND]: 'Not Found',
    [CONFIG.COL_CONCERNING]: 'Concerning',
    [CONFIG.COL_IDENTITY]: 'Identity Summary',
    [CONFIG.COL_PROFESSIONAL]: 'Professional Background',
    [CONFIG.COL_ORG_VERIFICATION]: 'Organization Verification',
    [CONFIG.COL_PUBLIC_PRESENCE]: 'Public Presence',
    [CONFIG.COL_HR_ALIGNMENT]: 'Human Rights Alignment',
    [CONFIG.COL_GOVT_CONNECTIONS]: 'Government Connections',
    [CONFIG.COL_RED_FLAGS]: 'Red Flags',
    [CONFIG.COL_INFO_GAPS]: 'Information Gaps',
    [CONFIG.COL_LINKEDIN_URL]: 'LinkedIn URL',
    [CONFIG.COL_TWITTER_URL]: 'Twitter/X URL',
    [CONFIG.COL_KEY_SOURCES]: 'Key Sources',
    [CONFIG.COL_STAGE1_VERDICT]: 'Stage 1 (Spam)',
    [CONFIG.COL_STAGE3_VERDICT]: 'Stage 3 (Deep Review)',
    [CONFIG.COL_LATENCY]: 'Processing Time',
    [CONFIG.COL_REVIEWER_NOTE]: 'Reviewer Notes',
  };

  for (const [col, label] of Object.entries(headers)) {
    const colNum = columnLetterToNumber_(col);
    sheet.getRange(1, colNum).setValue(label).setFontWeight('bold').setBackground('#334155').setFontColor('#e2e8f0');
  }

  // Color-code verdict column
  sheet.setColumnWidth(columnLetterToNumber_(CONFIG.COL_AI_VERDICT), 120);
  sheet.setColumnWidth(columnLetterToNumber_(CONFIG.COL_HEADLINE), 300);
  sheet.setColumnWidth(columnLetterToNumber_(CONFIG.COL_REASONING), 400);
  sheet.setColumnWidth(columnLetterToNumber_(CONFIG.COL_NEXT_STEP), 300);
  sheet.setColumnWidth(columnLetterToNumber_(CONFIG.COL_REVIEWER_NOTE), 300);

  // Freeze header row
  sheet.setFrozenRows(1);

  SpreadsheetApp.getUi().alert('✅ Output columns set up! You can now run the pipeline from the HRF Vettor menu.');
}

function promptForApiKeys() {
  const ui = SpreadsheetApp.getUi();

  const props = PropertiesService.getScriptProperties();
  const existingOai = props.getProperty('OPENAI_API_KEY');
  const existingExa = props.getProperty('EXA_API_KEY');

  const oaiResult = ui.prompt('OpenAI API Key',
    'Enter your OpenAI API key (starts with sk-proj-).\n' +
    (existingOai ? '✅ Current key: ' + existingOai.substring(0, 15) + '...' : '❌ No key set'),
    ui.ButtonSet.OK_CANCEL);

  if (oaiResult.getSelectedButton() == ui.Button.OK && oaiResult.getResponseText().trim()) {
    props.setProperty('OPENAI_API_KEY', oaiResult.getResponseText().trim());
  }

  const exaResult = ui.prompt('Exa.ai API Key',
    'Enter your Exa.ai API key.\n' +
    (existingExa ? '✅ Current key: ' + existingExa.substring(0, 10) + '...' : '❌ No key set'),
    ui.ButtonSet.OK_CANCEL);

  if (exaResult.getSelectedButton() == ui.Button.OK && exaResult.getResponseText().trim()) {
    props.setProperty('EXA_API_KEY', exaResult.getResponseText().trim());
  }

  ui.alert('✅ API keys saved!');
}


// ============================================================
// API HELPERS
// ============================================================

function getApiKey_(name) {
  const key = PropertiesService.getScriptProperties().getProperty(name);
  if (!key) throw new Error(`Missing API key: ${name}. Go to HRF Vettor > Set API Keys`);
  return key;
}

function openaiChat_(model, messages, maxTokens, temperature, jsonMode) {
  maxTokens = maxTokens || 2000;
  jsonMode = jsonMode !== false;

  const body = {
    model: model,
    messages: messages,
    max_completion_tokens: maxTokens,
  };
  if (temperature !== undefined && temperature !== null) body.temperature = temperature;
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + getApiKey_('OPENAI_API_KEY'),
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const data = JSON.parse(response.getContentText());
  if (code !== 200) throw new Error('OpenAI ' + code + ': ' + JSON.stringify(data));

  return data.choices[0].message.content || '{}';
}

function exaSearch_(query, numResults) {
  numResults = numResults || 10;

  const response = UrlFetchApp.fetch('https://api.exa.ai/search', {
    method: 'post',
    headers: {
      'x-api-key': getApiKey_('EXA_API_KEY'),
      'Content-Type': 'application/json',
    },
    payload: JSON.stringify({
      query: query,
      numResults: numResults,
      contents: {
        text: { maxCharacters: 3000 },
        highlights: { numSentences: 5 },
      },
    }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code !== 200) throw new Error('Exa ' + code + ': ' + response.getContentText());

  return JSON.parse(response.getContentText());
}

function parseJSON_(raw) {
  let s = raw || '{}';
  if (s.indexOf('```json') !== -1) s = s.split('```json')[1].split('```')[0];
  else if (s.indexOf('```') !== -1) s = s.split('```')[1].split('```')[0];
  return JSON.parse(s.trim() || '{}');
}


// ============================================================
// PROMPTS (identical to Python pipeline)
// ============================================================

const SPAM_PROMPT = `You are a spam detector for applications to the Oslo Freedom Forum, a major human rights conference hosted by the Human Rights Foundation.

Your ONLY job is to determine if this application is SPAM or NOT SPAM.

SPAM signals (any ONE is sufficient to mark as spam):
- Gibberish, random characters, or obviously fake names
- Gambling, pornography, or promotional links in any field
- Name matches organization name exactly AND no real content
- Interest statement contains URLs or promotional/commercial language unrelated to human rights
- AI-generated boilerplate that is clearly mass-submitted
- Claims previous attendance = "Yes" but lists no specific forum names
- Mojibake / garbled encoding in interest statement
- Interest statement is fewer than 10 words or a single repeated phrase

NOT spam (do NOT flag these):
- Short or simple interest statements (if they seem genuine and personal)
- Non-English text without promotional content
- Bitcoin or cryptocurrency mentions — HRF has a significant Bitcoin freedom program
- Government affiliations — handled by later stages, not spam
- Names with academic titles or prefixes (Dr., Prof., etc.)
- Long, detailed, personal interest statements
- Applications from people at legitimate-sounding NGOs, commissions, or academic institutions
- CRITICAL: If the interest statement is longer than 100 words and discusses specific personal experience, it is NOT spam regardless of other signals.

Respond with JSON only:
{"verdict": "SPAM" or "NOT_SPAM", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;


const RESEARCH_PROMPT = `You are a research analyst building a comprehensive person profile for the Oslo Freedom Forum vetting team.

Synthesize all available evidence into a structured person profile. Every claim must cite a source URL.

Build this profile:
1. **Identity Summary**: Who is this person? Real name confirmed? Multiple sources confirm same person?
2. **Professional Background**: Current role, past roles, education, expertise. Cite specific URLs.
3. **Organization Verification**: Is the stated organization real? What does it do? Is this person actually affiliated?
4. **Public Presence & Reputation**: Published articles, media mentions, conference appearances.
5. **Social Media Footprint**: Which platforms found, content themes, activity level.
6. **Human Rights Alignment**: Evidence of human rights work, civil society engagement, activism, journalism, Bitcoin/freedom tech.
7. **Government Connections**: Any government affiliations? Which government? Country's Freedom House status?
8. **Red Flags**: State propaganda links, authoritarian connections, inconsistencies.
9. **Information Gaps**: What could NOT be found despite searching?

IMPORTANT: Cite URLs for every factual claim.

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
}`;


const VERDICT_PROMPT = `You are a vetting decision-maker for the Oslo Freedom Forum (OFF), hosted by the Human Rights Foundation (HRF).

## Decision Rules

APPROVE if ANY of these are true:
- Person or organization appears in web results with legitimate context
- Bitcoin/crypto involvement is a STRONG POSITIVE signal — HRF runs a major Bitcoin freedom program
- Students, academics, early-career professionals are welcome
- Organization verified as legitimate NGO/civil society/media/startup
- Interest statement shows genuine personal knowledge of human rights issues
- Refugee support, anti-slavery, press freedom, digital rights, financial inclusion work = APPROVE
- When in doubt between APPROVE and FLAG, lean toward APPROVE if no red flags

REJECT if:
- Current employee of government ministry or state security in a Not Free country
  Not Free: Afghanistan, Belarus, China, Cuba, Egypt, Eritrea, Ethiopia, Iran, Myanmar, North Korea, Russia, Saudi Arabia, Somalia, South Sudan, Sudan, Syria, Tajikistan, Turkmenistan, UAE, Uzbekistan, Venezuela, Yemen
- Purpose involves promoting government agenda, state propaganda, or surveillance
- EXCEPTION: documented pro-democracy dissent by a government official → FLAG instead

FLAG if:
- Government official from a Partly Free state (needs human review)
- Cannot verify identity AND affiliations are vague or concerning
- Conflicting signals
- Confidence below 70%

Respond with JSON:
{
  "verdict": "APPROVED" or "FLAGGED" or "REJECTED",
  "confidence_breakdown": {"identity": 0-1, "organization": 0-1, "alignment": 0-1, "risk": 0-1},
  "overall_confidence": 0.0-1.0,
  "headline_decision": "One sentence explaining the decision",
  "verification_scorecard": {"confirmed": [], "not_found": [], "concerning": []},
  "recommended_next_step": "Specific, actionable instruction for the human reviewer.",
  "reasoning": "2-4 sentence detailed reasoning"
}`;


const DEEP_REVIEW_PROMPT = `You are a senior vetting analyst doing a deep review of a flagged applicant for the Oslo Freedom Forum.

Key rules:
- Bitcoin/crypto is POSITIVE (HRF Bitcoin program)
- Government ministry in Not Free country = REJECT (unless documented dissent)
- Students and early-career professionals should generally be approved if identity checks out
- If you can't resolve it, keep it FLAGGED with a VERY specific next step

Respond with JSON:
{"verdict": "APPROVED" or "FLAGGED" or "REJECTED", "confidence": 0.0-1.0, "reasoning": "detailed analysis", "recommended_next_step": "specific action for human reviewer"}`;


// ============================================================
// STAGE 1: SPAM CHECK
// ============================================================

function stage1SpamCheck_(applicant) {
  const profileText = `Name: ${applicant.name}
Title: ${applicant.title}
Organization: ${applicant.org}
How heard: ${applicant.howHeard}
Interest statement: ${applicant.interest}
Previous attendance: ${applicant.prevAttendance}
Previous forums: ${applicant.prevForums}
Additional comments: ${applicant.comments}
Social media: Twitter=${applicant.twitter}, Instagram=${applicant.instagram}, LinkedIn=${applicant.linkedin}, Facebook=${applicant.facebook}, Other=${applicant.otherSocial}`;

  const raw = openaiChat_(CONFIG.MODEL_SPAM,
    [{ role: 'system', content: SPAM_PROMPT }, { role: 'user', content: profileText }],
    300, 0.0);
  return parseJSON_(raw);
}


// ============================================================
// STAGE 2a: EXA RESEARCH
// ============================================================

function stage2aExaResearch_(applicant) {
  const dossier = {
    exaResults: [],
    linkedin: { found: false },
    twitter: { found: false },
    instagram: { found: false },
    facebook: { found: false },
    orgWebsite: { found: false },
    personArticles: [],
    orgArticles: [],
    searchesRun: [],
    errors: [],
  };

  // Search 1: Person + Organization
  try {
    const data = exaSearch_(applicant.name + ' ' + applicant.org, 10);
    dossier.searchesRun.push('person+org');
    for (const r of (data.results || [])) {
      const entry = { title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 2000), highlights: r.highlights || [] };
      dossier.exaResults.push(entry);
      if (r.url && r.url.indexOf('linkedin.com/in/') !== -1 && !dossier.linkedin.found) {
        dossier.linkedin = { found: true, url: r.url, summary: (r.text || '').substring(0, 500) };
      }
      if (r.url && (r.url.indexOf('twitter.com/') !== -1 || r.url.indexOf('x.com/') !== -1) && !dossier.twitter.found) {
        dossier.twitter = { found: true, url: r.url };
      }
    }
  } catch (e) { dossier.errors.push('Person search: ' + e.message); }

  // Search 2: Organization verification
  if (applicant.org && applicant.org.length > 3) {
    try {
      const data = exaSearch_(applicant.org + ' organization', 5);
      dossier.searchesRun.push('org');
      for (const r of (data.results || [])) {
        dossier.orgArticles.push({ title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 1500) });
      }
    } catch (e) { dossier.errors.push('Org search: ' + e.message); }
  }

  // Search 3: News/activism mentions
  try {
    const data = exaSearch_('"' + applicant.name + '" human rights OR activism', 5);
    dossier.searchesRun.push('news');
    const existingUrls = new Set(dossier.exaResults.map(e => e.url));
    for (const r of (data.results || [])) {
      if (!existingUrls.has(r.url)) {
        dossier.exaResults.push({ title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 1500) });
      }
    }
  } catch (e) { dossier.errors.push('News search: ' + e.message); }

  // Check applicant-provided social links
  if (applicant.linkedin && applicant.linkedin.length > 5) dossier.linkedin = { found: true, url: applicant.linkedin, source: 'provided' };
  if (applicant.twitter && applicant.twitter.length > 5) dossier.twitter = { found: true, url: applicant.twitter, source: 'provided' };
  if (applicant.instagram && applicant.instagram.length > 5) dossier.instagram = { found: true, url: applicant.instagram, source: 'provided' };
  if (applicant.facebook && applicant.facebook.length > 5) dossier.facebook = { found: true, url: applicant.facebook, source: 'provided' };

  return dossier;
}


// ============================================================
// STAGE 2b: RESEARCH SYNTHESIS
// ============================================================

function stage2bResearchSynthesis_(applicant, dossier) {
  let articlesText = '';
  const results = dossier.exaResults.slice(0, 12);
  for (let i = 0; i < results.length; i++) {
    const a = results[i];
    articlesText += '\n--- Source ' + (i + 1) + ': ' + a.title + ' ---\nURL: ' + a.url + '\nContent: ' + (a.text || '').substring(0, 1200) + '\n';
  }

  let orgText = '';
  for (const a of dossier.orgArticles.slice(0, 5)) {
    orgText += '\n--- Org: ' + a.title + ' ---\nURL: ' + a.url + '\nContent: ' + (a.text || '').substring(0, 800) + '\n';
  }

  const inputText = `## Application Data
Name: ${applicant.name}
Title: ${applicant.title}
Organization: ${applicant.org}
Interest: ${applicant.interest}
Previous attendance: ${applicant.prevAttendance}
Previous forums: ${applicant.prevForums}
Comments: ${applicant.comments}

## Social Media Found
LinkedIn: ${JSON.stringify(dossier.linkedin)}
Twitter/X: ${JSON.stringify(dossier.twitter)}

## Web Research Results (${dossier.exaResults.length} results)
${articlesText}

## Organization Research
${orgText || 'No organization-specific results found.'}`;

  const raw = openaiChat_(CONFIG.MODEL_RESEARCH,
    [{ role: 'system', content: RESEARCH_PROMPT }, { role: 'user', content: inputText }],
    3000);
  return parseJSON_(raw);
}


// ============================================================
// STAGE 2c: VERDICT
// ============================================================

function stage2cVerdict_(applicant, profile) {
  const inputText = `## Applicant
Name: ${applicant.name}
Title: ${applicant.title}
Organization: ${applicant.org}

## Research Profile
Identity Summary: ${profile.identity_summary || 'N/A'}
Professional Background: ${profile.professional_background || 'N/A'}
Organization Verification: ${profile.organization_verification || 'N/A'}
Public Presence: ${profile.public_presence || 'N/A'}
Social Media: ${profile.social_media_footprint || 'N/A'}
Human Rights Alignment: ${profile.human_rights_alignment || 'N/A'}
Government Connections: ${profile.government_connections || 'N/A'}
Red Flags: ${profile.red_flags || 'N/A'}
Information Gaps: ${profile.information_gaps || 'N/A'}
Key Sources: ${JSON.stringify(profile.key_sources || [])}`;

  const raw = openaiChat_(CONFIG.MODEL_VERDICT,
    [{ role: 'system', content: VERDICT_PROMPT }, { role: 'user', content: inputText }],
    2000);
  return parseJSON_(raw);
}


// ============================================================
// STAGE 3: DEEP REVIEW
// ============================================================

function stage3DeepReview_(applicant, profile, verdict) {
  const inputText = `## Applicant: ${applicant.name} at ${applicant.org}

## Research Profile
${JSON.stringify(profile)}

## Initial Verdict
Verdict: ${verdict.verdict}
Confidence: ${verdict.overall_confidence}
Reasoning: ${verdict.reasoning}
Confirmed: ${JSON.stringify((verdict.verification_scorecard || {}).confirmed || [])}
Not found: ${JSON.stringify((verdict.verification_scorecard || {}).not_found || [])}
Concerning: ${JSON.stringify((verdict.verification_scorecard || {}).concerning || [])}`;

  const raw = openaiChat_(CONFIG.MODEL_DEEP,
    [{ role: 'system', content: DEEP_REVIEW_PROMPT }, { role: 'user', content: inputText }],
    1500);
  return parseJSON_(raw);
}


// ============================================================
// READ APPLICANT FROM ROW
// ============================================================

function readApplicantFromRow_(sheet, row) {
  return {
    row: row,
    name: getCellValue_(sheet, row, CONFIG.COL_NAME),
    title: getCellValue_(sheet, row, CONFIG.COL_TITLE),
    org: getCellValue_(sheet, row, CONFIG.COL_ORG),
    howHeard: getCellValue_(sheet, row, CONFIG.COL_HOW_HEARD),
    interest: getCellValue_(sheet, row, CONFIG.COL_INTEREST),
    prevAttendance: getCellValue_(sheet, row, CONFIG.COL_PREV_ATTENDANCE),
    prevForums: getCellValue_(sheet, row, CONFIG.COL_PREV_FORUMS),
    comments: getCellValue_(sheet, row, CONFIG.COL_COMMENTS),
    twitter: getCellValue_(sheet, row, CONFIG.COL_TWITTER),
    instagram: getCellValue_(sheet, row, CONFIG.COL_INSTAGRAM),
    linkedin: getCellValue_(sheet, row, CONFIG.COL_LINKEDIN),
    facebook: getCellValue_(sheet, row, CONFIG.COL_FACEBOOK),
    otherSocial: getCellValue_(sheet, row, CONFIG.COL_OTHER_SOCIAL),
    hrfTruth: getCellValue_(sheet, row, CONFIG.COL_HRF_TRUTH),
  };
}


// ============================================================
// PROCESS ONE APPLICANT (full pipeline)
// ============================================================

function processOneApplicant_(sheet, row) {
  const applicant = readApplicantFromRow_(sheet, row);
  if (!applicant.name || applicant.name.trim().length === 0) return null;

  const startTime = new Date();
  setCellValue_(sheet, row, CONFIG.COL_STATUS, '⏳ Processing...');
  SpreadsheetApp.flush();

  let finalVerdict = 'flagged';
  let finalConfidence = 0;
  let profile = {};
  let verdict = {};
  let dossier = {};

  try {
    // === STAGE 1: Spam Check ===
    setCellValue_(sheet, row, CONFIG.COL_STATUS, '⏳ Stage 1: Spam check...');
    SpreadsheetApp.flush();

    const spam = stage1SpamCheck_(applicant);
    setCellValue_(sheet, row, CONFIG.COL_STAGE1_VERDICT, (spam.verdict || '').toUpperCase() + ' (' + Math.round((spam.confidence || 0) * 100) + '%)');

    if (spam.verdict === 'SPAM' && spam.confidence >= CONFIG.SPAM_CONFIDENCE_THRESHOLD) {
      finalVerdict = 'SPAM';
      finalConfidence = spam.confidence;
      writeResults_(sheet, row, {
        verdict: 'SPAM',
        confidence: spam.confidence,
        headline: 'Detected as spam: ' + spam.reasoning,
        reasoning: spam.reasoning,
        stage1: spam.verdict + ' (' + Math.round(spam.confidence * 100) + '%)',
      }, startTime);
      return { verdict: 'SPAM', name: applicant.name };
    }

    // === STAGE 2a: Exa Research ===
    setCellValue_(sheet, row, CONFIG.COL_STATUS, '⏳ Stage 2a: Web research...');
    SpreadsheetApp.flush();

    dossier = stage2aExaResearch_(applicant);

    // === STAGE 2b: Research Synthesis ===
    setCellValue_(sheet, row, CONFIG.COL_STATUS, '⏳ Stage 2b: Analyzing research...');
    SpreadsheetApp.flush();

    profile = stage2bResearchSynthesis_(applicant, dossier);

    // === STAGE 2c: Verdict ===
    setCellValue_(sheet, row, CONFIG.COL_STATUS, '⏳ Stage 2c: Rendering verdict...');
    SpreadsheetApp.flush();

    verdict = stage2cVerdict_(applicant, profile);

    const conf = verdict.overall_confidence || 0;

    if ((verdict.verdict === 'APPROVED' || verdict.verdict === 'REJECTED') && conf >= CONFIG.FLAG_THRESHOLD) {
      // Resolved at Stage 2
      writeResults_(sheet, row, {
        verdict: verdict.verdict,
        confidence: conf,
        headline: verdict.headline_decision,
        reasoning: verdict.reasoning,
        nextStep: verdict.recommended_next_step,
        confirmed: (verdict.verification_scorecard || {}).confirmed || [],
        notFound: (verdict.verification_scorecard || {}).not_found || [],
        concerning: (verdict.verification_scorecard || {}).concerning || [],
        profile: profile,
        dossier: dossier,
        stage1: spam.verdict + ' (' + Math.round(spam.confidence * 100) + '%)',
        stage3: 'Skipped (resolved at Stage 2)',
      }, startTime);
      return { verdict: verdict.verdict, name: applicant.name };
    }

    // === STAGE 3: Deep Review ===
    setCellValue_(sheet, row, CONFIG.COL_STATUS, '⏳ Stage 3: Deep review...');
    SpreadsheetApp.flush();

    const deep = stage3DeepReview_(applicant, profile, verdict);

    if ((deep.verdict === 'APPROVED' || deep.verdict === 'REJECTED') && deep.confidence >= CONFIG.DEEP_RESOLVE_THRESHOLD) {
      finalVerdict = deep.verdict;
      finalConfidence = deep.confidence;
    } else {
      finalVerdict = 'FLAGGED';
      finalConfidence = deep.confidence || conf;
    }

    writeResults_(sheet, row, {
      verdict: finalVerdict,
      confidence: finalConfidence,
      headline: verdict.headline_decision,
      reasoning: verdict.reasoning + '\n\n[Deep Review] ' + deep.reasoning,
      nextStep: deep.recommended_next_step || verdict.recommended_next_step,
      confirmed: (verdict.verification_scorecard || {}).confirmed || [],
      notFound: (verdict.verification_scorecard || {}).not_found || [],
      concerning: (verdict.verification_scorecard || {}).concerning || [],
      profile: profile,
      dossier: dossier,
      stage1: spam.verdict + ' (' + Math.round(spam.confidence * 100) + '%)',
      stage3: deep.verdict + ' (' + Math.round((deep.confidence || 0) * 100) + '%): ' + deep.reasoning,
    }, startTime);

    return { verdict: finalVerdict, name: applicant.name };

  } catch (e) {
    setCellValue_(sheet, row, CONFIG.COL_STATUS, '❌ Error');
    setCellValue_(sheet, row, CONFIG.COL_AI_VERDICT, 'ERROR');
    setCellValue_(sheet, row, CONFIG.COL_REASONING, e.message);
    return { verdict: 'ERROR', name: applicant.name, error: e.message };
  }
}


// ============================================================
// WRITE RESULTS TO ROW
// ============================================================

function writeResults_(sheet, row, data, startTime) {
  const elapsed = Math.round((new Date() - startTime) / 1000);

  // Verdict with color
  const verdictCell = sheet.getRange(row, columnLetterToNumber_(CONFIG.COL_AI_VERDICT));
  verdictCell.setValue(data.verdict);
  switch ((data.verdict || '').toUpperCase()) {
    case 'APPROVED': verdictCell.setBackground('#064e3b').setFontColor('#4ade80'); break;
    case 'FLAGGED': verdictCell.setBackground('#78350f').setFontColor('#fbbf24'); break;
    case 'REJECTED': verdictCell.setBackground('#7f1d1d').setFontColor('#f87171'); break;
    case 'SPAM': verdictCell.setBackground('#3b0764').setFontColor('#c084fc'); break;
  }

  setCellValue_(sheet, row, CONFIG.COL_STATUS, '✅ Complete');
  setCellValue_(sheet, row, CONFIG.COL_CONFIDENCE, Math.round((data.confidence || 0) * 100) + '%');
  setCellValue_(sheet, row, CONFIG.COL_HEADLINE, data.headline || '');
  setCellValue_(sheet, row, CONFIG.COL_REASONING, data.reasoning || '');
  setCellValue_(sheet, row, CONFIG.COL_NEXT_STEP, data.nextStep || '');
  setCellValue_(sheet, row, CONFIG.COL_CONFIRMED, (data.confirmed || []).join('\n'));
  setCellValue_(sheet, row, CONFIG.COL_NOT_FOUND, (data.notFound || []).join('\n'));
  setCellValue_(sheet, row, CONFIG.COL_CONCERNING, (data.concerning || []).join('\n'));
  setCellValue_(sheet, row, CONFIG.COL_STAGE1_VERDICT, data.stage1 || '');
  setCellValue_(sheet, row, CONFIG.COL_STAGE3_VERDICT, data.stage3 || '');
  setCellValue_(sheet, row, CONFIG.COL_LATENCY, elapsed + 's');

  // Research profile columns
  if (data.profile) {
    setCellValue_(sheet, row, CONFIG.COL_IDENTITY, data.profile.identity_summary || '');
    setCellValue_(sheet, row, CONFIG.COL_PROFESSIONAL, data.profile.professional_background || '');
    setCellValue_(sheet, row, CONFIG.COL_ORG_VERIFICATION, data.profile.organization_verification || '');
    setCellValue_(sheet, row, CONFIG.COL_PUBLIC_PRESENCE, data.profile.public_presence || '');
    setCellValue_(sheet, row, CONFIG.COL_HR_ALIGNMENT, data.profile.human_rights_alignment || '');
    setCellValue_(sheet, row, CONFIG.COL_GOVT_CONNECTIONS, data.profile.government_connections || '');
    setCellValue_(sheet, row, CONFIG.COL_RED_FLAGS, data.profile.red_flags || '');
    setCellValue_(sheet, row, CONFIG.COL_INFO_GAPS, data.profile.information_gaps || '');
    setCellValue_(sheet, row, CONFIG.COL_KEY_SOURCES, (data.profile.key_sources || []).join('\n'));
  }

  // Social links found
  if (data.dossier) {
    if (data.dossier.linkedin && data.dossier.linkedin.found) setCellValue_(sheet, row, CONFIG.COL_LINKEDIN_URL, data.dossier.linkedin.url || '');
    if (data.dossier.twitter && data.dossier.twitter.found) setCellValue_(sheet, row, CONFIG.COL_TWITTER_URL, data.dossier.twitter.url || '');
  }

  SpreadsheetApp.flush();
}


// ============================================================
// BATCH RUNNERS
// ============================================================

function runNextBatch() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "' + CONFIG.INPUT_SHEET + '" not found. Run Setup Output Columns first.'); return; }

  const lastRow = sheet.getLastRow();
  let processed = 0;
  const results = [];

  for (let row = 2; row <= lastRow && processed < CONFIG.BATCH_SIZE; row++) {
    const status = getCellValue_(sheet, row, CONFIG.COL_STATUS);
    const name = getCellValue_(sheet, row, CONFIG.COL_NAME);

    // Skip already processed or empty rows
    if (!name || name.trim().length === 0) continue;
    if (status && (status.indexOf('✅') !== -1 || status.indexOf('Complete') !== -1)) continue;
    if (status && status.indexOf('❌') !== -1) continue; // skip errors too

    const result = processOneApplicant_(sheet, row);
    if (result) {
      results.push(result);
      processed++;
    }
  }

  if (processed === 0) {
    SpreadsheetApp.getUi().alert('✅ All applicants have been processed!');
  } else {
    const summary = results.map(r => r.name + ': ' + r.verdict).join('\n');
    SpreadsheetApp.getUi().alert('Processed ' + processed + ' applicants:\n\n' + summary);
  }
}

function runAllRemaining() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "' + CONFIG.INPUT_SHEET + '" not found.'); return; }

  const ui = SpreadsheetApp.getUi();
  const confirm = ui.alert('Run All Remaining',
    'This will process all unprocessed applicants in batches of ' + CONFIG.BATCH_SIZE +
    '. Each batch takes ~3-5 minutes.\n\nIt will auto-continue until all are done (using time-based triggers).\n\nProceed?',
    ui.ButtonSet.YES_NO);

  if (confirm !== ui.Button.YES) return;

  // Process first batch immediately
  runNextBatchSilent_();

  // Set up trigger for remaining batches
  const remaining = countRemaining_(sheet);
  if (remaining > 0) {
    // Create a trigger to continue processing every 7 minutes
    ScriptApp.newTrigger('runNextBatchSilent_')
      .timeBased()
      .everyMinutes(1) // will be called every ~1 min, but each run takes ~5 min for 3 applicants
      .create();

    ui.alert('✅ First batch done. Auto-processing ' + remaining + ' remaining applicants.\n\nYou can close this and come back — it will keep running.\n\nUse HRF Vettor > Stop Auto-Processing to halt.');
  } else {
    ui.alert('✅ All applicants processed!');
  }
}

function runNextBatchSilent_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  let processed = 0;

  for (let row = 2; row <= lastRow && processed < CONFIG.BATCH_SIZE; row++) {
    const status = getCellValue_(sheet, row, CONFIG.COL_STATUS);
    const name = getCellValue_(sheet, row, CONFIG.COL_NAME);

    if (!name || name.trim().length === 0) continue;
    if (status && (status.indexOf('✅') !== -1 || status.indexOf('Complete') !== -1)) continue;
    if (status && status.indexOf('❌') !== -1) continue;

    processOneApplicant_(sheet, row);
    processed++;
  }

  // If nothing left, remove the trigger
  if (processed === 0 || countRemaining_(sheet) === 0) {
    stopAutoProcessing();
  }
}

function runSelectedRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveCell().getRow();

  if (row < 2) {
    SpreadsheetApp.getUi().alert('Select a data row (not the header).');
    return;
  }

  const name = getCellValue_(sheet, row, CONFIG.COL_NAME);
  if (!name) {
    SpreadsheetApp.getUi().alert('No applicant name found in this row.');
    return;
  }

  const result = processOneApplicant_(sheet, row);
  if (result) {
    SpreadsheetApp.getUi().alert('Done!\n\n' + result.name + ': ' + result.verdict);
  }
}

function stopAutoProcessing() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'runNextBatchSilent_') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  SpreadsheetApp.getUi().alert('⏹️ Auto-processing stopped.');
}

function countRemaining_(sheet) {
  const lastRow = sheet.getLastRow();
  let count = 0;
  for (let row = 2; row <= lastRow; row++) {
    const status = getCellValue_(sheet, row, CONFIG.COL_STATUS);
    const name = getCellValue_(sheet, row, CONFIG.COL_NAME);
    if (!name || name.trim().length === 0) continue;
    if (status && (status.indexOf('✅') !== -1 || status.indexOf('❌') !== -1)) continue;
    count++;
  }
  return count;
}


// ============================================================
// SUMMARY
// ============================================================

function showSummary() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  const counts = { APPROVED: 0, FLAGGED: 0, REJECTED: 0, SPAM: 0, ERROR: 0, pending: 0 };
  let matches = 0, total = 0;

  for (let row = 2; row <= lastRow; row++) {
    const name = getCellValue_(sheet, row, CONFIG.COL_NAME);
    if (!name) continue;

    const verdict = (getCellValue_(sheet, row, CONFIG.COL_AI_VERDICT) || '').toUpperCase();
    const truth = (getCellValue_(sheet, row, CONFIG.COL_HRF_TRUTH) || '').toUpperCase();

    if (verdict in counts) {
      counts[verdict]++;
      if (truth) {
        total++;
        if (verdict === truth || (verdict === 'SPAM' && truth === 'REJECTED')) matches++;
      }
    } else {
      counts.pending++;
    }
  }

  const accuracy = total > 0 ? Math.round(matches / total * 100) : 'N/A';

  SpreadsheetApp.getUi().alert(
    '📊 Pipeline Summary\n\n' +
    '✅ Approved: ' + counts.APPROVED + '\n' +
    '🟡 Flagged: ' + counts.FLAGGED + '\n' +
    '❌ Rejected: ' + counts.REJECTED + '\n' +
    '🗑️ Spam: ' + counts.SPAM + '\n' +
    '⚠️ Errors: ' + counts.ERROR + '\n' +
    '⏳ Pending: ' + counts.pending + '\n\n' +
    (total > 0 ? '🎯 Accuracy: ' + accuracy + '% (' + matches + '/' + total + ' vs HRF ground truth)' : 'No ground truth data to compare.')
  );
}


// ============================================================
// UTILITY HELPERS
// ============================================================

function columnLetterToNumber_(letter) {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col;
}

function getCellValue_(sheet, row, colLetter) {
  return String(sheet.getRange(row, columnLetterToNumber_(colLetter)).getValue() || '').trim();
}

function setCellValue_(sheet, row, colLetter, value) {
  sheet.getRange(row, columnLetterToNumber_(colLetter)).setValue(value);
}
