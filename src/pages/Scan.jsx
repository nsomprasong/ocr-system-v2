import { useState } from "react"
import {
  Box,
  Card,
  CardContent,
  Typography,
  Button,
  Stack,
  Chip,
  Alert,
  Divider,
  IconButton,
  CircularProgress,
} from "@mui/material"
import CloudUploadIcon from "@mui/icons-material/CloudUpload"
import CloseIcon from "@mui/icons-material/Close"
import { getPdfPageCount, isPdfFile } from "../services/pdf.service"

export default function Scan({ credits, files, setFiles, onNext }) {
  const [loadingFiles, setLoadingFiles] = useState(new Set())

  const handleSelect = async (fileList) => {
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
  }

  const removeFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleDrop = (e) => {
    e.preventDefault()
    handleSelect(e.dataTransfer.files)
  }

  const totalPages = files.reduce((s, f) => s + f.pageCount, 0)
  const creditEnough = credits >= totalPages

  return (
    <Stack spacing={3}>

      {/* Header */}
      <Box>
        <Typography variant="h5">สแกนเอกสาร</Typography>
        <Typography color="text.secondary">
          ขั้นตอนที่ 1 จาก 2 • เลือกไฟล์เอกสาร
        </Typography>
      </Box>

      {/* Summary */}
      <Card>
        <CardContent>
          <Stack direction="row" spacing={2}>
            <Chip label={`ไฟล์ ${files.length}`} />
            <Chip label={`ประมาณ ${totalPages} หน้า`} />
            <Chip
              label={`เครดิตคงเหลือ ${credits} หน้า`}
              color={creditEnough ? "success" : "error"}
            />
          </Stack>
        </CardContent>
      </Card>

      {/* Drop Zone */}
      <Card
        sx={{
          border: "2px dashed #cbd5e1",
          bgcolor: "#f8fafc",
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <CardContent sx={{ textAlign: "center", py: 2 }}>
          <CloudUploadIcon sx={{ fontSize: 40, color: "#64748b" }} />
          <Typography variant="subtitle1" mt={1}>
            ลากไฟล์มาวางที่นี่
          </Typography>
          <Typography color="text.secondary" fontSize={13}>
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
            size="small"
            sx={{ mt: 1.5 }}
            variant="outlined"
            onClick={() =>
              document.getElementById("scan-file-input").click()
            }
          >
            เลือกไฟล์
          </Button>
        </CardContent>
      </Card>

      {/* File List */}
      {files.length > 0 && (
        <Box
          sx={{
            maxHeight: 240,
            overflowY: "auto",
            border: "1px solid #e5e7eb",
            borderRadius: 1,
          }}
        >
          <Stack spacing={0}>
            {files.map((f, i) => (
              <Box key={i}>
                <Card
                  variant="outlined"
                  sx={{
                    borderRadius: 0,
                    boxShadow: "none",
                    border: "none",
                  }}
                >
                  <CardContent
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      py: 0.5,
                      px: 1.5,
                      "&:last-child": { pb: 0.5 },
                    }}
                  >
                    <Box>
                      <Typography fontSize={14} noWrap>
                        {f.originalName}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {loadingFiles.has(f.originalName) ? (
                          <Box display="flex" alignItems="center" gap={0.5}>
                            <CircularProgress size={10} />
                            กำลังนับจำนวนหน้า...
                          </Box>
                        ) : (
                          `${f.pageCount} หน้า`
                        )}
                      </Typography>
                    </Box>

                    <Box display="flex" alignItems="center" gap={0.5}>
                      {!loadingFiles.has(f.originalName) && (
                        <Chip
                          label={`${f.pageCount} หน้า`}
                          size="small"
                          sx={{ height: 20, fontSize: 11 }}
                        />
                      )}
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => removeFile(i)}
                        disabled={loadingFiles.has(f.originalName)}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </CardContent>
                </Card>

                {i < files.length - 1 && <Divider />}
              </Box>
            ))}
          </Stack>
        </Box>
      )}

      {/* Credit Warning */}
      {files.length > 0 && !creditEnough && (
        <Alert severity="warning">
          เอกสารชุดนี้ใช้เครดิต {totalPages} หน้า
          แต่คุณมีเครดิตเหลือ {credits} หน้า
        </Alert>
      )}

      {/* Action */}
      <Box display="flex" justifyContent="flex-end">
        <Button
          variant="contained"
          size="large"
          disabled={files.length === 0 || !creditEnough}
          onClick={onNext}
        >
          ไปขั้นตอนถัดไป (ยังไม่สแกน)
        </Button>
      </Box>

    </Stack>
  )
}
