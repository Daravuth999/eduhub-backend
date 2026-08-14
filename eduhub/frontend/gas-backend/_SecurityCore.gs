/**
 * ============================================================================
 *  SecurityCore.gs  —  EduHub unified GAS hardening library  (v6, Jan 2026)
 * ============================================================================
 *
 *  Drop this file into EVERY one of the 7 EduHub Apps Script projects:
 *
 *      • Portal           (getStudentData / getPasswordHint / validateCoupon …)
 *      • Points           (login / sendPoints / getRecentTransfers)
 *      • Game / LuckySpin (login / handleCardGame / getSlotConfig)
 *      • Rewards Shop     (login / getRewards / redeemReward)
 *      • Library          (login / getContent / completeLesson)
 *      • Assistant        (askGPT)
 *      • System Test      (fetchQuestions / submitTest / getTimerConfig)
 *      • Config           (getConfig — JSONP)
 *
 *  Then wrap doGet / doPost in your per-project Code.gs file using the
 *  helpers exposed below.  Existing business logic (the actual sheet writes,
 *  scoring, point math, etc.) stays UNTOUCHED — this file only adds the
 *  security perimeter around it.
 *
 *  ----------------------------------------------------------------------------
 *  REQUIRED SCRIPT PROPERTIES (set once per project — see DEPLOYMENT_GUIDE.md)
 *  ----------------------------------------------------------------------------
 *      HMAC_SECRET        long random hex string, ≥ 48 chars  (token signer)
 *      ALLOWED_ORIGINS    comma-separated list of allowed Origin/Referer hosts
 *                         e.g.  daravuthenglish.online,daravuth995.github.io,
 *                               <your-emergent-preview-host>
 *      USERS_SHEET_ID     ID of the Users sheet (role/permission source)
 *      USERS_SHEET_NAME   tab name (default: "Users")
 *      AUDIT_SHEET_NAME   tab name for audit log (auto-created if missing)
 *      RATE_LIMIT_RPM     requests-per-minute per user (default 45)
 *      RATE_LIMIT_BURST   burst window seconds (default 10)
 *      SESSION_TTL_MIN    session token TTL in minutes (default 720 = 12h)
 *      DEBUG_MODE         "true" → verbose error responses (NEVER in prod)
 *
 *  ----------------------------------------------------------------------------
 *  USERS sheet schema  (the role / identity source of truth)
 *  ----------------------------------------------------------------------------
 *      A: StudentID   (string, unique, NEVER editable client-side)
 *      B: Name
 *      C: Password    (you may keep this — only used the first time, server-side)
 *      D: Role        ("admin" | "teacher" | "student")
 *      E: Status      ("active" | "blocked")
 *      F: Email       (optional, used if you front the Web App with Google login)
 *
 *  Anything outside that sheet is data — never auth.
 *
 * ============================================================================ */

