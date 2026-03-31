/**
 * HRF OFF Vettor v2 — Google Apps Script Edition
 * 7-step AI vetting pipeline for Oslo Freedom Forum applicants
 *
 * Flow:
 *   1. Spam Filter        (gpt-4o-mini) — quick junk detection
 *   2. Web Research        (Exa.ai)      — 3 searches per person
 *   3. Initial Decision    (gpt-5)       — Approved / Flagged / Rejected
 *   4. Synthesis Report    (gpt-5)       — what was found, what's missing, why
 *   5. Deeper Research     (Exa.ai)      — targeted follow-up for FLAGGED only
 *   6. Updated Synthesis   (gpt-5)       — incorporate new findings
 *   7. Final Decision      (gpt-5)       — resolve the flag
 *
 * Setup:
 *   1. Paste this into Extensions > Apps Script
 *   2. Click HRF Vettor > Set API Keys
 *   3. Click HRF Vettor > Setup Output Columns
 *   4. Paste applicant data into columns A-M
 *   5. Click HRF Vettor > Run Pipeline
 */

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  INPUT_SHEET: 'Applicants',

  // Input columns (A-M) — no email
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

  // Output columns
  COL_HRF_TRUTH: 'N',           // Ground truth (testing only)
  COL_STATUS: 'O',              // Processing status
  COL_AI_VERDICT: 'P',          // Final verdict
  COL_CONFIDENCE: 'Q',          // Confidence %
  COL_HEADLINE: 'R',            // One-line headline decision
  COL_WHAT_FOUND: 'S',          // Synthesis: what was found
  COL_WHAT_MISSING: 'T',        // Synthesis: what's still unverified
  COL_WHAT_REVIEWER_SHOULD: 'U',// Synthesis: what reviewer should check
  COL_REASONING: 'V',           // Full reasoning
  COL_IDENTITY: 'W',            // Identity summary
  COL_PROFESSIONAL: 'X',        // Professional background
  COL_ORG_VERIFICATION: 'Y',    // Org verification
  COL_PUBLIC_PRESENCE: 'Z',     // Public presence
  COL_HR_ALIGNMENT: 'AA',       // Human rights alignment
  COL_GOVT_CONNECTIONS: 'AB',   // Government connections
  COL_RED_FLAGS: 'AC',          // Red flags
  COL_INFO_GAPS: 'AD',          // Information gaps
  COL_LINKEDIN_URL: 'AE',       // LinkedIn found
  COL_TWITTER_URL: 'AF',        // Twitter found
  COL_KEY_SOURCES: 'AG',        // Source URLs
  COL_SPAM_RESULT: 'AH',        // Step 1 result
  COL_INITIAL_DECISION: 'AI',   // Step 3 result
  COL_DEEP_RESEARCH: 'AJ',      // Step 5 result (if flagged)
  COL_FINAL_DECISION: 'AK',     // Step 7 result (if flagged)
  COL_LATENCY: 'AL',            // Processing time
  COL_REVIEWER_NOTE: 'AM',      // Human reviewer notes

  // Models
  MODEL_SPAM: 'gpt-4o-mini',
  MODEL_DECISION: 'gpt-5',
  MODEL_SYNTHESIS: 'gpt-5',
  MODEL_DEEP_DECISION: 'gpt-5',

  // Thresholds
  BATCH_SIZE: 3,
  SPAM_THRESHOLD: 0.95,
  RESOLVE_THRESHOLD: 0.70,
};


// ============================================================
// MENU & SETUP
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('🔍 HRF Vettor')
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
  if (!sheet) { sheet = ss.getActiveSheet(); sheet.setName(CONFIG.INPUT_SHEET); }

  const headers = {
    [CONFIG.COL_HRF_TRUTH]: 'HRF Ground Truth',
    [CONFIG.COL_STATUS]: 'Status',
    [CONFIG.COL_AI_VERDICT]: 'AI Verdict',
    [CONFIG.COL_CONFIDENCE]: 'Confidence',
    [CONFIG.COL_HEADLINE]: 'Headline Decision',
    [CONFIG.COL_WHAT_FOUND]: 'What Was Found',
    [CONFIG.COL_WHAT_MISSING]: 'What Is Still Unverified',
    [CONFIG.COL_WHAT_REVIEWER_SHOULD]: 'What Reviewer Should Check',
    [CONFIG.COL_REASONING]: 'Full Reasoning',
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
    [CONFIG.COL_SPAM_RESULT]: 'Step 1: Spam Check',
    [CONFIG.COL_INITIAL_DECISION]: 'Step 3: Initial Decision',
    [CONFIG.COL_DEEP_RESEARCH]: 'Step 5: Deeper Research',
    [CONFIG.COL_FINAL_DECISION]: 'Step 7: Final Decision',
    [CONFIG.COL_LATENCY]: 'Processing Time',
    [CONFIG.COL_REVIEWER_NOTE]: 'Reviewer Notes',
  };

  for (const [col, label] of Object.entries(headers)) {
    const n = colToNum_(col);
    sheet.getRange(1, n).setValue(label).setFontWeight('bold').setBackground('#334155').setFontColor('#e2e8f0');
  }

  // Set useful column widths
  sheet.setColumnWidth(colToNum_(CONFIG.COL_HEADLINE), 300);
  sheet.setColumnWidth(colToNum_(CONFIG.COL_WHAT_FOUND), 350);
  sheet.setColumnWidth(colToNum_(CONFIG.COL_WHAT_MISSING), 300);
  sheet.setColumnWidth(colToNum_(CONFIG.COL_WHAT_REVIEWER_SHOULD), 300);
  sheet.setColumnWidth(colToNum_(CONFIG.COL_REASONING), 400);
  sheet.setColumnWidth(colToNum_(CONFIG.COL_REVIEWER_NOTE), 300);
  sheet.setFrozenRows(1);

  SpreadsheetApp.getUi().alert('✅ Output columns created! Paste your applicant data into columns A-M, then run the pipeline.');
}

