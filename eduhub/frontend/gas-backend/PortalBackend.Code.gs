/**
 * Portal backend — Code.gs (security wrapper)
 *
 *  Original endpoint URL (preserve):
 *    AKfycbw_hGdyYmWukTCzaZoxuKMv34mYpQMXd7JtSFzpMpRjGd947eM70u-a1xTUJYA894FwAQ
 *
 *  Surfaces the same API contract the React frontend expects:
 *      ?action=login                  → NEW (issues a sessionToken)
 *      ?action=getStudentData         → student record (filtered, no password)
 *      ?action=getPasswordHint        → first-letter hint only
 *      ?action=validateCoupon         → server-side validation, no points trust
 *      ?action=getStudentComments     → caller's comments only
 *      ?action=getPerformanceHistory  → caller's history only
 *
 *  Existing business logic is delegated to PortalLogic_*  functions you already
 *  have in this Apps Script project — only the perimeter changes.
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'portal',
    allowed: {
      // public bootstrap actions
      login:                 { roles: ['student','teacher','admin'], anonymous: true, audit: true },
      getPasswordHint:       { anonymous: true, public: true },          // returns first letter only
      // authenticated reads (student can only read their own row — see handler)
      getStudentData:        { roles: ['student','teacher','admin'] },
      getStudentComments:    { roles: ['student','teacher','admin'] },
      getPerformanceHistory: { roles: ['student','teacher','admin'] },
      // authenticated writes
      // v7.9.9 — replay-protected. `validateCoupon` deducts value from
      // the student's PaymentAmount (writes to the sheet), so a captured
      // request must not be replayable. Frontend already sends nonce.
      validateCoupon:        { roles: ['student','teacher','admin'], requireNonce: true,  audit: true },
      libraryUnlock:         { roles: ['student','teacher','admin'], requireNonce: true,  audit: true },
      // v7.9.14 — Append a row to the `Unlocks` tab of the Books
      // spreadsheet (Timestamp | studentId | slug | price). Replaces
      // the legacy Google-Form path with an audited, server-validated
      // write. The frontend (unlocksService.js v7.9.14) ALSO fires the
      // Form fallback in parallel — both channels coexist safely
      // because gviz reads dedupe by slug.
      unlockRecord:          { roles: ['student','teacher','admin'], requireNonce: true,  audit: true },
    },
  }, handlePortal);
}

function handlePortal(action, params, ctx) {
  var V = SecurityCore.V;

  // ---- AUTH bootstrap ----
  if (action === 'login') {
    var sid = V.studentId(params.studentId || params.id);
    var pwd = V.str(params.password, { max: 128 });
    if (!sid || !pwd) return SecurityCore.fail('BAD_INPUT','Missing credentials.');
    if (SecurityCore.isLocked(sid)) return SecurityCore.fail('TEMP_LOCKED','Too many failed attempts.');
    var u = SecurityCore.authenticatePassword(sid, pwd);
    if (!u) {
      SecurityCore.recordFailure(sid);
      return SecurityCore.fail('BAD_CREDENTIALS','Incorrect Student ID or password.');
    }
    SecurityCore.clearFailures(sid);
    return {
      success: true,
      sessionToken: SecurityCore.issueToken(u.sid, u.role),
      role: u.role,
      name: u.name,
      studentId: u.sid,
    };
  }

  if (action === 'getPasswordHint') {
    var sid2 = V.studentId(params.studentId);
    if (!sid2) return SecurityCore.fail('BAD_INPUT','Invalid student ID.');
    var u2 = SecurityCore.getUser(sid2);
    if (!u2) return { success: true, hint: '' };
    var p = u2.pwd || '';
    return { success: true, hint: p ? (p.charAt(0) + '•••' + (p.length > 1 ? p.charAt(p.length-1) : '')) : '' };
  }

  // ---- AUTHENTICATED reads ----
  // For students: force them to ONLY read their own record.
  function _ownerOrPriv(reqSid){
    if (ctx.role === 'admin' || ctx.role === 'teacher') return reqSid || ctx.sid;
    return ctx.sid;   // student → ignore client-provided studentId
  }

  if (action === 'getStudentData') {
    var sid3 = _ownerOrPriv(V.studentId(params.studentId));
    var row = PortalLogic_getStudentRow_(sid3);          // <-- existing function
    if (!row) return SecurityCore.fail('NOT_FOUND','Student not found.');
    // strip secrets before responding
    delete row.Password; delete row.password; delete row.PasswordHash;
    return Object.assign({ success: true }, row);
  }

  if (action === 'getStudentComments') {
    var sid4 = _ownerOrPriv(V.studentId(params.studentId));
    return { success: true, comments: PortalLogic_getComments_(sid4) || [] };
  }

  if (action === 'getPerformanceHistory') {
    var sid5 = _ownerOrPriv(V.studentId(params.studentId));
    return { success: true, history: PortalLogic_getHistory_(sid5) || [] };
  }

  // ---- AUTHENTICATED write ----
  if (action === 'validateCoupon') {
    var sid6 = _ownerOrPriv(V.studentId(params.studentId));
    var code = V.str(params.couponCode, { max: 64, pattern: /^[A-Za-z0-9_\-]{1,64}$/ });
    if (!code) return SecurityCore.fail('BAD_INPUT','Invalid coupon code.');
    // ALL value math is done by your existing logic — never trust client values.
    return PortalLogic_validateCoupon_(sid6, code) || SecurityCore.fail('COUPON_FAILED','Coupon could not be applied.');
  }

  // ---- AUTHENTICATED write — Library cross-device ownership ----
  // v7.9.5 — appends the slug to the student's `UnlockedBooks` cell so a
  // purchase persists across browser/IP/device. The frontend calls this
  // right after a successful in-app purchase.
  if (action === 'libraryUnlock') {
    var sid7 = _ownerOrPriv(V.studentId(params.studentId));
    var slug = V.str(params.slug, { max: 80, pattern: /^[A-Za-z0-9 _\-]+$/ });
    if (!slug) return SecurityCore.fail('BAD_INPUT','Missing slug.');
    return PortalLogic_libraryUnlock_(sid7, slug) ||
           SecurityCore.fail('UNLOCK_FAILED','Could not record unlock.');
  }

  // v7.9.14 — append a row to the Books spreadsheet's `Unlocks` tab.
  // Schema (headers in row 1): Timestamp | studentId | slug | price
  if (action === 'unlockRecord') {
    var sid8  = _ownerOrPriv(V.studentId(params.studentId));
    var slug2 = V.str(params.slug, { max: 80, pattern: /^[A-Za-z0-9 _\-]+$/ });
    var pRaw  = params.price != null ? String(params.price) : '0';
    var pNum  = Math.max(0, Math.floor(Number(pRaw) || 0));
    if (!slug2) return SecurityCore.fail('BAD_INPUT','Missing slug.');
    var res = PortalLogic_unlockRecord_(sid8, slug2, pNum);
    if (!res) return SecurityCore.fail('UNLOCK_FAILED','Could not record unlock.');
    // Explicit confirmation shape — frontend v7.9.14 only trusts this
    // exact field combination (`ok:true` + `action:"unlockRecord"`).
    return Object.assign({ ok: true, success: true, action: 'unlockRecord' }, res);
  }

  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

/* ---------------------------------------------------------------------------
 *  PortalLogic_*   — v7.9.9 concrete implementations
 *
 *  The original code had these as TODO stubs, so a deployed backend returned
 *  `null`/empty/`not implemented` for every read. These bodies use the same
 *  Students / Comments / History / Coupons tabs the pre-secure codebase
 *  used. Sheet IDs and tab names are pulled from Script Properties so the
 *  same code works across environments.
 *
 *  REQUIRED SCRIPT PROPERTIES (add once in the Portal GAS project):
 *      PORTAL_SHEET_ID         Sheet with Students / Comments / History / Coupons tabs
 *      PORTAL_STUDENTS_TAB     default 'Students'
 *      PORTAL_COMMENTS_TAB     default 'Comments'
 *      PORTAL_HISTORY_TAB      default 'History'
 *      PORTAL_COUPONS_TAB      default 'Coupons'
 * --------------------------------------------------------------------------- */
