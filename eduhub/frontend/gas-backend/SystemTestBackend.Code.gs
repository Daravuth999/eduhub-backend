/**
 * System Test backend — Code.gs (security wrapper)
 *
 *  Original endpoint URL (preserve):
 *    AKfycbwQknsM0MJwRmoTGPai-_E2OSMb9FPxK7UsexqmpXZAqelyw99guEhjhNQn9hCL0m5uTg
 *
 *  Actions:
 *      ?action=getTimerConfig  → public timer config (read-only)
 *      ?action=fetchQuestions  → caller's question set, WITHOUT correct-answer keys
 *      ?action=submitTest      → server scores; client cannot send precomputed score
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'systemtest',
    allowed: {
      getTimerConfig:  { public: true },
      fetchQuestions:  { roles: ['student','teacher','admin'], audit: true },
      submitTest:      { roles: ['student','teacher','admin'], requireNonce: true, audit: true },
    },
  }, handleSystemTest);
}

function handleSystemTest(action, params, ctx) {
  var V = SecurityCore.V;

  if (action === 'getTimerConfig') {
    return { success: true, timerMinutes: SystemTestLogic_getTimerMinutes_() || 60 };
  }

  if (action === 'fetchQuestions') {
    var qs = SystemTestLogic_fetchQuestions_(ctx.sid) || [];
    // STRICT: strip any *answerKey, isCorrect, weighting fields before responding
    var safe = qs.map(function(q){
      return {
        id:       q.id || q.ID || null,                 // server-side ID we'll match later
        question: q.question || '',
        options:  Array.isArray(q.options) ? q.options.slice(0,8) : [],
        audio:    q.audio || '',
      };
    });
    // Cache the canonical answer key server-side, keyed by sid + run-id, so we
    // can score later without the client ever seeing them.
    SystemTestLogic_stashAnswerKey_(ctx.sid, qs);
    return { success: true, questions: safe };
  }

  if (action === 'submitTest') {
    var ans = V.json(params.answers, 16 * 1024);
    var beh = V.json(params.behaviorLog, 8 * 1024) || {};
    if (!Array.isArray(ans)) return SecurityCore.fail('BAD_INPUT','Answers must be an array.');
    if (ans.length > 200)    return SecurityCore.fail('BAD_INPUT','Too many answers.');
    return SystemTestLogic_score_(ctx.sid, ans, beh) || SecurityCore.fail('SCORE_FAILED','Could not score test.');
  }

  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

function SystemTestLogic_getTimerMinutes_()                { /* TODO */ return 60; }
function SystemTestLogic_fetchQuestions_(sid)              { /* TODO */ return []; }
function SystemTestLogic_stashAnswerKey_(sid, fullQs)      { /* TODO: write to private sheet keyed by sid */ }
function SystemTestLogic_score_(sid, answers, behaviorLog) { /* TODO: server-side scoring */ return { success:false, message:'not implemented' }; }
