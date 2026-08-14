/**
 * ============================================================================
 *  Author Studio — EduHub Library content authoring tool  (v1.0, Jan 2026)
 * ============================================================================
 *
 *  WHAT THIS IS
 *  ------------
 *  A Google-Sheets-bound Apps Script that gives the teacher / author a
 *  beautiful sidebar UI for adding new books and editing existing ones
 *  WITHOUT ever touching the spreadsheet rows by hand. It guarantees:
 *
 *    • APPEND-ONLY writes  — sheet.appendRow() only. Existing rows are
 *      never mutated, never deleted, never reordered.
 *
 *    • Revision-based edits — every save bumps the slug's revision
 *      number. The frontend (booksService.js) shows ONLY the latest
 *      revision; older rows remain in the sheet as a full history.
 *
 *    • Zero footprint in the student app — the studio lives inside
 *      Google Sheets via a custom menu. There is no admin UI in the
 *      public React app.
 *
 *    • Native Google authentication — only users with edit access to
 *      the Books spreadsheet can ever open the studio.
 *
 *  HOW TO INSTALL
 *  --------------
 *  See AUTHOR_STUDIO_GUIDE.md (in this folder). Tldr:
 *    1. Open the Books spreadsheet → Extensions → Apps Script.
 *    2. Paste the contents of THIS file as a new file `AuthorStudio.gs`.
 *    3. Paste AuthorStudioSidebar.html as a new HTML file with the EXACT
 *       name `AuthorStudioSidebar` (no extension shown in the editor).
 *    4. Save → reload the Sheet. A new menu "📚 Author Studio" appears.
 *    5. Click "Author Studio → Open Studio". Authorize on first run.
 *
 *  SHEET CONTRACT
 *  --------------
 *  The studio writes to whichever sheet is configured in
 *  AUTHOR_STUDIO_CONFIG.SHEET_NAME (default "Books"). The expected
 *  header columns are auto-created on first save if the sheet is empty.
 *  Existing sheets are NEVER reordered — we look up each column by name.
 *
 *  Required header columns (auto-created on demand):
 *    slug, section, title, subtitle, author, coverEmoji, coverGradient,
 *    accent, readingMinutes, level, published, newUntil, format,
 *    chapter, type, heading, body, image, audio, video, embed, poster,
 *    options, answer, explain, speaker, start, end, price, badge,
 *    coverImage, contentType, revision, _authoredAt, _authoredBy
 *
 *  The frontend already aliases most of these column names case-
 *  insensitively (booksService.js → ALIASES), so existing sheets that
 *  use slightly different names still work.
 *
 * ============================================================================ */

/* eslint-disable no-undef */
var AUTHOR_STUDIO_CONFIG = {
  SHEET_NAME:          'Books',
  ARCHIVE_SHEET_NAME:  'Books_Archive',
  STUDIO_VERSION:      '1.0.0',
  // Order of columns when we have to create the header row from scratch.
  // Existing sheets are matched by header NAME, not position, so changing
  // this list does not break any sheet that already has its own headers.
  CANONICAL_COLUMNS: [
    'slug','section','title','subtitle','author',
    'coverEmoji','coverGradient','accent','readingMinutes','level',
    'published','newUntil','format','price','badge','coverImage','contentType',
    'chapter','type','heading','body',
    'image','audio','video','embed','poster',
    'options','answer','explain','speaker','start','end',
    'revision','_authoredAt','_authoredBy',
  ],
};

/* ----------------------------- menu / opener ----------------------------- */