function _portalSS_() {
  var id = PropertiesService.getScriptProperties().getProperty('PORTAL_SHEET_ID')
        || PropertiesService.getScriptProperties().getProperty('USERS_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActive();
}
function _portalSheet_(propName, fallbackName) {
  var name = PropertiesService.getScriptProperties().getProperty(propName) || fallbackName;
  var ss = _portalSS_();
  return ss ? ss.getSheetByName(name) : null;
}
function _headerMap_(row) {
  var m = {};
  for (var i = 0; i < row.length; i++) {
    var h = String(row[i] || '').trim();
    if (h) m[h.toLowerCase()] = i;
  }
  return m;
}
function _findCol_(map, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var k = String(aliases[i]).toLowerCase();
    if (map[k] != null) return map[k];
  }
  return -1;
}

function PortalLogic_getStudentRow_(sid) {
  var sh = _portalSheet_('PORTAL_STUDENTS_TAB', 'Students');
  if (!sh) return null;
  var rng = sh.getDataRange().getValues();
  if (!rng.length) return null;
  var head = rng.shift();
  var map  = _headerMap_(head);
  var idCol = _findCol_(map, ['StudentID','Student ID','Student Id','id','SID','RollNo']);
  if (idCol < 0) return null;
  var wanted = String(sid || '').trim();
  for (var r = 0; r < rng.length; r++) {
    if (String(rng[r][idCol] || '').trim() === wanted) {
      var obj = {};
      for (var c = 0; c < head.length; c++) {
        var key = String(head[c] || '').trim();
        if (!key) continue;
        obj[key] = rng[r][c];
      }
      return obj;
    }
  }
  return null;
}

