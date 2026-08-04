"""
tuition_receipt_pdf.py — Persistent Tuition Receipt Engine: PDF/PNG rendering.

Pure rendering module: takes an already-finalized, immutable `receipt_doc`
(a `tuition_receipts` document — see tuition_tools.py) plus a small template
config (company header / notes / terms, editable via
GET/PUT /api/admin/tuition/receipt-template-config), and produces bytes.
Every field is read ONLY from those two inputs — never recomputed from
`tuition_records` or any other mutable source. That is what makes
regeneration deterministic: the same receipt_doc + template_cfg always
produce byte-for-byte identical output.

Layout follows the attached Zoho-style invoice template: company header
block, INVOICE title + invoice number, Balance Due, Invoice Date / Terms /
Due Date / P.O.#, Bill To, Subject, a single-row line-item table, Sub
Total/Total/Payment Made/Balance Due block, Notes, Terms & Conditions,
Cashier name.

Libraries: reportlab (pure-Python PDF, no system libraries — Render-safe)
and pymupdf/fitz (rasterizes the PDF we just built to PNG, so the PNG is
pixel-identical to the PDF from one layout function, not two renderers).
"""
from __future__ import annotations

import io
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_RIGHT

_INK = colors.HexColor("#111827")
_MUTED = colors.HexColor("#6b7280")
_HEADER_BG = colors.HexColor("#1f2937")
_LINE = colors.HexColor("#e5e7eb")
_TOTAL_BG = colors.HexColor("#f3f4f6")


def _fmt_money(amount_usd) -> str:
    try:
        return f"USD{float(amount_usd):.2f}"
    except (TypeError, ValueError):
        return "USD0.00"


def _fmt_date(value) -> str:
    if isinstance(value, datetime):
        return value.strftime("%d %b %Y")
    if not value:
        return "—"
    return str(value)


def _cashier_name(receipt_doc: dict) -> str:
    name = receipt_doc.get("recorded_by_name")
    if name:
        return str(name)
    return "Automated · KHQR"


def _billing_period(receipt_doc: dict) -> str:
    prev = receipt_doc.get("prev_due_date")
    new = receipt_doc.get("new_due_date")
    if prev and new:
        return f"{prev} → {new}"
    return new or "—"


def _styles():
    ss = getSampleStyleSheet()
    ss.add(ParagraphStyle(
        name="TTNTitle", fontName="Helvetica-Bold", fontSize=26,
        textColor=_INK, alignment=TA_RIGHT,
    ))
    ss.add(ParagraphStyle(
        name="TTNInvoiceNo", fontName="Helvetica-Bold", fontSize=11,
        textColor=_MUTED, alignment=TA_RIGHT,
    ))
    ss.add(ParagraphStyle(
        name="TTNBalanceLabel", fontName="Helvetica", fontSize=9,
        textColor=_MUTED, alignment=TA_RIGHT,
    ))
    ss.add(ParagraphStyle(
        name="TTNBalanceValue", fontName="Helvetica-Bold", fontSize=14,
        textColor=_INK, alignment=TA_RIGHT,
    ))
    ss.add(ParagraphStyle(
        name="TTNCompany", fontName="Helvetica-Bold", fontSize=12, textColor=_INK,
    ))
    ss.add(ParagraphStyle(
        name="TTNSmall", fontName="Helvetica", fontSize=9, textColor=_MUTED, leading=13,
    ))
    ss.add(ParagraphStyle(
        name="TTNLabel", fontName="Helvetica", fontSize=9, textColor=_MUTED,
    ))
    ss.add(ParagraphStyle(
        name="TTNBody", fontName="Helvetica", fontSize=9.5, textColor=_INK, leading=14,
    ))
    ss.add(ParagraphStyle(
        name="TTNHeading", fontName="Helvetica-Bold", fontSize=10, textColor=_INK,
    ))
    return ss


