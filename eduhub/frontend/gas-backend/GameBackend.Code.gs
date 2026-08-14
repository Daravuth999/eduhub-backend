/**
 * Game / Lucky-Spin backend — Code.gs (security wrapper)
 *
 *  Original endpoint URL (preserve):
 *    AKfycbxKSDSZm-iM9dTqT_noZ_EC1DV-lFcIinJGt-2sIdBCcWbfahyx_8uOKsEbenaeQMKa
 *
 *  Actions:
 *      ?action=login                  → issue sessionToken (replaces password-on-every-request)
 *      ?action=getSlotConfig          → cost + prize list (read-only, no scoring data)
 *      ?action=handleCardGame         → ENTIRE spin happens server-side
 *      ?action=getRestrictionMessage  → cooldown / lock-out info for caller
 *
 *  CRITICAL: prize selection, point delta, jackpot logic and history writes
 *  are ALL executed server-side. The client receives only the result it has
 *  earned — nothing about RNG seeds, full prize weights, or other students.
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'game',
    allowed: {
      login:                  { anonymous: true, audit: true },
      getSlotConfig:          { public: true },                              // safe to expose prize names+costs only
      handleCardGame:         { roles: ['student','teacher','admin'], requireNonce: true, audit: true },
      getRestrictionMessage:  { roles: ['student','teacher','admin'] },
    },
  }, handleGame);
}

function handleGame(action, params, ctx) {
  var V = SecurityCore.V;

  if (action === 'login') {
    var sid = V.studentId(params.id || params.studentId);
    var pwd = V.str(params.password, { max: 128 });
    if (!sid || !pwd) return SecurityCore.fail('BAD_INPUT','Missing credentials.');
    if (SecurityCore.isLocked(sid)) return SecurityCore.fail('TEMP_LOCKED','Try again later.');
    var u = SecurityCore.authenticatePassword(sid, pwd);
    if (!u) { SecurityCore.recordFailure(sid); return SecurityCore.fail('BAD_CREDENTIALS','Incorrect login.'); }
    SecurityCore.clearFailures(sid);
    return {
      success: true,
      sessionToken: SecurityCore.issueToken(u.sid, u.role),
      name: u.name,
      points: GameLogic_getBalance_(u.sid),
    };
  }

  if (action === 'getSlotConfig') {
    var cfg = GameLogic_getSlotConfig_();
    // Strip any RNG weights / admin metadata before returning
    return {
      spinCost: cfg.spinCost,
      prizes: (cfg.prizes || []).map(function(p){ return { Emoji: p.Emoji, PrizeName: p.PrizeName, RewardPoints: p.RewardPoints }; }),
    };
  }

  if (action === 'handleCardGame') {
    // The ONLY thing the client gets to do is request a spin.  Everything else
    // (cost deduction, RNG, prize, balance update) is server-side.
    var locked = GameLogic_isOnCooldown_(ctx.sid);
    if (locked) return { success: false, message: locked };
    return GameLogic_spin_(ctx.sid) || SecurityCore.fail('SPIN_FAILED','Spin could not be processed.');
  }

  if (action === 'getRestrictionMessage') {
    return { message: GameLogic_isOnCooldown_(ctx.sid) || '' };
  }

  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

/* --- replace stubs with your existing logic --- */
function GameLogic_getBalance_(sid)        { /* TODO */ return 0; }
function GameLogic_getSlotConfig_()        { /* TODO */ return { spinCost: 10, prizes: [] }; }
function GameLogic_isOnCooldown_(sid)      { /* TODO: returns string message OR '' */ return ''; }
function GameLogic_spin_(sid)              { /* TODO: server-side RNG + ledger write */ return { success:false, message:'not implemented' }; }
