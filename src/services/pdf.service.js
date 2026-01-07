// PDF Service - สำหรับนับจำนวนหน้าของ PDF
import * as pdfjsLib from "pdfjs-dist"

// ตั้งค่า worker สำหรับ PDF.js
// ใช้ worker จาก public folder (Vite จะ serve จาก root)
pdfjsLib.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`
console.log("✅ PDF.js worker configured:", pdfjsLib.GlobalWorkerOptions.workerSrc)

/**
 * นับจำนวนหน้าของ PDF
 */
export async function getPdfPageCount(file) {
  try {
    console.log("📄 Counting pages for PDF:", file.name)
    const arrayBuffer = await file.arrayBuffer()
    console.log("📦 ArrayBuffer size:", arrayBuffer.byteLength, "bytes")
    
    const loadingTask = pdfjsLib.getDocument({ 
      data: arrayBuffer,
      verbosity: 0 // ลด log จาก PDF.js
    })
    
    const pdf = await loadingTask.promise
    const pageCount = pdf.numPages
    console.log("✅ PDF page count:", pageCount, "pages")
    return pageCount
  } catch (error) {
    console.error("❌ Error counting PDF pages:", error)
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack
    })
    // ถ้านับไม่ได้ ให้ return 1 เป็นค่า default
    return 1
  }
}

/**
 * ตรวจสอบว่าเป็นไฟล์ PDF หรือไม่
 */
export function isPdfFile(file) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}
