from __future__ import annotations

import io
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import chess
from reportlab.lib import colors  # type: ignore[import-untyped]
from reportlab.lib.enums import TA_CENTER, TA_LEFT  # type: ignore[import-untyped]
from reportlab.lib.pagesizes import A4  # type: ignore[import-untyped]
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet  # type: ignore[import-untyped]
from reportlab.lib.units import mm  # type: ignore[import-untyped]
from reportlab.pdfbase import pdfmetrics  # type: ignore[import-untyped]
from reportlab.pdfbase.ttfonts import TTFont  # type: ignore[import-untyped]
from reportlab.platypus import (  # type: ignore[import-untyped]
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from chess_dossier.analysis.models import (
    AnalysisResult,
    CriticalDecision,
    ErrorTag,
    PlayerSide,
    RateMetric,
)
from chess_dossier.domain.enums import ReportLanguage

_INK = colors.HexColor("#17202A")
_MUTED = colors.HexColor("#66717D")
_PAPER = colors.HexColor("#F4F1E8")
_ACCENT = colors.HexColor("#9D3528")
_TEAL = colors.HexColor("#176B68")
_LINE = colors.HexColor("#CED4D7")
_LIGHT_SQUARE = colors.HexColor("#E8E2D3")
_DARK_SQUARE = colors.HexColor("#728B84")


class PdfReportRenderer:
    def __init__(
        self,
        *,
        regular_font: Path | None = None,
        bold_font: Path | None = None,
        brand_name: str = "Чест-досье",
    ) -> None:
        regular = regular_font or _find_font(
            (
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
                Path("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"),
            )
        )
        bold = bold_font or _find_font(
            (
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
                Path("/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
            )
        )
        if regular is None or bold is None:
            raise RuntimeError("A Unicode TrueType font is required to render the PDF report")
        self._font_name = "DossierSans"
        self._bold_name = "DossierSansBold"
        pdfmetrics.registerFont(TTFont(self._font_name, str(regular)))
        pdfmetrics.registerFont(TTFont(self._bold_name, str(bold)))
        self._brand_name = brand_name

    def render(self, result: AnalysisResult) -> bytes:
        buffer = io.BytesIO()
        document = SimpleDocTemplate(
            buffer,
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=20 * mm,
            bottomMargin=18 * mm,
            title=f"{self._brand_name}: {result.subject}",
            author=self._brand_name,
        )
        styles = self._styles()
        story: list[Any] = []
        story.extend(self._cover(result, styles))
        story.append(PageBreak())
        story.extend(self._methodology(result, styles))
        story.extend(self._metrics(result, styles))
        story.append(PageBreak())
        story.extend(self._evidence(result, styles))
        story.append(PageBreak())
        story.extend(self._training_plan(result, styles))
        story.extend(self._limitations(result, styles))
        document.build(
            story,
            onFirstPage=lambda canvas, doc: self._page(canvas, doc, result, cover=True),
            onLaterPages=lambda canvas, doc: self._page(canvas, doc, result, cover=False),
        )
        payload = buffer.getvalue()
        if not payload.startswith(b"%PDF-"):
            raise RuntimeError("ReportLab did not produce a valid PDF signature")
        return payload

    def _styles(self) -> dict[str, ParagraphStyle]:
        base = getSampleStyleSheet()
        return {
            "eyebrow": ParagraphStyle(
                "DossierEyebrow",
                parent=base["Normal"],
                fontName=self._bold_name,
                fontSize=8,
                leading=10,
                textColor=_ACCENT,
                spaceAfter=5,
                uppercase=True,
            ),
            "title": ParagraphStyle(
                "DossierTitle",
                parent=base["Title"],
                fontName=self._bold_name,
                fontSize=31,
                leading=34,
                textColor=_INK,
                alignment=TA_LEFT,
                spaceAfter=10,
            ),
            "subtitle": ParagraphStyle(
                "DossierSubtitle",
                parent=base["Normal"],
                fontName=self._font_name,
                fontSize=13,
                leading=18,
                textColor=_MUTED,
                spaceAfter=16,
            ),
            "h1": ParagraphStyle(
                "DossierH1",
                parent=base["Heading1"],
                fontName=self._bold_name,
                fontSize=18,
                leading=22,
                textColor=_INK,
                spaceBefore=8,
                spaceAfter=10,
            ),
            "h2": ParagraphStyle(
                "DossierH2",
                parent=base["Heading2"],
                fontName=self._bold_name,
                fontSize=12,
                leading=15,
                textColor=_TEAL,
                spaceBefore=7,
                spaceAfter=5,
            ),
            "body": ParagraphStyle(
                "DossierBody",
                parent=base["BodyText"],
                fontName=self._font_name,
                fontSize=9.2,
                leading=13.2,
                textColor=_INK,
                spaceAfter=7,
            ),
            "small": ParagraphStyle(
                "DossierSmall",
                parent=base["BodyText"],
                fontName=self._font_name,
                fontSize=7.5,
                leading=10.5,
                textColor=_MUTED,
            ),
            "metric": ParagraphStyle(
                "DossierMetric",
                parent=base["Normal"],
                fontName=self._bold_name,
                fontSize=19,
                leading=21,
                alignment=TA_CENTER,
                textColor=_INK,
            ),
            "metric_label": ParagraphStyle(
                "DossierMetricLabel",
                parent=base["Normal"],
                fontName=self._font_name,
                fontSize=7.5,
                leading=9,
                alignment=TA_CENTER,
                textColor=_MUTED,
            ),
            "piece": ParagraphStyle(
                "DossierPiece",
                parent=base["Normal"],
                fontName=self._font_name,
                fontSize=14,
                leading=16,
                alignment=TA_CENTER,
                textColor=_INK,
            ),
        }

    def _cover(self, result: AnalysisResult, styles: dict[str, ParagraphStyle]) -> list[Any]:
        lang_ru = result.report_language == ReportLanguage.RU
        title = "ШАХМАТНОЕ ДОСЬЕ" if lang_ru else "CHESS DOSSIER"
        subtitle = (
            "Доказательная диагностика решений и персональный тренировочный материал"
            if lang_ru
            else "Evidence-based decision diagnostics and personalized training material"
        )
        verified = len(result.critical_decisions)
        cards = Table(
            [
                [
                    Paragraph(str(len(result.games)), styles["metric"]),
                    Paragraph(str(result.decisions_analyzed), styles["metric"]),
                    Paragraph(str(verified), styles["metric"]),
                ],
                [
                    Paragraph("партий" if lang_ru else "games", styles["metric_label"]),
                    Paragraph("решений" if lang_ru else "decisions", styles["metric_label"]),
                    Paragraph(
                        "глубоких проверок" if lang_ru else "deep-confirmed",
                        styles["metric_label"],
                    ),
                ],
            ],
            colWidths=[53 * mm] * 3,
            rowHeights=[15 * mm, 9 * mm],
        )
        cards.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), _PAPER),
                    ("BOX", (0, 0), (-1, -1), 0.7, _LINE),
                    ("INNERGRID", (0, 0), (-1, -1), 0.4, _LINE),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ]
            )
        )
        meta = [
            ["ИГРОК" if lang_ru else "SUBJECT", _x(result.subject)],
            ["ДВИЖОК" if lang_ru else "ENGINE", _x(result.engine.name)],
            [
                "БЫСТРО / ГЛУБОКО" if lang_ru else "FAST / DEEP",
                f"{result.config.fast_nodes:,} / {result.config.deep_nodes:,} "
                + ("узлов" if lang_ru else "nodes"),
            ],
            ["SHA-256 КОРПУСА" if lang_ru else "CORPUS SHA-256", result.source_sha256[:20] + "..."],
            [
                "СФОРМИРОВАНО" if lang_ru else "GENERATED",
                _x(result.generated_at[:19].replace("T", " ")) + " UTC",
            ],
        ]
        meta_table = Table(meta, colWidths=[40 * mm, 118 * mm], rowHeights=8 * mm)
        meta_table.setStyle(
            TableStyle(
                [
                    ("FONTNAME", (0, 0), (0, -1), self._bold_name),
                    ("FONTNAME", (1, 0), (1, -1), self._font_name),
                    ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                    ("TEXTCOLOR", (0, 0), (0, -1), _ACCENT),
                    ("TEXTCOLOR", (1, 0), (1, -1), _INK),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.35, _LINE),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ]
            )
        )
        return [
            Spacer(1, 18 * mm),
            Paragraph(_x(self._brand_name.upper()), styles["eyebrow"]),
            Paragraph(title, styles["title"]),
            Paragraph(subtitle, styles["subtitle"]),
            Spacer(1, 5 * mm),
            cards,
            Spacer(1, 18 * mm),
            meta_table,
            Spacer(1, 10 * mm),
            Paragraph(
                (
                    "Оценка всегда дана с точки зрения исследуемого игрока. "
                    "Положительное число хорошо для него за оба цвета."
                    if lang_ru
                    else "Every score is shown from the subject's point of view. "
                    "A positive value favors the subject with either color."
                ),
                styles["small"],
            ),
        ]

    def _methodology(self, result: AnalysisResult, styles: dict[str, ParagraphStyle]) -> list[Any]:
        ru = result.report_language == ReportLanguage.RU
        blocks = [
            (
                "1. Корпус и знаменатель" if ru else "1. Corpus and denominator",
                (
                    f"Проанализировано {len(result.games)} уникальных партий и "
                    f"{result.decisions_analyzed} ходов игрока. Ходы соперника в знаменатель "
                    "ошибок не входят. Дубликаты удалены до запуска движка."
                    if ru
                    else f"The corpus contains {len(result.games)} unique games and "
                    f"{result.decisions_analyzed} subject decisions. Opponent moves are excluded "
                    "from error denominators. Duplicates were removed before engine analysis."
                ),
            ),
            (
                "2. Двухпроходная проверка" if ru else "2. Two-pass verification",
                (
                    f"Быстрый проход: {result.config.fast_nodes:,} узлов на каждое решение. "
                    f"Глубокий проход: {result.config.deep_nodes:,} узлов; каждый независимый "
                    "поиск начинается с очищенного hash. Проверяется "
                    f"не более {result.config.max_critical_positions} кандидатов. MultiPV равен 1."
                    if ru
                    else f"Fast pass: {result.config.fast_nodes:,} nodes for every decision. "
                    f"Deep pass: {result.config.deep_nodes:,} nodes with a cleared hash for every "
                    f"independent search and up to {result.config.max_critical_positions} "
                    "candidates. MultiPV remains 1."
                ),
            ),
            (
                "3. Граница вывода" if ru else "3. Inference boundary",
                (
                    "Отчет измеряет позиции и решения. Формулировки о внимании, страхе, импульсе "
                    "или намерении являются только тренерскими гипотезами и требуют разговора с "
                    "игроком до просмотра движка."
                    if ru
                    else "The report measures positions and decisions. Claims about attention, "
                    "fear, impulse or intent are coaching hypotheses that require a pre-engine "
                    "conversation with the player."
                ),
            ),
        ]
        output: list[Any] = [
            Paragraph("МЕТОДИКА" if ru else "METHOD", styles["eyebrow"]),
            Paragraph("Как читать цифры" if ru else "How to read the numbers", styles["h1"]),
        ]
        for heading, text in blocks:
            output.append(Paragraph(heading, styles["h2"]))
            output.append(Paragraph(_x(text), styles["body"]))
        if result.warnings:
            warning_text = "<br/>".join(f"- {_x(item)}" for item in result.warnings[:8])
            output.extend(
                [
                    Paragraph("Замечания к корпусу" if ru else "Corpus warnings", styles["h2"]),
                    Paragraph(warning_text, styles["small"]),
                ]
            )
        return output

    def _metrics(self, result: AnalysisResult, styles: dict[str, ParagraphStyle]) -> list[Any]:
        ru = result.report_language == ReportLanguage.RU
        phase_rows: list[list[Any]] = [
            [
                "Фаза" if ru else "Phase",
                "Ошибки" if ru else "Errors",
                "Решения" if ru else "Decisions",
                "Частота" if ru else "Rate",
            ]
        ]
        for phase_metric in result.phase_metrics:
            phase_rows.append(
                [
                    _cell(_phase_label(phase_metric.key, ru), styles),
                    phase_metric.numerator,
                    phase_metric.denominator,
                    f"{phase_metric.percentage:.1f}%",
                ]
            )
        threshold_rows: list[list[Any]] = [
            [
                "Порог" if ru else "Threshold",
                "Достигнут" if ru else "Reached",
                "Ниже +0.5" if ru else "Below +0.5",
                "В минус" if ru else "Negative",
                "Не выигран" if ru else "Not won",
            ]
        ]
        for threshold_metric in result.threshold_metrics:
            threshold_rows.append(
                [
                    f"+{threshold_metric.threshold_cp / 100:.0f}",
                    threshold_metric.reached_games,
                    _fraction(threshold_metric.fell_below_floor, threshold_metric.reached_games),
                    _fraction(threshold_metric.turned_negative, threshold_metric.reached_games),
                    _fraction(threshold_metric.not_won, threshold_metric.reached_games),
                ]
            )
        tag_rows: list[list[Any]] = [
            [
                "Главный тег" if ru else "Primary tag",
                "Позиций" if ru else "Positions",
                "Доля" if ru else "Share",
            ]
        ]
        for tag_metric in result.tag_metrics:
            if tag_metric.numerator:
                tag_rows.append(
                    [
                        _cell(_tag_label(tag_metric.key, ru), styles),
                        tag_metric.numerator,
                        f"{tag_metric.percentage:.1f}%",
                    ]
                )
        output: list[Any] = [
            Spacer(1, 5 * mm),
            Paragraph("КОРПУСНЫЕ МЕТРИКИ" if ru else "CORPUS METRICS", styles["eyebrow"]),
            Paragraph("Где ломается качество" if ru else "Where quality breaks", styles["h1"]),
            Paragraph("По фазам", styles["h2"]),
            _styled_table(phase_rows, [60 * mm, 28 * mm, 32 * mm, 36 * mm], self),
            Spacer(1, 5 * mm),
            Paragraph("Конверсия преимущества" if ru else "Advantage conversion", styles["h2"]),
            _styled_table(threshold_rows, [28 * mm, 32 * mm, 34 * mm, 30 * mm, 34 * mm], self),
            Spacer(1, 5 * mm),
            Paragraph(
                "Типы подтвержденных ошибок" if ru else "Confirmed error types", styles["h2"]
            ),
            _styled_table(tag_rows, [90 * mm, 32 * mm, 36 * mm], self),
        ]
        return output

    def _evidence(self, result: AnalysisResult, styles: dict[str, ParagraphStyle]) -> list[Any]:
        ru = result.report_language == ReportLanguage.RU
        output: list[Any] = [
            Paragraph("ДОКАЗАТЕЛЬНЫЕ ПОЗИЦИИ" if ru else "EVIDENCE POSITIONS", styles["eyebrow"]),
            Paragraph("Критические решения" if ru else "Critical decisions", styles["h1"]),
        ]
        if not result.critical_decisions:
            output.append(
                Paragraph(
                    (
                        "По заданным порогам подтвержденных крупных ошибок не найдено. Это не "
                        "доказывает безошибочность, а лишь честно сообщает результат фильтра."
                        if ru
                        else "No large errors were confirmed at the configured thresholds. This "
                        "does not prove perfect play; it only reports the filter result."
                    ),
                    styles["body"],
                )
            )
            return output
        for index, item in enumerate(result.critical_decisions[:8], 1):
            output.append(self._evidence_card(result, item, index, styles))
            output.append(Spacer(1, 5 * mm))
        return output

    def _evidence_card(
        self,
        result: AnalysisResult,
        item: CriticalDecision,
        index: int,
        styles: dict[str, ParagraphStyle],
    ) -> KeepTogether:
        ru = result.report_language == ReportLanguage.RU
        heading = (
            f"{index}. {item.game_key} - ход {item.move_number} - {_tag_label(item.tag.value, ru)}"
            if ru
            else f"{index}. {item.game_key} - move {item.move_number} - {_tag_label(item.tag.value, ru)}"
        )
        details = [
            [
                _cell("Сторона" if ru else "Side", styles, bold=True),
                _cell(_side_label(item.side, ru), styles),
            ],
            [
                _cell("Сыграно" if ru else "Played", styles, bold=True),
                _cell(item.played_san, styles),
            ],
            [
                _cell("Надежнее" if ru else "Best", styles, bold=True),
                _cell(item.best_san, styles),
            ],
            [
                _cell("Глубоко до / после" if ru else "Deep before / after", styles, bold=True),
                _cell(f"{_eval(item.deep_best)} / {_eval(item.deep_played)}", styles),
            ],
            [
                _cell("Потеря" if ru else "Loss", styles, bold=True),
                _cell(_loss_label(item, ru), styles),
            ],
            [
                _cell("Источник" if ru else "Source", styles, bold=True),
                _cell(item.site, styles),
            ],
            [
                _cell("Evidence ID", styles, bold=True),
                _cell(item.evidence_id, styles),
            ],
        ]
        detail_table = Table(details, colWidths=[35 * mm, 62 * mm])
        detail_table.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.3, _LINE),
                    ("BACKGROUND", (0, 0), (0, -1), _PAPER),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        board = _board_table(item.fen_before, item.side, styles)
        content = Table([[board, detail_table]], colWidths=[58 * mm, 100 * mm])
        content.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
        return KeepTogether([Paragraph(_x(heading), styles["h2"]), content])

    def _training_plan(
        self, result: AnalysisResult, styles: dict[str, ParagraphStyle]
    ) -> list[Any]:
        ru = result.report_language == ReportLanguage.RU
        dominant = _dominant_tags(result.tag_metrics)
        focus = [_tag_label(item, ru) for item in dominant]
        while len(focus) < 2:
            focus.append("конверсия" if ru else "conversion")
        rows: list[list[Any]] = [
            [
                "День" if ru else "Day",
                "Фокус" if ru else "Focus",
                "Работа" if ru else "Work",
            ]
        ]
        plan = _plan_rows(focus, ru)
        for day, topic, work in plan:
            rows.append([day, _cell(topic, styles), _cell(work, styles)])
        return [
            Paragraph("ПЛАН НА 14 ДНЕЙ" if ru else "14-DAY PLAN", styles["eyebrow"]),
            Paragraph("Перенос в практику" if ru else "Transfer into practice", styles["h1"]),
            Paragraph(
                (
                    "Первые три позиции каждой сессии решаются повторно без подсказки. Перед "
                    "движком игрок отмечает три момента: не понял угрозу, выбрал ход по желанию, "
                    "перестал считать. Один эпизод получает один главный тег."
                    if ru
                    else "Start every session by solving three previous positions without hints. "
                    "Before engine review, mark three moments: missed threat, desire-based move, "
                    "and stopped calculation. Each episode receives one primary tag."
                ),
                styles["body"],
            ),
            _styled_table(rows, [15 * mm, 48 * mm, 95 * mm], self),
            Spacer(1, 6 * mm),
        ]

    def _limitations(self, result: AnalysisResult, styles: dict[str, ParagraphStyle]) -> list[Any]:
        ru = result.report_language == ReportLanguage.RU
        return [
            Paragraph("ОГРАНИЧЕНИЯ" if ru else "LIMITATIONS", styles["eyebrow"]),
            Paragraph(
                "Что этот отчет не доказывает" if ru else "What this report does not prove",
                styles["h1"],
            ),
            Paragraph(
                (
                    "PGN не содержит полного мыслительного процесса и сам по себе не доказывает "
                    "использование подсказок. Оценка движка зависит от версии, позиции, бюджета "
                    "поиска и настроек. Корпусные проценты описывают только предоставленную выборку. "
                    "Ручная проверка экспертом обязательна до выдачи клиенту."
                    if ru
                    else "A PGN does not contain the full thought process and cannot by itself "
                    "prove outside assistance. Engine scores depend on version, position, search "
                    "budget and settings. Corpus rates describe only the supplied sample. Human "
                    "review is mandatory before delivery."
                ),
                styles["body"],
            ),
        ]

    def _page(self, canvas: Any, doc: Any, result: AnalysisResult, *, cover: bool) -> None:
        canvas.saveState()
        width, height = A4
        canvas.setFillColor(_INK)
        canvas.rect(0, height - 7 * mm, width, 7 * mm, fill=1, stroke=0)
        if not cover:
            canvas.setFont(self._font_name, 7)
            canvas.setFillColor(_MUTED)
            canvas.drawString(18 * mm, 10 * mm, self._brand_name.upper())
            canvas.drawRightString(
                width - 18 * mm,
                10 * mm,
                f"{result.subject}  |  {doc.page}",
            )
            canvas.setStrokeColor(_LINE)
            canvas.line(18 * mm, 13 * mm, width - 18 * mm, 13 * mm)
        canvas.restoreState()


