// OCR Router - V2 ONLY (no v1 fallback)
// This project uses OCR v2 exclusively
// v1 is maintained in a separate project and not used here

import { ocrFileV2 } from "./ocr.service.v2"
import type { OCRResult } from "../../core/types"
import type { Template } from "../../template/template.schema"

interface UserProfile {
  enableTemplateMode?: boolean
  [key: string]: any
}

/**
 * Routes OCR request to OCR v2 ONLY.
 * No fallback to v1 - v2 is the only supported version in this project.
 * 
 * @param imageFile - Image file to process
 * @param user - User profile with feature flag (optional, not used but kept for compatibility)
 * @param template - Selected template (optional)
 * @param options - OCR options (pageRange, startPage, endPage)
 * @returns OCRResult
 */
export async function routeOCR(
  imageFile: File,
  user: UserProfile | null = null,
  template: Template | null = null,
  options?: { pageRange?: string; startPage?: number; endPage?: number }
): Promise<OCRResult> {
  console.log(`🔀 [OCR Router] routeOCR called (V2 ONLY):`, {
    fileName: imageFile.name,
    fileType: imageFile.type,
    hasUser: !!user,
    userEnableTemplateMode: user?.enableTemplateMode,
    hasTemplate: !!template,
    templateId: template?.templateId,
  })
  
  try {
    // Get rotation from template if available (manual rotation set by user)
    const rotation = template?.rotation !== undefined && template?.rotation !== null 
      ? template.rotation 
      : undefined;
    if (rotation !== undefined) {
      console.log(`🔄 [OCR Router] Using template rotation: ${rotation}°`)
    } else {
      console.log(`🔄 [OCR Router] No rotation in template, using auto-detect`)
    }
    
    // Always use v2 - no fallback
    const scanMode = true // Always use scan mode when called from routeOCR (Scan page)
    console.log(`📋 [OCR Router] Calling ocrFileV2 with scanMode=${scanMode}, rotation=${rotation}, pageRange=${options?.pageRange || "all"}`)
    
    const result = await ocrFileV2(imageFile, rotation, scanMode, options)
    console.log(`✅ [OCR Router] OCR v2 success:`, {
      hasWords: !!(result?.words),
      wordsCount: result?.words?.length || 0,
      hasPage: !!(result?.page),
      pageWidth: result?.page?.width,
      pageHeight: result?.page?.height,
      fileName: result?.fileName,
    })
    
    // Validate result
    if (!result || !result.page || result.page.width === 0 || result.page.height === 0) {
      throw new Error("OCR v2 returned invalid result (page size 0x0)")
    }
    
    return result
  } catch (error) {
    console.error(`❌ [OCR Router] OCR v2 failed:`, error)
    console.error(`❌ [OCR Router] Error details:`, {
      message: error?.message,
      stack: error?.stack,
      errorName: error?.name,
    })
    // Don't fallback - throw error instead
    throw error
  }
}

/**
 * Convenience function for batch OCR processing.
 * Routes each file to OCR v2.
 * 
 * @param files - Array of image files
 * @param user - User profile with feature flag (optional, kept for compatibility)
 * @param template - Selected template (optional)
 * @returns Array of OCRResult (one per file)
 */
export async function routeOCRBatch(
  files: File[],
  user: UserProfile | null = null,
  template: Template | null = null
): Promise<OCRResult[]> {
  const results = await Promise.all(
    files.map((file) => routeOCR(file, user, template))
  )
  return results
}
