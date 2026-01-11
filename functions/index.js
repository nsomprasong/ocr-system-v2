const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");
const { Storage } = require("@google-cloud/storage");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors")({ origin: true });
// Note: Removed pdfjs-dist and canvas dependencies
// Now using v1 method (asyncBatchAnnotateFiles) which is proven to work

// DOMPoint polyfill (simple implementation)
if (!global.DOMPoint) {
  global.DOMPoint = class DOMPoint {
    constructor(x = 0, y = 0, z = 0, w = 1) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.w = w;
    }
  };
}

// ImageData polyfill for Node.js (needed by pdfjs-dist)
if (!global.ImageData) {
  global.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// Polyfill for Promise.withResolvers (Node.js < 22)
if (!Promise.withResolvers) {
  Promise.withResolvers = function() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Note: Removed pdfjs-dist usage - using v1 method (asyncBatchAnnotateFiles) instead
// This avoids compatibility issues with Node.js environment

admin.initializeApp();

const visionClient = new vision.ImageAnnotatorClient();
const storage = new Storage();

// 🔒 ใช้ bucket ที่สร้างไว้ล่วงหน้าเท่านั้น (ถ้ามี)
const BUCKET_NAME = process.env.GCS_BUCKET || "ocr-system-c3bea-ocr-temp";

// ---------- UTIL ----------
function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

// ---------- OCR IMAGE (BASE64) ----------
async function ocrImageBase64(base64) {
  console.log("📸 Processing image with Google Cloud Vision API");
  const buffer = Buffer.from(base64, "base64");

  const [result] = await visionClient.documentTextDetection({
    image: { content: buffer },
  });

  const text = result.fullTextAnnotation?.text || "";
  console.log(`✅ OCR completed. Text length: ${text.length}`);

  // Return แค่ text เหมือน Python script
  return text;
}

// ---------- OCR PDF (BASE64 → GCS → ASYNC) ----------
async function ocrPdfBase64(pdfBase64, filename = "input.pdf") {
  console.log(`📄 Processing PDF: ${filename}`);
  const buffer = Buffer.from(pdfBase64, "base64");
  const tmpPdfPath = path.join(os.tmpdir(), `${randomId()}-${filename}`);
  fs.writeFileSync(tmpPdfPath, buffer);

  try {
    let bucket = storage.bucket(BUCKET_NAME);
    
    // ตรวจสอบว่า bucket มีอยู่หรือไม่ ถ้าไม่มีให้สร้าง
    const [exists] = await bucket.exists();
    if (!exists) {
      console.log(`📦 Bucket ${BUCKET_NAME} does not exist, creating...`);
      try {
        await bucket.create({
          location: "us-central1",
          storageClass: "STANDARD",
        });
        console.log(`✅ Bucket ${BUCKET_NAME} created successfully`);
      } catch (createError) {
        console.error(`❌ Failed to create bucket: ${createError.message}`);
        // ถ้าสร้างไม่ได้ ให้ใช้ default bucket ของ Firebase
        const defaultBucket = storage.bucket();
        console.log(`🔄 Using default Firebase Storage bucket: ${defaultBucket.name}`);
        bucket = defaultBucket;
      }
    }

    const pdfGcsPath = `input/${randomId()}.pdf`;
    const outputPrefix = `output/${randomId()}/`;

    // upload PDF
    console.log(`📤 Uploading PDF to GCS: gs://${bucket.name}/${pdfGcsPath}`);
    await bucket.upload(tmpPdfPath, { destination: pdfGcsPath });

    const gcsInputUri = `gs://${bucket.name}/${pdfGcsPath}`;
    const gcsOutputUri = `gs://${bucket.name}/${outputPrefix}`;

    const request = {
      requests: [
        {
          inputConfig: {
            gcsSource: { uri: gcsInputUri },
            mimeType: "application/pdf",
          },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          outputConfig: {
            gcsDestination: { uri: gcsOutputUri },
            batchSize: 5,
          },
        },
      ],
    };

    console.log("⏳ Starting async batch annotation...");
    const [operation] =
      await visionClient.asyncBatchAnnotateFiles(request);
    await operation.promise();
    console.log("✅ Async batch annotation completed");

    // อ่านผลลัพธ์ (เหมือน Python script - แค่ text)
    let fullText = "";
    const [files] = await bucket.getFiles({ prefix: outputPrefix });
    
    console.log(`📂 Found ${files.length} files in output prefix: ${outputPrefix}`);

    if (files.length === 0) {
      console.warn("⚠️ No output files found. PDF processing may have failed.");
      throw new Error("PDF OCR processing failed: No output files generated");
    }

    for (const file of files) {
      if (!file.name.endsWith(".json")) {
        console.log(`⏭️ Skipping non-JSON file: ${file.name}`);
        continue;
      }

      console.log(`📄 Reading result file: ${file.name}`);
      try {
        const json = JSON.parse(
          (await file.download())[0].toString("utf8")
        );

        for (const res of json.responses || []) {
          if (res.fullTextAnnotation?.text) {
            fullText += res.fullTextAnnotation.text + "\n";
          } else {
            console.warn(`⚠️ Response without text in file: ${file.name}`);
          }
        }
      } catch (parseError) {
        console.error(`❌ Failed to parse JSON file ${file.name}:`, parseError);
      }
    }

    // Cleanup
    console.log("🧹 Cleaning up GCS files...");
    for (const file of files) {
      await file.delete().catch((err) => {
        console.warn(`⚠️ Failed to delete file ${file.name}:`, err.message);
      });
    }
    await bucket.file(pdfGcsPath).delete().catch((err) => {
      console.warn(`⚠️ Failed to delete PDF file:`, err.message);
    });

    console.log(`✅ PDF OCR completed. Text length: ${fullText.length}`);
    
    if (fullText.trim().length === 0) {
      console.warn("⚠️ PDF OCR returned empty text. The PDF may be empty or unreadable.");
    }

    // Return แค่ text เหมือน Python script
    return fullText;
  } finally {
    // Cleanup temp file
    if (fs.existsSync(tmpPdfPath)) {
      fs.unlinkSync(tmpPdfPath);
    }
  }
}

// ---------- LEGACY OCR FUNCTION (V2-SAFE NAME) ----------
// ⚠️ CRITICAL: This function is renamed to prevent deployment conflicts with production v1
// The production v1 function is deployed separately and must never be overwritten
// This function name ensures safe deployment without affecting existing v1 customers
exports.ocrImageLegacyV2 = onRequest(
  {
    region: "us-central1", // ใช้ us-central1 ตามที่ deploy อยู่
    cors: true,
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 10,
  },
  (req, res) => {
    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send("");
    }

    // Set CORS headers for all responses
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    cors(req, res, async () => {
      if (req.method !== "POST") {
        return res
          .status(405)
          .json({ success: false, error: "Method not allowed" });
      }

      try {
        // ===== IMAGE BASE64 =====
        if (req.body && req.body.image_base64) {
          const text = await ocrImageBase64(req.body.image_base64);
          return res.json({
            success: true,
            text, // Return แค่ text เหมือน Python script
          });
        }

        // ===== PDF BASE64 =====
        if (req.body && req.body.pdf_base64) {
          const text = await ocrPdfBase64(
            req.body.pdf_base64,
            req.body.filename || "input.pdf"
          );
          return res.json({
            success: true,
            text, // Return แค่ text เหมือน Python script
          });
        }

        // ===== INVALID =====
        return res.status(400).json({
          success: false,
          error: "Missing image_base64 or pdf_base64",
        });
      } catch (err) {
        console.error("OCR error:", err);
        console.error("Error stack:", err.stack);
        return res.status(500).json({
          success: false,
          error: err.message || "OCR failed",
        });
      }
    });
  }
);

// ---------- OCR IMAGE V2 (BASE64 → NORMALIZE → OCR → OCRResult) ----------
// NEW PIPELINE: Image → Normalize (detect orientation + rotate) → OCR
async function ocrImageBase64V2(base64, fileName = "image", manualRotation = null) {
  console.log("📸 [OCR V2] Processing image with normalization pipeline");
  const imageBuffer = Buffer.from(base64, "base64");
  
  // STEP 1: Normalize image (use manual rotation if provided, otherwise auto-detect)
  console.log(`📸 [OCR V2] Step 1: Normalizing image (manual rotation: ${manualRotation !== null ? manualRotation + "°" : "auto-detect"})...`);
  const normalized = await normalizeImage(imageBuffer, fileName, manualRotation);
  
  // STEP 2: OCR normalized image
  console.log(`📸 [OCR V2] Step 2: Running OCR on normalized image...`);
  const ocrResult = await ocrImageBufferV2(normalized.imageBuffer, fileName);
  
  // Update page dimensions to match normalized image
  ocrResult.page = {
    width: normalized.width,
    height: normalized.height,
  };
  
  // STEP 3: Convert normalized image to base64 for frontend
  const normalizedImageBase64 = normalized.imageBuffer.toString("base64");
  ocrResult.normalizedImageBase64 = normalizedImageBase64;
  
  console.log(`✅ [OCR V2] Image OCR completed with normalization pipeline`);
  console.log(`📸 [OCR V2] Normalized image base64 length: ${normalizedImageBase64.length}`);
  
  return ocrResult;
}

// ---------- UTILITIES ----------
const { normalizePdfToImages } = require("./utils/normalizePdfToImages");
const { normalizeImage } = require("./utils/normalizeImage");
const { parsePageRange } = require("./utils/parsePageRange");

// ---------- OCR PDF V2 (BASE64 → NORMALIZE → IMAGE → OCR → OCRResult) ----------
// NEW PIPELINE: PDF → Image → Normalize (detect orientation + rotate) → OCR
// This ensures Template and Scan use the same normalized images

/**
 * Scan a single page (helper for perPage mode)
 * Processes one page: PDF → Image → Normalize → OCR → Sort → Group
 * 
 * @param {Buffer} pdfBuffer - PDF buffer
 * @param {number} pageNumber - Page number (1-based)
 * @param {string} fileName - File name for logging
 * @param {number|null} manualRotation - Manual rotation (0, 90, 180, 270) or null for auto-detect
 * @returns {Promise<OCRResult|null>} OCR result for this page, or null if page not found
 */
async function scanSinglePage(pdfBuffer, pageNumber, fileName, manualRotation = null) {
  try {
    console.log(`📄 [ScanMode: perPage] Processing page ${pageNumber}`);
    
    // Convert PDF → Image (single page only)
    const normalizedPages = await normalizePdfToImages(pdfBuffer, fileName, {
      startPage: pageNumber,
      endPage: pageNumber,
    });
    
    if (!normalizedPages || normalizedPages.length === 0) {
      console.warn(`⚠️ [ScanMode: perPage] Page ${pageNumber} not found`);
      return null;
    }
    
    const page = normalizedPages[0];
    console.log(`📄 [ScanMode: perPage] Page ${pageNumber}: ${page.width}x${page.height}`);
    
    // Normalize image (use manual rotation if provided, otherwise auto-detect)
    const normalized = await normalizeImage(page.imageBuffer, `${fileName}-page-${pageNumber}`, manualRotation);
    
    // OCR normalized image
    const ocrResult = await ocrImageBufferV2(normalized.imageBuffer, `${fileName}-page-${pageNumber}`);
    
    // Update page dimensions to match normalized image
    ocrResult.page = {
      width: normalized.width,
      height: normalized.height,
    };
    
    // IMPORTANT: Words are already sorted by Y then X in ocrImageBufferV2
    // No need to sort again - words are in reading order (top → bottom, left → right)
    
    console.log(`✅ [ScanMode: perPage] Page ${pageNumber}: Completed, ${ocrResult.words?.length || 0} words`);
    
    return ocrResult;
  } catch (error) {
    console.error(`❌ [ScanMode: perPage] Error processing page ${pageNumber}:`, error);
    throw error;
  }
}

async function ocrPdfBase64V2(pdfBase64, fileName = "input.pdf", manualRotation = null, scanMode = false, options = {}) {
  try {
    // Normalize scanMode: support both boolean (backward compatible) and string ("batch"/"perPage")
    // Default to "batch" for backward compatibility
    let scanModeType = "batch"; // Default: batch mode (process all pages, combine results)
    if (typeof scanMode === "string") {
      scanModeType = scanMode === "perPage" ? "perPage" : "batch";
    } else if (scanMode === true) {
      scanModeType = "batch"; // Boolean true = batch mode (backward compatible)
    } else if (scanMode === false) {
      scanModeType = "template"; // Boolean false = template mode (first page only)
    }
    
    console.log(`📄 [OCR V2] Processing PDF with normalization pipeline: ${fileName}, scanMode: ${scanModeType}`);
    console.log(`📄 [OCR V2] PDF base64 length: ${pdfBase64?.length || 0}`);
    
    if (!pdfBase64 || pdfBase64.length === 0) {
      throw new Error("PDF base64 is empty");
    }
    
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    console.log(`📄 [OCR V2] PDF buffer size: ${pdfBuffer.length} bytes`);
    
    // STEP 1: Convert PDF → Images
    // For template setup: first page only
    // For scan mode: use pageRange, startPage/endPage, or all pages
    let pageRange = null; // null = all pages
    let startPage = undefined;
    let endPage = undefined;
    
    // Check for startPage/endPage (new feature - takes priority over pageRange)
    // IMPORTANT: Check for undefined/null explicitly (not falsy) to allow 0 values
    const hasStartPage = options?.startPage !== undefined && options?.startPage !== null;
    const hasEndPage = options?.endPage !== undefined && options?.endPage !== null;
    
    if (hasStartPage) {
      startPage = parseInt(options.startPage, 10);
      if (isNaN(startPage)) {
        console.warn(`⚠️ [OCR V2] Invalid startPage: ${options.startPage}, ignoring`);
        startPage = undefined;
      }
    }
    if (hasEndPage) {
      endPage = parseInt(options.endPage, 10);
      if (isNaN(endPage)) {
        console.warn(`⚠️ [OCR V2] Invalid endPage: ${options.endPage}, ignoring`);
        endPage = undefined;
      }
    }
    
    // Parse pageRange from options if provided (for scan mode) - only if startPage/endPage not provided
    if (!hasStartPage && !hasEndPage && scanMode && options?.pageRange) {
      if (typeof options.pageRange === "string") {
        // Parse string to array (will get totalPages later after loading PDF)
        // For now, just store the string and parse after loading PDF
        pageRange = options.pageRange;
      } else if (Array.isArray(options.pageRange)) {
        pageRange = options.pageRange;
      }
    } else if (!hasStartPage && !hasEndPage && !scanMode) {
      // Template mode: first page only (ONLY if startPage/endPage not provided)
      // If startPage/endPage is provided, use it instead
      pageRange = [1];
      console.log(`📄 [OCR V2] Template mode: No startPage/endPage provided, using first page only`);
    }
    
    // Log what we detected
    if (hasStartPage || hasEndPage) {
      console.log(`📄 [OCR V2] Detected startPage/endPage: startPage=${startPage}, endPage=${endPage}, scanMode=${scanMode}`);
    }
    
    // Log what we're processing
    if (hasStartPage || hasEndPage) {
      console.log(`📄 [OCR V2] Step 1: Converting PDF to images (pages: ${startPage || 1}-${endPage || "end"})...`);
    } else {
      console.log(`📄 [OCR V2] Step 1: Converting PDF to images (${scanMode ? (pageRange ? `pages: ${typeof pageRange === "string" ? pageRange : pageRange.join(", ")}` : "all pages") : "first page only"})...`);
    }
    
    // Load PDF first to get total pages (needed for pageRange validation)
    // Only needed if using pageRange (not needed for startPage/endPage as normalizePdfToImages handles it)
    let pageRangeArray = null;
    if (pageRange && !hasStartPage && !hasEndPage) {
      const { getPdfjsLib } = require("./utils/normalizePdfToImages");
      const pdfjsLib = await getPdfjsLib();
      const pdfUint8Array = new Uint8Array(pdfBuffer);
      const loadingTask = pdfjsLib.getDocument({ data: pdfUint8Array, verbosity: 0 });
      const pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;
      
      // Parse pageRange string to array if needed
      if (typeof pageRange === "string") {
        pageRangeArray = parsePageRange(pageRange, totalPages);
      } else if (Array.isArray(pageRange)) {
        // Validate array against total pages
        pageRangeArray = pageRange.filter(p => p >= 1 && p <= totalPages);
        if (pageRangeArray.length === 0) {
          throw new Error(`No valid pages to process. Specified pages: [${pageRange.join(", ")}], total pages: ${totalPages}`);
        }
      }
    }
    
    // Build options for normalizePdfToImages
    const normalizeOptions = {};
    if (hasStartPage || hasEndPage) {
      // Use startPage/endPage (new feature)
      if (hasStartPage) normalizeOptions.startPage = startPage;
      if (hasEndPage) normalizeOptions.endPage = endPage;
      console.log(`📄 [OCR V2] Using startPage/endPage: ${normalizeOptions.startPage || 1}-${normalizeOptions.endPage || "end"}`);
    } else if (pageRangeArray !== null) {
      // Use pageRange (existing feature)
      normalizeOptions.pageRange = pageRangeArray;
      console.log(`📄 [OCR V2] Using pageRange: [${pageRangeArray.join(", ")}]`);
    }
    // If neither is provided, normalizeOptions is empty {} = all pages (NON-BREAKING)
    
    let normalizedPages;
    try {
      normalizedPages = await normalizePdfToImages(pdfBuffer, fileName, normalizeOptions);
    } catch (pdfError) {
      console.error(`❌ [OCR V2] PDF conversion failed:`, pdfError);
      throw new Error(`PDF conversion failed: ${pdfError.message}`);
    }
    
    if (!normalizedPages || normalizedPages.length === 0) {
      throw new Error("PDF conversion failed: No pages extracted");
    }
    
    console.log(`📄 [OCR V2] Extracted ${normalizedPages.length} page(s)`);
  
  // Handle different scan modes
  if (scanModeType === "perPage") {
    // PER-PAGE MODE: Process each page separately, return per-page results
    console.log(`📄 [ScanMode: perPage] Processing pages separately...`);
    
    // IMPORTANT: In perPage mode, we need to get the total pages from the PDF first
    // because normalizedPages only contains the pages we extracted (based on startPage/endPage)
    // We need to process the ORIGINAL page range, not the extracted pages
    
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const results = [];
    
    // Get total pages from PDF (needed to validate page range)
    const { getPdfjsLib } = require("./utils/normalizePdfToImages");
    const pdfjsLib = await getPdfjsLib();
    const pdfUint8Array = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: pdfUint8Array, verbosity: 0 });
    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages;
    
    console.log(`📄 [ScanMode: perPage] PDF has ${totalPages} total pages`);
    
    // Determine page range from options (use the ORIGINAL request, not normalizedPages)
    let startPage = 1;
    let endPage = totalPages;
    
    if (options?.startPage !== undefined && options?.startPage !== null) {
      startPage = parseInt(options.startPage, 10);
      if (isNaN(startPage) || startPage < 1) {
        console.warn(`⚠️ [ScanMode: perPage] Invalid startPage: ${options.startPage}, using 1`);
        startPage = 1;
      }
    }
    if (options?.endPage !== undefined && options?.endPage !== null) {
      endPage = parseInt(options.endPage, 10);
      if (isNaN(endPage) || endPage < startPage) {
        console.warn(`⚠️ [ScanMode: perPage] Invalid endPage: ${options.endPage}, using ${totalPages}`);
        endPage = totalPages;
      }
    }
    
    // Ensure endPage doesn't exceed available pages
    endPage = Math.min(endPage, totalPages);
    
    console.log(`📄 [ScanMode: perPage] Page range: ${startPage}-${endPage} (${endPage - startPage + 1} pages)`);
    
    // Process each page separately
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      console.log(`📄 [ScanMode: perPage] Processing page ${pageNum}...`);
      
      try {
        const pageResult = await scanSinglePage(pdfBuffer, pageNum, fileName, manualRotation);
        
        if (pageResult) {
          results.push({
            pageNumber: pageNum,
            data: pageResult, // OCRResult for this page
          });
          console.log(`✅ [ScanMode: perPage] Page ${pageNum}: Completed, ${pageResult.words?.length || 0} words`);
        } else {
          console.warn(`⚠️ [ScanMode: perPage] Page ${pageNum}: No result (page not found or empty)`);
        }
      } catch (pageError) {
        console.error(`❌ [ScanMode: perPage] Error processing page ${pageNum}:`, pageError);
        // Continue processing other pages even if one fails
        // Optionally add error entry to results
        results.push({
          pageNumber: pageNum,
          error: pageError.message || "Failed to process page",
        });
      }
    }
    
    console.log(`✅ [ScanMode: perPage] Completed ${results.length} pages`);
    
    // Return per-page results
    return {
      scanMode: "perPage",
      pages: results,
    };
  } else if (scanModeType === "batch" || scanMode === true) {
    // SCAN MODE: Process all pages and combine words
    // IMPORTANT: For page-local grouping, we store words with pageNumber but keep original Y coordinates
    console.log(`📄 [OCR V2] Scan mode: Processing all ${normalizedPages.length} pages...`);
    const allWords = [];
    const pages = []; // Store per-page data for page-local grouping
    let maxWidth = 0;
    let maxHeight = 0;
    
    for (let i = 0; i < normalizedPages.length; i++) {
      const page = normalizedPages[i];
      const pageNumber = i + 1; // 1-based page number
      console.log(`📄 [OCR V2] Processing page ${pageNumber}/${normalizedPages.length}: ${page.width}x${page.height}`);
      
      try {
        // Normalize image (use manual rotation if provided, otherwise auto-detect)
        const normalized = await normalizeImage(page.imageBuffer, `${fileName}-page-${pageNumber}`, manualRotation);
        
        // OCR normalized image
        const ocrResult = await ocrImageBufferV2(normalized.imageBuffer, `${fileName}-page-${pageNumber}`);
        
        // IMPORTANT: Keep original Y coordinates (page-local) - DO NOT add offset
        // Add pageNumber to each word for page-local grouping
        if (ocrResult.words && ocrResult.words.length > 0) {
          const pageWords = ocrResult.words.map(word => ({
            ...word,
            pageNumber: pageNumber, // Store page number for page-local grouping
            // y: word.y (keep original Y - page-local coordinate)
          }));
          allWords.push(...pageWords);
          
          // Store per-page data for page-local grouping
          pages.push({
            pageNumber: pageNumber,
            width: normalized.width,
            height: normalized.height,
            words: pageWords, // Words with original Y coordinates (page-local)
          });
          
          console.log(`📄 [OCR V2] Page ${pageNumber}: Added ${pageWords.length} words (page-local Y coordinates, no offset)`);
        } else {
          // Store empty page data
          pages.push({
            pageNumber: pageNumber,
            width: normalized.width,
            height: normalized.height,
            words: [],
          });
        }
        
        // Track max dimensions
        maxWidth = Math.max(maxWidth, normalized.width);
        maxHeight = Math.max(maxHeight, normalized.height);
      } catch (pageError) {
        console.error(`❌ [OCR V2] Error processing page ${pageNumber}/${normalizedPages.length}:`, pageError);
        console.error(`❌ [OCR V2] Page error details:`, {
          message: pageError.message,
          stack: pageError.stack,
        });
        // Continue processing other pages even if one fails
        // Store empty page data
        if (page.width && page.height) {
          pages.push({
            pageNumber: pageNumber,
            width: page.width,
            height: page.height,
            words: [],
          });
          maxWidth = Math.max(maxWidth, page.width);
          maxHeight = Math.max(maxHeight, page.height);
        }
      }
    }
    
    // Create combined OCR result
    // For backward compatibility: single page object with max dimensions
    // But include pages array for page-local grouping
    const combinedResult = {
      fileName: fileName,
      page: {
        width: maxWidth,
        height: maxHeight, // Max page height (not cumulative)
      },
      words: allWords, // All words with pageNumber and original Y coordinates
      pages: pages, // Per-page data for page-local grouping
    };
    
    // IMPORTANT: Do NOT include normalizedImageBase64 in scan mode
    console.log(`✅ [OCR V2] PDF OCR completed (batch mode): ${allWords.length} words from ${normalizedPages.length} pages`);
    console.log(`📄 [OCR V2] Page-local grouping enabled: words have pageNumber, Y coordinates are page-local (no offset)`);
    return combinedResult;
  } else {
    // TEMPLATE MODE: Use only first page
    const firstPage = normalizedPages[0];
    console.log(`📄 [OCR V2] Template mode: Using first page: ${firstPage.width}x${firstPage.height}`);
    
    // STEP 2: Normalize image (use manual rotation if provided, otherwise auto-detect)
    console.log(`📄 [OCR V2] Step 2: Normalizing image (manual rotation: ${manualRotation !== null ? manualRotation + "°" : "auto-detect"})...`);
    let normalized;
    try {
      normalized = await normalizeImage(firstPage.imageBuffer, `${fileName}-page-1`, manualRotation);
    } catch (normalizeError) {
      console.error(`❌ [OCR V2] Image normalization failed:`, normalizeError);
      throw new Error(`Image normalization failed: ${normalizeError.message}`);
    }
    
    // STEP 3: OCR normalized image
    console.log(`📄 [OCR V2] Step 3: Running OCR on normalized image...`);
    let ocrResult;
    try {
      ocrResult = await ocrImageBufferV2(normalized.imageBuffer, fileName);
    } catch (ocrError) {
      console.error(`❌ [OCR V2] OCR failed:`, ocrError);
      throw new Error(`OCR failed: ${ocrError.message}`);
    }
    
    // Update page dimensions to match normalized image
    ocrResult.page = {
      width: normalized.width,
      height: normalized.height,
    };
    
    // STEP 4: Convert normalized image to base64 for frontend (template mode only)
    const normalizedImageBase64 = normalized.imageBuffer.toString("base64");
    ocrResult.normalizedImageBase64 = normalizedImageBase64;
    
    console.log(`✅ [OCR V2] PDF OCR completed with normalization pipeline`);
    console.log(`📸 [OCR V2] Normalized image base64 length: ${normalizedImageBase64.length}`);
    
    return ocrResult;
  }
  } catch (error) {
    console.error(`❌ [OCR V2] Error in ocrPdfBase64V2:`, error);
    console.error(`❌ [OCR V2] Error stack:`, error.stack);
    throw error; // Re-throw to be caught by caller
  }
}

