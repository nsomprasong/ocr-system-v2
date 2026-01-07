import {
  Box,
  List,
  ListItemButton,
  ListItemText,
  Typography,
  Divider,
  Button,
} from "@mui/material"
import { signOut } from "firebase/auth"
import { auth } from "../firebase"

export default function Sidebar({ page, onNavigate, credits }) {
  const user = auth.currentUser

  const menu = [
    { key: "scan", label: "สแกนเอกสาร" },
    { key: "excel", label: "ตั้งค่าคอลัมน์" },
    { key: "settings", label: "ตั้งค่าระบบ" },
  ]

  return (
    <Box
      sx={{
        width: 240,
        bgcolor: "#1e293b",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ===== Header ===== */}
      <Box sx={{ p: 2 }}>
        <Typography variant="h6">OCR SYSTEM</Typography>

        {user && (
          <Box>
            <Typography
              fontSize={12}
              sx={{ mt: 0.5, opacity: 0.8, wordBreak: "break-all" }}
            >
              {user.email}
            </Typography>

            <Typography
              fontSize={12}
              sx={{ mt: 0.5, opacity: 0.8 }}
            >
              เครดิตคงเหลือ: {credits} หน้า
            </Typography>
          </Box>
        )}
      </Box>

      <Divider sx={{ borderColor: "#334155" }} />

      {/* ===== Menu ===== */}
      <List sx={{ flex: 1, p: 1 }}>
        {menu.map((m) => (
          <ListItemButton
            key={m.key}
            selected={page === m.key}
            onClick={() => onNavigate(m.key)}
            sx={{
              borderRadius: 1,
              mb: 0.5,
              color: "#e5e7eb",
              "&.Mui-selected": {
                bgcolor: "#334155",
              },
            }}
          >
            <ListItemText primary={m.label} />
          </ListItemButton>
        ))}
      </List>

      <Divider sx={{ borderColor: "#334155" }} />

      {/* ===== Logout ===== */}
      <Box sx={{ p: 2 }}>
        <Button
          fullWidth
          size="small"
          variant="outlined"
          sx={{
            color: "#fca5a5",
            borderColor: "#fca5a5",
          }}
          onClick={async () => {
            await signOut(auth)
            window.location.reload()
          }}
        >
          ออกจากระบบ
        </Button>
      </Box>
    </Box>
  )
}