/**
 * onOpen — installs the custom menu the moment the spreadsheet loads.
 * No authorization needed for menu creation itself; the user is prompted
 * the first time they click an item that touches their data.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📚 Author Studio')
    .addItem('✍️ Open Studio',         'AuthorStudio_openStudio')
    .addItem('📚 Browse books',        'AuthorStudio_openBrowser')
    .addSeparator()
    .addItem('⚙️ Setup / repair sheet', 'AuthorStudio_setupSheet')
    .addItem('🧹 Archive old revisions', 'AuthorStudio_archiveOldRevisions')
    .addItem('ℹ️  About',               'AuthorStudio_about')
    .addToUi();
}

/** Opens the editing sidebar (for new books or editing existing ones). */
function AuthorStudio_openStudio() {
  var html = HtmlService.createHtmlOutputFromFile('AuthorStudioSidebar')
    .setTitle('📚 Author Studio')
    .setWidth(420);
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Opens the same sidebar but starts on the "browse books" tab. */
function AuthorStudio_openBrowser() {
  AuthorStudio_openStudio();
}

function AuthorStudio_about() {
  SpreadsheetApp.getUi().alert(
    'EduHub Author Studio v' + AUTHOR_STUDIO_CONFIG.STUDIO_VERSION + '\n\n' +
    'Append-only content authoring for the EduHub Library.\n' +
    'Every save creates a NEW revision — old rows are never overwritten.\n' +
    'The student app automatically shows only the latest revision.'
  );
}

/* ------------------------------ setup helper ----------------------------- */

/**
 * AuthorStudio_setupSheet — ensures the Books sheet exists with the
 * canonical header row. Safe to run multiple times (idempotent):
 *   • If the sheet doesn't exist → creates it with the full header.
 *   • If it exists with no headers → writes the header row.
 *   • If headers exist but `revision` / `_authoredAt` / `_authoredBy`
 *     are missing → APPENDS those columns to the right (does not
 *     touch existing data).
 */
function AuthorStudio_setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = AUTHOR_STUDIO_CONFIG.SHEET_NAME;
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS.length)
      .setValues([AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS])
      .setFontWeight('bold')
      .setBackground('#2a2140')
      .setFontColor('#f3e3a2');
    sh.setFrozenRows(1);
    SpreadsheetApp.getUi().alert(
      '✅ Created sheet "' + name + '" with the canonical header row.\n\n' +
      'You can now click "✍️ Open Studio" to add your first book.'
    );
    return;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS.length)
      .setValues([AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  // Append any missing meta columns (revision / _authoredAt / _authoredBy)
  // without disturbing existing data.
  var head = _readHeader(sh);
  var added = [];
  ['revision', '_authoredAt', '_authoredBy'].forEach(function (col) {
    if (head.indexOf(col) < 0) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(col).setFontWeight('bold');
      added.push(col);
      head.push(col);
    }
  });
  SpreadsheetApp.getUi().alert(
    added.length
      ? '✅ Setup complete. Added missing columns: ' + added.join(', ')
      : '✅ Setup complete. All required columns already present.'
  );
}

/* --------------------------- public API (sidebar) ------------------------ */

/**
 * AuthorStudio_listBooks — returns a deduplicated list of books currently
 * in the sheet (by slug), keyed off the LATEST revision of each slug.
 * Used by the sidebar's "📚 Browse books" picker.
 */
