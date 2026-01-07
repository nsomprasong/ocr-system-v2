const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");
const { Storage } = require("@google-cloud/storage");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors")({ origin: true });

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

// ---------- MAIN FUNCTION ----------
exports.ocrImage = onRequest(
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
