import { doc, getDoc, setDoc, updateDoc, serverTimestamp, enableNetwork } from "firebase/firestore"
import { db } from "../firebase"

// โหลด profile
export async function getUserProfile(uid) {
  try {
    // ลอง enable network ก่อน (ถ้ายัง offline)
    try {
      await enableNetwork(db)
    } catch {
      // ไม่เป็นไร - อาจจะ enable อยู่แล้ว
    }
    
    const ref = doc(db, "users", uid)
    const snap = await getDoc(ref)
    if (!snap.exists()) return null
    return snap.data()
  } catch (error) {
    console.error("Error getting user profile:", error)
    // ถ้า offline หรือ error ให้ return null (จะสร้างใหม่)
    if (error.code === "unavailable" || error.message?.includes("offline")) {
      console.warn("⚠️ Firestore is offline - using default values")
      // ลอง enable network อีกครั้ง
      try {
        await enableNetwork(db)
      } catch {
        // ไม่เป็นไร
      }
      return null
    }
    throw error
  }
}

// สร้าง profile ครั้งแรก
export async function createUserProfile(user) {
  const ref = doc(db, "users", user.uid)
  
  console.log(`📝 Creating user profile for: ${user.email} (${user.uid})`)
  console.log(`📄 Document path: ${ref.path}`)
  console.log(`🔗 Full path: users/${user.uid}`)
  
  try {
    // ตรวจสอบว่ามี document อยู่แล้วหรือไม่ (ป้องกันการเขียนซ้ำ)
    try {
      const existingSnap = await Promise.race([
        getDoc(ref),
        new Promise((_, reject) => setTimeout(() => reject(new Error("getDoc timeout")), 5000))
      ])
      
      if (existingSnap.exists()) {
        const existingData = existingSnap.data()
        console.log(`ℹ️ User profile already exists in Firestore`)
        console.log(`📊 Existing data:`, existingData)
        return // ไม่ต้องสร้างใหม่
      }
    } catch (checkError) {
      console.log(`ℹ️ Could not check existing document (will create new):`, checkError.message)
      // ไม่เป็นไร - จะสร้างใหม่
    }
    
    // Enable network ก่อน
    try {
      await enableNetwork(db)
      console.log(`✅ Network enabled`)
    } catch (networkError) {
      console.warn(`⚠️ Network enable warning:`, networkError.message)
    }
    
    const userData = {
      uid: user.uid,
      email: user.email,
      credits: 50,
      plan: "free",
      status: "active",
      columnConfig: [],
      bannedWords: [],
      totalUsedPages: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }
    
    console.log(`📝 User data to save:`, userData)
    
    // ใช้ Promise.race เพื่อเพิ่ม timeout
    console.log(`⏳ Attempting to write to Firestore...`)
    console.log(`📡 Firestore instance check:`, {
      db: db,
      dbType: typeof db,
      dbApp: db?.app,
      appName: db?.app?.name,
    })
    console.log(`📄 Document reference check:`, {
      ref: ref,
      refPath: ref.path,
      refType: ref.type,
      refId: ref.id,
    })
    
    const writeStartTime = Date.now()
    let setDocPromise = null
    
    try {
      // เรียก setDoc และเก็บ promise
      setDocPromise = setDoc(ref, userData)
      console.log(`📤 setDoc promise created:`, setDocPromise)
      
      // รอให้เสร็จ (พร้อม timeout)
      await Promise.race([
        setDocPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("setDoc timeout: เกิน 15 วินาที")), 15000)
        )
      ])
      
      const writeDuration = Date.now() - writeStartTime
      console.log(`✅ User profile created successfully in Firestore (took ${writeDuration}ms)`)
    } catch (setDocError) {
      const writeDuration = Date.now() - writeStartTime
      console.error(`❌ setDoc failed after ${writeDuration}ms:`, setDocError)
      console.error(`❌ Error code:`, setDocError.code)
      console.error(`❌ Error message:`, setDocError.message)
      console.error(`❌ Error stack:`, setDocError.stack)
      throw setDocError
    }
    
    // Verify ว่าข้อมูลถูกเขียนจริงๆ (รอสักครู่เพื่อให้ Firestore sync)
    console.log(`🔍 Verifying document creation...`)
    await new Promise(resolve => setTimeout(resolve, 1000)) // รอ 1 วินาที
    
    try {
      const verifySnap = await Promise.race([
        getDoc(ref),
        new Promise((_, reject) => setTimeout(() => reject(new Error("getDoc timeout")), 5000))
      ])
      
      if (verifySnap.exists()) {
        const savedData = verifySnap.data()
        console.log(`✅ Verified: User profile exists in Firestore`)
        console.log(`📊 Saved data:`, savedData)
        console.log(`📄 Document ID: ${verifySnap.id}`)
        console.log(`🔗 Full path: ${ref.path}`)
        
        // ตรวจสอบว่าข้อมูลถูกต้อง
        if (savedData.uid === user.uid && savedData.email === user.email) {
          console.log(`✅ Data verification passed: UID and email match`)
        } else {
          console.warn(`⚠️ Data verification warning: UID or email mismatch`)
        }
      } else {
        console.error(`❌ Verification failed: Document does not exist after creation!`)
        console.error(`❌ Expected path: ${ref.path}`)
        throw new Error("Document was not created in Firestore")
      }
    } catch (verifyError) {
      console.error(`❌ Could not verify profile creation:`, verifyError.message)
      console.error(`❌ This might indicate a problem with Firestore Rules or network`)
      // ไม่ throw - อาจจะสำเร็จแล้ว แต่ verify ไม่ได้
    }
    
  } catch (error) {
    console.error("❌ Error creating user profile:", error)
    console.error("❌ Error details:", {
      code: error.code,
      message: error.message,
      stack: error.stack
    })
    
    // ตรวจสอบ error code
    if (error.code === "permission-denied") {
      console.error("❌ PERMISSION DENIED: Firestore Rules ไม่อนุญาตให้เขียนข้อมูล")
      console.error("💡 กรุณาตรวจสอบ Firestore Rules ใน Firebase Console")
      console.error("💡 Rules ควรอนุญาตให้ authenticated users เขียนได้:")
      console.error("   match /users/{userId} {")
      console.error("     allow read, write: if request.auth != null && request.auth.uid == userId;")
      console.error("   }")
      throw new Error("ไม่มีสิทธิ์ในการสร้าง profile กรุณาตรวจสอบ Firestore Rules")
    } else if (error.code === "not-found" || error.code === "failed-precondition") {
      console.error("❌ DATABASE NOT FOUND: Firestore database ไม่พบหรือยังไม่ได้ถูกสร้าง")
      throw new Error("Firestore database ไม่พบ กรุณาไปที่ Firebase Console และสร้าง Firestore database")
    } else if (error.code === "unavailable" || error.message?.includes("offline")) {
      console.warn("⚠️ Firestore is offline - profile will be created when online")
      return // ไม่ throw - จะสร้างใหม่เมื่อ online
    }
    
    throw error
  }
}