def render_receipt_pdf(receipt_doc: dict, template_cfg: dict) -> bytes:
    """Build the receipt PDF. Never raises for missing optional fields —
    every lookup below has a safe default."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.55 * inch, bottomMargin=0.55 * inch,
        title=receipt_doc.get("invoice_number") or receipt_doc.get("receipt_id") or "Receipt",
    )
    s = _styles()
    story = []

    company_name = template_cfg.get("company_name") or "Eduhub Studio"
    company_lines = "<br/>".join(filter(None, [
        template_cfg.get("company_address"),
        template_cfg.get("company_phone"),
        template_cfg.get("company_email"),
    ]))

    header_tbl = Table(
        [[
            Paragraph(f"<b>{company_name}</b><br/>{company_lines}", s["TTNSmall"]),
            Paragraph("INVOICE", s["TTNTitle"]),
        ]],
        colWidths=[3.6 * inch, 3.2 * inch],
    )
    header_tbl.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(header_tbl)
    story.append(Spacer(1, 4))

    invoice_number = receipt_doc.get("invoice_number") or receipt_doc.get("receipt_id") or "—"
    story.append(Paragraph(f"# {invoice_number}", s["TTNInvoiceNo"]))
    story.append(Spacer(1, 10))

    balance_tbl = Table(
        [[
            Paragraph("Bill To", s["TTNLabel"]),
            "",
        ], [
            Paragraph(str(receipt_doc.get("clean_id") or receipt_doc.get("student_id") or "—"), s["TTNBody"]),
            Paragraph("Balance Due", s["TTNBalanceLabel"]),
        ], [
            "",
            Paragraph("USD0.00", s["TTNBalanceValue"]),
        ]],
        colWidths=[3.6 * inch, 3.2 * inch],
    )
    balance_tbl.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story.append(balance_tbl)
    story.append(Spacer(1, 6))

    meta_tbl = Table(
        [
            ["Invoice Date:", _fmt_date(receipt_doc.get("confirmed_at"))],
            ["Payment Method:", str(receipt_doc.get("method") or "—").upper()],
            ["Reference:", str(receipt_doc.get("reference") or "—")],
            ["Billing Period:", _billing_period(receipt_doc)],
        ],
        colWidths=[1.3 * inch, 3.5 * inch],
        hAlign="RIGHT",
    )
    meta_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("TEXTCOLOR", (0, 0), (0, -1), _MUTED),
        ("TEXTCOLOR", (1, 0), (1, -1), _INK),
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
    ]))
    story.append(meta_tbl)
    story.append(Spacer(1, 14))

    story.append(Paragraph("Subject:", s["TTNLabel"]))
    story.append(Paragraph("Tuition Fee Payment", s["TTNBody"]))
    story.append(Spacer(1, 10))

    amount_usd = receipt_doc.get("amount_usd") or 0
    line_desc = "Tuition Fee"
    months = receipt_doc.get("months_covered")
    if months:
        line_desc += f" — {months} month{'s' if months != 1 else ''}"
    item_tbl = Table(
        [
            ["#", "Item & Description", "Qty", "Rate", "Amount"],
            ["1", line_desc, "1.00", _fmt_money(amount_usd), _fmt_money(amount_usd)],
        ],
        colWidths=[0.35 * inch, 3.55 * inch, 0.6 * inch, 1.15 * inch, 1.15 * inch],
    )
    item_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("LINEBELOW", (0, 1), (-1, 1), 0.5, _LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(item_tbl)
    story.append(Spacer(1, 8))

    totals_tbl = Table(
        [
            ["", "Sub Total", _fmt_money(amount_usd)],
            ["", "Total", _fmt_money(amount_usd)],
            ["", "Payment Made", f"(-) {_fmt_money(amount_usd)}"],
            ["", "Balance Due", "USD0.00"],
        ],
        colWidths=[3.9 * inch, 1.4 * inch, 1.5 * inch],
    )
    totals_tbl.setStyle(TableStyle([
        ("FONTNAME", (1, 0), (-1, -1), "Helvetica"),
        ("FONTNAME", (1, 3), (-1, 3), "Helvetica-Bold"),
        ("FONTSIZE", (1, 0), (-1, -1), 9.5),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("BACKGROUND", (1, 3), (-1, 3), _TOTAL_BG),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(totals_tbl)
    story.append(Spacer(1, 22))

    story.append(Paragraph("Notes", s["TTNHeading"]))
    story.append(Paragraph(template_cfg.get("notes") or "Thank you for your payment.", s["TTNSmall"]))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Terms & Conditions", s["TTNHeading"]))
    story.append(Paragraph(template_cfg.get("terms_and_conditions") or "", s["TTNSmall"]))
    story.append(Spacer(1, 30))

    story.append(Paragraph(f"Cashier: {_cashier_name(receipt_doc)}", s["TTNBody"]))

    doc.build(story)
    return buf.getvalue()


def render_receipt_png(receipt_doc: dict, template_cfg: dict, dpi: int = 200) -> bytes:
    """Renders the PDF, then rasterizes page 0 to PNG at the given DPI —
    guarantees the PNG is pixel-identical to the PDF (one layout function,
    not two parallel renderers)."""
    import fitz  # pymupdf — imported lazily so pdf-only callers never pay for it

    pdf_bytes = render_receipt_pdf(receipt_doc, template_cfg)
    with fitz.open(stream=pdf_bytes, filetype="pdf") as pdf:
        page = pdf[0]
        matrix = fitz.Matrix(dpi / 72, dpi / 72)
        pixmap = page.get_pixmap(matrix=matrix)
        return pixmap.tobytes("png")
