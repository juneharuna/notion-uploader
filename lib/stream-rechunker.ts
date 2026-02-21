import { sendFileData, completeMultiPartUpload } from "./notion";

const NOTION_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

interface BlobInfo {
  url: string;
  pathname: string;
}

/**
 * Streams Blob chunks to Notion API, re-chunking from 4MB to 10MB on the fly.
 * Memory usage is O(NOTION_CHUNK_SIZE) = O(10MB) regardless of total file size.
 *
 * For single-part uploads: accumulates all data into one buffer and sends without part_number.
 * For multi-part uploads: buffers 10MB at a time and sends as numbered parts.
 */
export async function streamToNotion(
  uploadId: string,
  sortedBlobs: BlobInfo[],
  contentType: string,
  useMultiPart: boolean,
  onPartSent?: (partNumber: number, totalParts: number) => void
): Promise<void> {
  if (useMultiPart) {
    await streamMultiPart(
      uploadId,
      sortedBlobs,
      contentType,
      onPartSent
    );
  } else {
    await streamSinglePart(uploadId, sortedBlobs, contentType);
  }
}

async function streamSinglePart(
  uploadId: string,
  sortedBlobs: BlobInfo[],
  contentType: string
): Promise<void> {
  // For single-part, we still need to combine all chunks (max 20MB)
  const chunks: Buffer[] = [];

  for (const blob of sortedBlobs) {
    const response = await fetch(blob.url);
    const arrayBuffer = await response.arrayBuffer();
    chunks.push(Buffer.from(arrayBuffer));
  }

  const combinedBuffer = Buffer.concat(chunks);
  await sendFileData(uploadId, combinedBuffer, contentType);
}

async function streamMultiPart(
  uploadId: string,
  sortedBlobs: BlobInfo[],
  contentType: string,
  onPartSent?: (partNumber: number, totalParts: number) => void
): Promise<void> {
  // Calculate total size for estimating total parts
  let totalBlobSize = 0;
  const blobBuffers: Buffer[] = [];

  // First pass: fetch all blob sizes to calculate total parts
  // We fetch blobs one at a time to keep memory low
  let buffer = Buffer.alloc(0);
  let partNumber = 1;

  // Estimate total parts (will be exact after processing all blobs)
  // We'll update the estimate as we go
  let processedSize = 0;

  for (const blob of sortedBlobs) {
    const response = await fetch(blob.url);
    const arrayBuffer = await response.arrayBuffer();
    const chunk = Buffer.from(arrayBuffer);
    processedSize += chunk.length;

    buffer = Buffer.concat([buffer, chunk]);

    // Flush 10MB parts as they accumulate
    while (buffer.length >= NOTION_CHUNK_SIZE) {
      const part = buffer.subarray(0, NOTION_CHUNK_SIZE);
      buffer = Buffer.from(buffer.subarray(NOTION_CHUNK_SIZE));

      await sendFileData(uploadId, part, contentType, partNumber);

      // Estimate total parts based on what we've seen so far
      const avgBlobSize = processedSize / (sortedBlobs.indexOf(blob) + 1);
      const estimatedTotalSize = avgBlobSize * sortedBlobs.length;
      const estimatedTotalParts = Math.ceil(
        estimatedTotalSize / NOTION_CHUNK_SIZE
      );

      onPartSent?.(partNumber, estimatedTotalParts);
      partNumber++;
    }
  }

  // Flush remaining data
  if (buffer.length > 0) {
    const totalParts = partNumber; // This is the last part
    await sendFileData(uploadId, buffer, contentType, partNumber);
    onPartSent?.(partNumber, totalParts);
  }

  await completeMultiPartUpload(uploadId);
}