function promptForApiKeys() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const oai = props.getProperty('OPENAI_API_KEY');
  const exa = props.getProperty('EXA_API_KEY');

  const r1 = ui.prompt('OpenAI API Key',
    'Enter your OpenAI key (starts with sk-proj-).\n' + (oai ? '✅ Key set: ' + oai.substring(0, 15) + '...' : '❌ No key'),
    ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() == ui.Button.OK && r1.getResponseText().trim())
    props.setProperty('OPENAI_API_KEY', r1.getResponseText().trim());

  const r2 = ui.prompt('Exa.ai API Key',
    'Enter your Exa key.\n' + (exa ? '✅ Key set: ' + exa.substring(0, 10) + '...' : '❌ No key'),
    ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() == ui.Button.OK && r2.getResponseText().trim())
    props.setProperty('EXA_API_KEY', r2.getResponseText().trim());

  ui.alert('✅ API keys saved!');
}


// ============================================================
// API HELPERS
// ============================================================

function getKey_(name) {
  const k = PropertiesService.getScriptProperties().getProperty(name);
  if (!k) throw new Error('Missing: ' + name + '. Go to HRF Vettor > Set API Keys');
  return k;
}

function gpt_(model, system, user, maxTokens) {
  const body = {
    model: model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: maxTokens || 2000,
    response_format: { type: 'json_object' },
  };

  const r = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + getKey_('OPENAI_API_KEY'), 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (r.getResponseCode() !== 200) throw new Error('OpenAI ' + r.getResponseCode() + ': ' + r.getContentText());
  const raw = JSON.parse(r.getContentText()).choices[0].message.content || '{}';

  // Parse JSON (handle markdown code blocks)
  let s = raw;
  if (s.indexOf('```json') !== -1) s = s.split('```json')[1].split('```')[0];
  else if (s.indexOf('```') !== -1) s = s.split('```')[1].split('```')[0];
  return JSON.parse(s.trim() || '{}');
}

function exa_(query, numResults) {
  const r = UrlFetchApp.fetch('https://api.exa.ai/search', {
    method: 'post',
    headers: { 'x-api-key': getKey_('EXA_API_KEY'), 'Content-Type': 'application/json' },
    payload: JSON.stringify({
      query: query,
      numResults: numResults || 10,
      contents: { text: { maxCharacters: 3000 }, highlights: { numSentences: 5 } },
    }),
    muteHttpExceptions: true,
  });

  if (r.getResponseCode() !== 200) throw new Error('Exa ' + r.getResponseCode() + ': ' + r.getContentText());
  return JSON.parse(r.getContentText());
}


// ============================================================
// STEP 1: SPAM FILTER (gpt-4o-mini)
// ============================================================

const SPAM_PROMPT = `You are a spam detector for applications to the Oslo Freedom Forum, a major human rights conference.

SPAM signals (any ONE = spam):
- Gibberish, random characters, obviously fake names
- Gambling, pornography, promotional links
- Name = organization name exactly AND no real content
- Promotional/commercial interest statement unrelated to human rights
- AI-generated boilerplate, mass-submitted templates
- Claims attendance but lists no specific forums
- Mojibake / garbled encoding
- Interest < 10 words or single repeated phrase

NOT spam:
- Short but genuine interest statements
- Non-English text without promo content
- Bitcoin/cryptocurrency mentions (HRF has a Bitcoin program)
- Government affiliations (handled later)
- Academic titles (Dr., Prof.)
- Long personal interest statements (>100 words with specific experience = NOT spam)
- Legitimate NGOs, commissions, academic institutions

Respond JSON: {"verdict": "SPAM" or "NOT_SPAM", "confidence": 0.0-1.0, "reasoning": "brief explanation"}`;

