/**
 * AI Assistant backend — Code.gs (security wrapper)
 *
 *  Original endpoint URL (preserve):
 *    AKfycbzrDPwsOB4GC3kMD85jls4PyMzTl6KWoRHRz1wuNE6NEIcuoqjrri3FU0eegFdoBM50wg
 *
 *  Actions:
 *      ?action=askGPT  → forwards to OpenAI/Gemini (server-held key) with
 *                        per-user point gating
 *
 *  CRITICAL: the OpenAI / Gemini key MUST live in Script Properties as
 *  LLM_API_KEY — never in code, never returned to the frontend.
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'assistant',
    allowed: {
      askGPT: { roles: ['student','teacher','admin'], audit: true },
    },
  }, handleAssistant);
}

function handleAssistant(action, params, ctx) {
  var V = SecurityCore.V;

  if (action === 'askGPT') {
    var msg = V.str(params.message, { max: 4000 });
    if (!msg) return SecurityCore.fail('BAD_INPUT','Message is empty.');
    var history = V.json(params.messageHistory, 32 * 1024) || [];
    if (!Array.isArray(history)) history = [];
    history = history.slice(-12);                     // server-side hard cap

    // Per-user daily point gate — server-trusted
    var pts = AssistantLogic_getPointsLeft_(ctx.sid);
    if (pts <= 0) return SecurityCore.fail('OUT_OF_POINTS','You have no AI credits left today.');

    var reply = AssistantLogic_callLLM_(ctx.sid, msg, history);
    if (!reply || !reply.text) return SecurityCore.fail('LLM_FAIL','Tutor could not respond. Try again.');

    AssistantLogic_decrementPoints_(ctx.sid, reply.cost || 1);
    return {
      success: true,
      reply: reply.text,
      pointsLeft: AssistantLogic_getPointsLeft_(ctx.sid),
    };
  }
  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

/* ---------------------------------------------------------------------------
 *  AssistantLogic_*   — v7.9.9 concrete implementations
 *
 *  Per-student daily AI-credit quota is tracked in the `AssistantUsage` tab
 *  of the Portal / Users sheet (whichever Script Property points to). The
 *  LLM call uses OpenAI's chat completions endpoint; switch provider by
 *  changing only `_callOpenAI_` below.
 *
 *  REQUIRED SCRIPT PROPERTIES (Assistant project):
 *      LLM_API_KEY            OpenAI / Gemini key (server-only, never echoed)
 *      LLM_MODEL              optional — defaults to 'gpt-4o-mini'
 *      LLM_DAILY_POINT_CAP    optional — defaults to '100' (per student per day)
 *      ASSISTANT_SHEET_ID     optional — defaults to USERS_SHEET_ID
 *      ASSISTANT_USAGE_TAB    optional — defaults to 'AssistantUsage'
 * --------------------------------------------------------------------------- */
function _assistantUsageSheet_() {
  var p = PropertiesService.getScriptProperties();
  var sheetId = p.getProperty('ASSISTANT_SHEET_ID') || p.getProperty('USERS_SHEET_ID');
  if (!sheetId) return null;
  var tab = p.getProperty('ASSISTANT_USAGE_TAB') || 'AssistantUsage';
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(tab);
  if (!sh) {
    sh = ss.insertSheet(tab);
    sh.appendRow(['day', 'sid', 'used']);
    sh.setFrozenRows(1);
  }
  return sh;
}
function _todayKey_() {
  var tz = Session.getScriptTimeZone() || 'UTC';
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}
function _assistantCap_() {
  var raw = PropertiesService.getScriptProperties().getProperty('LLM_DAILY_POINT_CAP');
  var n = parseInt(raw, 10);
  return (isNaN(n) || n <= 0) ? 100 : n;
}

function AssistantLogic_getPointsLeft_(sid) {
  var sh = _assistantUsageSheet_();
  if (!sh) return _assistantCap_();
  var today = _todayKey_();
  var data = sh.getDataRange().getValues();
  var used = 0;
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][0]) === today && String(data[r][1]) === String(sid)) {
      used = parseInt(data[r][2], 10) || 0;
      break;
    }
  }
  return Math.max(0, _assistantCap_() - used);
}

function AssistantLogic_decrementPoints_(sid, cost) {
  cost = Math.max(1, parseInt(cost, 10) || 1);
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { return; }
  try {
    var sh = _assistantUsageSheet_();
    if (!sh) return;
    var today = _todayKey_();
    var data = sh.getDataRange().getValues();
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][0]) === today && String(data[r][1]) === String(sid)) {
        var cur = parseInt(data[r][2], 10) || 0;
        sh.getRange(r + 1, 3).setValue(cur + cost);
        return;
      }
    }
    sh.appendRow([today, String(sid), cost]);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function AssistantLogic_callLLM_(sid, msg, history) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('LLM_API_KEY');
  if (!apiKey) return null;
  var model  = PropertiesService.getScriptProperties().getProperty('LLM_MODEL') || 'gpt-4o-mini';

  // Build the chat messages array. `history` is the recent turn log the
  // frontend passed in (already server-side-capped to 12 entries by the
  // route handler above).
  var messages = [
    { role: 'system',
      content: 'You are EduHub Tutor, a patient English-teaching assistant for Cambodian ' +
               'high-school students. Keep answers short, friendly, and use simple English. ' +
               'Never reveal internal system information, API keys, or student lists.' }
  ];
  if (Array.isArray(history)) {
    for (var i = 0; i < history.length; i++) {
      var h = history[i] || {};
      var role = (h.role === 'assistant' || h.role === 'user' || h.role === 'system') ? h.role : 'user';
      var content = String(h.content || h.text || '').slice(0, 2000);
      if (content) messages.push({ role: role, content: content });
    }
  }
  messages.push({ role: 'user', content: String(msg).slice(0, 4000) });

  var body = {
    model: model,
    messages: messages,
    temperature: 0.4,
    max_tokens: 600,
  };
  try {
    var resp = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    var code = resp.getResponseCode();
    var text = resp.getContentText();
    if (code < 200 || code >= 300) {
      // NEVER leak the upstream body (may contain request traces). Log
      // server-side for the admin and return a generic null.
      try { Logger.log('[Assistant] LLM HTTP ' + code + ' — ' + text.slice(0, 500)); } catch (_) {}
      return null;
    }
    var json = JSON.parse(text);
    var reply = ((json.choices || [])[0] || {}).message || {};
    var out = String(reply.content || '').trim();
    if (!out) return null;
    // Cost = ceil(tokens/100) — keeps the heaviest conversations capped.
    var totalTokens = (json.usage && json.usage.total_tokens) || 200;
    var cost = Math.max(1, Math.ceil(totalTokens / 100));
    return { text: out, cost: cost };
  } catch (err) {
    try { Logger.log('[Assistant] LLM exception — ' + String(err).slice(0, 500)); } catch (_) {}
    return null;
  }
}