// ---------- HELPER: Extract text from word preserving spaces and breaks ----------
/**
 * Extract text from OCR word preserving all spaces, line breaks, and formatting
 * Reads space/break information from symbol.property.detectedBreak.type
 * 
 * CRITICAL: This function preserves ALL whitespace exactly as OCR detected
 * - SPACE, EOL_SURE_SPACE, SURE_SPACE → add space
 * - LINE_BREAK → add newline
 * - HYPHEN → keep hyphen (no space added)
 * 
 * @param {Object} word - OCR word object with symbols array
 * @returns {string} Text with spaces and breaks preserved exactly as OCR detected
 */
function extractTextFromWord(word) {
  let text = "";

  if (!word || !word.symbols || word.symbols.length === 0) {
    // Fallback: use word.text if available, but don't modify it
    // IMPORTANT: Don't trim or normalize - return as-is
    return word?.text || "";
  }

  for (const symbol of word.symbols || []) {
    // Add symbol text (preserve all characters including tone marks, diacritics)
    text += symbol.text || "";

    // Read break type from symbol property to preserve spaces and line breaks
    // Vision API break types:
    // - "SPACE": Regular space
    // - "EOL_SURE_SPACE": End of line with sure space
    // - "SURE_SPACE": Sure space (high confidence)
    // - "LINE_BREAK": Line break (newline)
    // - "HYPHEN": Hyphen (no space added)
    // - "UNKNOWN": Unknown break (ignore)
    const breakType = symbol.property?.detectedBreak?.type;

    if (breakType === "SPACE" || breakType === "EOL_SURE_SPACE" || breakType === "SURE_SPACE") {
      text += " ";
    } else if (breakType === "LINE_BREAK") {
      text += "\n";
    }
    // HYPHEN and UNKNOWN: don't add anything (symbol.text already contains the character)
  }

  return text;
}