function step1_spamFilter(app) {
  return gpt_(CONFIG.MODEL_SPAM, SPAM_PROMPT,
    `Name: ${app.name}\nTitle: ${app.title}\nOrg: ${app.org}\nHow heard: ${app.howHeard}\nInterest: ${app.interest}\nPrev attendance: ${app.prevAttendance}\nPrev forums: ${app.prevForums}\nComments: ${app.comments}\nSocials: Twitter=${app.twitter}, LinkedIn=${app.linkedin}, Instagram=${app.instagram}`,
    300);
}


// ============================================================
// STEP 2: WEB RESEARCH (Exa.ai — 3 searches)
// ============================================================

function step2_webResearch(app) {
  const research = { results: [], orgResults: [], linkedin: null, twitter: null, errors: [], searches: [] };

  // Search 1: Person + Org
  try {
    const d = exa_(app.name + ' ' + app.org, 10);
    research.searches.push('person+org');
    for (const r of (d.results || [])) {
      const entry = { title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 2000), highlights: r.highlights || [] };
      research.results.push(entry);
      if (r.url && r.url.indexOf('linkedin.com/in/') !== -1 && !research.linkedin) research.linkedin = r.url;
      if (r.url && (r.url.indexOf('twitter.com/') !== -1 || r.url.indexOf('x.com/') !== -1) && !research.twitter) research.twitter = r.url;
    }
  } catch (e) { research.errors.push('Person: ' + e.message); }

  // Search 2: Organization
  if (app.org && app.org.length > 3) {
    try {
      const d = exa_(app.org + ' organization', 5);
      research.searches.push('org');
      for (const r of (d.results || [])) research.orgResults.push({ title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 1500) });
    } catch (e) { research.errors.push('Org: ' + e.message); }
  }

  // Search 3: News/activism
  try {
    const d = exa_('"' + app.name + '" human rights OR activism OR conference', 5);
    research.searches.push('news');
    const urls = new Set(research.results.map(e => e.url));
    for (const r of (d.results || [])) {
      if (!urls.has(r.url)) research.results.push({ title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 1500) });
    }
  } catch (e) { research.errors.push('News: ' + e.message); }

  // Add applicant-provided social links
  if (app.linkedin && app.linkedin.length > 5 && !research.linkedin) research.linkedin = app.linkedin;
  if (app.twitter && app.twitter.length > 5 && !research.twitter) research.twitter = app.twitter;

  return research;
}


// ============================================================
// STEP 3: INITIAL DECISION (gpt-5)
// ============================================================

const DECISION_PROMPT = `You are a vetting decision-maker for the Oslo Freedom Forum (HRF).

You will receive an applicant's application AND web research results from Exa.ai. Make a decision.

APPROVE if ANY:
- Person/org found in web results with legitimate context
- Bitcoin/crypto = STRONG POSITIVE (HRF Bitcoin program)
- Students, academics, early-career = welcome (thin web presence is normal)
- Verified NGO/civil society/media/startup
- Genuine human rights knowledge in interest statement
- Refugee support, press freedom, digital rights, financial inclusion
- When in doubt between APPROVE and FLAG → lean APPROVE if no red flags

REJECT if:
- Government ministry/state security in Not Free country (Afghanistan, Belarus, China, Cuba, Egypt, Eritrea, Ethiopia, Iran, Myanmar, North Korea, Russia, Saudi Arabia, Somalia, South Sudan, Sudan, Syria, Tajikistan, Turkmenistan, UAE, Uzbekistan, Venezuela, Yemen)
- Promoting government agenda/propaganda/surveillance
- Exception: documented dissent → FLAG instead

FLAG if:
- Government official from Partly Free state
- Cannot verify identity AND affiliations are vague/concerning
- Conflicting signals
- Confidence < 70%

Respond JSON:
{
  "verdict": "APPROVED" or "FLAGGED" or "REJECTED",
  "overall_confidence": 0.0-1.0,
  "headline_decision": "One sentence: what was confirmed and why this decision",
  "reasoning": "2-4 sentences",
  "flag_reason": "If FLAGGED: what specific info is missing that would resolve this?"
}`;

function step3_initialDecision(app, research) {
  let articlesText = '';
  for (let i = 0; i < Math.min(research.results.length, 12); i++) {
    const a = research.results[i];
    articlesText += '\n--- Source ' + (i + 1) + ': ' + a.title + ' ---\nURL: ' + a.url + '\n' + (a.text || '').substring(0, 1200) + '\n';
  }
  let orgText = '';
  for (const a of research.orgResults.slice(0, 5)) {
    orgText += '\n--- ' + a.title + ' ---\nURL: ' + a.url + '\n' + (a.text || '').substring(0, 800) + '\n';
  }

  return gpt_(CONFIG.MODEL_DECISION, DECISION_PROMPT,
    `## Application\nName: ${app.name}\nTitle: ${app.title}\nOrg: ${app.org}\nInterest: ${app.interest}\nPrev attendance: ${app.prevAttendance}\nForums: ${app.prevForums}\nComments: ${app.comments}\n\n## Web Research (${research.results.length} results)\n${articlesText}\n\n## Org Research\n${orgText || 'None'}`,
    1500);
}