function PortalLogic_getComments_(sid) {
  var sh = _portalSheet_('PORTAL_COMMENTS_TAB', 'Comments');
  if (!sh) return [];
  var rng = sh.getDataRange().getValues();
  if (rng.length < 2) return [];
  var head = rng.shift();
  var map  = _headerMap_(head);
  var idCol = _findCol_(map, ['StudentID','Student ID','id']);
  if (idCol < 0) return [];
  var wanted = String(sid || '').trim();
  var out = [];
  for (var r = 0; r < rng.length; r++) {
    if (String(rng[r][idCol] || '').trim() !== wanted) continue;
    var row = {};
    for (var c = 0; c < head.length; c++) {
      var key = String(head[c] || '').trim();
      if (!key || c === idCol) continue;
      var v = rng[r][c];
      row[key] = (v instanceof Date) ? v.toISOString() : v;
    }
    // normalise common keys the frontend expects
    row.teacherName = row.teacherName || row.TeacherName || row.Teacher || '';
    row.comment     = row.comment     || row.Comment     || row.text    || row.Text || '';
    row.type        = row.type        || row.Type        || 'general';
    row.date        = row.date        || row.Date        || row.Timestamp || '';
    out.push(row);
  }
  // newest first
  out.sort(function(a,b){ return String(b.date||'').localeCompare(String(a.date||'')); });
  return out.slice(0, 50);
}

function PortalLogic_getHistory_(sid) {
  var sh = _portalSheet_('PORTAL_HISTORY_TAB', 'History');
  if (!sh) return [];
  var rng = sh.getDataRange().getValues();
  if (rng.length < 2) return [];
  var head = rng.shift();
  var map  = _headerMap_(head);
  var idCol = _findCol_(map, ['StudentID','Student ID','id']);
  if (idCol < 0) return [];
  var wanted = String(sid || '').trim();
  var out = [];
  for (var r = 0; r < rng.length; r++) {
    if (String(rng[r][idCol] || '').trim() !== wanted) continue;
    var row = {};
    for (var c = 0; c < head.length; c++) {
      var key = String(head[c] || '').trim();
      if (!key || c === idCol) continue;
      var v = rng[r][c];
      if (v instanceof Date) v = v.toISOString();
      // coerce numeric-looking fields
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      row[key] = v;
    }
    out.push(row);
  }
  out.sort(function(a,b){ return String(a.date||a.Date||'').localeCompare(String(b.date||b.Date||'')); });
  return out.slice(-36); // last 3 years monthly, ample
}

/**
 * Server-trusted coupon validation. The client NEVER sends the discount
 * value — this function reads `Coupons` tab, checks window + uses, then
 * updates the student's `PaymentAmount` cell and increments `UsedCount`.
 *
 * `Coupons` tab columns (case-insensitive, any unused ones can be omitted):
 *    Code | DiscountPercent | MaxUses | UsedCount | ExpiresAt | Active
 */
