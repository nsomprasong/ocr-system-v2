import { useState, useEffect } from "react"
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Stack,
  Chip,
  Alert,
  IconButton,
  CircularProgress,
  Grid,
  AppBar,
  Toolbar,
  RadioGroup,
  FormControlLabel,
  Radio,
  TextField,
  LinearProgress,
  Divider,
} from "@mui/material"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import CloseIcon from "@mui/icons-material/Close"
import DescriptionIcon from "@mui/icons-material/Description"
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf"
import ImageIcon from "@mui/icons-material/Image"
import PlayArrowIcon from "@mui/icons-material/PlayArrow"
import { getPdfPageCount, isPdfFile } from "../services/pdf.service"
import { auth } from "../firebase"
import { updateUserCredits, getUserProfile } from "../services/user.service"
// Removed: import { ocrFile } from "../services/ocr.service" - not used, using runOCR (v2) instead
import { extractDataFromText } from "../services/textProcessor.service"
import {
  createSeparateExcelFiles,
  createCombinedExcelFile,
} from "../services/excel.service"
import { runOCR } from "../utils/runOCR"
import { loadTemplates, loadTemplate } from "../../template/loadTemplate"
import { Select, MenuItem, FormControl, InputLabel } from "@mui/material"
import { buildRows } from "../../excel/buildRow"

// Batch Scan Configuration
const BATCH_SIZE = 10 // Number of pages per batch

/**
 * Parse page range string to array of page numbers
 * Examples:
 * - "1" → [1]
 * - "1-5" → [1,2,3,4,5]
 * - "1,3,5" → [1,3,5]
 * - "1,2-6,20-22" → [1,2,3,4,5,6,20,21,22]
 * @param {string} pageRange - Page range string
 * @param {number} totalPages - Total pages in PDF (for validation)
 * @returns {number[]|null} Array of page numbers or null for all pages
 */
