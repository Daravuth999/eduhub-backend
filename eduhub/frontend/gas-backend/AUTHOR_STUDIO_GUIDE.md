# 📚 Author Studio — Deployment & Usage Guide

> **Version 1.0 · Jan 2026**
> Companion files: `AuthorStudio.Code.gs`, `AuthorStudioSidebar.html`

A built-in, append-only authoring tool for the EduHub Library — the teacher
adds stories, paragraphs, conversations, quizzes, tables, audio/video, and
more, with **live preview** and **zero risk of overwriting** existing
content. The studio lives entirely **inside Google Sheets** (no admin UI in
the student app), uses **Google's own authentication**, and writes only
**new revisions** — old rows are preserved as immutable history.

---

## 1. Why this design (read me first)

| Constraint | How Author Studio satisfies it |
|---|---|
| ✅ No admin controls inside the student app | Studio runs as a Google Sheets bound script, not a public route. Students never see it. |
| ✅ Cannot overwrite existing content | All writes use `sheet.appendRow()`. Existing rows are never edited or deleted. |
| ✅ Edits are safe | Each save bumps the slug's `revision` column. The frontend reads only the **highest revision per slug** — the previous version stays in the sheet as history. |
| ✅ Author authenticates without an in-app login | Google's native sign-in: only users with edit access to the Books spreadsheet can ever open the studio. |
| ✅ Author can add content fast | Block templates + bulk markdown paste + drafts auto-saved. |
| ✅ Existing system intact | Backend logic, points, shop, reader, GAS code — none of it changes. Only one tiny additive change in `booksService.js` (revision-aware loader). |

---

## 2. One-time deployment (≈ 5 minutes)

### 2.1  Open your Books spreadsheet
Open the Google Sheet whose ID is in the EduHub front-end's
`REACT_APP_BOOKS_SHEET_ID` env var (e.g. `1DY8NSPcyvWy-GPbVA2tcxqiadUwZ1AgfNWtCQjvkO-E`).

### 2.2  Open the bound Apps Script project
**Extensions → Apps Script** (this opens a script that is **container-bound** to
the spreadsheet — its `onOpen` trigger and custom menu only ever appear in
this Sheet).

### 2.3  Add the two studio files
In the Apps Script editor, on the left panel:

1. **Create a new script file** named `AuthorStudio` and paste the entire
   contents of `gas-backend/AuthorStudio.Code.gs` into it. Save (Ctrl/Cmd+S).
2. **Create a new HTML file** (the `+` button → HTML) named exactly
   `AuthorStudioSidebar` (no `.html` extension shown in the editor).
   Paste the entire contents of `gas-backend/AuthorStudioSidebar.html`. Save.

### 2.4  Authorize the script
1. Reload the spreadsheet tab in your browser. You should see a new menu
   labelled **📚 Author Studio**.
2. Click **📚 Author Studio → ⚙️ Setup / repair sheet**. Google will ask
   for permission — click **Continue → choose your account → Advanced →
   Go to (project name) (unsafe) → Allow**. (Apps Script bound to your own
   sheets is private — the warning is generic.)
3. The setup will:
   * Create a `Books` sheet if missing, with the canonical header row.
   * Append `revision`, `_authoredAt`, `_authoredBy` columns to the existing
     `Books` sheet if they aren't already there. Existing data is untouched.

### 2.5  Open the studio
Click **📚 Author Studio → ✍️ Open Studio**. The sidebar opens on the right.
You're done.

> **Tip — multiple authors.** Anyone you grant edit access to the
> spreadsheet can open the menu. Each author's email is recorded in the
> `_authoredBy` column on every row they save, so you have a full audit
> trail.

---

## 3. The four sidebar tabs

### ✍️ Edit
The structured authoring view.

* Top form = book metadata (title auto-derives the slug).
* Each "chapter" is a card with an editable title and any number of
  blocks. Reorder with ↑/↓; remove with 🗑.
* Add a block by clicking one of the type buttons under the chapter:
  Paragraph · Heading · Quote · Image · Audio · Video · Embed ·
  Transcript · Dialogue · MCQ · Fill-in-the-blank · Markdown / Table ·
  Example / Code.
* Bottom action bar:
  * **💾 Draft** — saves the current state to *this browser's*
    localStorage. Survives reloads.
  * **✓ Save revision** — appends the current state to the Sheet as
    revision N+1. Students see the change instantly (≤ 10 s sheet
    cache TTL on the front end).

### 📋 Bulk paste
Paste any markdown / plain text and hit **Convert into blocks**. The parser
detects:

