/**
 * Points backend — Code.gs (security wrapper)
 *
 *   Original endpoint URL (preserve):
 *     AKfycbzRktKyql2I_FbPESNRpCrFDlse-qNd9_Opv9si-g-j2lcanOUPP49IzcyA59lFqVycdA
 *
 *  Actions:
 *      ?action=login              → issue sessionToken (replaces password-on-every-request)
 *      ?action=getRecentTransfers → caller's transfers only
 *      ?action=sendPoints         → server computes new balances; client cannot specify them
 *
 *  CRITICAL: amount, balances, fees — all calculated server-side. The client
 *  ONLY supplies (receiverId, amount). The server validates ownership, ledger,
 *  daily caps, and writes transactionally.
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'points',
    allowed: {
      login:               { anonymous: true, audit: true },
      getRecentTransfers:  { roles: ['student','teacher','admin'] },
      sendPoints:          { roles: ['student','teacher','admin'], requireNonce: true, audit: true },
    },
  }, handlePoints);
}

function handlePoints(action, params, ctx) {
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
      points: PointsLogic_getBalance_(u.sid) || 0,
      name: u.name,
    };
  }

  if (action === 'getRecentTransfers') {
    // students always see their own; teacher/admin may pass an id
    var who = (ctx.role === 'admin' || ctx.role === 'teacher')
      ? (V.studentId(params.id) || ctx.sid)
      : ctx.sid;
    return { success: true, history: PointsLogic_getRecentTransfers_(who) || [] };
  }

  if (action === 'sendPoints') {
    // Server-trusted sender = ctx.sid. Client's `id` field is IGNORED for sender.
    var sender   = ctx.sid;
    var receiver = V.studentId(params.receiverId);
    var amount   = V.int(params.amount, 1, 100000);
    if (!receiver || amount == null) return SecurityCore.fail('BAD_INPUT','Invalid recipient or amount.');
    if (receiver === sender) return SecurityCore.fail('SELF_TRANSFER','You cannot send points to yourself.');

    // delegate to existing transactional logic — no balance trust from client
    var res = PointsLogic_sendPoints_(sender, receiver, amount);
    return res || SecurityCore.fail('TRANSFER_FAILED','Transfer could not be completed.');
  }

  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

/* --- replace stubs with your existing logic --- */
function PointsLogic_getBalance_(sid)                     { /* TODO */ return 0; }
function PointsLogic_getRecentTransfers_(sid)             { /* TODO */ return []; }
function PointsLogic_sendPoints_(senderSid, recvSid, amt) { /* TODO */ return { success: false, message: 'not implemented' }; }
