import { initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore"

const firebaseConfig = {
  apiKey: "AIzaSyCQXBDJRPKPu9wbAwMVIYx4pKWgTEKhD_E",
  authDomain: "ocr-system-c3bea.firebaseapp.com",
  projectId: "ocr-system-c3bea",
  storageBucket: "ocr-system-c3bea.firebasestorage.app",
  messagingSenderId: "282838463362",
  appId: "1:282838463362:web:7fa9685913fdeda8d5559b",
  measurementId: "G-WTEWW8DWJE"
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)

// Debug: Log Firestore initialization
console.log("🔥 Firestore initialized:", {
  db: db,
  app: app,
  projectId: firebaseConfig.projectId,
  dbApp: db?.app,
  dbType: typeof db,
})

// ตรวจสอบว่า Firestore ทำงานหรือไม่
if (db) {
  console.log("✅ Firestore db object exists")
} else {
  console.error("❌ Firestore db object is null or undefined!")
}