| Markdown / shape | Becomes |
|---|---|
| `## Title` line | New chapter |
| `### Title` line | Heading block |
| `>` prefix line | Quote block |
| Blank line | Paragraph break |
| `---` on its own line | Chapter break |
| `![alt](url)` | Image block |
| `audio: <url>` / `video: <url>` / `embed: <url>` | Media block |
| `Q:` followed by `A) … *B) … C) …` | MCQ (the `*` marks the correct option) |
| `Q:` followed by `A: <answer>` | Fill-in-the-blank |
| `A:` / `B:` / `Teacher:` / `Student:` line | Dialogue line |
| Markdown table block | Markdown block (rendered by the reader as a real table) |

Convert always **appends** to your existing chapters — paste article-by-
article and refine each one in the Edit tab afterwards.

### 📚 Browse
Lists every book currently in the sheet (latest revision only). Click any
row to load it into the Edit tab; the next save creates a new revision —
your previous version remains in the sheet as history.

### 👁 Preview
A live, parchment-styled rendering of exactly what the student will see in
the React reader. Updates as you type.

---

## 4. Editing existing books safely

> **Golden rule:** the studio NEVER mutates rows in place. Every save is a
> brand-new revision appended to the bottom of the sheet.

Workflow:

1. **Browse** tab → click the book you want to edit.
2. The studio fetches the book's **latest revision** and pre-fills the
   editor.
3. Make your changes.
4. **✓ Save revision** → studio appends the new revision (e.g. rev 1 → 2).
5. The frontend's revision-aware loader (in `booksService.js`) immediately
   shows revision 2 to all students; revision 1 stays in the sheet for
   forensics, rollback, or audit.

**To "roll back"**, just open the sheet, find the rows of the older
revision (filter by `slug` + `revision`), copy them, paste them at the
bottom with a new (higher) revision number. The studio's own
**🧹 Archive old revisions** menu item is the recommended way to keep the
sheet tidy — it moves all-but-latest rows to a `Books_Archive` tab.

---

## 5. The new `revision` column — details

| Column | Type | Set by | Read by |
|---|---|---|---|
| `revision` | integer | Studio (auto, always max+1 per slug) | `booksService.js` filters to highest per slug |
| `_authoredAt` | ISO string | Studio | (audit only) |
| `_authoredBy` | email | Studio | (audit only) |

**Backwards compatibility:** rows without any `revision` value are treated
as revision 0. So your existing books continue to work as-is until you
re-save them through the studio (which then becomes revision 1).

---

## 6. Files reference

```
gas-backend/
├── AuthorStudio.Code.gs            ← server side (Apps Script)
├── AuthorStudioSidebar.html        ← sidebar UI (single-file)
└── AUTHOR_STUDIO_GUIDE.md          ← THIS FILE

src/eduhub/pages/library/books/
└── booksService.js                 ← +43 lines: revision filter
```

No other files were modified. The original `gas-backend/LibraryBackend.Code.gs`
(and the entire SecurityCore wrapper) is untouched — Author Studio is its own
container-bound script and does not talk to any of the public web-app endpoints.

---

## 7. FAQ

**Q. Does this require a separate "Apps Script project" deployment?**
No. It's container-bound to your Books spreadsheet, so installing it is as
simple as pasting the two files in the Apps Script editor that opens from
**Extensions → Apps Script**. There's no `Deploy → Web app` step.

**Q. Can two authors edit at the same time?**
Yes. A `LockService.getDocumentLock()` guards each save (15-second wait),
so simultaneous publishes serialize cleanly without ever clobbering each
other.

**Q. What if I want to delete a row by hand for some reason?**
The studio never relies on a particular row being present — it always
recomputes everything from the latest revision per slug. You're free to
delete archive rows manually with no risk to the live shelves.

**Q. How big can a book get?**
Apps Script payload limit per call is well over 1 MB (way more than a
typical book). For very long books, save chapter by chapter — every save
appends, so multiple incremental saves still produce one consistent
latest-revision view.

**Q. Can I disable the studio temporarily?**
Yes — open the Apps Script editor and remove the `onOpen` trigger
(Triggers panel) or simply rename the function. The custom menu disappears
on the next sheet reload. The student app keeps working as normal.

**Q. Is anything sent to a third-party server?**
No. All studio traffic is between your browser and Google's own Apps
Script runtime, in your own Google account.

---

## 8. Why this is the safest authoring tool you can give a paying-class

* **Every save = an immutable snapshot.** Old revisions never leave the
  sheet, so if a typo ships you can roll back in 30 s.
* **Append-only writes** mean a flaky network or accidental browser close
  cannot corrupt anything: the worst case is a partially-written *new*
  revision, which the frontend ignores until the higher revision finishes.
* **Container-bound + Google auth** means you don't have to manage any
  passwords, API keys, or "admin only" routes in the public app — there
  is literally nothing for an attacker to find.
* **No spreadsheet drag risk.** The teacher works in the sidebar, never in
  the grid. There is nothing to accidentally drag into the wrong cell.

— Designed for Learning Excellence.
