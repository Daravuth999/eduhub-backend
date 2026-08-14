/**
 * =============================================================================
 *  _AuditArchive.gs — v7.9.9 (Feb 2026)
 *  Monthly archive job for the AuditLog sheet written by SecurityCore.audit().
 * =============================================================================
 *
 *  Why:
 *    The `AuditLog` tab grows without bound — one row per login / write /
 *    security event across all 7 GAS backends. At the default per-user
 *    rate limit this can reach hundreds of thousands of rows per year,
 *    which slows every read and eventually bumps into the 10M-cell
 *    spreadsheet limit.
 *
 *  What this does:
 *    • On the first day of every month, moves all rows from `AuditLog`
 *      that are older than `AUDIT_RETENTION_DAYS` (default 31) into a
 *      dated archive tab named `AuditLog_YYYY-MM` in the SAME
 *      spreadsheet. The live `AuditLog` keeps only the rolling window.
 *    • Is idempotent — running it twice in the same month is safe:
 *      already-archived rows are not duplicated (it appends to the
 *      month tab, then truncates the live tab to the retention window).
 *    • Can be invoked manually from the Apps Script editor via
 *      `runAuditArchiveNow()` for on-demand clean-ups.
 *
 *  Installation (once, in any ONE of the 7 projects — usually Portal):
 *    1. Open the Portal (or any) GAS project in script.google.com.
 *    2. Add this file as `_AuditArchive.gs` (already included in the
 *       `gas-backend/` folder you're pasting from).
 *    3. Run `installAuditArchiveTrigger()` ONCE from the editor — this
 *       registers a monthly time-driven trigger (first of the month,
 *       03:00 in the project timezone).
 *    4. (Optional) `runAuditArchiveNow()` — to archive immediately.
 *    5. (Optional) Set Script Property `AUDIT_RETENTION_DAYS` to a
 *       non-default window (e.g. `60`).
 *
 *  The trigger lives in a SINGLE project because the `AuditLog` tab is
 *  a shared sheet (USERS_SHEET_ID) written by every backend through
 *  SecurityCore.audit(). Do NOT install the trigger in more than one
 *  project or you'll get overlapping archive jobs.
 */

/** Register the monthly trigger. Safe to call repeatedly — existing
 *  audit-archive triggers are replaced so you never end up with two. */
function installAuditArchiveTrigger() {
  var triggers = ScriptApp.getProjectTriggers() || [];
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditArchiveMonthly') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('auditArchiveMonthly')
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();
  Logger.log('Monthly AuditLog archive trigger installed (runs 1st of each month at 03:00 project-tz).');
}

/** Remove the monthly trigger (reverses installAuditArchiveTrigger). */
function uninstallAuditArchiveTrigger() {
  var triggers = ScriptApp.getProjectTriggers() || [];
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'auditArchiveMonthly') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' audit-archive triggers.');
}

/** Manual entrypoint — archive right now. */
function runAuditArchiveNow() {
  return auditArchiveMonthly();
}

/** Worker invoked by the monthly trigger. */
function auditArchiveMonthly() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty('USERS_SHEET_ID');
  if (!sheetId) {
    Logger.log('[AuditArchive] USERS_SHEET_ID missing — nothing to do.');
    return { archived: 0, reason: 'no-sheet-id' };
  }
  var logName = props.getProperty('AUDIT_SHEET_NAME') || 'AuditLog';
  var retentionDays = parseInt(props.getProperty('AUDIT_RETENTION_DAYS') || '31', 10);
  if (isNaN(retentionDays) || retentionDays < 7) retentionDays = 31;

  var lock = LockService.getScriptLock();
  try { lock.waitLock(30 * 1000); }
  catch (e) {
    Logger.log('[AuditArchive] Could not acquire lock — another run is in progress.');
    return { archived: 0, reason: 'busy' };
  }

  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var log = ss.getSheetByName(logName);
    if (!log) {
      Logger.log('[AuditArchive] AuditLog tab missing — nothing to archive.');
      return { archived: 0, reason: 'no-log' };
    }

    var last = log.getLastRow();
    if (last <= 1) return { archived: 0, reason: 'empty' };

    var rng = log.getRange(1, 1, last, log.getLastColumn());
    var values = rng.getValues();
    var header = values.shift();
    var cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    var stale = [];
    var kept = [];
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var tsRaw = row[0];
      var ts = tsRaw instanceof Date ? tsRaw.getTime() : new Date(tsRaw).getTime();
      if (isNaN(ts) || ts < cutoff) {
        stale.push(row);
      } else {
        kept.push(row);
      }
    }

    if (!stale.length) {
      Logger.log('[AuditArchive] No stale rows to archive (retention = ' + retentionDays + 'd).');
      return { archived: 0, reason: 'none-stale' };
    }

    // Determine target archive tab name from the OLDEST stale row so every
    // archive sheet is bounded by a single calendar month of the log.
    var firstStaleTs = stale[0][0];
    var d = firstStaleTs instanceof Date ? firstStaleTs : new Date(firstStaleTs);
    var tag = Utilities.formatDate(d, Session.getScriptTimeZone() || 'UTC', 'yyyy-MM');
    var archiveName = logName + '_' + tag;

    var archive = ss.getSheetByName(archiveName);
    if (!archive) {
      archive = ss.insertSheet(archiveName);
      archive.appendRow(header);
      archive.setFrozenRows(1);
    }
    archive.getRange(archive.getLastRow() + 1, 1, stale.length, header.length).setValues(stale);

    // Truncate the live log and rewrite with the retained rows (faster than
    // deleting row-by-row, and atomic within the lock window).
    log.clearContents();
    log.getRange(1, 1, 1, header.length).setValues([header]);
    if (kept.length) {
      log.getRange(2, 1, kept.length, header.length).setValues(kept);
    }
    log.setFrozenRows(1);

    Logger.log('[AuditArchive] Archived ' + stale.length + ' rows into "' + archiveName + '"; kept ' + kept.length + ' in live log.');
    return { archived: stale.length, kept: kept.length, archiveTab: archiveName };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