def _find_font(candidates: Iterable[Path]) -> Path | None:
    return next((path for path in candidates if path.is_file()), None)


def _x(value: object) -> str:
    return escape(str(value))


def _cell(value: object, styles: dict[str, ParagraphStyle], *, bold: bool = False) -> Paragraph:
    style = styles["small"]
    if bold:
        style = ParagraphStyle(
            f"{style.name}Bold",
            parent=style,
            fontName="DossierSansBold",
            textColor=_INK,
        )
    return Paragraph(_x(value), style)


def _styled_table(rows: list[list[Any]], widths: list[float], renderer: PdfReportRenderer) -> Table:
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), _INK),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), renderer._bold_name),
                ("FONTNAME", (0, 1), (-1, -1), renderer._font_name),
                ("FONTSIZE", (0, 0), (-1, -1), 7.5),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _PAPER]),
                ("GRID", (0, 0), (-1, -1), 0.35, _LINE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return table


def _board_table(fen: str, side: PlayerSide, styles: dict[str, ParagraphStyle]) -> Table:
    board = chess.Board(fen)
    ranks = list(range(7, -1, -1)) if side == PlayerSide.WHITE else list(range(8))
    files = list(range(8)) if side == PlayerSide.WHITE else list(range(7, -1, -1))
    symbols = {
        "K": "♔",
        "Q": "♕",
        "R": "♖",
        "B": "♗",
        "N": "♘",
        "P": "♙",
        "k": "♚",
        "q": "♛",
        "r": "♜",
        "b": "♝",
        "n": "♞",
        "p": "♟",
    }
    data: list[list[Paragraph]] = []
    commands: list[tuple[Any, ...]] = [
        ("GRID", (0, 0), (-1, -1), 0.2, colors.HexColor("#52625E")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]
    for row_index, rank in enumerate(ranks):
        row: list[Paragraph] = []
        for column_index, file_index in enumerate(files):
            piece = board.piece_at(chess.square(file_index, rank))
            row.append(Paragraph(symbols.get(piece.symbol(), "") if piece else "", styles["piece"]))
            square_color = _LIGHT_SQUARE if (file_index + rank) % 2 else _DARK_SQUARE
            commands.append(
                ("BACKGROUND", (column_index, row_index), (column_index, row_index), square_color)
            )
        data.append(row)
    table = Table(data, colWidths=[7 * mm] * 8, rowHeights=[7 * mm] * 8)
    table.setStyle(TableStyle(commands))
    return table


def _fraction(value: int, denominator: int) -> str:
    percentage = 0.0 if denominator == 0 else value * 100 / denominator
    return f"{value}/{denominator} ({percentage:.1f}%)"


def _eval(value: object) -> str:
    from chess_dossier.analysis.models import EngineEvaluation

    if not isinstance(value, EngineEvaluation):
        raise TypeError("Invalid engine evaluation")
    if value.mate_in is not None:
        return f"M{value.mate_in:+d}"
    return f"{value.score_cp / 100:+.2f}"


def _loss_label(item: CriticalDecision, ru: bool) -> str:
    if item.deep_best.mate_in is not None or item.deep_played.mate_in is not None:
        return "изменение матового статуса" if ru else "mate status changed"
    suffix = " пешки" if ru else " pawns"
    return f"{item.loss_cp / 100:.2f}{suffix}"


def _side_label(side: PlayerSide, ru: bool) -> str:
    if not ru:
        return side.value
    return "белые" if side == PlayerSide.WHITE else "черные"


def _tag_label(value: str, ru: bool) -> str:
    labels = {
        ErrorTag.STALEMATE.value: ("пат", "stalemate"),
        ErrorTag.MATE.value: ("мат", "mate"),
        ErrorTag.QUEEN_PIECE.value: ("ферзь/фигура", "queen/piece"),
        ErrorTag.CONVERSION.value: ("конверсия", "conversion"),
        ErrorTag.CHECK_TEMPO.value: ("шах с темпом", "check with tempo"),
        ErrorTag.OTHER.value: ("другая крупная ошибка", "other major error"),
    }
    pair = labels.get(value, (value, value))
    return pair[0] if ru else pair[1]


def _phase_label(value: str, ru: bool) -> str:
    labels = {
        "opening": ("ходы 1-10", "moves 1-10"),
        "middlegame": ("ходы 11-25", "moves 11-25"),
        "late": ("после 25-го", "after move 25"),
    }
    pair = labels.get(value, (value, value))
    return pair[0] if ru else pair[1]


def _dominant_tags(metrics: tuple[RateMetric, ...]) -> list[str]:
    return [
        item.key
        for item in sorted(metrics, key=lambda metric: metric.numerator, reverse=True)
        if item.numerator > 0
    ][:2]


def _plan_rows(focus: list[str], ru: bool) -> list[tuple[str, str, str]]:
    if ru:
        return [
            (
                "1",
                "Исходная диагностика",
                "Решить 8 ошибок без подсказки; письменно назвать угрозу.",
            ),
            ("2", focus[0], "12 позиций из errors-пака; перед ходом перечислить шахи и взятия."),
            ("3", "Конверсия", "3 позиции из conversion-пака до победы против бота."),
            ("4", focus[1], "10 позиций; один главный тег после каждого решения."),
            (
                "5",
                "Перенос",
                "2 партии 5+3; максимум, затем самостоятельная отметка трех моментов.",
            ),
            ("6", "Повтор", "Повторить 6 ошибок дней 1-4 без просмотра ответа."),
            ("7", "Контрольный срез", "4 позиции + 2 партии; записать знаменатель и число срывов."),
            ("8", focus[0], "Новый блок 12 позиций; обязательный лучший ответ соперника."),
            ("9", "Конверсия +2/+3", "4 выигранные позиции; запрет на ход без плана упрощения."),
            ("10", focus[1], "10 позиций на точность форсирующей линии."),
            ("11", "Перенос", "2 партии 5+3; после паузы заново сформулировать угрозу."),
            ("12", "Смешанный тест", "12 позиций без названий тегов и без подсказок."),
            ("13", "Повтор ошибок", "Вернуться ко всем нерешенным позициям; не добавлять новые."),
            ("14", "Итоговый срез", "Сравнить ошибки на 100 решений, а не настроение и рейтинг."),
        ]
    return [
        ("1", "Baseline", "Solve 8 errors without hints; write down the opponent threat."),
        ("2", focus[0], "12 error-pack positions; list checks and captures before moving."),
        ("3", "Conversion", "Convert 3 positions from the conversion pack against a bot."),
        ("4", focus[1], "10 positions; assign one primary tag after each decision."),
        ("5", "Transfer", "Play at most two 5+3 games, then mark three uncertain moments."),
        ("6", "Repeat", "Repeat 6 errors from days 1-4 without seeing the answer."),
        ("7", "Checkpoint", "4 positions plus 2 games; record denominator and failures."),
        ("8", focus[0], "12 new positions; name the opponent's best reply before moving."),
        ("9", "Conversion +2/+3", "4 winning positions; state the simplification plan."),
        ("10", focus[1], "10 positions focused on forcing-line accuracy."),
        ("11", "Transfer", "Two 5+3 games; restate the threat after every long pause."),
        ("12", "Mixed test", "12 unlabeled positions without hints."),
        ("13", "Error repeat", "Return to every failed position; add no new material."),
        ("14", "Final checkpoint", "Compare errors per 100 decisions, not mood or rating."),
    ]
