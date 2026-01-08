import { useEffect, useState } from "react"
import { onAuthStateChanged, signOut } from "firebase/auth"

import { auth } from "./firebase"
import {
  getUserProfile,
  createUserProfile,
} from "./services/user.service"

import AppLayout from "./components/AppLayout"
import Login from "./pages/Login"
import Scan from "./pages/Scan"
import ExcelMode from "./pages/ExcelMode"
import Export from "./pages/Export"
import Settings from "./pages/Settings"

export default function App() {
  const [page, setPage] = useState("scan")

  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  const [credits, setCredits] = useState(0)
  const [scanFiles, setScanFiles] = useState([])

  const [columnConfig, setColumnConfig] = useState([
    {
      key: "name",
      label: "รายชื่อ",
      mode: "auto",
      manualValue: "",
      width: 30,
    },
    {
      key: "houseNumber",
      label: "บ้านเลขที่",
      mode: "auto",
      manualValue: "",
      width: 15,
    },
    {
      key: "moo",
      label: "หมู่",
      mode: "auto",
      manualValue: "",
      width: 12,
    },
    {
      key: "tambon",
      label: "ตำบล",
      mode: "auto",
      manualValue: "",
      width: 20,
    },
    {
      key: "filename",
      label: "ชื่อไฟล์ภาพ",
      mode: "auto",
      manualValue: "",
      width: 35,
    },
  ])

  // 🔐 Auth + Firestore bootstrap
  useEffect(() => {
    console.log("🔧 Setting up auth listener...")
    
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      console.log("🔐 Auth state changed:", u ? u.email : "null")
      
      if (!u) {
        console.log("❌ No user - showing login")
        setUser(null)
        setLoading(false)
        return
      }

      console.log("✅ User found:", u.email)
      console.log("📧 Email verified:", u.emailVerified)
      
      // ตรวจสอบ email verification
      if (!u.emailVerified) {
        console.log("❌ Email not verified - signing out")
        setUser(null)
        setLoading(false)
        // Sign out เพื่อบังคับให้กลับไปหน้า login
        signOut(auth).catch((err) => {
          console.error("Error signing out:", err)
        })
        return
      }
      
      setUser(u)

      // ตั้งค่า default values ก่อน
      setCredits(100)
      
      // แสดง app ทันที (ไม่รอ profile)
      setLoading(false)
      console.log("✅ App visible - loading profile in background")
      
      // โหลด profile แบบ background (ไม่ block UI)
      try {
        let profile = null
        try {
          // ใช้ timeout เพื่อไม่ให้ค้างนาน
          profile = await Promise.race([
            getUserProfile(u.uid),
            new Promise((resolve) => setTimeout(() => resolve(null), 3000))
          ])
          console.log("📄 Profile:", profile ? "found" : "not found")
        } catch (getError) {
          console.warn("⚠️ Could not get profile (may be offline):", getError.message)
          profile = null
        }
        
        if (!profile) {
          console.log("🆕 Creating new profile in background...")
          // สร้าง profile แบบ background (ไม่ block)
          createUserProfile(u).then(() => {
            console.log("✅ Profile created in background")
            // ลอง get อีกครั้ง
            getUserProfile(u.uid).then((newProfile) => {
              if (newProfile) {
                setCredits(newProfile.credits || 100)
                if (newProfile.columnConfig?.length) {
                  setColumnConfig(newProfile.columnConfig)
                }
                console.log("✅ Profile loaded from Firestore")
              }
            }).catch(() => {
              // ไม่เป็นไร - ยังใช้ default values
            })
          }).catch((createError) => {
            console.error("❌ Error creating profile:", createError)
            // ไม่เป็นไร - ใช้ default values
          })
        } else {
          // ถ้าได้ profile แล้ว ให้อัปเดต state
          setCredits(profile.credits || 100)
          if (profile.columnConfig?.length) {
            setColumnConfig(profile.columnConfig)
          }
          console.log("✅ Profile loaded successfully")
        }
      } catch (error) {
        console.error("❌ Error loading profile:", error)
        // ไม่เป็นไร - ใช้ default values
      }
    })

    return () => unsubscribe()
  }, [])

  // ⏳ Loading
  if (loading) {
    return <div style={{ padding: 40 }}>Loading...</div>
  }

  // 🔑 ยังไม่ login → หน้า Login
  if (!user) {
    return <Login />
  }

  // 📄 Page router
  let content = null

  if (page === "scan") {
    content = (
      <Scan
        credits={credits}
        files={scanFiles}
        setFiles={setScanFiles}
        onNext={() => setPage("export")}
      />
    )
  }

  if (page === "excel") {
    content = (
      <ExcelMode
        columnConfig={columnConfig}
        setColumnConfig={setColumnConfig}
      />
    )
  }

  if (page === "export") {
    content = (
      <Export
        scanFiles={scanFiles}
        credits={credits}
        columnConfig={columnConfig}
        onConsume={(used) =>
          setCredits((c) => c - used)
        }
        onDone={() => {
          setScanFiles([])
          setPage("scan")
        }}
      />
    )
  }

  if (page === "settings") {
    content = (
      <Settings
        onDone={() => setPage("scan")}
      />
    )
  }

  // ✅ Login แล้ว → เข้า Layout
  return (
    <AppLayout
      page={page}
      onNavigate={setPage}
      credits={credits}
      onLogout={async () => {
        await signOut(auth)
        setUser(null)
      }}
    >
      {content}
    </AppLayout>
  )
}
