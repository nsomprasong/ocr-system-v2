// Excel Service - สร้างไฟล์ Excel จากข้อมูล OCR
import * as XLSX from "xlsx"

/**
 * สร้างไฟล์ Excel จากข้อมูล
 * @param {Array} data - ข้อมูล array of objects
 * @param {Array} columnConfig - การตั้งค่าคอลัมน์
 * @param {string} filename - ชื่อไฟล์
 */
export function createExcelFile(data, columnConfig, filename = "output.xlsx") {
  // สร้าง workbook ใหม่
  const wb = XLSX.utils.book_new()
  
  // สร้าง worksheet
  const ws = XLSX.utils.aoa_to_sheet([])
  
  // เพิ่ม header row
  const headers = columnConfig.map((col) => col.label || col.key)
  XLSX.utils.sheet_add_aoa(ws, [headers], { origin: "A1" })
  
  // เพิ่มข้อมูล
  const rows = data.map((row) => {
    return columnConfig.map((col) => {
      return row[col.key] || ""
    })
  })
  
  if (rows.length > 0) {
    XLSX.utils.sheet_add_aoa(ws, rows, { origin: "A2" })
  }
  
  // ตั้งค่าความกว้างคอลัมน์
  const colWidths = columnConfig.map((col) => ({
    wch: col.width || 20,
  }))
  ws["!cols"] = colWidths
  
  // เพิ่ม worksheet เข้า workbook
  XLSX.utils.book_append_sheet(wb, ws, "รายชื่อ")
  
  // สร้างไฟล์ Excel
  XLSX.writeFile(wb, filename)
}

/**
 * สร้างไฟล์ Excel แบบแยกไฟล์ (separate mode)
 */
export function createSeparateExcelFiles(fileData, columnConfig) {
  fileData.forEach(({ filename, data }) => {
    const baseName = filename.replace(/\.[^/.]+$/, "")
    createExcelFile(data, columnConfig, `${baseName}.xlsx`)
  })
}

/**
 * สร้างไฟล์ Excel แบบรวมไฟล์เดียว (combine mode)
 */
export function createCombinedExcelFile(allData, columnConfig, filename = "combined.xlsx") {
  // รวมข้อมูลทั้งหมด
  const combinedData = []
  allData.forEach(({ data }) => {
    combinedData.push(...data)
  })
  
  createExcelFile(combinedData, columnConfig, filename)
}