// ============================================================
// STEP 4: SYNTHESIS REPORT (gpt-5 — runs for ALL applicants)
// ============================================================

const SYNTHESIS_PROMPT = `You are a research analyst writing a vetting report for the Oslo Freedom Forum team.

You have an applicant's data, web research, and an initial AI decision. Write a structured report that a human reviewer can use.

Your report MUST include:
1. **Identity Summary**: Who is this person based on what was found?
2. **Professional Background**: Roles, education, expertise — cite URLs
3. **Organization Verification**: Is the org real? What does it do? Is this person affiliated?
4. **Public Presence**: Articles, media, conferences — cite URLs
5. **Human Rights Alignment**: Evidence of HR work, activism, journalism, Bitcoin/freedom tech
6. **Government Connections**: Any govt ties? Which country? Freedom House status?
7. **Red Flags**: Inconsistencies, propaganda links, authoritarian connections
8. **Information Gaps**: What could NOT be found

Then provide three synthesis fields:
- **what_was_found**: Bullet list of confirmed facts with source URLs
- **what_is_unverified**: Bullet list of claims that couldn't be verified
- **what_reviewer_should_check**: Specific actions for the human reviewer (e.g., "Check LinkedIn profile at [url] to confirm current role")

Cite URLs for every factual claim. If nothing found, say so.

Respond JSON:
{
  "identity_summary": "...",
  "professional_background": "...",
  "organization_verification": "...",
  "public_presence": "...",
  "human_rights_alignment": "...",
  "government_connections": "...",
  "red_flags": "...",
  "information_gaps": "...",
  "what_was_found": ["fact 1 (source: url)", "fact 2 (source: url)"],
  "what_is_unverified": ["claim 1", "claim 2"],
  "what_reviewer_should_check": ["action 1", "action 2"],
  "key_sources": ["url1", "url2"]
}`;

function step4_synthesisReport(app, research, decision) {
  let articlesText = '';
  for (let i = 0; i < Math.min(research.results.length, 15); i++) {
    const a = research.results[i];
    articlesText += '\n--- Source ' + (i + 1) + ': ' + a.title + ' ---\nURL: ' + a.url + '\n';
    if (a.highlights && a.highlights.length > 0) articlesText += 'Highlights: ' + a.highlights.slice(0, 3).join(' | ') + '\n';
    articlesText += (a.text || '').substring(0, 1200) + '\n';
  }
  let orgText = '';
  for (const a of research.orgResults.slice(0, 5)) {
    orgText += '\n--- ' + a.title + ' ---\nURL: ' + a.url + '\n' + (a.text || '').substring(0, 800) + '\n';
  }

  return gpt_(CONFIG.MODEL_SYNTHESIS, SYNTHESIS_PROMPT,
    `## Application\nName: ${app.name}\nTitle: ${app.title}\nOrg: ${app.org}\nInterest: ${app.interest}\nComments: ${app.comments}\nLinkedIn: ${research.linkedin || 'not found'}\nTwitter: ${research.twitter || 'not found'}\n\n## Initial Decision: ${decision.verdict} (${Math.round((decision.overall_confidence || 0) * 100)}%)\nReasoning: ${decision.reasoning}\n${decision.flag_reason ? 'Flag reason: ' + decision.flag_reason : ''}\n\n## Web Research (${research.results.length} results)\n${articlesText}\n\n## Org Research\n${orgText || 'None'}`,
    3000);
}


// ============================================================
// STEP 5: DEEPER RESEARCH (Exa.ai — FLAGGED only)
// ============================================================

function step5_deeperResearch(app, decision, synthesis) {
  const deepResults = { results: [], searches: [], errors: [] };

  // Build targeted queries based on what's missing
  const gaps = (synthesis.information_gaps || '') + ' ' + (synthesis.what_is_unverified || []).join(' ') + ' ' + (decision.flag_reason || '');

  // Search 4: Targeted search based on flag reason
  try {
    const query = app.name + ' ' + (gaps.indexOf('government') !== -1 ? 'government ministry official' :
      gaps.indexOf('organization') !== -1 || gaps.indexOf('org') !== -1 ? app.org + ' registration funding leadership' :
      gaps.indexOf('identity') !== -1 ? app.name + ' biography profile' :
      app.name + ' ' + app.org + ' background');
    const d = exa_(query, 8);
    deepResults.searches.push('targeted: ' + query.substring(0, 50));
    const existingUrls = new Set(); // don't dedup against original — we want fresh perspectives
    for (const r of (d.results || [])) {
      deepResults.results.push({ title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 2000) });
    }
  } catch (e) { deepResults.errors.push('Targeted: ' + e.message); }

  // Search 5: Try alternate name/language search
  try {
    const d = exa_('"' + app.name + '"', 5);
    deepResults.searches.push('exact name');
    for (const r of (d.results || [])) {
      deepResults.results.push({ title: r.title || '', url: r.url || '', text: (r.text || '').substring(0, 1500) });
    }
  } catch (e) { deepResults.errors.push('Name: ' + e.message); }

  return deepResults;
}