function PortalLogic_validateCoupon_(sid, code) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) {
    return SecurityCore.fail('BUSY','Please try again in a moment.');
  }
  try {
    var sh = _portalSheet_('PORTAL_COUPONS_TAB', 'Coupons');
    if (!sh) return SecurityCore.fail('COUPON_FAILED','Coupon registry not configured.');
    var rng = sh.getDataRange().getValues();
    if (rng.length < 2) return SecurityCore.fail('COUPON_FAILED','No coupons available.');
    var head = rng[0];
    var map  = _headerMap_(head);
    var codeCol     = _findCol_(map, ['Code','Coupon','CouponCode']);
    var pctCol      = _findCol_(map, ['DiscountPercent','Discount','Percent']);
    var maxCol      = _findCol_(map, ['MaxUses','Max','Limit']);
    var usedCol     = _findCol_(map, ['UsedCount','Used','Count']);
    var expCol      = _findCol_(map, ['ExpiresAt','Expiry','ExpiresOn']);
    var activeCol   = _findCol_(map, ['Active','Enabled','Status']);
    if (codeCol < 0 || pctCol < 0) return SecurityCore.fail('COUPON_FAILED','Coupon sheet schema invalid.');
    var wantedCode = String(code || '').trim().toUpperCase();
    for (var r = 1; r < rng.length; r++) {
      var row = rng[r];
      if (String(row[codeCol] || '').trim().toUpperCase() !== wantedCode) continue;
      if (activeCol >= 0) {
        var a = String(row[activeCol] || '').trim().toLowerCase();
        if (a && ['false','no','0','disabled','inactive'].indexOf(a) >= 0) {
          return SecurityCore.fail('COUPON_INACTIVE','This coupon is not active.');
        }
      }
      if (expCol >= 0 && row[expCol]) {
        var exp = new Date(row[expCol]);
        if (!isNaN(exp.getTime()) && exp.getTime() < Date.now()) {
          return SecurityCore.fail('COUPON_EXPIRED','This coupon has expired.');
        }
      }
      if (maxCol >= 0 && usedCol >= 0) {
        var max = parseInt(row[maxCol], 10) || 0;
        var used = parseInt(row[usedCol], 10) || 0;
        if (max > 0 && used >= max) {
          return SecurityCore.fail('COUPON_EXHAUSTED','This coupon has been fully used.');
        }
      }
      var pct = parseFloat(row[pctCol]);
      if (isNaN(pct) || pct <= 0 || pct > 100) return SecurityCore.fail('COUPON_FAILED','Invalid coupon value.');

      // Look up student's current PaymentAmount and update it.
      var studentRow = PortalLogic_getStudentRow_(sid);
      if (!studentRow) return SecurityCore.fail('NOT_FOUND','Student not found.');
      var base = parseFloat(studentRow.PaymentAmount || studentRow['Payment Amount'] || 0);
      if (isNaN(base) || base <= 0) return SecurityCore.fail('NO_BALANCE','No outstanding payment to discount.');
      var newAmount = Math.max(0, Math.round((base * (1 - pct/100)) * 100) / 100);

      // Write back the new amount to the student row.
      var studentsSheet = _portalSheet_('PORTAL_STUDENTS_TAB', 'Students');
      var sData = studentsSheet.getDataRange().getValues();
      var sHead = sData[0];
      var sMap  = _headerMap_(sHead);
      var sidCol = _findCol_(sMap, ['StudentID','Student ID','id']);
      var payCol = _findCol_(sMap, ['PaymentAmount','Payment Amount','Payment']);
      if (sidCol >= 0 && payCol >= 0) {
        for (var i = 1; i < sData.length; i++) {
          if (String(sData[i][sidCol] || '').trim() === String(sid).trim()) {
            studentsSheet.getRange(i + 1, payCol + 1).setValue(newAmount);
            break;
          }
        }
      }

      // Increment UsedCount atomically.
      if (usedCol >= 0) {
        var prevUsed = parseInt(row[usedCol], 10) || 0;
        sh.getRange(r + 1, usedCol + 1).setValue(prevUsed + 1);
      }

      return {
        success: true,
        discountPercent: pct,
        newAmount: newAmount,
        message: 'Coupon applied: ' + pct + '% off.',
      };
    }
    return SecurityCore.fail('COUPON_NOT_FOUND','This coupon code does not exist.');
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/**
 * v7.9.5 — Library cross-device unlock.
 *
 *   1) Open the Students sheet (same one PortalLogic_getStudentRow_ uses).
 *   2) Locate the row whose StudentID === sid.
 *   3) Read the `UnlockedBooks` cell, split by comma, add the slug if
 *      not present, write back, return the full list.
 *
 * SHEET REQUIREMENTS:
 *   • Add an `UnlockedBooks` column to the Students tab if not already
 *     present (text, comma-separated).
 *
 * Replace the SS / SHEET / RANGE constants below with the same handles
 * the rest of your Portal logic uses (or re-export them from a shared
 * helper). The function is intentionally idempotent and append-only —
 * a re-purchase never duplicates the slug.
 */
function PortalLogic_libraryUnlock_(sid, slug) {
  try {
    var ss    = SpreadsheetApp.getActive();        // <-- swap if you use openById
    var sheet = ss.getSheetByName('Students');     // <-- match your tab name
    if (!sheet) return null;
    var data  = sheet.getDataRange().getValues();
    var head  = data[0].map(function(h){ return String(h).trim(); });
    var idCol = head.indexOf('StudentID');         if (idCol < 0) idCol = head.indexOf('studentId');
    var ubCol = head.indexOf('UnlockedBooks');
    if (idCol < 0 || ubCol < 0) return null;
    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idCol]).trim() === String(sid).trim()) {
        var existing = String(data[r][ubCol] || '')
                        .split(/[,\n;|]+/)
                        .map(function(s){ return s.trim(); })
                        .filter(Boolean);
        if (existing.indexOf(slug) === -1) existing.push(slug);
        sheet.getRange(r + 1, ubCol + 1).setValue(existing.join(','));
        return { success: true, unlocked: existing };
      }
    }
    return null;
  } catch (e) {
    return { success: false, error: String(e) };
  }
}


