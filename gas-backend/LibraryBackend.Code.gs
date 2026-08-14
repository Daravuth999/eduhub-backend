/**
 * Library backend — Code.gs (security wrapper)
 *
 *  Original endpoint URL (preserve):
 *    AKfycbzgTmcWAwLw8ZlA6cmSgkxv-KvQwSHwTLgL3cwD4l3RI8iHIOYacJPbGke76Fo0ETR8kA
 *
 *  Actions:
 *      ?action=login            → issue sessionToken
 *      ?action=getContent       → public lesson list (no internal IDs/answers)
 *      ?action=getStudentStats  → caller's stats only
 *      ?action=completeLesson   → server validates lesson + dedupes
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'library',
    allowed: {
      login:            { anonymous: true, audit: true },
      getContent:       { public: true },
      getStudentStats:  { roles: ['student','teacher','admin'] },
      completeLesson:   { roles: ['student','teacher','admin'], requireNonce: true, audit: true },
    },
  }, handleLibrary);
}

function handleLibrary(action, params, ctx) {
  var V = SecurityCore.V;

  if (action === 'login') {
    var sid = V.studentId(params.studentId || params.id);
    var pwd = V.str(params.password, { max: 128 });
    if (!sid || !pwd) return SecurityCore.fail('BAD_INPUT','Missing credentials.');
    if (SecurityCore.isLocked(sid)) return SecurityCore.fail('TEMP_LOCKED','Try again later.');
    var u = SecurityCore.authenticatePassword(sid, pwd);
    if (!u) { SecurityCore.recordFailure(sid); return SecurityCore.fail('BAD_CREDENTIALS','Incorrect login.'); }
    SecurityCore.clearFailures(sid);
    return {
      success: true,
      sessionToken: SecurityCore.issueToken(u.sid, u.role),
      name: u.name, studentId: u.sid,
    };
  }

  if (action === 'getContent') {
    // Strip any internal answer keys / instructor notes
    return { success: true, content: LibraryLogic_getPublicContent_() || [] };
  }

  if (action === 'getStudentStats') {
    return { success: true, stats: LibraryLogic_getStats_(ctx.sid) || {} };
  }

  if (action === 'completeLesson') {
    var title = V.str(params.lessonTitle, { max: 200 });
    var type  = V.enum(params.lessonType, ['video','reading','quiz','exercise']);
    if (!title || !type) return SecurityCore.fail('BAD_INPUT','Invalid lesson details.');
    return LibraryLogic_completeLesson_(ctx.sid, title, type) || SecurityCore.fail('COMPLETE_FAILED','Could not record completion.');
  }

  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

function LibraryLogic_getPublicContent_()              { /* TODO */ return []; }
function LibraryLogic_getStats_(sid)                   { /* TODO */ return {}; }
function LibraryLogic_completeLesson_(sid, t, type)    { /* TODO: dedupe + cap */ return { success:false, message:'not implemented' }; }