// ============================================================
// STEP 6: UPDATED SYNTHESIS (gpt-5 — FLAGGED only)
// ============================================================

const UPDATED_SYNTHESIS_PROMPT = `You are a senior research analyst updating a vetting report with new information.

You previously flagged this applicant because specific information was missing. A second round of targeted web searches has been conducted. Incorporate the new findings into an updated report.

Focus on:
- Did the new searches resolve the ambiguity?
- What new facts were confirmed?
- What remains unverified even after deeper research?
- Updated recommendation for the reviewer

Respond JSON:
{
  "updated_findings": "What the deeper research revealed",
  "resolved_gaps": ["gaps that were filled"],
  "remaining_gaps": ["gaps that still exist"],
  "updated_what_found": ["all confirmed facts including new ones (cite URLs)"],
  "updated_what_unverified": ["remaining unverified claims"],
  "updated_reviewer_actions": ["specific actions for reviewer with new context"],
  "new_key_sources": ["new urls found"]
}`;

function step6_updatedSynthesis(app, synthesis, deepResearch, decision) {
  let newArticles = '';
  for (let i = 0; i < deepResearch.results.length; i++) {
    const a = deepResearch.results[i];
    newArticles += '\n--- New Source ' + (i + 1) + ': ' + a.title + ' ---\nURL: ' + a.url + '\n' + (a.text || '').substring(0, 1200) + '\n';
  }

  return gpt_(CONFIG.MODEL_SYNTHESIS, UPDATED_SYNTHESIS_PROMPT,
    `## Applicant: ${app.name} at ${app.org}\n\n## Original Flag Reason\n${decision.flag_reason || decision.reasoning}\n\n## Original Synthesis\nWhat was found: ${JSON.stringify(synthesis.what_was_found)}\nWhat was unverified: ${JSON.stringify(synthesis.what_is_unverified)}\nInfo gaps: ${synthesis.information_gaps}\n\n## NEW Deeper Research (${deepResearch.results.length} results)\n${newArticles || 'No additional results found.'}`,
    2000);
}


// ============================================================
// STEP 7: FINAL DECISION (gpt-5 — FLAGGED only)
// ============================================================

const FINAL_DECISION_PROMPT = `You are a senior vetting decision-maker resolving a flagged case for the Oslo Freedom Forum.

This applicant was flagged in the initial review. Additional targeted research has been conducted. Make a final decision.

Rules (same as initial):
- Bitcoin/crypto = POSITIVE
- Govt ministry Not Free country = REJECT (unless documented dissent)
- Students/early-career with confirmed identity = APPROVE
- If STILL ambiguous after deeper research = keep FLAGGED with very specific reviewer instructions

Respond JSON:
{
  "verdict": "APPROVED" or "FLAGGED" or "REJECTED",
  "confidence": 0.0-1.0,
  "headline_decision": "One sentence final determination",
  "reasoning": "What changed (or didn't) after deeper research",
  "reviewer_action": "If still FLAGGED: exact action for human reviewer"
}`;

function step7_finalDecision(app, synthesis, updatedSynthesis, decision) {
  return gpt_(CONFIG.MODEL_DEEP_DECISION, FINAL_DECISION_PROMPT,
    `## Applicant: ${app.name}, ${app.title} at ${app.org}\n\n## Initial Decision: ${decision.verdict} (${Math.round((decision.overall_confidence || 0) * 100)}%)\n${decision.reasoning}\nFlag reason: ${decision.flag_reason || 'N/A'}\n\n## Original Findings\n${JSON.stringify(synthesis.what_was_found)}\n\n## Deeper Research Findings\n${updatedSynthesis.updated_findings || 'No new findings'}\nResolved: ${JSON.stringify(updatedSynthesis.resolved_gaps)}\nRemaining: ${JSON.stringify(updatedSynthesis.remaining_gaps)}`,
    1500);
}


// ============================================================
// READ APPLICANT FROM ROW
// ============================================================