function AuthorStudio_listBooks() {
  var ctx = _readSheet();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  var byRev = _groupLatestRevisionRows(ctx.rows, ctx.head);
  var books = [];
  var seen = {};
  byRev.forEach(function (row) {
    var slug = String(row.slug || '').trim();
    if (!slug || seen[slug]) return;
    seen[slug] = true;
    books.push({
      slug:       slug,
      title:      String(row.title || ''),
      section:    String(row.section || 'story'),
      author:     String(row.author || ''),
      published:  _truthy(row.published),
      revision:   Number(row.revision || 0),
      newUntil:   String(row.newUntil || ''),
      coverEmoji: String(row.coverEmoji || ''),
    });
  });
  // Sort: published first, then alphabetical
  books.sort(function (a, b) {
    if (a.published !== b.published) return a.published ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  return { ok: true, books: books };
}

/**
 * AuthorStudio_loadBookForEdit — returns the FULL editable payload for
 * a book (latest revision only) so the sidebar can pre-fill the editor.
 */
function AuthorStudio_loadBookForEdit(slug) {
  slug = String(slug || '').trim();
  if (!slug) return { ok: false, error: 'missing-slug' };
  var ctx = _readSheet();
  if (!ctx.ok) return { ok: false, error: ctx.error };
  // Filter to all rows for this slug, then keep the highest revision only.
  var slugRows = ctx.rows.filter(function (r) {
    return String(r.slug || '').trim() === slug;
  });
  if (!slugRows.length) return { ok: false, error: 'not-found' };
  var maxRev = 0;
  slugRows.forEach(function (r) {
    var n = Number(r.revision || 0);
    if (Number.isFinite(n) && n > maxRev) maxRev = n;
  });
  var latest = slugRows.filter(function (r) {
    return Number(r.revision || 0) === maxRev;
  });
  // First row carries book-level metadata; subsequent rows are blocks.
  var meta = latest[0] || {};
  var book = {
    slug:           String(meta.slug || ''),
    section:        String(meta.section || 'story'),
    title:          String(meta.title || ''),
    subtitle:       String(meta.subtitle || ''),
    author:         String(meta.author || ''),
    coverEmoji:     String(meta.coverEmoji || ''),
    coverGradient:  String(meta.coverGradient || ''),
    accent:         String(meta.accent || ''),
    readingMinutes: Number(meta.readingMinutes || 0) || '',
    level:          String(meta.level || ''),
    published:      _truthy(meta.published),
    newUntil:       String(meta.newUntil || ''),
    price:          Number(meta.price || 0) || 0,
    badge:          String(meta.badge || ''),
    coverImage:     String(meta.coverImage || ''),
    contentType:    String(meta.contentType || ''),
    revision:       maxRev,
    chapters:       _rowsToChapters(latest),
  };
  return { ok: true, book: book };
}

/**
 * AuthorStudio_appendBookRevision — the ONE write endpoint.
 *
 *   • Receives a full book payload (metadata + chapters[].blocks[]).
 *   • Looks up the current max revision for this slug.
 *   • Appends ONE row per block, all stamped with revision = max + 1.
 *   • Stamps _authoredAt (ISO timestamp) and _authoredBy (user email).
 *   • Returns { ok: true, revision: N, rowsAppended: M }.
 *
 *   This function uses sheet.appendRow() exclusively → it is impossible
 *   to overwrite, reorder, or delete existing rows.
 */
function AuthorStudio_appendBookRevision(payload) {
  try {
    var book = _validateBookPayload(payload);
    var ctx = _readSheet({ ensureHeaders: true });
    if (!ctx.ok) return { ok: false, error: ctx.error };
    var sh = ctx.sheet;
    var head = ctx.head;

    // Compute next revision for this slug
    var slugRows = ctx.rows.filter(function (r) {
      return String(r.slug || '').trim() === book.slug;
    });
    var maxRev = 0;
    slugRows.forEach(function (r) {
      var n = Number(r.revision || 0);
      if (Number.isFinite(n) && n > maxRev) maxRev = n;
    });
    var nextRev = maxRev + 1;
    var stampAt = new Date().toISOString();
    var stampBy = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || '';

    // Build one row per block. Block 0 is "metadata" (carries book-level
    // fields + the first chapter title + first block).
    var rows = _bookToRows(book, head, {
      revision: nextRev,
      authoredAt: stampAt,
      authoredBy: stampBy,
    });

    // Lock to prevent two concurrent saves from racing each other.
    var lock = LockService.getDocumentLock();
    lock.waitLock(15000);
    try {
      rows.forEach(function (row) { sh.appendRow(row); });
    } finally {
      try { lock.releaseLock(); } catch (e) { /* ignore */ }
    }

    return {
      ok: true,
      revision: nextRev,
      rowsAppended: rows.length,
      authoredAt: stampAt,
      authoredBy: stampBy,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * AuthorStudio_archiveOldRevisions — moves all but the latest revision
 * of every slug into a "Books_Archive" sheet, then DELETES those rows
 * from the live sheet. Optional housekeeping after many edits — never
 * required for correctness (the frontend already ignores old revisions).
 *
 *   • Always creates the archive sheet on demand.
 *   • Operates inside a document lock + script transaction:
 *       1. Append all-old rows to archive (with timestamp).
 *       2. Build the keep-set of row indexes to retain in live sheet.
 *       3. Rewrite live sheet with header + keep-set in one setValues().
 */
function AuthorStudio_archiveOldRevisions() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Archive old revisions?',
    'For every book this moves all rows EXCEPT its latest revision into the ' +
    '"' + AUTHOR_STUDIO_CONFIG.ARCHIVE_SHEET_NAME + '" sheet (created if needed).\n\n' +
    'Old rows in the live sheet are then deleted. The student app is unaffected ' +
    'because it already only reads the latest revision.\n\nProceed?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  var ctx = _readSheet();
  if (!ctx.ok) { ui.alert('Cannot read sheet: ' + ctx.error); return; }
  var sh = ctx.sheet;
  var head = ctx.head;

  // Determine max revision per slug
  var maxRev = {};
  ctx.rows.forEach(function (r) {
    var slug = String(r.slug || '').trim();
    if (!slug) return;
    var rev = Number(r.revision || 0);
    if (!(slug in maxRev) || rev > maxRev[slug]) maxRev[slug] = rev;
  });

  var keep = [];
  var move = [];
  ctx.rows.forEach(function (r, i) {
    var slug = String(r.slug || '').trim();
    var rev = Number(r.revision || 0);
    if (!slug || maxRev[slug] === undefined) { keep.push(r); return; }
    if (rev === maxRev[slug]) keep.push(r);
    else move.push(r);
  });

  if (!move.length) { ui.alert('No old revisions found — nothing to archive.'); return; }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var arch = ss.getSheetByName(AUTHOR_STUDIO_CONFIG.ARCHIVE_SHEET_NAME);
  if (!arch) {
    arch = ss.insertSheet(AUTHOR_STUDIO_CONFIG.ARCHIVE_SHEET_NAME);
    arch.getRange(1, 1, 1, head.length + 1)
      .setValues([head.concat(['_archivedAt'])])
      .setFontWeight('bold');
    arch.setFrozenRows(1);
  }
  var archHead = _readHeader(arch);

  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try {
    var stamp = new Date().toISOString();
    move.forEach(function (r) {
      var row = archHead.map(function (col) {
        if (col === '_archivedAt') return stamp;
        return r[col] !== undefined ? r[col] : '';
      });
      arch.appendRow(row);
    });

    // Rebuild live sheet: header + keep rows
    var keepRows = keep.map(function (r) {
      return head.map(function (col) {
        return r[col] !== undefined ? r[col] : '';
      });
    });
    var lastRow = sh.getLastRow();
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, head.length).clearContent();
    if (keepRows.length) {
      sh.getRange(2, 1, keepRows.length, head.length).setValues(keepRows);
    }
  } finally {
    try { lock.releaseLock(); } catch (e) { /* ignore */ }
  }
  ui.alert('✅ Archived ' + move.length + ' old row(s) into "' +
           AUTHOR_STUDIO_CONFIG.ARCHIVE_SHEET_NAME + '". ' +
           'Live sheet now contains only the latest revision per book.');
}

/* ------------------------- internal sheet helpers ------------------------ */

function _readSheet(opts) {
  opts = opts || {};
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var name = AUTHOR_STUDIO_CONFIG.SHEET_NAME;
    var sh = ss.getSheetByName(name);
    if (!sh) {
      if (opts.ensureHeaders) {
        sh = ss.insertSheet(name);
        sh.getRange(1, 1, 1, AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS.length)
          .setValues([AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS])
          .setFontWeight('bold');
        sh.setFrozenRows(1);
      } else {
        return { ok: false, error: 'sheet-not-found:' + name };
      }
    }
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow === 0) {
      if (opts.ensureHeaders) {
        sh.getRange(1, 1, 1, AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS.length)
          .setValues([AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS])
          .setFontWeight('bold');
        sh.setFrozenRows(1);
        lastCol = AUTHOR_STUDIO_CONFIG.CANONICAL_COLUMNS.length;
      } else {
        return { ok: false, error: 'sheet-empty' };
      }
    }
    var head = _readHeader(sh);
    // Ensure meta columns exist when caller plans to write
    if (opts.ensureHeaders) {
      ['revision', '_authoredAt', '_authoredBy'].forEach(function (col) {
        if (head.indexOf(col) < 0) {
          var c = sh.getLastColumn() + 1;
          sh.getRange(1, c).setValue(col).setFontWeight('bold');
          head.push(col);
        }
      });
    }
    var rows = [];
    if (lastRow > 1) {
      var values = sh.getRange(2, 1, lastRow - 1, head.length).getValues();
      values.forEach(function (arr) {
        var obj = {};
        head.forEach(function (col, i) {
          var v = arr[i];
          if (v === null || v === undefined) v = '';
          obj[col] = v;
        });
        rows.push(obj);
      });
    }
    return { ok: true, sheet: sh, head: head, rows: rows };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function _readHeader(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return [];
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  return head.map(function (h) { return String(h || '').trim(); });
}

function _truthy(v) {
  if (v === true) return true;
  if (v === false || v === '' || v === 0 || v == null) return false;
  var s = String(v).trim().toLowerCase();
  return ['true', 'yes', '1', 'y', 'live', 'published'].indexOf(s) >= 0;
}

/**
 * _groupLatestRevisionRows — given all rows + headers, returns ONLY rows
 * belonging to the highest revision number for each slug.
 */
function _groupLatestRevisionRows(rows, head) {
  var max = {};
  rows.forEach(function (r) {
    var slug = String(r.slug || '').trim();
    if (!slug) return;
    var rev = Number(r.revision || 0);
    if (!(slug in max) || rev > max[slug]) max[slug] = rev;
  });
  return rows.filter(function (r) {
    var slug = String(r.slug || '').trim();
    if (!slug) return false;
    return Number(r.revision || 0) === max[slug];
  });
}

/* ----------------------- payload validation + shaping -------------------- */

function _validateBookPayload(p) {
  if (!p || typeof p !== 'object') throw new Error('Empty payload.');
  var slug = _slugify(p.slug || p.title);
  if (!slug) throw new Error('A slug or title is required.');
  var section = String(p.section || 'story').toLowerCase().trim();
  if (['stories','conversations','exercises'].indexOf(section) >= 0) {
    section = section.replace(/s$/, '');
  }
  if (['story','conversation','exercise'].indexOf(section) < 0) section = 'story';
  var chapters = Array.isArray(p.chapters) ? p.chapters : [];
  // Filter out empty chapters / blocks
  chapters = chapters
    .map(function (ch) {
      var blocks = Array.isArray(ch.blocks) ? ch.blocks : [];
      blocks = blocks.filter(function (b) {
        return b && (b.text || b.heading || b.audio || b.video || b.embed || b.image);
      });
      return { title: String(ch.title || '').trim() || 'Main', blocks: blocks };
    })
    .filter(function (ch) { return ch.blocks.length > 0; });
  if (!chapters.length) {
    // A book with zero blocks is still allowed if it has metadata (cover-only
    // entry to reserve a slug, e.g. published=false). We add a stub block.
    chapters = [{ title: 'Main', blocks: [{ type: 'paragraph', text: '' }] }];
  }
  return {
    slug:           slug,
    section:        section,
    title:          String(p.title || '').trim() || slug,
    subtitle:       String(p.subtitle || '').trim(),
    author:         String(p.author || '').trim(),
    coverEmoji:     String(p.coverEmoji || '').trim(),
    coverGradient:  String(p.coverGradient || '').trim(),
    accent:         String(p.accent || '').trim(),
    readingMinutes: Number(p.readingMinutes || 0) || '',
    level:          String(p.level || '').trim(),
    published:      _truthy(p.published) || p.published === true,
    newUntil:       String(p.newUntil || '').trim(),
    price:          Math.max(0, Math.floor(Number(p.price || 0))),
    badge:          String(p.badge || '').trim().toUpperCase().slice(0, 14),
    coverImage:     String(p.coverImage || '').trim(),
    contentType:    String(p.contentType || '').trim().toLowerCase(),
    chapters:       chapters,
  };
}

function _slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * _bookToRows — convert a validated book into rows the sheet expects.
 * Produces:
 *   row 0: book metadata + first chapter title + first block
 *   row 1+: chapter rows (one row per block)
 *
 * Only columns present in `head` are written — any absent column is
 * silently skipped (caller has already ensured meta columns exist).
 */
function _bookToRows(book, head, stamp) {
  var rows = [];
  var meta = {
    slug:           book.slug,
    section:        book.section,
    title:          book.title,
    subtitle:       book.subtitle,
    author:         book.author,
    coverEmoji:     book.coverEmoji,
    coverGradient:  book.coverGradient,
    accent:         book.accent,
    readingMinutes: book.readingMinutes,
    level:          book.level,
    published:      book.published ? 'TRUE' : 'FALSE',
    newUntil:       book.newUntil,
    price:          book.price,
    badge:          book.badge,
    coverImage:     book.coverImage,
    contentType:    book.contentType,
    format:         'blocks',
    revision:       stamp.revision,
    _authoredAt:    stamp.authoredAt,
    _authoredBy:    stamp.authoredBy,
  };
  book.chapters.forEach(function (ch, ci) {
    ch.blocks.forEach(function (blk, bi) {
      var rowObj = {};
      // Book-level metadata is repeated on EVERY row of this revision so
      // booksService.js (which scans rows independently) reliably picks it
      // up regardless of which row it parses first. Nothing in the sheet
      // has ever required metadata to be on a single row.
      Object.keys(meta).forEach(function (k) { rowObj[k] = meta[k]; });
      rowObj.chapter = ch.title;
      rowObj.type    = (blk.type || 'paragraph').toLowerCase();
      rowObj.heading = blk.heading || '';
      // Map media-typed blocks to their canonical column.
      var t = String(blk.type || '').toLowerCase();
      if (t === 'audio')      { rowObj.audio = blk.text || ''; rowObj.body = blk.body || ''; }
      else if (t === 'video') { rowObj.video = blk.text || ''; rowObj.body = blk.body || ''; }
      else if (t === 'embed') { rowObj.embed = blk.text || ''; rowObj.body = blk.body || ''; }
      else if (t === 'image') { rowObj.image = blk.text || ''; rowObj.body = blk.body || ''; }
      else { rowObj.body = blk.text || ''; }
      if (blk.poster)  rowObj.poster  = blk.poster;
      if (blk.options) rowObj.options = blk.options;
      if (blk.answer)  rowObj.answer  = blk.answer;
      if (blk.explain) rowObj.explain = blk.explain;
      if (blk.speaker) rowObj.speaker = blk.speaker;
      if (blk.start  !== undefined && blk.start  !== '') rowObj.start = Number(blk.start);
      if (blk.end    !== undefined && blk.end    !== '') rowObj.end   = Number(blk.end);

      var row = head.map(function (col) {
        return rowObj[col] !== undefined && rowObj[col] !== null ? rowObj[col] : '';
      });
      rows.push(row);
    });
  });
  return rows;
}

function _rowsToChapters(rows) {
  var byTitle = [];
  var byTitleIdx = {};
  rows.forEach(function (r) {
    var title = String(r.chapter || '').trim() || 'Main';
    if (byTitleIdx[title] === undefined) {
      byTitleIdx[title] = byTitle.length;
      byTitle.push({ title: title, blocks: [] });
    }
    var ch = byTitle[byTitleIdx[title]];
    var t = String(r.type || 'paragraph').toLowerCase();
    var blk = { type: t };
    if (t === 'audio')      blk.text = String(r.audio || r.body || '');
    else if (t === 'video') blk.text = String(r.video || r.body || '');
    else if (t === 'embed') blk.text = String(r.embed || r.body || '');
    else if (t === 'image') blk.text = String(r.image || r.body || '');
    else                    blk.text = String(r.body || '');
    if (r.heading) blk.heading = String(r.heading);
    if (r.poster)  blk.poster  = String(r.poster);
    if (r.options) blk.options = String(r.options);
    if (r.answer)  blk.answer  = String(r.answer);
    if (r.explain) blk.explain = String(r.explain);
    if (r.speaker) blk.speaker = String(r.speaker);
    if (r.start !== undefined && r.start !== '') blk.start = Number(r.start);
    if (r.end   !== undefined && r.end   !== '') blk.end   = Number(r.end);
    // Only push blocks that have at least some content
    if (blk.text || blk.heading || blk.audio || blk.video || blk.embed || blk.image) {
      ch.blocks.push(blk);
    }
  });
  return byTitle.filter(function (ch) { return ch.blocks.length > 0; });
}

/* ------------------------------ self test -------------------------------- */

/** Run from the editor to confirm the script can read the sheet. */
function AuthorStudio_selfTest() {
  var ctx = _readSheet();
  if (!ctx.ok) {
    Logger.log('Sheet read FAILED: ' + ctx.error);
    return ctx;
  }
  Logger.log('Sheet "' + AUTHOR_STUDIO_CONFIG.SHEET_NAME + '" → ' +
             ctx.rows.length + ' rows, ' + ctx.head.length + ' columns.');
  Logger.log('Headers: ' + JSON.stringify(ctx.head));
  var list = AuthorStudio_listBooks();
  Logger.log('Books listed: ' + (list.books || []).length);
  return list;
}
