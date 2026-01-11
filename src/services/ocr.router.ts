// OCR Router - Decides which OCR version to use based on feature flag and template
// Does NOT modify existing ocr.service.js or ocrImage function

import { ocrImage as ocrImageV1 } from "./ocr.service"
import { ocrFileV2 } from "./ocr.service.v2"
import type { OCRResult } from "../../core/types"
import type { Template } from "../../template/template.schema"

interface UserProfile {
  enableTemplateMode?: boolean
  [key: string]: any
}

/**
 * Converts OCR v1 text result to OCRResult format.
 * OCR v1 returns plain text, so we create a minimal OCRResult.
 * Note: This loses bounding box information (v1 doesn't provide it).
 */
function convertV1TextToOCRResult(text: string, fileName: string): OCRResult {
  return {
    fileName,
    page: {
      width: 0, // v1 doesn't provide page dimensions
      height: 0,
    },
    words: text
      .split(/\s+/)
      .filter((word) => word.trim().length > 0)
      .map((word, index) => ({
        text: word.trim(),
        x: 0, // v1 doesn't provide coordinates
        y: 0,
        w: 0,
        h: 0,
      })),
  }
}

/**
 * Determines which OCR version to use based on feature flag and template.
 * 
 * Logic:
 * - If user.enableTemplateMode is true AND template is provided → use OCR v2
 * - Otherwise → use OCR v1 (default, stable, legacy)
 * 
 * @param user - User profile with enableTemplateMode flag
 * @param template - Selected template (null for legacy mode)
 * @returns true if should use OCR v2, false for OCR v1
 */
export function shouldUseOCRv2(
  user: UserProfile | null,
  template: Template | null
): boolean {
  // Check feature flag and template
  const hasFeatureFlag = user?.enableTemplateMode === true
  const hasTemplate = template !== null && template !== undefined

  // Use v2 only if both conditions are met
  const useV2 = hasFeatureFlag && hasTemplate

  console.log(`🔀 [OCR Router] Decision:`, {
    enableTemplateMode: hasFeatureFlag,
    hasTemplate,
    useV2,
  })

  return useV2
}

/**
 * Routes OCR request to appropriate version (v1 or v2).
 * 
 * This function provides instant rollback capability:
 * - Set user.enableTemplateMode = false → instantly uses v1
 * - Remove template selection → instantly uses v1
 * - No data migration needed
 * 
 * @param imageFile - Image file to process
 * @param user - User profile with feature flag
 * @param template - Selected template (null for legacy mode)
 * @returns OCRResult (same format for both v1 and v2)
 */
export async function routeOCR(
  imageFile: File,
  user: UserProfile | null = null,
  template: Template | null = null,
  options?: { pageRange?: string; startPage?: number; endPage?: number }
): Promise<OCRResult> {
  console.log(`🔀 [OCR Router] routeOCR called:`, {
    fileName: imageFile.name,
    fileType: imageFile.type,
    hasUser: !!user,
    userEnableTemplateMode: user?.enableTemplateMode,
    hasTemplate: !!template,
    templateId: template?.templateId,
  })
  
  const useV2 = shouldUseOCRv2(user, template)

  if (useV2) {
    console.log(`✅ [OCR Router] Using OCR v2 (template-based)`)
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
      
      // Use ocrFileV2 to support both images and PDFs
      // scanMode = true for Scan page (scan all pages, no image), false for Template page (first page only, with image)
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
        console.error(`❌ [OCR Router] OCR v2 returned invalid result (page size 0x0), falling back to v1`)
        throw new Error("OCR v2 returned invalid result (page size 0x0)")
      }
      
      return result
    } catch (error) {
      console.error(`❌ [OCR Router] OCR v2 failed, falling back to v1:`, error)
      console.error(`❌ [OCR Router] Error details:`, {
        message: error?.message,
        stack: error?.stack,
        errorName: error?.name,
      })
      // Fallback to v1 on error (instant rollback)
      console.log(`🔄 [OCR Router] Falling back to OCR v1...`)
      const text = await ocrImageV1(imageFile)
      return convertV1TextToOCRResult(text, imageFile.name)
    }
  } else {
    console.log(`✅ [OCR Router] Using OCR v1 (legacy, stable)`)
    console.log(`ℹ️ [OCR Router] Reason:`, {
      hasUser: !!user,
      enableTemplateMode: user?.enableTemplateMode,
      hasTemplate: !!template,
    })
    const text = await ocrImageV1(imageFile)
    return convertV1TextToOCRResult(text, imageFile.name)
  }
}

/**
 * Convenience function for batch OCR processing.
 * Routes each file to appropriate OCR version.
 * 
 * @param files - Array of image files
 * @param user - User profile with feature flag
 * @param template - Selected template (null for legacy mode)
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
