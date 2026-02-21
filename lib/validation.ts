// Notion File Upload API supported extensions
export const SUPPORTED_EXTENSIONS = new Set([
  // Image
  ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp", ".ico",
  // Document
  ".pdf", ".txt", ".json", ".doc", ".dot", ".docx", ".dotx",
  ".xls", ".xlt", ".xla", ".xlsx", ".xltx",
  ".ppt", ".pot", ".pps", ".ppa", ".pptx", ".potx",
  // Audio
  ".aac", ".adts", ".mid", ".midi", ".mp3", ".mpga", ".m4a", ".m4b", ".oga", ".ogg", ".wav", ".wma",
  // Video
  ".amv", ".asf", ".wmv", ".avi", ".f4v", ".flv", ".gifv", ".m4v", ".mp4", ".mkv", ".webm", ".mov", ".qt", ".mpeg",
]);

export function isSupportedExtension(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}