// อัปเดตเครดิต
export async function updateUserCredits(uid, newCredits) {
  const ref = doc(db, "users", uid)
  const maxRetries = 2
  let lastError = null
  
  console.log(`💾 Starting credit update: uid=${uid}, newCredits=${newCredits}`)
  console.log(`📡 Firestore instance:`, db)
  console.log(`📄 Document reference:`, ref.path)
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Enable network ก่อนทุกครั้ง
      console.log(`🔌 Enabling network (attempt ${attempt})...`)
      try {
        await enableNetwork(db)
        console.log(`✅ Network enabled`)
      } catch (networkError) {
        console.warn(`⚠️ Network enable warning:`, networkError.message)
        // ไม่เป็นไร - อาจจะ enable อยู่แล้ว
      }
      
      console.log(`💾 Updating credits in Firestore (attempt ${attempt}/${maxRetries}): ${newCredits}`)
      
      // ใช้ setDoc with merge option
      const updateData = {
        credits: newCredits,
        updatedAt: serverTimestamp(),
      }
      
      console.log(`📝 Update data:`, updateData)
      
      // ลด timeout เป็น 15 วินาที
      const result = await Promise.race([
        setDoc(ref, updateData, { merge: true }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error("setDoc timeout: เกิน 15 วินาที")), 15000)
        )
      ])
      
      console.log(`✅ Credits updated successfully in Firestore: ${newCredits}`)
      
      // ตรวจสอบว่า update สำเร็จจริงๆ (optional - อาจทำให้ช้า)
      try {
        const verifySnap = await Promise.race([
          getDoc(ref),
          new Promise((_, reject) => setTimeout(() => reject(new Error("getDoc timeout")), 5000))
        ])
        if (verifySnap.exists()) {
          const actualCredits = verifySnap.data().credits
          console.log(`✅ Verified: Credits in Firestore = ${actualCredits}`)
        }
      } catch (verifyError) {
        console.warn(`⚠️ Could not verify update:`, verifyError.message)
        // ไม่เป็นไร - update อาจสำเร็จแล้ว
      }
      
      return // สำเร็จแล้ว - ออกจาก loop
      
    } catch (error) {
      console.error(`❌ Error updating credits (attempt ${attempt}/${maxRetries}):`, error)
      console.error(`❌ Error details:`, {
        code: error.code,
        message: error.message,
        stack: error.stack
      })
      
      // ตรวจสอบ error code
      if (error.code === "permission-denied") {
        throw new Error("ไม่มีสิทธิ์ในการอัปเดตเครดิต กรุณาตรวจสอบ Firestore Rules ใน Firebase Console")
      } else if (error.code === "not-found") {
        throw new Error("Firestore database ไม่พบ กรุณาตรวจสอบว่าได้สร้าง Firestore database แล้วใน Firebase Console")
      } else if (error.code === "unavailable") {
        console.warn("⚠️ Firestore is unavailable - may be offline")
      } else if (error.code === "failed-precondition") {
        throw new Error("Firestore database ยังไม่ได้ถูกสร้าง กรุณาไปที่ Firebase Console และสร้าง Firestore database")
      }
      
      lastError = error
      
      // ถ้าไม่ใช่ attempt สุดท้าย ให้ retry
      if (attempt < maxRetries) {
        const waitTime = 3000
        console.log(`⏳ Waiting ${waitTime}ms before retry...`)
        await new Promise(resolve => setTimeout(resolve, waitTime))
      }
    }
  }
  
  // ถ้าทุก attempt ล้มเหลว
  console.error("❌ All attempts failed to update credits")
  let errorMsg = `ไม่สามารถอัปเดตเครดิตได้: ${lastError?.message || "Unknown error"}`
  
  if (lastError?.code === "permission-denied") {
    errorMsg = "ไม่มีสิทธิ์ในการอัปเดตเครดิต กรุณาตรวจสอบ Firestore Rules ใน Firebase Console"
  } else if (lastError?.code === "not-found" || lastError?.code === "failed-precondition") {
    errorMsg = "Firestore database ไม่พบหรือยังไม่ได้ถูกสร้าง กรุณาไปที่ Firebase Console และสร้าง Firestore database"
  } else if (lastError?.message?.includes("timeout")) {
    errorMsg = `การเชื่อมต่อ Firestore timeout: ${lastError.message}. กรุณาตรวจสอบ network connection และ Firestore database`
  }
  
  throw new Error(errorMsg)
}

// บันทึก columnConfig
export async function updateColumnConfig(uid, columnConfig) {
  const ref = doc(db, "users", uid)
  await updateDoc(ref, {
    columnConfig,
    updatedAt: serverTimestamp(),
  })
}
