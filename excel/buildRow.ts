import type { OCRResult } from "../core/types"
import type { Template } from "../template/template.schema"
import { extractTableData } from "../src/utils/extractTableData"

/**
 * Builds Excel rows from OCR result and template using primary column alignment.
 * 
 * Uses the column with the most rows (by Y-axis) as the PRIMARY COLUMN.
 * PRIMARY COLUMN defines ALL rows in the table.
 * Other columns fill data ONLY when token.y matches an existing primary row.y.
 * 
 * Applies fieldType formatting (PERSON_NAME, NORMAL_TEXT) using mergeGroupLines
 * to match the preview behavior.
 * 
 * @param ocrResult - OCR result with words and page dimensions
 * @param template - Template with column definitions and zones
 * @returns Array of table rows (one per primary row)
 */
export function buildRows(ocrResult: OCRResult, template: Template): Array<Record<string, string>> {
  // Use unified extractTableData function with export mode
  return extractTableData(
    ocrResult,
    template,
    {
      mode: "export",
      yTolerance: 15, // Strict tolerance for export
    }
  )
}

/**
 * Builds a single Excel row from OCR result and template.
 * 
 * DEPRECATED: This function creates only one row per file.
 * Use buildRows() instead for proper multi-row alignment.
 * 
 * @param ocrResult - OCR result with words and page dimensions
 * @param template - Template with column definitions and zones
 * @returns Plain object representing one Excel row (columnKey -> cell value)
 * @deprecated Use buildRows() instead
 */
export function buildRow(ocrResult: OCRResult, template: Template): Record<string, string> {
  // For backward compatibility, return first row from buildRows
  const rows = buildRows(ocrResult, template)
  
  if (rows.length === 0) {
    // No rows - return empty row
    const emptyRow: Record<string, string> = {}
    for (const column of template.columns) {
      emptyRow[column.columnKey] = ""
    }
    return emptyRow
  }

  // Return first row (for backward compatibility)
  return rows[0]
}
