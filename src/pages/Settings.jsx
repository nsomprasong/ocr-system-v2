// src/pages/Settings.jsx
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Stack,
  Alert,
} from "@mui/material"
import { useState } from "react"
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
} from "firebase/auth"
import { auth } from "../firebase"

export default function Settings({ onDone }) {
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")

  const handleChangePassword = async () => {
    setError("")
    setSuccess("")

    if (newPassword.length < 6)
      return setError("รหัสผ่านใหม่ต้องอย่างน้อย 6 ตัว")

    if (newPassword !== confirmPassword)
      return setError("รหัสผ่านใหม่ไม่ตรงกัน")

    try {
      const user = auth.currentUser
      if (!user) throw new Error("no-user")

      // re-authenticate
      const credential = EmailAuthProvider.credential(
        user.email,
        currentPassword
      )

      await reauthenticateWithCredential(user, credential)
      await updatePassword(user, newPassword)

      setSuccess("เปลี่ยนรหัสผ่านเรียบร้อยแล้ว")

      setTimeout(() => {
        onDone() // 👈 กลับหน้า Scan
      }, 1000)
    } catch (e) {
      setError("รหัสผ่านปัจจุบันไม่ถูกต้อง")
    }
  }

  return (
    <Box maxWidth={480}>
      <Typography variant="h5" fontWeight={600} mb={2}>
        ตั้งค่าระบบ
      </Typography>

      <Card variant="outlined" sx={{ boxShadow: "none" }}>
        <CardContent>
          <Typography fontWeight={600} mb={1}>
            เปลี่ยนรหัสผ่าน
          </Typography>

          <Stack spacing={2}>
            <TextField
              label="รหัสผ่านปัจจุบัน"
              type="password"
              size="small"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />

            <TextField
              label="รหัสผ่านใหม่"
              type="password"
              size="small"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />

            <TextField
              label="ยืนยันรหัสผ่านใหม่"
              type="password"
              size="small"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />

            <Button
              variant="contained"
              onClick={handleChangePassword}
            >
              บันทึกรหัสผ่านใหม่
            </Button>

            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">{success}</Alert>}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  )
}
