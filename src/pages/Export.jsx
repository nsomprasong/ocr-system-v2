import { auth } from "../firebase"
import { updateUserCredits } from "../services/user.service"
import { useState } from "react"
import {
  Box,
  Card,
  CardContent,
  Typography,
  RadioGroup,
  FormControlLabel,
  Radio,
  Button,
  Divider,
  Alert,
  CircularProgress,
  Stack,
  Chip,
  IconButton,
  TextField,
  LinearProgress,
} from "@mui/material"
import PlayArrowIcon from "@mui/icons-material/PlayArrow"
import CloseIcon from "@mui/icons-material/Close"
import { ocrFile } from "../services/ocr.service"
import { extractDataFromText } from "../services/textProcessor.service"
import {
  createSeparateExcelFiles,
  createCombinedExcelFile,
} from "../services/excel.service"
import {
  saveExcelToServer,
  saveWordToServer,
} from "../services/fileExport.service"

export default function Export({
  scanFiles,
  credits,
  columnConfig,
  onConsume,
  onDone,
}) {
  const [mode, setMode] = useState("separate")
  const [fileType, setFileType] = useState("xlsx") // xlsx หรือ doc
  const [status, setStatus] = useState("idle")
  const [progress, setProgress] = useState(0)
  const [currentFile, setCurrentFile] = useState("")
  const [error, setError] = useState("")

  const totalPages = scanFiles.reduce((s, f) => s + f.pageCount, 0)
  const creditEnough = credits >= totalPages

  const handleRun = async () => {
    if (!creditEnough) return

    const user = auth.currentUser
    if (!user) return

    setStatus("running")
    setProgress(0)
    setError("")
    setCurrentFile("กำลังเริ่มต้น...")

    try {
      console.log(`🚀 Starting export process...`)
      console.log(`📊 Total files: ${scanFiles.length}, Total pages: ${totalPages}`)
      
      // 🔥 อัปเดตเครดิต Firestore ก่อน (พร้อม timeout)
      console.log(`💳 Updating credits: ${credits} -> ${credits - totalPages}`)
      setCurrentFile("กำลังอัปเดตเครดิต...")
      setProgress(5) // เริ่มต้นที่ 5%
      
      const newCredits = credits - totalPages
      try {
        await updateUserCredits(user.uid, newCredits)
        console.log(`✅ Credits updated successfully`)
        // อัปเดต state ใน local ด้วย
        onConsume(totalPages) // อัปเดต credits ใน App.jsx
      } catch (creditError) {
        console.error(`❌ Failed to update credits:`, creditError)
        setError(`ไม่สามารถอัปเดตเครดิตได้: ${creditError.message}. กรุณาลองใหม่อีกครั้ง`)
        setStatus("idle")
        setProgress(0)
        setCurrentFile("")
        return // หยุดการทำงานถ้าอัปเดตเครดิตไม่สำเร็จ
      }
      
      setProgress(10) // อัปเดต progress หลังจากอัปเดตเครดิต

      // ประมวลผลไฟล์ทีละไฟล์
      const fileData = []

      for (let i = 0; i < scanFiles.length; i++) {
        const fileItem = scanFiles[i]
        setCurrentFile(fileItem.originalName)
        
        // อัปเดต progress เริ่มต้น
        const baseProgress = (i / scanFiles.length) * 100
        setProgress(baseProgress)
        
        console.log(`📄 Processing file ${i + 1}/${scanFiles.length}: ${fileItem.originalName}`)

        try {
          // เรียก OCR พร้อม timeout (เหมือน Python script - ได้ text กลับมา)
          console.log(`🔍 Starting OCR for: ${fileItem.originalName}`)
          const ocrResult = await Promise.race([
            ocrFile(fileItem.file),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error("OCR timeout: เกิน 5 นาที")), 5 * 60 * 1000)
            )
          ])
          
          // ตรวจสอบว่า ocrResult เป็น string หรือไม่
          const ocrText = typeof ocrResult === "string" ? ocrResult : (ocrResult?.text || "")
          
          console.log(`✅ OCR completed for: ${fileItem.originalName}`)
          console.log(`📄 OCR result type:`, typeof ocrResult)
          console.log(`📄 OCR text length: ${ocrText?.length || 0}`)
          console.log(`📄 OCR text preview (first 200 chars):`, typeof ocrText === "string" ? ocrText.substring(0, 200) : "(not a string)")

          // ตรวจสอบว่า ocrText เป็น string และไม่ว่าง
          if (!ocrText || typeof ocrText !== "string" || ocrText.trim().length === 0) {
            console.warn(`⚠️ OCR returned empty or invalid text. Result:`, ocrResult)
            setError(`ไม่พบข้อมูลในไฟล์ ${fileItem.originalName}. OCR ไม่สามารถอ่านข้อความได้`)
            continue
          }

          // แยกข้อมูลจาก OCR text (เหมือน Python script เป๊ะๆ)
          console.log(`📝 Extracting data from OCR text...`)
          const names = extractDataFromText(ocrText)
          console.log(`✅ Extracted ${names.length} names from text`)
          
          if (names.length === 0) {
            console.warn(`⚠️ No data extracted from OCR text. OCR text was: "${ocrText.substring(0, 100)}"`)
            setError(`ไม่พบข้อมูลในไฟล์ ${fileItem.originalName}. OCR text ที่ได้: "${ocrText.substring(0, 100) || "(empty)"}"`)
          }

          // สร้างข้อมูลตาม columnConfig (เหมือน Python script)
          const data = names.map((name, idx) => {
            const row = {}
            columnConfig.forEach((col, colIdx) => {
              if (col.mode === "auto") {
                // คอลัมน์แรกที่เป็น auto mode จะเป็นชื่อ-สกุล
                if (colIdx === 0) {
                  row[col.key] = name
                } else {
                  // คอลัมน์อื่นๆ ที่เป็น auto mode ยังไม่ implement
                  row[col.key] = ""
                }
              } else {
                // Manual mode - ใช้ค่าคงที่
                row[col.key] = col.manualValue || ""
              }
            })
            
            // เพิ่มชื่อไฟล์ในแถวแรก (เหมือนโค้ด Python: file if i == 0 else "")
            const filenameCol = columnConfig.find(
              (col) => col.label && col.label.includes("ชื่อไฟล์")
            )
            if (filenameCol && idx === 0) {
              row[filenameCol.key] = fileItem.originalName
            }
            
            return row
          })

          fileData.push({
            filename: fileItem.originalName,
            data,
          })
          
          // อัปเดต progress หลังจากประมวลผลเสร็จ
          const fileProgress = ((i + 1) / scanFiles.length) * 100
          setProgress(fileProgress)
          console.log(`✅ File ${i + 1}/${scanFiles.length} completed: ${fileItem.originalName}`)
        } catch (err) {
          console.error(`❌ Error processing ${fileItem.originalName}:`, err)
          setError(`เกิดข้อผิดพลาดในการประมวลผล ${fileItem.originalName}: ${err.message}`)
          // ยังคงดำเนินการต่อกับไฟล์อื่นๆ แต่ต้องอัปเดต progress
          const fileProgress = ((i + 1) / scanFiles.length) * 100
          setProgress(fileProgress)
        }
      }

      // ดาวน์โหลดไฟล์
      console.log(`💾 Downloading ${fileData.length} files...`)
      setCurrentFile("กำลังดาวน์โหลดไฟล์...")
      setProgress(95) // เกือบเสร็จแล้ว
      
      if (fileData.length > 0) {
        try {
          if (fileType === "xlsx") {
            // ดาวน์โหลดไฟล์ Excel
            if (mode === "separate") {
              createSeparateExcelFiles(fileData, columnConfig)
            } else {
              createCombinedExcelFile(fileData, columnConfig, "combined.xlsx")
            }
          } else {
            // Word files ต้องใช้ backend API
            setError("ไฟล์ Word ต้องใช้ Backend API เท่านั้น กรุณาเปลี่ยนเป็น Excel")
            setStatus("idle")
            return
          }
        } catch (downloadError) {
          console.error("Error downloading:", downloadError)
          setError(`เกิดข้อผิดพลาดในการดาวน์โหลด: ${downloadError.message}`)
          setStatus("idle")
          return
        }
      }

      // onConsume ถูกเรียกแล้วตอนอัปเดตเครดิตสำเร็จ (บรรทัด 77)
      setStatus("success")

      setTimeout(() => {
        setStatus("idle")
        setProgress(0)
        setCurrentFile("")
        onDone()
      }, 2000)
    } catch (err) {
      console.error("❌ Export Error:", err)
      setError(`เกิดข้อผิดพลาด: ${err.message}. กรุณาตรวจสอบ console สำหรับรายละเอียดเพิ่มเติม`)
      setStatus("idle")
      setProgress(0)
      setCurrentFile("")
    }
  }

  return (
    <Box sx={{ height: "calc(100vh - 120px)", display: "flex", flexDirection: "column" }}>
      <Box sx={{ flexShrink: 0, mb: 2 }}>
        <Typography variant="h5">สแกนและบันทึกไฟล์</Typography>
        <Typography color="text.secondary" variant="body2">
          ขั้นตอนที่ 2 จาก 2 • ตรวจสอบและสั่งงาน
        </Typography>
      </Box>

      {/* Scrollable Content */}
      <Box sx={{ flex: 1, overflowY: "auto", pr: 1 }}>
        <Stack spacing={1.5}>
          {/* Summary */}
          <Card variant="outlined">
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Stack direction="row" spacing={1.5} flexWrap="wrap">
                <Chip label={`ไฟล์ ${scanFiles.length}`} size="small" />
                <Chip label={`รวม ${totalPages} หน้า`} size="small" />
                <Chip
                  label={`เครดิตคงเหลือ ${credits} หน้า`}
                  color={creditEnough ? "success" : "error"}
                  size="small"
                />
              </Stack>
            </CardContent>
          </Card>

          {/* Export Mode & File Type - รวมกัน */}
          <Card variant="outlined">
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Stack spacing={1.5}>
                <Box>
                  <Typography variant="body2" fontWeight={500} gutterBottom>
                    รูปแบบการบันทึกไฟล์
                  </Typography>
                  <RadioGroup
                    row
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    sx={{ mt: 0.5 }}
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

                <Box>
                  <Typography variant="body2" fontWeight={500} gutterBottom>
                    ประเภทไฟล์
                  </Typography>
                  <RadioGroup
                    row
                    value={fileType}
                    onChange={(e) => setFileType(e.target.value)}
                    sx={{ mt: 0.5 }}
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
              </Stack>
            </CardContent>
          </Card>

          {/* Destination */}
          <Card variant="outlined">
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Typography variant="body2" fontWeight={500} gutterBottom>
                ปลายทางจัดเก็บไฟล์
              </Typography>
              <TextField
                fullWidth
                size="small"
                disabled
                value="โฟลเดอร์ Downloads ของเบราว์เซอร์"
                sx={{ mt: 0.5 }}
              />
            </CardContent>
          </Card>

          {/* File Preview (Compact) */}
          <Card variant="outlined">
            <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
              <Typography variant="body2" fontWeight={500} gutterBottom>
                ไฟล์ที่จะถูกสร้าง ({scanFiles.length} ไฟล์)
              </Typography>
              <Box
                sx={{
                  maxHeight: 150,
                  overflowY: "auto",
                  border: "1px solid #e5e7eb",
                  borderRadius: 1,
                  mt: 1,
                }}
              >
                <Stack spacing={0}>
                  {scanFiles.map((f, i) => (
                    <Box key={i}>
                      <Box
                        sx={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          px: 1.5,
                          py: 0.75,
                        }}
                      >
                        <Typography
                          fontSize={13}
                          lineHeight={1.2}
                          noWrap
                          sx={{ flex: 1, mr: 1 }}
                        >
                          {f.originalName}
                        </Typography>
                        <Chip
                          label={`${f.pageCount} หน้า`}
                          size="small"
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      </Box>
                      {i < scanFiles.length - 1 && <Divider />}
                    </Box>
                  ))}
                </Stack>
              </Box>
            </CardContent>
          </Card>

          {/* Progress */}
          {status === "running" && (
            <Card variant="outlined">
              <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
                <Stack spacing={1}>
                  <Typography variant="body2" color="text.secondary">
                    {currentFile ? `กำลังประมวลผล: ${currentFile}` : "กำลังเริ่มต้น..."}
                  </Typography>
                  <LinearProgress 
                    variant="determinate" 
                    value={progress} 
                    sx={{ height: 6, borderRadius: 3 }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {Math.round(progress)}% เสร็จสมบูรณ์
                  </Typography>
                  {progress === 0 && (
                    <Alert severity="info" sx={{ mt: 0.5 }} size="small">
                      ⏳ กำลังรอการตอบกลับจาก OCR API... กรุณารอสักครู่
                    </Alert>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}

          {/* Status Messages */}
          {status === "success" && (
            <Alert severity="success" sx={{ mt: 0.5 }}>
              สแกนและดาวน์โหลดไฟล์เรียบร้อยแล้ว ไฟล์{fileType === "xlsx" ? " Excel" : " Word"} ถูกดาวน์โหลดไปที่โฟลเดอร์ Downloads
            </Alert>
          )}

          {error && (
            <Alert severity="error" onClose={() => setError("")} sx={{ mt: 0.5 }}>
              {error}
            </Alert>
          )}

          {!creditEnough && (
            <Alert severity="error" sx={{ mt: 0.5 }}>
              เครดิตไม่เพียงพอสำหรับเอกสารชุดนี้
            </Alert>
          )}
        </Stack>
      </Box>

      {/* Fixed Action Button */}
      <Box sx={{ flexShrink: 0, pt: 2, pb: 1, borderTop: 1, borderColor: "divider", bgcolor: "background.paper" }}>
        <Button
          variant="contained"
          size="large"
          fullWidth
          startIcon={status === "running" ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
          disabled={!creditEnough || status === "running"}
          onClick={handleRun}
        >
          {status === "running" ? "กำลังประมวลผล..." : "สแกนและบันทึกไฟล์"}
        </Button>
      </Box>
    </Box>
  )
}
