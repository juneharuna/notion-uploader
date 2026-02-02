const NOTION_API_BASE = "https://api.notion.com/v1";

export interface FileUploadResponse {
  id: string;
  status: string;
  file_url?: {
    url: string;
    expiry_time: string;
  };
}

export interface UploadProgress {
  phase: "creating" | "uploading" | "completing" | "attaching" | "done";
  progress: number;
  chunkIndex?: number;
  totalChunks?: number;
}

export type ProgressCallback = (progress: UploadProgress) => void;

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB per chunk (Notion API limit)
const MAX_SINGLE_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB

function getNotionApiKey(): string {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY is not configured");
  return key;
}

function getNotionPageId(): string {
  const id = process.env.NOTION_PAGE_ID;
  if (!id) throw new Error("NOTION_PAGE_ID is not configured");
  return id;
}

function getHeaders() {
  return {
    Authorization: `Bearer ${getNotionApiKey()}`,
    "Notion-Version": "2022-06-28",
  };
}

function getFileUploadHeaders() {
  return {
    Authorization: `Bearer ${getNotionApiKey()}`,
    "Notion-Version": "2025-09-03",
  };
}

// Create file upload object
export async function createFileUpload(
  filename: string,
  contentType: string,
  multiPart: boolean = false,
  numberOfParts?: number
): Promise<FileUploadResponse> {
  const body: Record<string, unknown> = {
    filename,
    content_type: contentType,
  };

  if (multiPart && numberOfParts) {
    body.mode = "multi_part";
    body.number_of_parts = numberOfParts;
  }

  const response = await fetch(`${NOTION_API_BASE}/file_uploads`, {
    method: "POST",
    headers: {
      ...getFileUploadHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create file upload: ${error}`);
  }

  return response.json();
}

// Send file data (single or part) - accepts Buffer for server-side use
export async function sendFileData(
  uploadId: string,
  file: Buffer,
  contentType: string,
  partNumber?: number
): Promise<FileUploadResponse> {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(file)], { type: contentType }));

  // part_number must be in the request body, not query parameter
  if (partNumber) {
    formData.append("part_number", String(partNumber));
  }

  const url = `${NOTION_API_BASE}/file_uploads/${uploadId}/send`;

  const response = await fetch(url, {
    method: "POST",
    headers: getFileUploadHeaders(),
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send file data: ${error}`);
  }

  return response.json();
}

// Complete multi-part upload
export async function completeMultiPartUpload(
  uploadId: string
): Promise<FileUploadResponse> {
  const response = await fetch(
    `${NOTION_API_BASE}/file_uploads/${uploadId}/complete`,
    {
      method: "POST",
      headers: getFileUploadHeaders(),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to complete upload: ${error}`);
  }

  return response.json();
}

// Attach file to Notion page
export async function attachFileToPage(
  fileUploadId: string,
  filename: string,
  pageId?: string
): Promise<void> {
  const targetPageId = pageId || getNotionPageId();
  const response = await fetch(
    `${NOTION_API_BASE}/blocks/${targetPageId}/children`,
    {
      method: "PATCH",
      headers: {
        ...getHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "file",
            file: {
              type: "file_upload",
              file_upload: {
                id: fileUploadId,
              },
              caption: [
                {
                  type: "text",
                  text: {
                    content: filename,
                  },
                },
              ],
            },
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to attach file to page: ${error}`);
  }
}

// Main upload function (for small files under Vercel limit - kept for backward compatibility)
export async function uploadFileToNotion(
  filename: string,
  contentType: string,
  fileBuffer: Buffer,
  onProgress?: ProgressCallback
): Promise<{ success: boolean; fileUploadId: string }> {
  const fileSize = fileBuffer.length;
  const isMultiPart = fileSize > MAX_SINGLE_UPLOAD_SIZE;

  onProgress?.({ phase: "creating", progress: 0 });

  if (isMultiPart) {
    // Multi-part upload for files > 20MB
    const numberOfParts = Math.ceil(fileSize / CHUNK_SIZE);

    const uploadObj = await createFileUpload(
      filename,
      contentType,
      true,
      numberOfParts
    );

    onProgress?.({ phase: "uploading", progress: 5, chunkIndex: 0, totalChunks: numberOfParts });

    // Upload each chunk
    for (let i = 0; i < numberOfParts; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const chunk = fileBuffer.subarray(start, end);

      await sendFileData(uploadObj.id, chunk, contentType, i + 1);

      const progress = 5 + ((i + 1) / numberOfParts) * 80;
      onProgress?.({
        phase: "uploading",
        progress,
        chunkIndex: i + 1,
        totalChunks: numberOfParts,
      });
    }

    onProgress?.({ phase: "completing", progress: 85 });
    await completeMultiPartUpload(uploadObj.id);

    onProgress?.({ phase: "attaching", progress: 90 });
    await attachFileToPage(uploadObj.id, filename);

    onProgress?.({ phase: "done", progress: 100 });

    return { success: true, fileUploadId: uploadObj.id };
  } else {
    // Single upload for files <= 20MB
    const uploadObj = await createFileUpload(filename, contentType);

    onProgress?.({ phase: "uploading", progress: 20 });
    await sendFileData(uploadObj.id, fileBuffer, contentType);

    onProgress?.({ phase: "attaching", progress: 80 });
    await attachFileToPage(uploadObj.id, filename);

    onProgress?.({ phase: "done", progress: 100 });

    return { success: true, fileUploadId: uploadObj.id };
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