function readApp_(sheet, row) {
  return {
    row: row,
    name: cell_(sheet, row, CONFIG.COL_NAME),
    title: cell_(sheet, row, CONFIG.COL_TITLE),
    org: cell_(sheet, row, CONFIG.COL_ORG),
    howHeard: cell_(sheet, row, CONFIG.COL_HOW_HEARD),
    interest: cell_(sheet, row, CONFIG.COL_INTEREST),
    prevAttendance: cell_(sheet, row, CONFIG.COL_PREV_ATTENDANCE),
    prevForums: cell_(sheet, row, CONFIG.COL_PREV_FORUMS),
    comments: cell_(sheet, row, CONFIG.COL_COMMENTS),
    twitter: cell_(sheet, row, CONFIG.COL_TWITTER),
    instagram: cell_(sheet, row, CONFIG.COL_INSTAGRAM),
    linkedin: cell_(sheet, row, CONFIG.COL_LINKEDIN),
    facebook: cell_(sheet, row, CONFIG.COL_FACEBOOK),
    otherSocial: cell_(sheet, row, CONFIG.COL_OTHER_SOCIAL),
    hrfTruth: cell_(sheet, row, CONFIG.COL_HRF_TRUTH),
  };
}


// ============================================================
// PROCESS ONE APPLICANT (full 7-step pipeline)
// ============================================================

function processOne_(sheet, row) {
  const app = readApp_(sheet, row);
  if (!app.name || app.name.trim().length === 0) return null;

  const start = new Date();
  setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 1: Spam check...');
  SpreadsheetApp.flush();

  try {
    // ── STEP 1: Spam Filter ──
    const spam = step1_spamFilter(app);
    setCell_(sheet, row, CONFIG.COL_SPAM_RESULT, spam.verdict + ' (' + Math.round((spam.confidence || 0) * 100) + '%) — ' + spam.reasoning);

    if (spam.verdict === 'SPAM' && spam.confidence >= CONFIG.SPAM_THRESHOLD) {
      writeOutput_(sheet, row, start, {
        verdict: 'SPAM', confidence: spam.confidence,
        headline: 'Spam: ' + spam.reasoning,
      });
      return { name: app.name, verdict: 'SPAM' };
    }

    // ── STEP 2: Web Research ──
    setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 2: Web research...');
    SpreadsheetApp.flush();
    const research = step2_webResearch(app);

    // ── STEP 3: Initial Decision ──
    setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 3: Initial decision...');
    SpreadsheetApp.flush();
    const decision = step3_initialDecision(app, research);
    setCell_(sheet, row, CONFIG.COL_INITIAL_DECISION, decision.verdict + ' (' + Math.round((decision.overall_confidence || 0) * 100) + '%) — ' + (decision.headline_decision || ''));

    // ── STEP 4: Synthesis Report (ALL applicants) ──
    setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 4: Building report...');
    SpreadsheetApp.flush();
    const synthesis = step4_synthesisReport(app, research, decision);

    // Write research profile to sheet
    writeSynthesis_(sheet, row, synthesis, research);

    // If APPROVED or REJECTED with sufficient confidence → done
    if ((decision.verdict === 'APPROVED' || decision.verdict === 'REJECTED') && (decision.overall_confidence || 0) >= CONFIG.RESOLVE_THRESHOLD) {
      writeOutput_(sheet, row, start, {
        verdict: decision.verdict,
        confidence: decision.overall_confidence,
        headline: decision.headline_decision,
        reasoning: decision.reasoning,
        whatFound: synthesis.what_was_found,
        whatMissing: synthesis.what_is_unverified,
        whatReviewer: synthesis.what_reviewer_should_check,
      });
      return { name: app.name, verdict: decision.verdict };
    }

    // ── STEP 5: Deeper Research (FLAGGED only) ──
    setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 5: Deeper research...');
    SpreadsheetApp.flush();
    const deepResearch = step5_deeperResearch(app, decision, synthesis);
    setCell_(sheet, row, CONFIG.COL_DEEP_RESEARCH, deepResearch.results.length + ' new results from ' + deepResearch.searches.join(', '));

    // ── STEP 6: Updated Synthesis ──
    setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 6: Updating report...');
    SpreadsheetApp.flush();
    const updatedSynthesis = step6_updatedSynthesis(app, synthesis, deepResearch, decision);

    // ── STEP 7: Final Decision ──
    setCell_(sheet, row, CONFIG.COL_STATUS, '⏳ Step 7: Final decision...');
    SpreadsheetApp.flush();
    const finalDecision = step7_finalDecision(app, synthesis, updatedSynthesis, decision);
    setCell_(sheet, row, CONFIG.COL_FINAL_DECISION, finalDecision.verdict + ' (' + Math.round((finalDecision.confidence || 0) * 100) + '%) — ' + (finalDecision.headline_decision || ''));

    // Merge synthesis
    const mergedFound = [...(synthesis.what_was_found || []), ...(updatedSynthesis.updated_what_found || [])];
    const mergedMissing = updatedSynthesis.updated_what_unverified || synthesis.what_is_unverified || [];
    const mergedReviewer = updatedSynthesis.updated_reviewer_actions || synthesis.what_reviewer_should_check || [];
    const mergedSources = [...(synthesis.key_sources || []), ...(updatedSynthesis.new_key_sources || [])];

    // Update sources with new ones
    setCell_(sheet, row, CONFIG.COL_KEY_SOURCES, [...new Set(mergedSources)].join('\n'));

    const finalVerdict = (finalDecision.confidence || 0) >= 0.70 && (finalDecision.verdict === 'APPROVED' || finalDecision.verdict === 'REJECTED')
      ? finalDecision.verdict : 'FLAGGED';

    writeOutput_(sheet, row, start, {
      verdict: finalVerdict,
      confidence: finalDecision.confidence || decision.overall_confidence,
      headline: finalDecision.headline_decision || decision.headline_decision,
      reasoning: decision.reasoning + '\n\n[After deeper research] ' + finalDecision.reasoning,
      whatFound: mergedFound,
      whatMissing: mergedMissing,
      whatReviewer: mergedReviewer,
    });

    return { name: app.name, verdict: finalVerdict };

  } catch (e) {
    setCell_(sheet, row, CONFIG.COL_STATUS, '❌ Error');
    setCell_(sheet, row, CONFIG.COL_AI_VERDICT, 'ERROR');
    setCell_(sheet, row, CONFIG.COL_REASONING, e.message);
    return { name: app.name, verdict: 'ERROR', error: e.message };
  }
}


