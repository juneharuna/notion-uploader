import { fetchWithRetry } from "./retry";

const NOTION_API_BASE = "https://api.notion.com/v1";

export interface FileUploadResponse {
  id: string;
  status: string;
  file_url?: {
    url: string;
    expiry_time: string;
  };
}


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

  const response = await fetchWithRetry(`${NOTION_API_BASE}/file_uploads`, {
    method: "POST",
    headers: {
      ...getHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }, { timeoutMs: 30_000 });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create file upload: ${error}`);
  }

  const result = await response.json();
  if (result.object === "error") {
    throw new Error(`Notion API error: ${result.code} - ${result.message}`);
  }
  return result;
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

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: getHeaders(),
    body: formData,
  }, { maxRetries: 5, timeoutMs: 120_000 });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send file data: ${error}`);
  }

  const result = await response.json();
  if (result.object === "error") {
    throw new Error(`Notion API error: ${result.code} - ${result.message}`);
  }
  return result;
}

// Complete multi-part upload
export async function completeMultiPartUpload(
  uploadId: string
): Promise<FileUploadResponse> {
  const response = await fetchWithRetry(
    `${NOTION_API_BASE}/file_uploads/${uploadId}/complete`,
    {
      method: "POST",
      headers: getHeaders(),
    },
    { timeoutMs: 30_000 }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to complete upload: ${error}`);
  }

  const result = await response.json();
  if (result.object === "error") {
    throw new Error(`Notion API error: ${result.code} - ${result.message}`);
  }
  return result;
}

// Attach file to Notion page
export async function attachFileToPage(
  fileUploadId: string,
  filename: string,
  pageId?: string
): Promise<void> {
  const targetPageId = pageId || getNotionPageId();
  const response = await fetchWithRetry(
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
    },
    { timeoutMs: 30_000 }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to attach file to page: ${error}`);
  }
}


// Re-export for backward compatibility
export { formatFileSize } from "./format";
