/**
 * Config backend — Code.gs (security wrapper, JSONP-capable)
 *
 *  Original endpoint URL (preserve):
 *    AKfycby7Ca0rv5uZAalC7l0jyeQM2JQ2iX34LwW_CKB41cYiu2n4jZ9A6aK-SdGfaPkmYUmmoA
 *
 *  Actions:
 *      ?action=getConfig&callback=…  → public welcome / announcements / stat labels
 *
 *  PUBLIC endpoint — but rate-limited and guarded against:
 *    • callback-name injection (only [A-Za-z_$][A-Za-z0-9_$]{0,40})
 *    • full sheet dumps (we ONLY return the curated keys defined here)
 */
function doGet(e)  { return route(e); }
function doPost(e) { return route(e); }

function route(e) {
  return SecurityCore.secureExecute(e, {
    scope: 'config',
    allowJSONP: true,
    allowed: {
      getConfig: { public: true },
    },
  }, handleConfig);
}

function handleConfig(action, params, ctx) {
  if (action === 'getConfig') {
    var c = ConfigLogic_loadCurated_() || {};
    // ALLOWLIST every field we expose. Anything outside this set never leaves
    // the spreadsheet.
    return {
      success: true,
      title:                 String(c.title || ''),
      khmerWelcome:          String(c.khmerWelcome || ''),
      subtitle:              String(c.subtitle || ''),
      instructorName:        String(c.instructorName || ''),
      announcementTitle:     String(c.announcementTitle || ''),
      announcementMessages:  Array.isArray(c.announcementMessages) ? c.announcementMessages.slice(0,8).map(String) : [],
      enableTypewriter:      !!c.enableTypewriter,
      typewriterSpeed:       Number(c.typewriterSpeed) || 28,
      stats: {
        evaluation:  _statShape(c, 'evaluation'),
        points:      _statShape(c, 'points'),
        attendance:  _statShape(c, 'attendance'),
        leaderboard: _statShape(c, 'leaderboard'),
      },
    };
  }
  return SecurityCore.fail('UNKNOWN_ACTION','Action not implemented.');
}

function _statShape(c, k) {
  var s = (c.stats && c.stats[k]) || {};
  return {
    value: s.value == null ? null : String(s.value),
    trend: ['up','down','neutral'].indexOf(String(s.trend)) >= 0 ? String(s.trend) : 'neutral',
    label: String(s.label || ''),
  };
}

function ConfigLogic_loadCurated_() { /* TODO */ return {}; }