// ============================================================
// WRITE HELPERS
// ============================================================

function writeSynthesis_(sheet, row, syn, research) {
  setCell_(sheet, row, CONFIG.COL_IDENTITY, syn.identity_summary || '');
  setCell_(sheet, row, CONFIG.COL_PROFESSIONAL, syn.professional_background || '');
  setCell_(sheet, row, CONFIG.COL_ORG_VERIFICATION, syn.organization_verification || '');
  setCell_(sheet, row, CONFIG.COL_PUBLIC_PRESENCE, syn.public_presence || '');
  setCell_(sheet, row, CONFIG.COL_HR_ALIGNMENT, syn.human_rights_alignment || '');
  setCell_(sheet, row, CONFIG.COL_GOVT_CONNECTIONS, syn.government_connections || '');
  setCell_(sheet, row, CONFIG.COL_RED_FLAGS, syn.red_flags || '');
  setCell_(sheet, row, CONFIG.COL_INFO_GAPS, syn.information_gaps || '');
  setCell_(sheet, row, CONFIG.COL_KEY_SOURCES, (syn.key_sources || []).join('\n'));
  if (research.linkedin) setCell_(sheet, row, CONFIG.COL_LINKEDIN_URL, research.linkedin);
  if (research.twitter) setCell_(sheet, row, CONFIG.COL_TWITTER_URL, research.twitter);
}

function writeOutput_(sheet, row, start, data) {
  const elapsed = Math.round((new Date() - start) / 1000);

  // Color-coded verdict
  const vc = sheet.getRange(row, colToNum_(CONFIG.COL_AI_VERDICT));
  vc.setValue(data.verdict);
  switch ((data.verdict || '').toUpperCase()) {
    case 'APPROVED': vc.setBackground('#064e3b').setFontColor('#4ade80'); break;
    case 'FLAGGED':  vc.setBackground('#78350f').setFontColor('#fbbf24'); break;
    case 'REJECTED': vc.setBackground('#7f1d1d').setFontColor('#f87171'); break;
    case 'SPAM':     vc.setBackground('#3b0764').setFontColor('#c084fc'); break;
  }

  setCell_(sheet, row, CONFIG.COL_STATUS, '✅ Complete');
  setCell_(sheet, row, CONFIG.COL_CONFIDENCE, Math.round((data.confidence || 0) * 100) + '%');
  setCell_(sheet, row, CONFIG.COL_HEADLINE, data.headline || '');
  setCell_(sheet, row, CONFIG.COL_REASONING, data.reasoning || '');
  setCell_(sheet, row, CONFIG.COL_LATENCY, elapsed + 's');

  if (data.whatFound) setCell_(sheet, row, CONFIG.COL_WHAT_FOUND, (Array.isArray(data.whatFound) ? data.whatFound : []).join('\n'));
  if (data.whatMissing) setCell_(sheet, row, CONFIG.COL_WHAT_MISSING, (Array.isArray(data.whatMissing) ? data.whatMissing : []).join('\n'));
  if (data.whatReviewer) setCell_(sheet, row, CONFIG.COL_WHAT_REVIEWER_SHOULD, (Array.isArray(data.whatReviewer) ? data.whatReviewer : []).join('\n'));

  SpreadsheetApp.flush();
}


// ============================================================
// BATCH RUNNERS
// ============================================================