// ---------- OCR IMAGE BUFFER V2 (INTERNAL) ----------
// Internal function that OCRs an image buffer (used after normalization)
async function ocrImageBufferV2(imageBuffer, fileName = "image") {
  console.log(`📸 [OCR V2] Processing image buffer: ${fileName}`);

  // Use documentTextDetection for structured documents (preserves layout)
  const [result] = await visionClient.documentTextDetection({
    image: { content: imageBuffer },
    imageContext: {
      languageHints: ["th", "en"], // Thai first, then English
    },
  });

  const fullTextAnnotation = result.fullTextAnnotation;
  if (!fullTextAnnotation) {
    console.warn("⚠️ [OCR V2] No fullTextAnnotation found");
    return {
      fileName,
      page: { width: 0, height: 0 },
      words: [],
    };
  }

  // Extract page dimensions
  const page = fullTextAnnotation.pages?.[0];
  const pageWidth = page?.width || 0;
  const pageHeight = page?.height || 0;

  // Extract words with bounding boxes
  // IMPORTANT: Use extractTextFromWord to preserve all spaces, line breaks, and formatting
  const words = [];
  
  if (fullTextAnnotation.pages) {
    for (const page of fullTextAnnotation.pages) {
      if (page.blocks) {
        for (const block of page.blocks) {
          if (block.paragraphs) {
            for (const paragraph of block.paragraphs) {
              if (paragraph.words) {
                for (const word of paragraph.words) {
                  // Use extractTextFromWord to preserve spaces and breaks from OCR
                  const wordText = extractTextFromWord(word);
                  
                  if (wordText && word.boundingBox?.vertices) {
                    const vertices = word.boundingBox.vertices;
                    if (vertices.length >= 2) {
                      const x = Math.min(...vertices.map((v) => v.x || 0));
                      const y = Math.min(...vertices.map((v) => v.y || 0));
                      const maxX = Math.max(...vertices.map((v) => v.x || 0));
                      const maxY = Math.max(...vertices.map((v) => v.y || 0));
                      const w = maxX - x;
                      const h = maxY - y;
                      
                      if (w > 0 && h > 0) {
                        words.push({
                          text: wordText,
                          x,
                          y,
                          w,
                          h,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  
  console.log(`📊 [OCR V2] Extracted ${words.length} words from documentTextDetection`);
  
  // Sort words by Y position (top to bottom), then X (left to right)
  // IMPORTANT: Use ROW_TOLERANCE (10px) to determine if words are on the same row
  // This ensures proper row ordering (records start from top row, not middle of page)
  const ROW_TOLERANCE = 10; // pixels - adjust based on DPI
  words.sort((a, b) => {
    const yDiff = Math.abs(a.y - b.y);
    if (yDiff > ROW_TOLERANCE) {
      return a.y - b.y; // Different rows - sort by Y (top → bottom)
    }
    return a.x - b.x; // Same row - sort by X (left → right)
  });
  
  // Log first few words for debugging row order
  if (words.length > 0) {
    const firstRowY = words[0].y;
    const firstRowWords = words.filter(w => Math.abs(w.y - firstRowY) <= ROW_TOLERANCE).slice(0, 3);
    const firstRowPreview = firstRowWords.map(w => w.text).join(" ");
    console.log(`📄 [RowSort] Total words: ${words.length}, firstRowY: ${firstRowY}, firstRowPreview: "${firstRowPreview}..."`);
  }

  console.log(`✅ [OCR V2] Image buffer OCR completed. Found ${words.length} words`);
  
  // Log sample words to verify space preservation and number detection
  if (words.length > 0) {
    const sampleWords = words.slice(0, 10);
    console.log(`📝 [OCR V2] Sample words (first 10):`, sampleWords.map(w => ({
      text: `"${w.text}"`,
      hasSpace: w.text.includes(" "),
      hasNewline: w.text.includes("\n"),
      length: w.text.length,
      isNumber: /^\d+$/.test(w.text.trim()),
      containsNumber: /\d/.test(w.text),
    })));
    
    // Check for potential number misreadings (common OCR errors: 5→เก, 0→O, 1→l)
    const numberMisreadings = words.filter(w => {
      const text = w.text.trim();
      // Check if text looks like a misread number (Thai characters that might be numbers)
      return /^[เกกขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ]+$/.test(text) && text.length === 1;
    });
    if (numberMisreadings.length > 0) {
      console.warn(`⚠️ [OCR V2] Potential number misreadings detected:`, numberMisreadings.slice(0, 5).map(w => `"${w.text}"`));
    }
  }
  
  // Additional debugging info
  if (words.length === 0) {
    console.warn("⚠️ [OCR V2] No words extracted from OCR result");
    console.log("📊 [OCR V2] FullTextAnnotation details:", {
      hasPages: !!fullTextAnnotation.pages,
      pagesCount: fullTextAnnotation.pages?.length || 0,
      hasText: !!fullTextAnnotation.text,
      textLength: fullTextAnnotation.text?.length || 0,
      textPreview: fullTextAnnotation.text?.substring(0, 200) || "(no text)",
    });
  }
  
  return {
    fileName,
    page: {
      width: pageWidth,
      height: pageHeight,
    },
    words,
  };
}

// ---------- OCR IMAGE V2 FUNCTION ----------
exports.ocrImageV2 = onRequest(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 540,
    memory: "4GiB", // Increased from 2GiB for large multi-page PDF processing (39+ pages)
    maxInstances: 10,
  },
  (req, res) => {
    // IMPORTANT: Set CORS headers BEFORE any async operations
    // This ensures CORS headers are always sent, even if function crashes
    const setCorsHeaders = () => {
      res.set("Access-Control-Allow-Origin", "*");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type");
    };
    
    // Handle preflight requests
    if (req.method === "OPTIONS") {
      setCorsHeaders();
      res.set("Access-Control-Max-Age", "3600");
      return res.status(204).send("");
    }

    // Set CORS headers for all responses
    setCorsHeaders();

    cors(req, res, async () => {
      if (req.method !== "POST") {
        return res
          .status(405)
          .json({ success: false, error: "Method not allowed" });
      }

      try {
        // Debug logging
        console.log("📥 [OCR V2] Request received:", {
          method: req.method,
          contentType: req.headers["content-type"],
          hasBody: !!req.body,
          bodyKeys: req.body ? Object.keys(req.body) : [],
          hasImageBase64: !!(req.body && req.body.image_base64),
          hasPdfBase64: !!(req.body && req.body.pdf_base64),
        });

        // ===== IMAGE BASE64 =====
        if (req.body && req.body.image_base64) {
          console.log("📸 [OCR V2] Processing image...");
          const fileName = req.body.fileName || "image";
          const manualRotation = req.body.rotation !== undefined && req.body.rotation !== null 
            ? parseInt(req.body.rotation) 
            : null;
          if (manualRotation !== null) {
            console.log(`🔄 [OCR V2] Using manual rotation: ${manualRotation}°`);
          }
          const ocrResult = await ocrImageBase64V2(
            req.body.image_base64,
            fileName,
            manualRotation
          );
          return res.json({
            success: true,
            result: ocrResult, // Returns OCRResult
          });
        }

        // ===== PDF BASE64 =====
        if (req.body && req.body.pdf_base64) {
          console.log("📄 [OCR V2] Processing PDF...");
          const fileName = req.body.fileName || req.body.filename || "input.pdf";
          const manualRotation = req.body.rotation !== undefined && req.body.rotation !== null 
            ? parseInt(req.body.rotation) 
            : null;
          // Support both boolean (backward compatible) and string scanMode
          const scanModeInput = req.body.scanMode;
          let scanMode = false; // Default: template mode (backward compatible)
          if (typeof scanModeInput === "string" && scanModeInput === "perPage") {
            scanMode = "perPage"; // New: perPage mode
          } else if (scanModeInput === true) {
            scanMode = true; // Boolean true = batch mode (backward compatible)
          } else if (scanModeInput === false) {
            scanMode = false; // Boolean false = template mode (backward compatible)
          }
          // If scanMode is undefined/null, default to false (template mode)
          
          const pageRange = req.body.pageRange; // Optional: page range string like "1,2-6,20-22"
          const startPage = req.body.startPage; // Optional: start page number (1-based, inclusive)
          const endPage = req.body.endPage; // Optional: end page number (1-based, inclusive)
          
          // Debug: Log what we received
          console.log(`📋 [OCR V2] Request body keys:`, Object.keys(req.body));
          console.log(`📋 [OCR V2] Received startPage:`, startPage, `(type: ${typeof startPage})`);
          console.log(`📋 [OCR V2] Received endPage:`, endPage, `(type: ${typeof endPage})`);
          console.log(`📋 [OCR V2] Received pageRange:`, pageRange);
          console.log(`📋 [OCR V2] Received scanMode:`, scanModeInput, `→ normalized: ${scanMode}`);
          
          if (manualRotation !== null) {
            console.log(`🔄 [OCR V2] Using manual rotation: ${manualRotation}°`);
          }
          if (startPage !== undefined || endPage !== undefined) {
            console.log(`📋 [OCR V2] Page range: ${startPage || 1}-${endPage || "end"}`);
          } else if (pageRange) {
            console.log(`📋 [OCR V2] Page range: ${pageRange}`);
          }
          
          // Determine mode description
          let modeDescription = "TEMPLATE (first page, with image)";
          if (scanMode === "perPage") {
            modeDescription = "PER-PAGE (process each page separately)";
          } else if (scanMode === true) {
            modeDescription = "BATCH (all pages, no image)";
          }
          console.log(`📋 [OCR V2] Mode: ${modeDescription}`);
          
          // Build options object (only include defined values)
          const ocrOptions = {};
          if (startPage !== undefined || endPage !== undefined) {
            // New: startPage/endPage takes priority
            if (startPage !== undefined) ocrOptions.startPage = startPage;
            if (endPage !== undefined) ocrOptions.endPage = endPage;
            console.log(`📋 [OCR V2] Built ocrOptions with startPage/endPage:`, ocrOptions);
          } else if (pageRange !== undefined) {
            // Existing: pageRange
            ocrOptions.pageRange = pageRange;
            console.log(`📋 [OCR V2] Built ocrOptions with pageRange:`, ocrOptions);
          } else {
            console.log(`📋 [OCR V2] No page options provided, ocrOptions is empty:`, ocrOptions);
          }
          // If neither is provided, ocrOptions is {} = all pages (NON-BREAKING)
          
          const ocrResult = await ocrPdfBase64V2(
            req.body.pdf_base64,
            fileName,
            manualRotation,
            scanMode,
            ocrOptions
          );
          
          // Handle different response formats based on scanMode
          if (scanMode === "perPage" && ocrResult.scanMode === "perPage") {
            // Per-page mode: return per-page results
            return res.json({
              success: true,
              scanMode: "perPage",
              pages: ocrResult.pages,
            });
          } else {
            // Batch or template mode: return original format (backward compatible)
            return res.json({
              success: true,
              result: ocrResult, // Returns OCRResult
            });
          }
        }

        // ===== INVALID =====
        console.error("❌ [OCR V2] Missing required field. Request body:", JSON.stringify(req.body).substring(0, 200));
        return res.status(400).json({
          success: false,
          error: "Missing image_base64 or pdf_base64",
        });
      } catch (err) {
        console.error("❌ [OCR V2] Error:", err);
        console.error("❌ [OCR V2] Error stack:", err.stack);
        console.error("❌ [OCR V2] Error name:", err.name);
        console.error("❌ [OCR V2] Error message:", err.message);
        
        // IMPORTANT: Set CORS headers even on error (already set above, but ensure)
        // Use the setCorsHeaders from outer scope
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.set("Access-Control-Allow-Headers", "Content-Type");
        
        // Return error response with CORS headers
        try {
          return res.status(500).json({
            success: false,
            error: err.message || "OCR V2 failed",
            errorType: err.name || "UnknownError",
          });
        } catch (responseError) {
          // If response already sent, log the error
          console.error("❌ [OCR V2] Failed to send error response:", responseError);
        }
      }
    });
  }
);