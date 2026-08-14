/**
 * Rewards-Shop backend — Code.gs (security wrapper)
 *
 *  Original endpoint URL (preserve):
 *    AKfycbyp40ywz45gwSAJQjQpCAKR61wF5T6gh4MnQEcNltqW4V5p2DPlyQR1khAi3a3bqCHu
 *
 *  Actions:
 *      ?action=login           → issue sessionToken
 *      ?action=getStudentData  → caller's points + history only
 *      ?action=getRewards      → public reward catalogue (no internal flags)
 *      ?action=redeemReward    → server validates points, deducts atomically
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'shop',
    allowed: {
      login:           { anonymous: true, audit: true },
      getStudentData:  { roles: ['student','teacher','admin'] },
      getRewards:      { public: true },
      redeemReward:    { roles: ['student','teacher','admin'], requireNonce: true, audit: true },
    },
  }, handleShop);
}

function handleShop(action, params, ctx) {
  var V = SecurityCore.V;

  if (action === 'login') {
    var sid = V.studentId(params.id || params.studentId);
    var pwd = V.str(params.password, { max: 128 });
    if (!sid || !pwd) return SecurityCore.fail('BAD_INPUT','Missing credentials.');
    if (SecurityCore.isLocked(sid)) return SecurityCore.fail('TEMP_LOCKED','Try again later.');
    var u = SecurityCore.authenticatePassword(sid, pwd);
    if (!u) { SecurityCore.recordFailure(sid); return SecurityCore.fail('BAD_CREDENTIALS','Incorrect login.'); }
    SecurityCore.clearFailures(sid);
    var s = ShopLogic_getStudent_(u.sid);
    return {
      success: true,
      sessionToken: SecurityCore.issueToken(u.sid, u.role),
      student: { id: u.sid, name: u.name, points: s.points || 0, history: s.history || [] },
    };
  }

  if (action === 'getStudentData') {
    var s2 = ShopLogic_getStudent_(ctx.sid);
    return {
      success: true,
      student: { id: ctx.sid, name: ctx.user.name, points: s2.points || 0, history: s2.history || [] },
    };
  }

  if (action === 'getRewards') {
    return { success: true, rewards: ShopLogic_getRewards_() || [] };
  }

  if (action === 'redeemReward') {
    var item = V.str(params.itemName, { max: 120 });
    if (!item) return SecurityCore.fail('BAD_INPUT','Missing reward name.');
    // SERVER looks up the canonical PointCost. We IGNORE params.pointCost.
    return ShopLogic_redeem_(ctx.sid, item) || SecurityCore.fail('REDEEM_FAILED','Could not redeem reward.');
  }

  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

function ShopLogic_getStudent_(sid)            { /* TODO */ return { points: 0, history: [] }; }
function ShopLogic_getRewards_()               { /* TODO */ return []; }
function ShopLogic_redeem_(sid, itemName)      { /* TODO: atomic point deduction */ return { success:false, message:'not implemented' }; }