function runNextBatch() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) { SpreadsheetApp.getUi().alert('Sheet "Applicants" not found. Run Setup first.'); return; }

  const lastRow = sheet.getLastRow();
  let processed = 0;
  const results = [];

  for (let row = 2; row <= lastRow && processed < CONFIG.BATCH_SIZE; row++) {
    const status = cell_(sheet, row, CONFIG.COL_STATUS);
    const name = cell_(sheet, row, CONFIG.COL_NAME);
    if (!name || name.trim().length === 0) continue;
    if (status && (status.indexOf('✅') !== -1 || status.indexOf('❌') !== -1)) continue;

    const r = processOne_(sheet, row);
    if (r) { results.push(r); processed++; }
  }

  if (processed === 0) SpreadsheetApp.getUi().alert('✅ All applicants processed!');
  else SpreadsheetApp.getUi().alert('Processed ' + processed + ':\n\n' + results.map(r => r.name + ': ' + r.verdict).join('\n'));
}

function runAllRemaining() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) return;

  const ui = SpreadsheetApp.getUi();
  const c = ui.alert('Run All', 'Process all remaining applicants in batches of ' + CONFIG.BATCH_SIZE + '?\n\nIt auto-continues until done.', ui.ButtonSet.YES_NO);
  if (c !== ui.Button.YES) return;

  runBatchSilent_();
  if (countRemaining_(sheet) > 0) {
    ScriptApp.newTrigger('runBatchSilent_').timeBased().everyMinutes(1).create();
    ui.alert('✅ First batch done. Auto-processing remaining.\n\nUse HRF Vettor > Stop to halt.');
  } else {
    ui.alert('✅ All done!');
  }
}

function runBatchSilent_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) return;
  let processed = 0;
  for (let row = 2; row <= sheet.getLastRow() && processed < CONFIG.BATCH_SIZE; row++) {
    const status = cell_(sheet, row, CONFIG.COL_STATUS);
    const name = cell_(sheet, row, CONFIG.COL_NAME);
    if (!name || !name.trim()) continue;
    if (status && (status.indexOf('✅') !== -1 || status.indexOf('❌') !== -1)) continue;
    processOne_(sheet, row);
    processed++;
  }
  if (processed === 0 || countRemaining_(sheet) === 0) stopAutoProcessing();
}

function runSelectedRow() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveCell().getRow();
  if (row < 2) { SpreadsheetApp.getUi().alert('Select a data row.'); return; }
  const r = processOne_(sheet, row);
  if (r) SpreadsheetApp.getUi().alert(r.name + ': ' + r.verdict);
}

function stopAutoProcessing() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'runBatchSilent_') ScriptApp.deleteTrigger(t);
  }
  try { SpreadsheetApp.getUi().alert('⏹️ Stopped.'); } catch (e) { /* triggered run, no UI */ }
}

function countRemaining_(sheet) {
  let c = 0;
  for (let row = 2; row <= sheet.getLastRow(); row++) {
    const s = cell_(sheet, row, CONFIG.COL_STATUS);
    const n = cell_(sheet, row, CONFIG.COL_NAME);
    if (n && n.trim() && !(s && (s.indexOf('✅') !== -1 || s.indexOf('❌') !== -1))) c++;
  }
  return c;
}


// ============================================================
// SUMMARY
// ============================================================

function showSummary() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.INPUT_SHEET);
  if (!sheet) return;
  const counts = { APPROVED: 0, FLAGGED: 0, REJECTED: 0, SPAM: 0, ERROR: 0, pending: 0 };
  let matches = 0, total = 0;

  for (let row = 2; row <= sheet.getLastRow(); row++) {
    const name = cell_(sheet, row, CONFIG.COL_NAME);
    if (!name) continue;
    const v = (cell_(sheet, row, CONFIG.COL_AI_VERDICT) || '').toUpperCase();
    const t = (cell_(sheet, row, CONFIG.COL_HRF_TRUTH) || '').toUpperCase();
    if (v in counts) { counts[v]++; if (t) { total++; if (v === t || (v === 'SPAM' && t === 'REJECTED')) matches++; } }
    else counts.pending++;
  }

  SpreadsheetApp.getUi().alert(
    '📊 Summary\n\n✅ Approved: ' + counts.APPROVED + '\n🟡 Flagged: ' + counts.FLAGGED +
    '\n❌ Rejected: ' + counts.REJECTED + '\n🗑️ Spam: ' + counts.SPAM +
    '\n⚠️ Errors: ' + counts.ERROR + '\n⏳ Pending: ' + counts.pending +
    (total > 0 ? '\n\n🎯 Accuracy: ' + Math.round(matches / total * 100) + '% (' + matches + '/' + total + ')' : ''));
}


// ============================================================
// UTILITY
// ============================================================

function colToNum_(l) { let c = 0; for (let i = 0; i < l.length; i++) c = c * 26 + (l.charCodeAt(i) - 64); return c; }
function cell_(s, r, c) { return String(s.getRange(r, colToNum_(c)).getValue() || '').trim(); }
function setCell_(s, r, c, v) { s.getRange(r, colToNum_(c)).setValue(v); }