/* eslint-disable no-undef */
var SecurityCore = (function () {
  // ----- constants -----------------------------------------------------------
  var ALG = Utilities.MacAlgorithm.HMAC_SHA_256;
  var TOKEN_VERSION = 'v1';
  var MAX_BODY_BYTES = 32 * 1024;       // hard payload cap
  var MAX_STR_LEN    = 4 * 1024;        // per-field cap (askGPT message etc.)
  var NONCE_TTL_SEC  = 5 * 60;          // anti-replay window
  var ABUSE_THRESHOLD = 3;              // failed-auth strikes before lockout
  var ABUSE_LOCKOUT_SEC = 10 * 60;      // 10-minute cooldown

  var props_ = PropertiesService.getScriptProperties();
  var cache_ = CacheService.getScriptCache();

  // ----- tiny utils ----------------------------------------------------------
  function _now()      { return Math.floor(Date.now() / 1000); }
  function _rand(n)    { return Utilities.getUuid().replace(/-/g, '').slice(0, n || 16); }
  function _b64u(bytes){
    return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,'');
  }
  function _fromB64u(s){
    s = String(s || '');
    var pad = (4 - (s.length % 4)) % 4;
    return Utilities.base64DecodeWebSafe(s + '===='.slice(0, pad));
  }
  function _hmac(secret, msg){
    return _b64u(Utilities.computeHmacSignature(ALG, msg, secret));
  }
  function _eq(a, b){ // constant-time-ish string compare
    a = String(a||''); b = String(b||'');
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    return d === 0;
  }
  function _prop(k, dflt){
    var v = props_.getProperty(k);
    return v == null || v === '' ? dflt : v;
  }
  function _propInt(k, dflt){
    var v = parseInt(_prop(k, ''), 10);
    return isNaN(v) ? dflt : v;
  }
  function _isDebug(){ return _prop('DEBUG_MODE','false') === 'true'; }

  // ----- JSON / JSONP responder ----------------------------------------------
  function jsonOut(obj, callback){
    var s = JSON.stringify(obj);
    if (callback && /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/.test(callback)) {
      // JSONP — only used by Config endpoint. Strict callback whitelist regex.
      return ContentService
        .createTextOutput(callback + '(' + s + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(s)
      .setMimeType(ContentService.MimeType.JSON);
  }

  function fail(code, msg, extra){
    var out = { success: false, error: code, message: msg };
    if (extra && _isDebug()) out.debug = extra;
    return out;
  }

  // ----- origin gate ---------------------------------------------------------
  function _allowedOrigin(e){
    var allow = _prop('ALLOWED_ORIGINS', '');
    if (!allow) return true;                                  // not configured → off
    var hostSet = allow.split(',').map(function(h){ return h.trim().toLowerCase(); }).filter(Boolean);
    if (!hostSet.length) return true;
    var headers = (e && e.headers) || {};
    // GAS only exposes a subset of headers; we check Origin / Referer when present.
    var origin = (headers['Origin'] || headers['origin'] || '').toLowerCase();
    var ref    = (headers['Referer'] || headers['referer'] || '').toLowerCase();
    function _ok(u){
      if (!u) return false;
      try {
        var h = u.replace(/^https?:\/\//,'').split('/')[0];
        return hostSet.some(function(ah){ return h === ah || h.endsWith('.'+ah); });
      } catch(_) { return false; }
    }
    if (!origin && !ref) return true;   // GAS sometimes strips both — don't hard-block
    return _ok(origin) || _ok(ref);
  }

  // ----- payload normaliser --------------------------------------------------
  function readParams(e){
    var p = {};
    try {
      // JSON body (preferred)
      if (e && e.postData && e.postData.contents) {
        var raw = String(e.postData.contents);
        if (raw.length > MAX_BODY_BYTES) throw new Error('payload-too-large');
        var ct  = (e.postData.type || '').toLowerCase();
        if (ct.indexOf('application/json') === 0) {
          var j = JSON.parse(raw);
          if (j && typeof j === 'object') Object.keys(j).forEach(function(k){ p[k] = j[k]; });
        }
      }
    } catch(err){ throw err; }

    // querystring + form-encoded merged (form takes precedence over query for a key)
    if (e && e.parameter) {
      Object.keys(e.parameter).forEach(function(k){
        if (p[k] == null) p[k] = e.parameter[k];
      });
    }

    // strict per-field length cap
    Object.keys(p).forEach(function(k){
      if (typeof p[k] === 'string' && p[k].length > MAX_STR_LEN) {
        throw new Error('field-too-long:'+k);
      }
    });
    return p;
  }

  // ----- input validators ----------------------------------------------------
  var V = {
    str: function(v, opts){
      opts = opts || {};
      if (v == null) return opts.optional ? '' : null;
      var s = String(v);
      if (opts.trim !== false) s = s.trim();
      if (!opts.optional && !s) return null;
      if (opts.max && s.length > opts.max) return null;
      if (opts.pattern && !opts.pattern.test(s)) return null;
      return s;
    },
    studentId: function(v){ return V.str(v, { max: 32, pattern: /^[A-Za-z0-9_\-\.]{1,32}$/ }); },
    int: function(v, min, max){
      if (v == null || v === '') return null;
      var n = parseInt(v, 10);
      if (isNaN(n)) return null;
      if (min != null && n < min) return null;
      if (max != null && n > max) return null;
      return n;
    },
    bool: function(v){
      if (v === true || v === 'true' || v === '1' || v === 1) return true;
      if (v === false || v === 'false' || v === '0' || v === 0) return false;
      return null;
    },
    enum: function(v, allowed){
      v = V.str(v, { max: 64 });
      return v && allowed.indexOf(v) >= 0 ? v : null;
    },
    json: function(v, maxLen){
      var s = V.str(v, { max: maxLen || MAX_STR_LEN });
      if (!s) return null;
      try { return JSON.parse(s); } catch(_) { return null; }
    },
  };

  // ----- session tokens ------------------------------------------------------
  // token = base64u(headerJSON) + "." + base64u(payloadJSON) + "." + sig
  // payload = { sid, role, iat, exp, jti }
  function _secret(){
    var s = _prop('HMAC_SECRET','');
    if (!s || s.length < 32) throw new Error('HMAC_SECRET missing or too short');
    return s;
  }
  function issueToken(sid, role){
    var ttl = _propInt('SESSION_TTL_MIN', 720) * 60;
    var hdr = { v: TOKEN_VERSION, alg: 'HS256' };
    var pay = { sid: sid, role: role || 'student', iat: _now(), exp: _now() + ttl, jti: _rand(12) };
    var h = _b64u(JSON.stringify(hdr));
    var p = _b64u(JSON.stringify(pay));
    var sig = _hmac(_secret(), h + '.' + p);
    return h + '.' + p + '.' + sig;
  }
  function verifyToken(tok){
    if (!tok || typeof tok !== 'string' || tok.length > 2048) return null;
    var parts = tok.split('.');
    if (parts.length !== 3) return null;
    var sigCheck = _hmac(_secret(), parts[0] + '.' + parts[1]);
    if (!_eq(sigCheck, parts[2])) return null;
    try {
      var pay = JSON.parse(Utilities.newBlob(_fromB64u(parts[1])).getDataAsString());
      if (pay.exp && pay.exp < _now()) return null;
      return pay;
    } catch(_) { return null; }
  }

  // ----- nonce / replay protection ------------------------------------------
  function checkNonce(nonce){
    nonce = V.str(nonce, { max: 80 });
    if (!nonce) return false;
    var k = 'nonce:'+nonce;
    if (cache_.get(k)) return false;       // already used
    cache_.put(k, '1', NONCE_TTL_SEC);
    return true;
  }

  // ----- rate limit + abuse detection ----------------------------------------
  function rateLimit(scope, key){
    var rpm = _propInt('RATE_LIMIT_RPM', 45);
    var burst = _propInt('RATE_LIMIT_BURST', 10);
    var k = 'rl:' + scope + ':' + key;
    var raw = cache_.get(k);
    var now = _now();
    var bucket = raw ? JSON.parse(raw) : { ts: now, count: 0, b: now, bc: 0 };

    // sliding 60s window
    if (now - bucket.ts >= 60) { bucket.ts = now; bucket.count = 0; }
    if (now - bucket.b  >= burst) { bucket.b  = now; bucket.bc = 0; }
    bucket.count++; bucket.bc++;
    cache_.put(k, JSON.stringify(bucket), 120);

    if (bucket.bc > Math.max(8, Math.floor(rpm/3))) return { ok: false, reason: 'burst' };
    if (bucket.count > rpm) return { ok: false, reason: 'rpm' };
    return { ok: true };
  }

  function recordFailure(sid){
    sid = V.str(sid,{max:32}) || 'anon';
    var k = 'fail:'+sid;
    var n = parseInt(cache_.get(k) || '0', 10) + 1;
    cache_.put(k, String(n), ABUSE_LOCKOUT_SEC);
    if (n >= ABUSE_THRESHOLD) cache_.put('lock:'+sid, '1', ABUSE_LOCKOUT_SEC);
    return n;
  }
  function isLocked(sid){
    sid = V.str(sid,{max:32}) || 'anon';
    return cache_.get('lock:'+sid) === '1';
  }
  function clearFailures(sid){
    sid = V.str(sid,{max:32}) || 'anon';
    cache_.remove('fail:'+sid);
    cache_.remove('lock:'+sid);
  }

  // ----- audit log -----------------------------------------------------------
  function audit(sid, action, status, meta){
    try {
      var sheetId = _prop('USERS_SHEET_ID','');
      if (!sheetId) return;
      var ss = SpreadsheetApp.openById(sheetId);
      var name = _prop('AUDIT_SHEET_NAME', 'AuditLog');
      var sh = ss.getSheetByName(name) || ss.insertSheet(name);
      if (sh.getLastRow() === 0) {
        sh.appendRow(['timestamp','sid','action','status','ip_or_origin','meta']);
        sh.setFrozenRows(1);
      }
      sh.appendRow([
        new Date().toISOString(),
        String(sid || ''),
        String(action || ''),
        String(status || ''),
        (meta && meta.origin) || '',
        meta ? JSON.stringify(meta).slice(0, 4000) : '',
      ]);
    } catch (err) { /* never block on audit */ }
  }

  // ----- users / roles -------------------------------------------------------
  //
  //  We auto-detect the Users sheet columns against a list of common aliases
  //  so the wrapper works with your EXISTING student sheet — you don't need
  //  to rename anything.  If your sheet uses an exotic name, set the script
  //  property USERS_HEADER_MAP to a JSON object, e.g.
  //      { "sid": "student_no", "pwd": "passcode" }
  //  Keys supported: sid | name | pwd | role | status | email
  //
  var _usersCache = null;

  // Default alias dictionary (all lowercased, whitespace/punctuation stripped).
  var USER_HEADER_ALIASES = {
    sid:    ['studentid','student id','student_id','student-id','student no','studentno','id','sid','stud id','studid','rollno','rollnumber','usercode','user id','userid'],
    name:   ['name','fullname','full name','studentname','student name','displayname'],
    pwd:    ['password','pass','passcode','pwd','pw','secret','login password','student password'],
    role:   ['role','usertype','user type','type','permission','access','accesslevel'],
    status: ['status','state','active','enabled','accountstatus','account status'],
    email:  ['email','mail','emailaddress','email address','gmail'],
  };

  function _norm(s){ return String(s||'').toLowerCase().replace(/[\s_\-\.]+/g,''); }

  function _resolveHeaderMap(head){
    // head is already lowercased+trimmed; normalise further for fuzzy match.
    var normHead = head.map(_norm);
    var override = {};
    try {
      var raw = _prop('USERS_HEADER_MAP','');
      if (raw) override = JSON.parse(raw) || {};
    } catch(_) { override = {}; }

    function findIdx(key){
      // 1) explicit override from Script Properties
      if (override[key]) {
        var want = _norm(override[key]);
        var i = normHead.indexOf(want);
        if (i >= 0) return i;
      }
      // 2) alias table
      var aliases = USER_HEADER_ALIASES[key] || [];
      for (var a = 0; a < aliases.length; a++) {
        var j = normHead.indexOf(_norm(aliases[a]));
        if (j >= 0) return j;
      }
      return -1;
    }
    return {
      sid:    findIdx('sid'),
      name:   findIdx('name'),
      pwd:    findIdx('pwd'),
      role:   findIdx('role'),
      status: findIdx('status'),
      email:  findIdx('email'),
    };
  }

  function _loadUsers(){
    if (_usersCache && _usersCache.ts + 60 > _now()) return _usersCache.map;
    var sheetId = _prop('USERS_SHEET_ID','');
    var name    = _prop('USERS_SHEET_NAME', 'Users');
    if (!sheetId) return {};
    var sh = SpreadsheetApp.openById(sheetId).getSheetByName(name);
    if (!sh) return {};

    var rng  = sh.getDataRange().getValues();
    if (!rng.length) return {};
    var head = rng.shift().map(function(s){ return String(s||'').trim().toLowerCase(); });
    var idx  = _resolveHeaderMap(head);

    // If we can't even locate the ID column, there's no point continuing — but
    // we STILL return empty so callers fail gracefully.  Run diagnoseUsersSheet()
    // from the editor to see what went wrong.
    if (idx.sid < 0) {
      Logger.log('[SecurityCore] Could not locate Student ID column. Headers seen: ' + JSON.stringify(head));
      return {};
    }

    var map = {};
    rng.forEach(function(row){
      var sid = String(row[idx.sid] || '').trim();
      if (!sid) return;
      var u = {
        sid:    sid,
        name:   idx.name  >= 0 ? String(row[idx.name]  || '') : sid,
        pwd:    idx.pwd   >= 0 ? String(row[idx.pwd]   || '') : '',
        role:   idx.role  >= 0 ? String(row[idx.role]  || '').toLowerCase() : '',
        status: idx.status>= 0 ? String(row[idx.status]|| '').toLowerCase() : '',
        email:  idx.email >= 0 ? String(row[idx.email] || '') : '',
      };
      // Fallbacks when columns are absent OR cell is blank:
      if (!u.role || ['student','teacher','admin'].indexOf(u.role) < 0) u.role = 'student';
      if (!u.status) u.status = 'active';
      // Accept common "truthy" status values in addition to literal 'active':
      if (['active','enabled','yes','1','true','ok'].indexOf(u.status) >= 0) u.status = 'active';
      map[sid] = u;
    });
    _usersCache = { ts: _now(), map: map };
    return map;
  }

  function invalidateUsersCache(){ _usersCache = null; }

  function getUser(sid){
    sid = V.studentId(sid);
    if (!sid) return null;
    return _loadUsers()[sid] || null;
  }
  function authenticatePassword(sid, pwd){
    var u = getUser(sid);
    if (!u) return null;
    if (u.status !== 'active') return null;
    if (!u.pwd) return null;
    // Constant-time compare; trim trailing whitespace sometimes left in Sheets cells.
    if (!_eq(String(u.pwd).trim(), String(pwd || '').trim())) return null;
    return u;
  }

  /**
   * diagnoseUsersSheet()
   *
   *   Run this from the Apps Script editor when login is failing.  It logs
   *   the detected Sheet ID, tab name, column headers, resolved column index
   *   for each logical field, and the first resolved row (with the password
   *   masked).  No data leaves the script.
   */
  function diagnoseUsersSheet_(){
    var sheetId = _prop('USERS_SHEET_ID','');
    var tab     = _prop('USERS_SHEET_NAME', 'Users');
    Logger.log('USERS_SHEET_ID   = ' + (sheetId ? '(set, ' + sheetId.length + ' chars)' : '(MISSING!)'));
    Logger.log('USERS_SHEET_NAME = ' + tab);
    if (!sheetId) return { ok: false, reason: 'USERS_SHEET_ID missing' };
    var ss; try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { Logger.log('Cannot open spreadsheet: ' + e); return { ok:false, reason:'cannot-open-sheet' }; }
    var sh = ss.getSheetByName(tab);
    if (!sh) {
      var tabs = ss.getSheets().map(function(s){ return s.getName(); });
      Logger.log('Tab "' + tab + '" NOT FOUND. Tabs in this spreadsheet: ' + JSON.stringify(tabs));
      return { ok: false, reason: 'tab-not-found', tabs: tabs };
    }
    var rng = sh.getDataRange().getValues();
    if (!rng.length) { Logger.log('Sheet is empty.'); return { ok:false, reason:'empty' }; }
    var rawHead = rng[0];
    var head    = rawHead.map(function(s){ return String(s||'').trim().toLowerCase(); });
    var idx     = _resolveHeaderMap(head);
    Logger.log('Headers (raw)   : ' + JSON.stringify(rawHead));
    Logger.log('Headers (lower) : ' + JSON.stringify(head));
    Logger.log('Resolved indexes: ' + JSON.stringify(idx));
    var sample = null;
    if (rng.length > 1 && idx.sid >= 0) {
      var r = rng[1];
      sample = {
        sid:    r[idx.sid],
        name:   idx.name  >= 0 ? r[idx.name]  : '(no column)',
        pwd:    idx.pwd   >= 0 ? (r[idx.pwd] ? '***' + String(r[idx.pwd]).slice(-2) : '(blank)') : '(no column)',
        role:   idx.role  >= 0 ? r[idx.role]  : '(no column — will default to student)',
        status: idx.status>= 0 ? r[idx.status]: '(no column — will default to active)',
      };
      Logger.log('Row 2 sample    : ' + JSON.stringify(sample));
    }
    var users = _loadUsers();
    Logger.log('Users loaded    : ' + Object.keys(users).length);
    return { ok: idx.sid >= 0, headers: rawHead, indexes: idx, sample: sample, userCount: Object.keys(users).length };
  }

  // ----- main wrapper --------------------------------------------------------
  /**
   * secureExecute(e, opts, handler)
   *   opts = {
   *     allowed:   { actionName: { roles: ['student','teacher','admin'], anonymous?: bool, public?: bool } },
   *     scope:     'portal' | 'points' | 'game' | 'shop' | 'library' | 'assistant' | 'systemtest' | 'config',
   *     allowJSONP: bool          // only for Config endpoint
   *   }
   *   handler(action, params, ctx) — returns plain object (auto-wrapped to JSON)
   *   ctx = { user, role, sid, params, scope, e }
   */
  function secureExecute(e, opts, handler){
    opts = opts || {};
    var scope = opts.scope || 'unknown';
    var callback = (e && e.parameter && e.parameter.callback) || null;
    var allowJSONP = !!opts.allowJSONP;

    try {
      // 1) Origin / referer gate
      if (!_allowedOrigin(e)) {
        audit('-', 'origin-rejected', 'fail', { scope: scope });
        return jsonOut(fail('FORBIDDEN_ORIGIN','Request origin not allowed.'), allowJSONP ? callback : null);
      }

      // 2) Parse + cap payload
      var params;
      try { params = readParams(e); }
      catch(parseErr){
        return jsonOut(fail('BAD_PAYLOAD','Malformed request body', String(parseErr)), allowJSONP ? callback : null);
      }

      // 3) Action allow-list
      var action = V.str(params.action, { max: 64, pattern: /^[A-Za-z0-9_]+$/ });
      if (!action || !opts.allowed || !opts.allowed[action]) {
        audit('-', 'unknown-action:'+(action||'(none)'), 'fail', { scope: scope });
        return jsonOut(fail('UNKNOWN_ACTION','Action not permitted.'), allowJSONP ? callback : null);
      }
      var rule = opts.allowed[action];

      // 4) Authentication (token > password-on-login > anonymous)
      var user = null, role = 'anonymous', sid = null;
      var token = V.str(params.sessionToken, { max: 2048, optional: true });
      if (token) {
        var pay = verifyToken(token);
        if (!pay) {
          audit('-', action, 'bad-token', { scope: scope });
          return jsonOut(fail('BAD_TOKEN','Session expired or invalid. Please sign in again.'), allowJSONP ? callback : null);
        }
        user = getUser(pay.sid);
        if (!user) {
          audit(pay.sid, action, 'unknown-user', { scope: scope });
          return jsonOut(fail('UNKNOWN_USER','User no longer exists.'), allowJSONP ? callback : null);
        }
        if (user.status !== 'active') {
          audit(pay.sid, action, 'inactive', { scope: scope });
          return jsonOut(fail('ACCOUNT_BLOCKED','Account inactive.'), allowJSONP ? callback : null);
        }
        role = user.role || 'student';
        sid = user.sid;
      }

      // 5) Role gate / anonymous gate
      if (!rule.public) {
        if (!user && !rule.anonymous) {
          audit('-', action, 'no-auth', { scope: scope });
          return jsonOut(fail('AUTH_REQUIRED','Sign in required.'), allowJSONP ? callback : null);
        }
        if (user && rule.roles && rule.roles.indexOf(role) < 0) {
          audit(sid, action, 'role-denied', { scope: scope, role: role });
          return jsonOut(fail('FORBIDDEN','Your role cannot perform this action.'), allowJSONP ? callback : null);
        }
      }

      // 6) Lockout check (failed-auth abuse)
      var rlKey = sid || 'anon:'+(_rand(8));
      if (sid && isLocked(sid)) {
        audit(sid, action, 'locked', { scope: scope });
        return jsonOut(fail('TEMP_LOCKED','Too many failed attempts — try again in a few minutes.'), allowJSONP ? callback : null);
      }

      // 7) Rate limit (per-user when authed, per-action+random when anonymous)
      var rl = rateLimit(scope+':'+action, rlKey);
      if (!rl.ok) {
        audit(sid || '-', action, 'rate-limited:'+rl.reason, { scope: scope });
        return jsonOut(fail('RATE_LIMIT','Too many requests. Slow down.'), allowJSONP ? callback : null);
      }

      // 8) Optional anti-replay (frontend can pass `nonce` for sensitive writes)
      if (rule.requireNonce) {
        if (!checkNonce(params.nonce)) {
          audit(sid || '-', action, 'nonce-replay', { scope: scope });
          return jsonOut(fail('REPLAY','Stale or duplicate request.'), allowJSONP ? callback : null);
        }
      }

      // 9) Run handler
      var ctx = { user: user, role: role, sid: sid, params: params, scope: scope, e: e };
      var result;
      try {
        result = handler(action, params, ctx);
      } catch (handlerErr) {
        audit(sid || '-', action, 'handler-error', { scope: scope, err: String(handlerErr).slice(0,500) });
        return jsonOut(fail('SERVER_ERROR','Something went wrong.', String(handlerErr)), allowJSONP ? callback : null);
      }

      // 10) Coerce result + audit success on writes
      if (result == null) result = { success: true };
      if (typeof result !== 'object') result = { success: true, value: result };
      if (rule.audit) audit(sid || '-', action, 'ok', { scope: scope });

      return jsonOut(result, allowJSONP ? callback : null);
    } catch (fatal) {
      // catch-all: never leak stack traces
      try { audit('-', 'fatal', 'fail', { scope: scope, err: String(fatal).slice(0,500) }); } catch(_){}
      return jsonOut(fail('SERVER_ERROR','Unexpected server error.', String(fatal)), allowJSONP ? callback : null);
    }
  }

  // ----- public --------------------------------------------------------------
  return {
    // wrapper
    secureExecute: secureExecute,
    jsonOut: jsonOut,
    fail: fail,
    // tokens
    issueToken: issueToken,
    verifyToken: verifyToken,
    // identity
    authenticatePassword: authenticatePassword,
    getUser: getUser,
    invalidateUsersCache: invalidateUsersCache,
    diagnoseUsersSheet: diagnoseUsersSheet_,
    // helpers
    V: V,
    audit: audit,
    rateLimit: rateLimit,
    recordFailure: recordFailure,
    clearFailures: clearFailures,
    isLocked: isLocked,
    checkNonce: checkNonce,
    readParams: readParams,
  };
})();

/**
 * Quick self-check  —  run from the editor once after setting Script Properties
 * to verify HMAC_SECRET is configured.
 */
function runSecuritySelfTest() {
  var sid = 'TEST_USER';
  var tok = SecurityCore.issueToken(sid, 'student');
  var pay = SecurityCore.verifyToken(tok);
  if (!pay || pay.sid !== sid) throw new Error('Token round-trip failed');
  Logger.log('OK — token round-trip works. Token length: ' + tok.length);
  Logger.log('Decoded payload: ' + JSON.stringify(pay));
}

/**
 * diagnoseUsersSheet()
 *   Run this from the Apps Script editor when login is failing. It logs the
 *   detected Sheet ID, tab name, column headers, resolved column indexes and
 *   a masked sample row so you can instantly see which column is missing or
 *   mis-named. No data leaves the script — output goes to Executions → Logs.
 */
function diagnoseUsersSheet() {
  return SecurityCore.diagnoseUsersSheet();
}

/**
 * refreshUsersCache()
 *   Call this once after fixing the sheet / headers / properties so the next
 *   login doesn't use the 60-second stale cache.
 */
function refreshUsersCache() {
  SecurityCore.invalidateUsersCache();
  Logger.log('Users cache cleared. Next request will re-read the sheet.');
}
