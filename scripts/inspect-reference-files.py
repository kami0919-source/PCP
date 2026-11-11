import json
import sys
from pathlib import Path

from docx import Document
from openpyxl import load_workbook
from pptx import Presentation


def compact(value):
    if value is None:
        return None
    return str(value).strip()


def inspect_xlsx(path):
    workbook = load_workbook(path, data_only=False)
    sheets = []
    for sheet in workbook.worksheets:
        rows = []
        for row in sheet.iter_rows():
            values = [compact(cell.value) for cell in row]
            if any(value not in (None, "") for value in values):
                rows.append({"row": row[0].row, "values": values})
        styled = []
        for row in sheet.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                styled.append({
                    "cell": cell.coordinate,
                    "value": compact(cell.value),
                    "fill": cell.fill.fgColor.rgb or cell.fill.fgColor.indexed,
                    "bold": bool(cell.font.bold),
                    "fontSize": cell.font.sz,
                    "horizontal": cell.alignment.horizontal,
                    "vertical": cell.alignment.vertical,
                    "wrap": bool(cell.alignment.wrap_text),
                })
        sheets.append({
            "name": sheet.title,
            "dimensions": sheet.dimensions,
            "mergedCells": [str(item) for item in sheet.merged_cells.ranges],
            "freezePanes": str(sheet.freeze_panes or ""),
            "columnWidths": {key: value.width for key, value in sheet.column_dimensions.items() if value.width},
            "rows": rows,
            "styledCells": styled,
        })
    return {"type": "xlsx", "sheets": sheets}


def inspect_pptx(path):
    presentation = Presentation(path)
    slides = []
    for index, slide in enumerate(presentation.slides, 1):
        shapes = []
        for shape in slide.shapes:
            text = compact(getattr(shape, "text", ""))
            if text or getattr(shape, "has_table", False):
                item = {
                    "name": shape.name,
                    "type": str(shape.shape_type),
                    "left": round(shape.left / 914400, 2),
                    "top": round(shape.top / 914400, 2),
                    "width": round(shape.width / 914400, 2),
                    "height": round(shape.height / 914400, 2),
                }
                if text:
                    item["text"] = text
                if getattr(shape, "has_table", False):
                    item["table"] = [[compact(cell.text) for cell in row.cells] for row in shape.table.rows]
                shapes.append(item)
        slides.append({"slide": index, "shapes": shapes})
    return {
        "type": "pptx",
        "slideCount": len(presentation.slides),
        "sizeInches": [round(presentation.slide_width / 914400, 2), round(presentation.slide_height / 914400, 2)],
        "slides": slides,
    }


def inspect_docx(path):
    document = Document(path)
    paragraphs = []
    for index, paragraph in enumerate(document.paragraphs, 1):
        text = compact(paragraph.text)
        if text:
            paragraphs.append({"index": index, "style": paragraph.style.name if paragraph.style else "", "text": text})
    tables = []
    for index, table in enumerate(document.tables, 1):
        tables.append({
            "table": index,
            "rows": [[compact(cell.text) for cell in row.cells] for row in table.rows],
        })
    return {"type": "docx", "paragraphs": paragraphs, "tables": tables}


def main():
    output = {}
    for raw_path in sys.argv[1:]:
        path = Path(raw_path)
        suffix = path.suffix.lower()
        if suffix == ".xlsx":
            data = inspect_xlsx(path)
        elif suffix == ".pptx":
            data = inspect_pptx(path)
        elif suffix == ".docx":
            data = inspect_docx(path)
        else:
            continue
        output[str(path)] = data
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