/**
 * v7.9.14 — Append a row to the `Unlocks` tab of the Books spreadsheet.
 *
 *   Schema (row 1 = headers): Timestamp | studentId | slug | price
 *
 *   This is the audited, server-side equivalent of the legacy Google
 *   Form POST. Both channels safely coexist — the frontend gviz reader
 *   dedupes by slug, so a duplicate row is harmless.
 *
 *   REQUIRED SCRIPT PROPERTIES (add once in the Portal GAS project):
 *       BOOKS_SHEET_ID    Spreadsheet ID that hosts the `Unlocks` tab
 *                         (same Sheet the Books CMS uses).
 *       UNLOCKS_TAB_NAME  Optional. Defaults to 'Unlocks'.
 *
 *   The tab is auto-created with the correct headers if it doesn't
 *   exist yet — the operator only needs to set BOOKS_SHEET_ID once.
 */
function PortalLogic_unlockRecord_(sid, slug, price) {
  try {
    var props = PropertiesService.getScriptProperties();
    var bookSsId = props.getProperty('BOOKS_SHEET_ID')
                || props.getProperty('REACT_APP_BOOKS_SHEET_ID');
    var tabName  = props.getProperty('UNLOCKS_TAB_NAME') || 'Unlocks';
    var ss = bookSsId ? SpreadsheetApp.openById(bookSsId) : SpreadsheetApp.getActive();
    if (!ss) return null;

    var sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, 4).setValues([['Timestamp','studentId','slug','price']]);
      sheet.setFrozenRows(1);
    } else {
      // Make sure header row is present (defensive — operator may have
      // created the tab manually without headers).
      var firstRow = sheet.getRange(1, 1, 1, 4).getValues()[0].map(String);
      var hasHeaders = firstRow.join(',').toLowerCase().indexOf('studentid') >= 0;
      if (!hasHeaders) {
        sheet.insertRowBefore(1);
        sheet.getRange(1, 1, 1, 4).setValues([['Timestamp','studentId','slug','price']]);
        sheet.setFrozenRows(1);
      }
    }

    sheet.appendRow([new Date(), String(sid), String(slug), Number(price) || 0]);
    return { appended: true, sheet: tabName, slug: String(slug) };
  } catch (e) {
    return { appended: false, error: String(e) };
  }
}