function parsePageRange(pageRange, totalPages) {
  if (!pageRange || pageRange.trim() === "" || pageRange.trim().toLowerCase() === "all") {
    return null // null means all pages
  }

  const pages = new Set()
  const parts = pageRange.split(",").map(p => p.trim()).filter(p => p.length > 0)

  for (const part of parts) {
    if (part.includes("-")) {
      // Range: "1-5"
      const [start, end] = part.split("-").map(s => parseInt(s.trim(), 10))
      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range: "${part}"`)
      }
      if (totalPages && end > totalPages) {
        throw new Error(`Page ${end} exceeds total pages (${totalPages})`)
      }
      for (let i = start; i <= end; i++) {
        pages.add(i)
      }
    } else {
      // Single page: "1"
      const pageNum = parseInt(part, 10)
      if (isNaN(pageNum) || pageNum < 1) {
        throw new Error(`Invalid page number: "${part}"`)
      }
      if (totalPages && pageNum > totalPages) {
        throw new Error(`Page ${pageNum} exceeds total pages (${totalPages})`)
      }
      pages.add(pageNum)
    }
  }

  const sortedPages = Array.from(pages).sort((a, b) => a - b)
  return sortedPages.length > 0 ? sortedPages : null
}

/**
 * Calculate pages to scan based on user input
 * @param {string} pageRange - Page range string (e.g. "1,2-6,20-22")
 * @param {string} startPage - Start page number (string from input)
 * @param {string} endPage - End page number (string from input)
 * @param {number} totalPages - Total pages in PDF
 * @returns {number[]|null} Array of page numbers to scan, or null for all pages
 */
function calculatePagesToScan(pageRange, startPage, endPage, totalPages) {
  console.log(`🔍 [calculatePagesToScan] Input: pageRange="${pageRange}", startPage="${startPage}", endPage="${endPage}", totalPages=${totalPages}`)
  
  // Priority 1: startPage/endPage
  if (startPage || endPage) {
    const start = startPage ? parseInt(startPage, 10) : 1
    const end = endPage ? parseInt(endPage, 10) : totalPages
    console.log(`🔍 [calculatePagesToScan] Using startPage/endPage: start=${start}, end=${end}`)
    if (!isNaN(start) && !isNaN(end) && start >= 1 && end >= start && end <= totalPages) {
      const result = Array.from({ length: end - start + 1 }, (_, i) => start + i)
      console.log(`✅ [calculatePagesToScan] Result from startPage/endPage: [${result.join(', ')}]`)
      return result
    } else {
      console.log(`⚠️ [calculatePagesToScan] Invalid startPage/endPage, falling back to pageRange`)
    }
  }
  
  // Priority 2: pageRange string
  if (pageRange && pageRange.trim() !== "") {
    try {
      const result = parsePageRange(pageRange, totalPages)
      console.log(`✅ [calculatePagesToScan] Result from pageRange: ${result ? `[${result.join(', ')}]` : 'null (all pages)'}`)
      return result
    } catch (err) {
      console.error("❌ [calculatePagesToScan] Error parsing pageRange:", err)
      return null // Fallback to all pages
    }
  }
  
  // Default: all pages
  console.log(`📄 [calculatePagesToScan] No page range specified, returning null (all pages)`)
  return null
}

/**
 * Scan File State Structure
 * @typedef {Object} ScanFileState
 * @property {File} file
 * @property {string} originalName
 * @property {number} totalPages
 * @property {number[]|null} pagesToScan - Pages to scan (null = all pages)
 * @property {Set<number>} receivedPages
 * @property {Record<number, any>} pageResults - pageNumber -> OCRResult
 * @property {"pending" | "scanning" | "done" | "error"} status
 * @property {string} [error]
 */

export default function Scan({ credits, files, setFiles, onNext, columnConfig, onConsume }) {
  const [loadingFiles, setLoadingFiles] = useState(new Set())
  const [mode, setMode] = useState("separate")
  const [fileType, setFileType] = useState("xlsx")
  const [status, setStatus] = useState("idle")
  const [progress, setProgress] = useState(0)
  const [currentFile, setCurrentFile] = useState("")
  const [error, setError] = useState("")
  const [templateModeEnabled, setTemplateModeEnabled] = useState(false)
  const [ocrResults, setOcrResults] = useState([])
  const [templates, setTemplates] = useState([])
  const [selectedTemplateId, setSelectedTemplateId] = useState(() => {
    // โหลดค่า default จาก localStorage
    const saved = localStorage.getItem("scan_selected_template_id")
    return saved || null
  })
  const [selectedTemplateConfig, setSelectedTemplateConfig] = useState(null)
  const [selectedTemplate, setSelectedTemplate] = useState(null) // เก็บ template object เต็มๆ เพื่อใช้ zones
  const [pageRange, setPageRange] = useState("") // Page range string like "1,2-6,20-22"
  const [startPage, setStartPage] = useState("") // Start page number (1-based)
  const [endPage, setEndPage] = useState("") // End page number (1-based)
  
  // Batch Scan State
  const [scanQueue, setScanQueue] = useState([]) // Array of ScanFileState objects
  const [currentFileIndex, setCurrentFileIndex] = useState(0)
  const [currentBatch, setCurrentBatch] = useState({ start: 0, end: 0 })
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 })
  const [isScanning, setIsScanning] = useState(false) // Track if scanning is in progress

  const handleSelect = async (fileList) => {
    try {
      setLoadingFiles(new Set(Array.from(fileList).map((f) => f.name)))
      
      const selected = await Promise.all(
        Array.from(fileList).map(async (f) => {
          let pageCount = 1
          
          // ถ้าเป็น PDF ให้นับจำนวนหน้าจริง
          if (isPdfFile(f)) {
            try {
              console.log("🔍 Processing PDF file:", f.name)
              pageCount = await getPdfPageCount(f)
              console.log("📊 Page count result:", pageCount)
            } catch (error) {
              console.error("❌ Error counting PDF pages:", error)
              pageCount = 1
            }
          } else {
            // สำหรับไฟล์รูปภาพ ให้เป็น 1 หน้า
            pageCount = 1
          }
          
          return {
            file: f,
            originalName: f.name,
            pageCount,
          }
        })
      )
      
      setFiles((prev) => [...prev, ...selected])
      setLoadingFiles(new Set())
      
      // If scanning is in progress, add new files to queue
      if (isScanning && scanQueue.length > 0) {
        const newFileStates = selected.map(fileItem => ({
          file: fileItem.file,
          originalName: fileItem.originalName,
          totalPages: fileItem.pageCount,
          receivedPages: new Set(),
          pageResults: {},
          status: "pending",
        }))
        
        setScanQueue((prev) => [...prev, ...newFileStates])
        console.log(`📎 [BatchScan] Added ${newFileStates.length} new file(s) to queue during scan`)
      }
    } catch (error) {
      console.error("❌ Error in handleSelect:", error)
      setError(`เกิดข้อผิดพลาดในการเลือกไฟล์: ${error.message}`)
      setLoadingFiles(new Set())
    }
  }

  const removeFile = (index) => {
    const fileToRemove = files[index]
    setFiles((prev) => prev.filter((_, i) => i !== index))
    
    // If scanning is in progress, also remove from queue
    if (isScanning && fileToRemove) {
      setScanQueue((prev) => prev.filter((fileState) => fileState.file !== fileToRemove.file))
      console.log(`🗑️ [BatchScan] Removed file from queue: ${fileToRemove.originalName}`)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    handleSelect(e.dataTransfer.files)
  }

  // Check if template mode is enabled and load templates
  useEffect(() => {
    let isMounted = true
    const user = auth.currentUser
    if (user) {
      // Load profile with timeout
      Promise.race([
        getUserProfile(user.uid),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ])
        .then((profile) => {
          if (isMounted && profile) {
            setTemplateModeEnabled(profile?.enableTemplateMode === true)
          }
        })
        .catch(() => {
          if (isMounted) {
            setTemplateModeEnabled(false)
          }
        })
      
      // Load templates with timeout and error handling
      Promise.race([
        loadTemplates(user.uid),
        new Promise((resolve) => setTimeout(() => resolve([]), 5000))
      ])
        .then((templatesList) => {
          if (isMounted) {
            setTemplates(templatesList || [])
            
            // ถ้ามีเทมเพลตและยังไม่ได้เลือก ให้เลือกตัวแรก
            if (templatesList && templatesList.length > 0) {
              const savedTemplateId = localStorage.getItem("scan_selected_template_id")
              if (savedTemplateId && templatesList.find(t => t.templateId === savedTemplateId)) {
                // ใช้ค่า saved
                setSelectedTemplateId(savedTemplateId)
              } else {
                // เลือกตัวแรกเป็น default
                const firstTemplateId = templatesList[0].templateId
                setSelectedTemplateId(firstTemplateId)
                localStorage.setItem("scan_selected_template_id", firstTemplateId)
              }
            }
          }
        })
        .catch((err) => {
          console.error("Failed to load templates:", err)
          if (isMounted) {
            setTemplates([])
          }
        })
    }
    
    return () => {
      isMounted = false
    }
  }, [])

  // Load template config when selected
  useEffect(() => {
    let isMounted = true
    const user = auth.currentUser
    if (selectedTemplateId && user) {
      Promise.race([
        loadTemplate(user.uid, selectedTemplateId),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000))
      ])
        .then((template) => {
          if (isMounted) {
            if (template) {
              try {
                // เก็บ template object เต็มๆ เพื่อใช้ zones
                setSelectedTemplate(template)
                
                // แปลง template columns เป็น columnConfig format สำหรับ Excel export
                // columnConfig format: { key, label, mode, manualValue, width }
                const columnConfig = template.columns.map((col, index) => ({
                  key: col.columnKey || `col_${index}`,
                  label: col.label || col.columnName || `Column ${index + 1}`,
                  mode: col.defaultValue ? "manual" : "auto",
                  manualValue: col.defaultValue || "",
                  width: 20, // default width
                }))
                setSelectedTemplateConfig(columnConfig)
                console.log(`✅ Template config loaded for export: ${columnConfig.length} columns`)
                console.log(`📋 Template columns:`, columnConfig.map(c => `${c.label} (${c.key})`).join(", "))
              } catch (err) {
                console.error("Failed to convert template to columnConfig:", err)
                setSelectedTemplateConfig(null)
                setSelectedTemplate(null)
              }
            } else {
              setSelectedTemplateConfig(null)
              setSelectedTemplate(null)
            }
          }
        })
        .catch((err) => {
          console.error("Failed to load template:", err)
          if (isMounted) {
            setSelectedTemplateConfig(null)
            setSelectedTemplate(null)
          }
        })
    } else {
      setSelectedTemplateConfig(null)
      setSelectedTemplate(null)
    }
    
    return () => {
      isMounted = false
    }
  }, [selectedTemplateId])

  const totalPages = files.reduce((s, f) => s + f.pageCount, 0)
  const creditEnough = credits >= totalPages

  /**
   * Scan a single file using batch processing (perPage mode)
   * Processes pages in batches of BATCH_SIZE
   * @param {ScanFileState} fileState
   * @param {Array} queue - Array of ScanFileState objects (for progress calculation)
   */
  const scanSingleFile = async (fileState, queue) => {
    fileState.status = "scanning"
    setCurrentFile(fileState.originalName)
    
    // Determine which pages to scan
    const pagesToScan = fileState.pagesToScan || Array.from({ length: fileState.totalPages }, (_, i) => i + 1)
    const actualTotalPages = pagesToScan.length
    
    console.log(`📄 [BatchScan] Starting scan for: ${fileState.originalName}`)
    console.log(`📄 [BatchScan] fileState.pagesToScan:`, fileState.pagesToScan)
    console.log(`📄 [BatchScan] Calculated pagesToScan:`, pagesToScan)
    console.log(`📄 [BatchScan] Total pages in file: ${fileState.totalPages}, Pages to scan: ${pagesToScan.length} (${pagesToScan.length === fileState.totalPages ? 'all' : pagesToScan.join(', ')})`)
    
    const user = auth.currentUser
    if (!user) {
      throw new Error("User not authenticated")
    }
    
    // Process pages in batches (only scan pages in pagesToScan)
    for (let i = 0; i < pagesToScan.length; i += BATCH_SIZE) {
      const batchPages = pagesToScan.slice(i, i + BATCH_SIZE)
      const startPage = batchPages[0]
      const endPage = batchPages[batchPages.length - 1]
      
      setCurrentBatch({ start: startPage, end: endPage })
      
      console.log(`📄 [BatchScan] Processing batch: pages ${startPage}-${endPage} (${batchPages.length} pages)`)
      
      try {
        // Call OCR API with perPage mode
        const runOCRResult = await runOCR(fileState.file, {
          scanMode: "perPage", // Use perPage mode for batch processing
          template: selectedTemplate || null,
          userProfile: user ? { enableTemplateMode: true } : null,
          startPage: startPage,
          endPage: endPage,
        })
        
        // Handle perPage response format
        const ocrResult = runOCRResult.ocrResult
        
        // Log raw response for debugging
        console.log(`🔍 [BatchScan] Raw OCR result for batch ${startPage}-${endPage}:`, {
          hasOcrResult: !!ocrResult,
          scanMode: ocrResult?.scanMode,
          hasPages: !!ocrResult?.pages,
          pagesCount: ocrResult?.pages?.length,
          pages: ocrResult?.pages?.map(p => ({ pageNumber: p.pageNumber, hasData: !!p.data, hasError: !!p.error }))
        })
        
        // Check if result is perPage format
        if (ocrResult && typeof ocrResult === 'object' && 'scanMode' in ocrResult && ocrResult.scanMode === "perPage" && ocrResult.pages) {
          // Per-page results format
          const expectedPagesInBatch = batchPages.length
          console.log(`✅ [BatchScan] Received ${ocrResult.pages.length} pages from batch ${startPage}-${endPage} (expected: ${expectedPagesInBatch})`)
          
          const receivedPageNumbers = []
          const pagesBeforeBatch = fileState.receivedPages.size
          const pagesWithErrors = []
          const pagesWithNoData = []
          
          for (const pageResult of ocrResult.pages) {
            // Only process pages that are in our pagesToScan list
            if (!pagesToScan.includes(pageResult.pageNumber)) {
              console.warn(`⚠️ [BatchScan] Skipping page ${pageResult.pageNumber} (not in pagesToScan)`)
              continue
            }
            
            // Handle error case
            if (pageResult.error) {
              console.error(`❌ [BatchScan] Page ${pageResult.pageNumber} error:`, pageResult.error)
              pagesWithErrors.push({ pageNumber: pageResult.pageNumber, error: pageResult.error })
              continue
            }
            
            // Handle null or missing data case
            if (!pageResult.data) {
              console.warn(`⚠️ [BatchScan] Page ${pageResult.pageNumber} has no data (null or missing)`)
              pagesWithNoData.push(pageResult.pageNumber)
              continue
            }
            
            // Valid page result
            fileState.pageResults[pageResult.pageNumber] = pageResult.data
            fileState.receivedPages.add(pageResult.pageNumber)
            receivedPageNumbers.push(pageResult.pageNumber)
            console.log(`✅ [BatchScan] Page ${pageResult.pageNumber} stored`)
          }
          
          // Log summary
          if (pagesWithErrors.length > 0) {
            console.error(`❌ [BatchScan] Batch ${startPage}-${endPage} has ${pagesWithErrors.length} pages with errors:`, pagesWithErrors.map(p => `${p.pageNumber}(${p.error})`).join(', '))
          }
          if (pagesWithNoData.length > 0) {
            console.warn(`⚠️ [BatchScan] Batch ${startPage}-${endPage} has ${pagesWithNoData.length} pages with no data:`, pagesWithNoData.join(', '))
          }
          
          const pagesAfterBatch = fileState.receivedPages.size
          const newPagesInBatch = pagesAfterBatch - pagesBeforeBatch
          
          console.log(`📊 [BatchScan] Batch ${startPage}-${endPage}: Received ${newPagesInBatch} new pages (total: ${pagesAfterBatch}/${actualTotalPages})`)
          console.log(`📋 [BatchScan] Pages in this batch: ${receivedPageNumbers.sort((a, b) => a - b).join(', ')}`)
          
          // Check if all expected pages in this batch were received
          const missingPages = batchPages.filter(pageNum => !fileState.receivedPages.has(pageNum))
          
          if (missingPages.length > 0) {
            console.error(`❌ [BatchScan] Batch ${startPage}-${endPage} missing pages: ${missingPages.join(', ')}`)
            console.error(`❌ [BatchScan] Expected ${expectedPagesInBatch} pages, received ${newPagesInBatch} pages, missing ${missingPages.length} pages`)
            console.error(`❌ [BatchScan] Received page numbers: ${receivedPageNumbers.sort((a, b) => a - b).join(', ') || 'none'}`)
            
            // If no pages were received at all, this might be a backend issue
            if (newPagesInBatch === 0) {
              console.error(`❌ [BatchScan] Backend returned 0 pages for batch ${startPage}-${endPage}. This might indicate a backend error.`)
              throw new Error(`Backend returned no pages for batch ${startPage}-${endPage}. Please check backend logs.`)
            }
            
            throw new Error(`Batch ${startPage}-${endPage} incomplete: missing pages ${missingPages.join(', ')}`)
          } else {
            console.log(`✅ [BatchScan] Batch ${startPage}-${endPage} complete: all ${expectedPagesInBatch} pages received`)
          }
        } else {
          // Fallback: treat as single result (for backward compatibility)
          console.warn(`⚠️ [BatchScan] Received non-perPage result, treating as single page`)
          if (ocrResult && ocrResult.words) {
            // For single page, assume it's the first page in pagesToScan
            const firstPage = pagesToScan[0] || 1
            fileState.pageResults[firstPage] = ocrResult
            fileState.receivedPages.add(firstPage)
          }
        }
        
        // Update batch progress immediately after receiving results
        const currentReceived = fileState.receivedPages.size
        console.log(`📊 [BatchScan] Updating progress: ${currentReceived}/${actualTotalPages} pages`)
        setBatchProgress({ 
          current: currentReceived, 
          total: actualTotalPages 
        })
        
        // Update overall progress
        // Progress range: 10-90% (reserve 10% for credit update, 10% for Excel export)
        const fileIndex = queue.findIndex(f => f.file === fileState.file)
        const fileProgressBase = 10 + (fileIndex / queue.length) * 80 // Base progress for this file (10-90%)
        const fileProgressRange = 80 / queue.length // Progress range allocated for each file
        const fileProgressWithin = (fileState.receivedPages.size / actualTotalPages) * fileProgressRange // Progress within this file (0-fileProgressRange)
        const totalProgress = fileProgressBase + fileProgressWithin
        
        setProgress(Math.min(90, totalProgress)) // Cap at 90% (reserve 10% for Excel export)
        
        const progressPercent = (fileState.receivedPages.size / actualTotalPages) * 100
        console.log(`📊 [BatchScan] Progress: ${fileState.receivedPages.size}/${actualTotalPages} pages (${progressPercent.toFixed(1)}%), total: ${totalProgress.toFixed(1)}%`)
      } catch (batchError) {
        console.error(`❌ [BatchScan] Error processing batch ${startPage}-${endPage}:`, batchError)
        fileState.status = "error"
        fileState.error = `Batch ${startPage}-${endPage} failed: ${batchError.message}`
        throw batchError
      }
    }
    
    // All batches completed - verify all pages were received
    const receivedCount = fileState.receivedPages.size
    const expectedCount = actualTotalPages
    
    if (receivedCount !== expectedCount) {
      console.error(`❌ [BatchScan] File ${fileState.originalName} incomplete after all batches: ${receivedCount}/${expectedCount} pages`)
      console.error(`📋 [BatchScan] Expected pages: [${pagesToScan.join(', ')}]`)
      console.error(`📋 [BatchScan] Received pages: [${Array.from(fileState.receivedPages).sort((a, b) => a - b).join(', ')}]`)
      const missingPages = pagesToScan.filter(p => !fileState.receivedPages.has(p))
      console.error(`📋 [BatchScan] Missing pages: ${missingPages.join(', ')}`)
      throw new Error(`File incomplete: ${receivedCount}/${expectedCount} pages received`)
    }
    
    fileState.status = "done"
    console.log(`✅ [BatchScan] Completed: ${fileState.originalName} (${receivedCount}/${expectedCount} pages)`)
  }

  /**
   * Run scan queue - process all files with batch scanning
   * @param {Array} queue - Array of ScanFileState objects
   */
  const runScanQueue = async (queue) => {
    if (!queue || queue.length === 0) {
      console.warn(`⚠️ [BatchScan] Scan queue is empty`)
      return
    }
    
    // Update state for UI
    setScanQueue(queue)
    setStatus("running")
    setIsScanning(true) // Mark scanning as in progress
    setProgress(0)
    setError("")
    setCurrentFile("กำลังเริ่มต้น...")
    
    const fileData = []
    
    try {
      // Process each file (use queue parameter, not scanQueue state)
      let processedCount = 0
      for (let i = 0; i < queue.length; i++) {
        const fileState = queue[i]
        
        // Skip if file was removed from files list
        const fileStillExists = files.some(f => f.file === fileState.file)
        if (!fileStillExists) {
          console.log(`⏭️ [BatchScan] Skipping removed file: ${fileState.originalName}`)
          continue
        }
        
        setCurrentFileIndex(processedCount)
        processedCount++
        
        console.log(`📄 [BatchScan] Processing file ${processedCount}/${queue.length}: ${fileState.originalName}`)
        
        try {
          await scanSingleFile(fileState, queue)
          
          // Verify that all pages have been processed
          const expectedPages = fileState.pagesToScan ? fileState.pagesToScan.length : fileState.totalPages
          if (fileState.receivedPages.size !== expectedPages) {
            console.warn(`⚠️ [BatchScan] File ${fileState.originalName} incomplete: ${fileState.receivedPages.size}/${expectedPages} pages`)
            // Don't process incomplete files
            continue
          }
          
          // Combine all page results into single OCRResult (only after all pages are complete)
          if (fileState.receivedPages.size > 0) {
            // Sort page numbers
            const sortedPageNumbers = Array.from(fileState.receivedPages).sort((a, b) => a - b)
            
            // Combine words from all pages
            const allWords = []
            const pages = []
            let maxWidth = 0
            let maxHeight = 0
            
            for (const pageNum of sortedPageNumbers) {
              const pageResult = fileState.pageResults[pageNum]
              if (pageResult && pageResult.words) {
                // Add pageNumber to each word
                const pageWords = pageResult.words.map(word => ({
                  ...word,
                  pageNumber: pageNum,
                }))
                allWords.push(...pageWords)
                
                // Store page data
                pages.push({
                  pageNumber: pageNum,
                  width: pageResult.page?.width || 0,
                  height: pageResult.page?.height || 0,
                  words: pageWords,
                })
                
                maxWidth = Math.max(maxWidth, pageResult.page?.width || 0)
                maxHeight = Math.max(maxHeight, pageResult.page?.height || 0)
              }
            }
            
            // Create combined OCRResult
            const combinedResult = {
              fileName: fileState.originalName,
              page: {
                width: maxWidth,
                height: maxHeight,
              },
              words: allWords,
              pages: pages,
            }
            
            setOcrResults((prev) => [...prev, combinedResult])
            
            // Extract data using buildRows (same as preview) - only after all pages are complete
            if (selectedTemplate && combinedResult.words && combinedResult.page) {
              console.log(`📝 [BatchScan] Extracting data using buildRows for ${fileState.originalName} (${allWords.length} words from ${pages.length} pages)...`)
              const rows = buildRows(combinedResult, selectedTemplate)
              console.log(`✅ [BatchScan] Extracted ${rows.length} rows from ${fileState.originalName}`)
              
              // Convert rows to fileData format
              const configToUse = selectedTemplateConfig || columnConfig || []
              const data = rows.map((row, rowIdx) => {
                const newRow = {}
                
                selectedTemplate.columns.forEach((templateCol) => {
                  const columnKey = templateCol.columnKey
                  const colConfig = configToUse?.find(c => c.key === columnKey)
                  
                  if (templateCol.defaultValue) {
                    newRow[columnKey] = templateCol.defaultValue
                    return
                  }
                  
                  if (colConfig && colConfig.mode === "manual") {
                    newRow[columnKey] = colConfig.manualValue || ""
                    return
                  }
                  
                  newRow[columnKey] = row[columnKey] || ""
                })
                
                const filenameCol = configToUse?.find(
                  (col) => (col.label && (col.label.includes("ชื่อไฟล์") || col.label.includes("filename"))) ||
                           (col.key && (col.key.includes("filename") || col.key.includes("file")))
                )
                if (filenameCol && rowIdx === 0) {
                  newRow[filenameCol.key] = fileState.originalName
                }
                
                return newRow
              })
              
              fileData.push({
                filename: fileState.originalName,
                data,
              })
              console.log(`✅ [BatchScan] Added ${data.length} rows to fileData for ${fileState.originalName}`)
            }
          }
          
          // Remove completed file from files list
          setFiles((prev) => prev.filter((fileItem) => fileItem.file !== fileState.file))
          console.log(`✅ [BatchScan] Removed completed file from list: ${fileState.originalName}`)
        } catch (fileError) {
          console.error(`❌ [BatchScan] Error processing file ${fileState.originalName}:`, fileError)
          fileState.status = "error"
          fileState.error = fileError.message
          setError(`เกิดข้อผิดพลาดในการประมวลผล ${fileState.originalName}: ${fileError.message}`)
          // Remove error file from files list as well
          setFiles((prev) => prev.filter((fileItem) => fileItem.file !== fileState.file))
          // Continue with next file
        }
      }
      
      // Export Excel files (only after all files are processed)
      if (fileData.length > 0) {
        const totalRows = fileData.reduce((sum, f) => sum + f.data.length, 0)
        console.log(`💾 [BatchScan] All files processed. Downloading ${fileData.length} file(s) with ${totalRows} total rows...`)
        setCurrentFile("กำลังดาวน์โหลดไฟล์...")
        setProgress(95)
        
        const configToUse = selectedTemplateConfig || columnConfig || []
        
        if (fileType === "xlsx") {
          if (mode === "separate") {
            createSeparateExcelFiles(fileData, configToUse)
          } else {
            createCombinedExcelFile(fileData, configToUse, "combined.xlsx")
          }
        } else {
          setError("ไฟล์ Word ต้องใช้ Backend API เท่านั้น กรุณาเปลี่ยนเป็น Excel")
          setStatus("idle")
          setIsScanning(false)
          return
        }
      }
      
      setStatus("success")
      setProgress(100)
      setIsScanning(false) // Mark scanning as complete
      
      setTimeout(() => {
        setStatus("idle")
        setProgress(0)
        setCurrentFile("")
        // Only clear files if queue is empty (all files processed)
        if (scanQueue.length === 0) {
          setFiles([])
        }
        setScanQueue([])
        setCurrentFileIndex(0)
        setCurrentBatch({ start: 0, end: 0 })
        setBatchProgress({ current: 0, total: 0 })
      }, 2000)
    } catch (err) {
      console.error("❌ [BatchScan] Export Error:", err)
      setError(`เกิดข้อผิดพลาด: ${err.message}`)
      setStatus("idle")
      setProgress(0)
      setCurrentFile("")
    }
  }

  const handleRun = async () => {
    if (!creditEnough || files.length === 0) return

    const user = auth.currentUser
    if (!user) return

    // Calculate pages to scan for each file
    // For now, only support page range for single PDF file
    const queue = files.map((fileItem, index) => {
      let pagesToScan = null // null = all pages
      
      // Only apply page range to single PDF file
      if (files.length === 1 && isPdfFile(fileItem.file)) {
        try {
          console.log(`🔍 [Scan] Calculating pages to scan for ${fileItem.originalName}:`)
          console.log(`   - pageRange: "${pageRange}" (type: ${typeof pageRange})`)
          console.log(`   - startPage: "${startPage}" (type: ${typeof startPage})`)
          console.log(`   - endPage: "${endPage}" (type: ${typeof endPage})`)
          console.log(`   - totalPages: ${fileItem.pageCount}`)
          
          pagesToScan = calculatePagesToScan(pageRange, startPage, endPage, fileItem.pageCount)
          
          if (pagesToScan) {
            console.log(`✅ [Scan] File ${fileItem.originalName}: Will scan ${pagesToScan.length} pages (${pagesToScan.join(', ')}) out of ${fileItem.pageCount} total pages`)
          } else {
            console.log(`📄 [Scan] File ${fileItem.originalName}: Will scan all ${fileItem.pageCount} pages (pagesToScan is null)`)
          }
        } catch (err) {
          console.error(`❌ [Scan] Error calculating pages to scan for ${fileItem.originalName}:`, err)
          setError(`เกิดข้อผิดพลาดในการคำนวณช่วงหน้า: ${err.message}`)
          throw err
        }
      } else {
        // For multiple files or non-PDF, scan all pages
        pagesToScan = null
        console.log(`📄 [Scan] File ${fileItem.originalName}: Will scan all ${fileItem.pageCount} pages (multiple files or non-PDF)`)
      }
      
      return {
        file: fileItem.file,
        originalName: fileItem.originalName,
        totalPages: fileItem.pageCount,
        pagesToScan: pagesToScan, // Array of page numbers to scan, or null for all pages
        receivedPages: new Set(),
        pageResults: {},
        status: "pending",
      }
    })
    
    // Calculate total pages to scan (for credit calculation)
    const totalPagesToScan = queue.reduce((sum, fileState) => {
      if (fileState.pagesToScan) {
        return sum + fileState.pagesToScan.length
      } else {
        return sum + fileState.totalPages
      }
    }, 0)
    
    setScanQueue(queue)
    setOcrResults([])

    try {
      console.log(`🚀 Starting batch scan process...`)
      console.log(`📊 Total files: ${queue.length}, Total pages in files: ${totalPages}, Pages to scan: ${totalPagesToScan}`)
      
      // อัปเดตเครดิต Firestore ก่อน (ใช้จำนวนหน้าที่จะสแกนจริง)
      console.log(`💳 Updating credits: ${credits} -> ${credits - totalPagesToScan}`)
      setCurrentFile("กำลังอัปเดตเครดิต...")
      setProgress(5)
      
      const newCredits = credits - totalPagesToScan
      try {
        await updateUserCredits(user.uid, newCredits)
        console.log(`✅ Credits updated successfully`)
        if (onConsume) {
          onConsume(totalPagesToScan)
        }
      } catch (creditError) {
        console.error(`❌ Failed to update credits:`, creditError)
        setError(`ไม่สามารถอัปเดตเครดิตได้: ${creditError.message}. กรุณาลองใหม่อีกครั้ง`)
        setStatus("idle")
        setIsScanning(false)
        setProgress(0)
        setCurrentFile("")
        return
      }
      
      setProgress(10)
      
      // Use batch scan controller (handles all files, batches, and Excel export)
      // Pass queue directly to avoid React state async update issue
      await runScanQueue(queue)
    } catch (err) {
      console.error("❌ Export Error:", err)
      setError(`เกิดข้อผิดพลาด: ${err.message}`)
      setStatus("idle")
      setIsScanning(false)
      setProgress(0)
      setCurrentFile("")
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)" }}>
      {/* Navbar */}
      <AppBar 
        position="static" 
        elevation={0}
        sx={{ 
          background: "linear-gradient(135deg, #1e293b 0%, #334155 100%)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
        }}
      >
        <Toolbar sx={{ justifyContent: "space-between", py: 1.5 }}>
          <Typography 
            variant="h5" 
            fontWeight={700} 
            sx={{ 
              color: "#ffffff",
              background: "linear-gradient(135deg, #ffffff 0%, #e2e8f0 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            สแกนเอกสาร
          </Typography>
          <Typography variant="body2" sx={{ color: "#94a3b8" }}>
            อัปโหลดไฟล์เอกสารเพื่อเริ่มกระบวนการสแกน
          </Typography>
        </Toolbar>
      </AppBar>

      <Box sx={{ width: "100%", p: 2.5 }}>
        <Grid container spacing={2}>
          {/* Left Column: Upload & File List */}
          <Grid size={{ xs: 12, lg: 8 }}>
            <Stack spacing={2}>
              {/* Summary Card */}
              <Card sx={{ boxShadow: "0 4px 12px rgba(0,0,0,0.08)", borderRadius: 2 }}>
                <CardContent sx={{ p: 0 }}>
                  <Box sx={{ 
                    background: "linear-gradient(135deg, #334155 0%, #475569 100%)",
                    p: 2,
                    borderTopLeftRadius: 8,
                    borderTopRightRadius: 8,
                  }}>
                    <Typography variant="h6" fontWeight={600} sx={{ color: "#ffffff", fontSize: "1.1rem" }}>
                      สรุปข้อมูล
                    </Typography>
                  </Box>
                  <Box sx={{ p: 2 }}>
                    <Stack spacing={2}>
                      {/* Template Selection */}
                      <FormControl fullWidth size="small" required>
                        <InputLabel>เลือกเทมเพลต *</InputLabel>
                        {templates.length > 0 ? (
                          <>
                            <Select
                              value={selectedTemplateId || ""}
                              label="เลือกเทมเพลต *"
                              onChange={(e) => {
                                const templateId = e.target.value
                                setSelectedTemplateId(templateId)
                                // บันทึกค่าไว้ใน localStorage
                                if (templateId) {
                                  localStorage.setItem("scan_selected_template_id", templateId)
                                } else {
                                  localStorage.removeItem("scan_selected_template_id")
                                }
                              }}
                              required
                              sx={{
                                bgcolor: "#ffffff",
                              }}
                              error={!selectedTemplateId}
                            >
                              {templates.map((template) => (
                                <MenuItem key={template.templateId} value={template.templateId}>
                                  {template.templateName}
                                </MenuItem>
                              ))}
                            </Select>
                            {!selectedTemplateId && (
                              <Typography variant="caption" sx={{ color: "#ef4444", mt: 0.5, display: "block" }}>
                                กรุณาเลือกเทมเพลต
                              </Typography>
                            )}
                          </>
                        ) : (
                          <Box
                            sx={{
                              p: 2,
                              bgcolor: "#fef3c7",
                              border: "1px solid #fde68a",
                              borderRadius: 1,
                              textAlign: "center",
                            }}
                          >
                            <Typography variant="body2" sx={{ color: "#92400e", mb: 1 }}>
                              ยังไม่มีเทมเพลต
                            </Typography>
                            <Typography variant="caption" sx={{ color: "#78350f" }}>
                              กรุณาสร้างเทมเพลตในหน้า "ตั้งค่าเทมเพลต" ก่อน
                            </Typography>
                          </Box>
                        )}
                      </FormControl>
                      
                      {/* Page Range Selection (only for single PDF file) */}
                      {files.length === 1 && files.some(f => isPdfFile(f.file)) && (
                        <Box>
                          <Typography variant="caption" sx={{ color: "#64748b", mb: 1, display: "block" }}>
                            เลือกวิธีระบุช่วงหน้า:
                          </Typography>
                          <Stack spacing={2}>
                            {/* Option 1: Start/End Page (Simple range) */}
                            <Box>
                              <Typography variant="caption" sx={{ color: "#475569", mb: 0.5, display: "block", fontWeight: 500 }}>
                                วิธีที่ 1: ระบุช่วงหน้า (แนะนำ)
                              </Typography>
                              <Stack direction="row" spacing={1}>
                                <TextField
                                  size="small"
                                  label="ตั้งแต่หน้า"
                                  placeholder="เช่น: 20"
                                  value={startPage}
                                  onChange={(e) => {
                                    setStartPage(e.target.value)
                                    setPageRange("") // Clear pageRange when using startPage/endPage
                                  }}
                                  type="number"
                                  inputProps={{ min: 1 }}
                                  sx={{
                                    bgcolor: "#ffffff",
                                    flex: 1,
                                  }}
                                />
                                <TextField
                                  size="small"
                                  label="ถึงหน้า"
                                  placeholder="เช่น: 30"
                                  value={endPage}
                                  onChange={(e) => {
                                    setEndPage(e.target.value)
                                    setPageRange("") // Clear pageRange when using startPage/endPage
                                  }}
                                  type="number"
                                  inputProps={{ min: 1 }}
                                  sx={{
                                    bgcolor: "#ffffff",
                                    flex: 1,
                                  }}
                                />
                              </Stack>
                            </Box>
                            
                            {/* Option 2: Page Range String (Advanced) */}
                            <Box>
                              <Typography variant="caption" sx={{ color: "#475569", mb: 0.5, display: "block", fontWeight: 500 }}>
                                วิธีที่ 2: ระบุหน้าแบบละเอียด
                              </Typography>
                              <TextField
                                fullWidth
                                size="small"
                                label="ช่วงหน้าที่จะสแกน"
                                placeholder="เช่น: 1,2-6,20-22"
                                value={pageRange}
                                onChange={(e) => {
                                  setPageRange(e.target.value)
                                  setStartPage("") // Clear startPage/endPage when using pageRange
                                  setEndPage("")
                                }}
                                helperText="ระบุหน้าเฉพาะ: 1,3,5 หรือช่วง: 1-10 หรือรวมกัน: 1,2-6,20-22"
                                sx={{
                                  bgcolor: "#ffffff",
                                }}
                              />
                            </Box>
                          </Stack>
                          {(startPage || endPage || pageRange) && (
                            <Typography variant="caption" sx={{ color: "#10b981", mt: 1, display: "block" }}>
                              ✓ จะสแกนเฉพาะหน้าที่ระบุ (ไม่ระบุ = ทั้งหมด)
                            </Typography>
                          )}
                        </Box>
                      )}
                      
                      {/* Summary Chips */}
                      <Stack direction="row" spacing={2} flexWrap="wrap">
                        <Chip 
                          label={`ไฟล์ ${files.length}`} 
                          sx={{ 
                            bgcolor: "#f0f9ff",
                            color: "#0369a1",
                            fontWeight: 500,
                          }}
                        />
                        <Chip 
                          label={`ประมาณ ${totalPages} หน้า`}
                          sx={{ 
                            bgcolor: "#fef3c7",
                            color: "#92400e",
                            fontWeight: 500,
                          }}
                        />
                        <Chip
                          label={`เครดิตคงเหลือ ${credits} หน้า`}
                          color={creditEnough ? "success" : "error"}
                          sx={{ fontWeight: 500 }}
                        />
                        {selectedTemplateId && (
                          <Chip
                            label={`เทมเพลต: ${templates.find(t => t.templateId === selectedTemplateId)?.templateName || ""}`}
                            sx={{ 
                              bgcolor: "#e0e7ff",
                              color: "#4338ca",
                              fontWeight: 500,
                            }}
                          />
                        )}
                      </Stack>
                    </Stack>
                  </Box>
                </CardContent>
              </Card>

              {/* Upload & File List Card */}
              <Card 
                sx={{ 
                  boxShadow: "0 4px 12px rgba(0,0,0,0.08)", 
                  borderRadius: 2,
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
              >
                <CardContent sx={{ p: 0 }}>
                  <Box sx={{ 
                    background: "linear-gradient(135deg, #334155 0%, #475569 100%)",
                    p: 2,
                    borderTopLeftRadius: 8,
                    borderTopRightRadius: 8,
                  }}>
                    <Typography variant="h6" fontWeight={600} sx={{ color: "#ffffff", fontSize: "1.1rem" }}>
                      อัปโหลดไฟล์ ({files.length})
                    </Typography>
                  </Box>
                  
                  {/* Drop Zone */}
                  {files.length === 0 ? (
                    <Box 
                      sx={{ 
                        textAlign: "center", 
                        py: 6, 
                        px: 2,
                        border: "2px dashed #cbd5e1",
                        m: 2,
                        borderRadius: 2,
                        bgcolor: "#f8fafc",
                        transition: "all 0.3s ease",
                        "&:hover": {
                          borderColor: "#3b82f6",
                          bgcolor: "#f0f9ff",
                        },
                      }}
                    >
                      <CloudUploadIcon sx={{ fontSize: 64, color: "#3b82f6", mb: 2 }} />
                      <Typography variant="h6" sx={{ mb: 1, color: "#1e293b", fontWeight: 600 }}>
                        ลากไฟล์มาวางที่นี่
                      </Typography>
                      <Typography color="text.secondary" sx={{ mb: 3, fontSize: "0.9rem" }}>
                        รองรับ PDF / JPG / PNG
                      </Typography>

                      <input
                        hidden
                        multiple
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        id="scan-file-input"
                        onChange={(e) => handleSelect(e.target.files)}
                      />

                      <Button
                        variant="contained"
                        startIcon={<CloudUploadIcon />}
                        onClick={() =>
                          document.getElementById("scan-file-input").click()
                        }
                        sx={{
                          background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)",
                          boxShadow: "0 4px 12px rgba(59, 130, 246, 0.3)",
                          "&:hover": {
                            background: "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)",
                            boxShadow: "0 6px 16px rgba(59, 130, 246, 0.4)",
                          },
                          px: 4,
                          py: 1.5,
                        }}
                      >
                        เลือกไฟล์
                      </Button>
                    </Box>
                  ) : (
                    <Box sx={{ p: 2 }}>
                      {/* Upload Button */}
                      <Box sx={{ mb: 2 }}>
                        <input
                          hidden
                          multiple
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          id="scan-file-input"
                          onChange={(e) => handleSelect(e.target.files)}
                        />
                        <Button
                          variant="outlined"
                          startIcon={<CloudUploadIcon />}
                          onClick={() =>
                            document.getElementById("scan-file-input").click()
                          }
                          fullWidth
                          sx={{
                            borderColor: "#cbd5e1",
                            color: "#475569",
                            "&:hover": {
                              borderColor: "#94a3b8",
                              bgcolor: "#f8fafc",
                            },
                            py: 1.5,
                          }}
                        >
                          เพิ่มไฟล์
                        </Button>
                      </Box>

                      {/* File Grid */}
                      <Box sx={{ 
                        display: "grid", 
                        gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
                        gap: 1.5,
                        overflowY: "auto",
                        maxHeight: 400,
                        p: 0.5,
                      }}>
                        {files.map((f, i) => {
                          const isPdf = isPdfFile(f.file)
                          return (
                            <Box
                              key={i}
                              sx={{
                                position: "relative",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                p: 1.5,
                                borderRadius: 1.5,
                                bgcolor: "#f8fafc",
                                border: "1px solid #e2e8f0",
                                transition: "all 0.2s ease",
                                "&:hover": {
                                  bgcolor: "#f1f5f9",
                                  borderColor: "#cbd5e1",
                                  transform: "translateY(-2px)",
                                  boxShadow: "0 4px 8px rgba(0,0,0,0.1)",
                                },
                              }}
                            >
                              {/* Icon กลมๆ */}
                              <Box
                                sx={{
                                  width: 48,
                                  height: 48,
                                  borderRadius: "50%",
                                  background: isPdf 
                                    ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
                                    : "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  mb: 0.75,
                                  boxShadow: isPdf
                                    ? "0 2px 8px rgba(239, 68, 68, 0.3)"
                                    : "0 2px 8px rgba(59, 130, 246, 0.3)",
                                }}
                              >
                                {isPdf ? (
                                  <PictureAsPdfIcon sx={{ fontSize: 24, color: "#ffffff" }} />
                                ) : (
                                  <ImageIcon sx={{ fontSize: 24, color: "#ffffff" }} />
                                )}
                              </Box>
                              
                              {/* ชื่อไฟล์ */}
                              <Typography 
                                variant="caption" 
                                sx={{ 
                                  color: "#1e293b", 
                                  fontWeight: 500,
                                  textAlign: "center",
                                  fontSize: "0.7rem",
                                  lineHeight: 1.3,
                                  mb: 0.25,
                                  wordBreak: "break-word",
                                  maxWidth: "100%",
                                }}
                              >
                                {f.originalName.length > 15 
                                  ? f.originalName.substring(0, 15) + "..." 
                                  : f.originalName}
                              </Typography>
                              
                              {/* จำนวนหน้า */}
                              <Typography 
                                variant="caption" 
                                sx={{ 
                                  color: "#64748b", 
                                  fontSize: "0.6rem",
                                }}
                              >
                                {loadingFiles.has(f.originalName) ? (
                                  <CircularProgress size={8} />
                                ) : (
                                  `${f.pageCount} หน้า`
                                )}
                              </Typography>

                              {/* ปุ่มลบ */}
                              <IconButton
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  removeFile(i)
                                }}
                                disabled={loadingFiles.has(f.originalName)}
                                sx={{
                                  position: "absolute",
                                  top: 2,
                                  right: 2,
                                  width: 20,
                                  height: 20,
                                  bgcolor: "#fee2e2",
                                  color: "#dc2626",
                                  "&:hover": {
                                    bgcolor: "#fecaca",
                                    transform: "scale(1.1)",
                                  },
                                  transition: "all 0.2s ease",
                                }}
                              >
                                <CloseIcon sx={{ fontSize: 12 }} />
                              </IconButton>
                            </Box>
                          )
                        })}
                      </Box>
                    </Box>
                  )}
                </CardContent>
              </Card>

              {/* Credit Warning */}
              {files.length > 0 && !creditEnough && (
                <Alert 
                  severity="warning"
                  sx={{ 
                    borderRadius: 2,
                    "& .MuiAlert-icon": {
                      fontSize: 24,
                    },
                  }}
                >
                  เอกสารชุดนี้ใช้เครดิต {totalPages} หน้า แต่คุณมีเครดิตเหลือ {credits} หน้า
                </Alert>
              )}
            </Stack>
          </Grid>

          {/* Right Column: Export Settings & Action */}
          <Grid size={{ xs: 12, lg: 4 }}>
            <Stack spacing={2} sx={{ position: "sticky", top: 20 }}>
              {/* Export Settings Card */}
              {files.length > 0 && (
                <Card sx={{ boxShadow: "0 4px 12px rgba(0,0,0,0.08)", borderRadius: 2 }}>
                  <CardContent sx={{ p: 0 }}>
                    <Box sx={{ 
                      background: "linear-gradient(135deg, #334155 0%, #475569 100%)",
                      p: 2,
                      borderTopLeftRadius: 8,
                      borderTopRightRadius: 8,
                    }}>
                      <Typography variant="h6" fontWeight={600} sx={{ color: "#ffffff", fontSize: "1.1rem" }}>
                        ตั้งค่าการส่งออก
                      </Typography>
                    </Box>
                    <Box sx={{ p: 2 }}>
                      <Stack spacing={2}>
                        {/* Export Mode */}
                        <Box>
                          <Typography variant="body2" fontWeight={500} sx={{ mb: 1, color: "#1e293b" }}>
                            รูปแบบการบันทึกไฟล์
                          </Typography>
                          <RadioGroup
                            value={mode}
                            onChange={(e) => setMode(e.target.value)}
                          >
                            <FormControlLabel
                              value="separate"
                              control={<Radio size="small" />}
                              label="แยกไฟล์"
                            />
                            <FormControlLabel
                              value="combine"
                              control={<Radio size="small" />}
                              label="รวมเป็นไฟล์เดียว"
                            />
                          </RadioGroup>
                        </Box>

                        <Divider />

                        {/* File Type */}
                        <Box>
                          <Typography variant="body2" fontWeight={500} sx={{ mb: 1, color: "#1e293b" }}>
                            ประเภทไฟล์
                          </Typography>
                          <RadioGroup
                            value={fileType}
                            onChange={(e) => setFileType(e.target.value)}
                          >
                            <FormControlLabel
                              value="xlsx"
                              control={<Radio size="small" />}
                              label="Excel (.xlsx)"
                            />
                            <FormControlLabel
                              value="doc"
                              control={<Radio size="small" />}
                              label="Word (.docx)"
                            />
                          </RadioGroup>
                        </Box>

                        <Divider />

                        {/* Destination */}
                        <Box>
                          <Typography variant="body2" fontWeight={500} sx={{ mb: 1, color: "#1e293b" }}>
                            ปลายทางจัดเก็บไฟล์
                          </Typography>
                          <TextField
                            fullWidth
                            size="small"
                            disabled
                            value="โฟลเดอร์ Downloads"
                            sx={{ mt: 0.5 }}
                          />
                        </Box>
                      </Stack>
                    </Box>
                  </CardContent>
                </Card>
              )}

              {/* Action Card - แสดงเฉพาะเมื่อมีไฟล์ */}
              {files.length > 0 && (
                <Card sx={{ boxShadow: "0 4px 12px rgba(0,0,0,0.08)", borderRadius: 2 }}>
                  <CardContent sx={{ p: 0 }}>
                    <Box sx={{ 
                      background: "linear-gradient(135deg, #334155 0%, #475569 100%)",
                      p: 2,
                      borderTopLeftRadius: 8,
                      borderTopRightRadius: 8,
                    }}>
                      <Typography variant="h6" fontWeight={600} sx={{ color: "#ffffff", fontSize: "1.1rem" }}>
                        เริ่มสแกน
                      </Typography>
                    </Box>
                    <Box sx={{ p: 3 }}>
                      {/* Progress */}
                      {status === "running" && (
                        <Box sx={{ mb: 2 }}>
                          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                            {currentFile ? `กำลังสแกนไฟล์: ${currentFile}` : "กำลังเริ่มต้น..."}
                          </Typography>
                          {batchProgress.total > 0 && (
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                              หน้า {batchProgress.current} / {batchProgress.total} หน้า ({Math.round((batchProgress.current / batchProgress.total) * 100)}%)
                            </Typography>
                          )}
                          {currentBatch.start > 0 && currentBatch.end > 0 && batchProgress.current < batchProgress.total && (
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontSize: "0.75rem", fontStyle: "italic" }}>
                              กำลังประมวลผล: หน้า {currentBatch.start}–{currentBatch.end}
                            </Typography>
                          )}
                          <LinearProgress 
                            variant="determinate" 
                            value={progress} 
                            sx={{ height: 6, borderRadius: 3, mb: 1 }}
                          />
                          <Typography variant="caption" color="text.secondary">
                            {Math.round(progress)}% เสร็จสมบูรณ์
                          </Typography>
                        </Box>
                      )}

                      {/* Status Messages */}
                      {status === "success" && (
                        <Alert severity="success" sx={{ mb: 2 }}>
                          สแกนและดาวน์โหลดไฟล์เรียบร้อยแล้ว
                        </Alert>
                      )}

                      {error && (
                        <Alert severity="error" onClose={() => setError("")} sx={{ mb: 2 }}>
                          {error}
                        </Alert>
                      )}

                      {/* Action Button */}
                      <Button
                        variant="contained"
                        fullWidth
                        size="large"
                        startIcon={status === "running" ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
                        disabled={!creditEnough || status === "running" || !selectedTemplateId}
                        onClick={handleRun}
                        sx={{
                          background: creditEnough && status !== "running" && selectedTemplateId
                            ? "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)"
                            : "linear-gradient(135deg, #94a3b8 0%, #64748b 100%)",
                          boxShadow: creditEnough && status !== "running" && selectedTemplateId
                            ? "0 4px 12px rgba(59, 130, 246, 0.3)"
                            : "none",
                          "&:hover": {
                            background: creditEnough && status !== "running" && selectedTemplateId
                              ? "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)"
                              : "linear-gradient(135deg, #94a3b8 0%, #64748b 100%)",
                            boxShadow: creditEnough && status !== "running" && selectedTemplateId
                              ? "0 6px 16px rgba(59, 130, 246, 0.4)"
                              : "none",
                          },
                          py: 1.5,
                          fontSize: "1rem",
                          fontWeight: 600,
                        }}
                      >
                        {status === "running" 
                          ? "กำลังประมวลผล..." 
                          : "สแกนและบันทึกไฟล์"}
                      </Button>
                      {!creditEnough && (
                        <Typography variant="body2" sx={{ mt: 2, color: "#ef4444", textAlign: "center" }}>
                          เครดิตไม่เพียงพอ
                        </Typography>
                      )}
                      {!selectedTemplateId && (
                        <Typography variant="body2" sx={{ mt: 2, color: "#ef4444", textAlign: "center" }}>
                          กรุณาเลือกเทมเพลต
                        </Typography>
                      )}
                    </Box>
                  </CardContent>
                </Card>
              )}
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </Box>
  )
}
