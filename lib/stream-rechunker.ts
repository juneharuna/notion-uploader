import { sendFileData, completeMultiPartUpload } from "./notion";
import { fetchWithRetry } from "./retry";

const NOTION_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB
const PREFETCH_CONCURRENCY = 3;
const SEND_CONCURRENCY = 2;

interface BlobInfo {
  url: string;
  pathname: string;
}

/**
 * Streams Blob chunks to Notion API, re-chunking from 4MB to 10MB on the fly.
 *
 * Optimizations:
 * - Sliding window prefetch: fetches 3 blobs ahead in parallel
 * - Buffer array accumulation: avoids O(n²) Buffer.concat in loop
 * - Parallel Notion sends: sends 2 parts concurrently
 *
 * For single-part uploads: accumulates all data into one buffer and sends without part_number.
 * For multi-part uploads: buffers 10MB at a time and sends as numbered parts.
 */
export async function streamToNotion(
  uploadId: string,
  sortedBlobs: BlobInfo[],
  contentType: string,
  useMultiPart: boolean,
  onPartSent?: (partNumber: number, totalParts: number) => void,
  totalFileSize?: number
): Promise<void> {
  if (useMultiPart) {
    await streamMultiPart(
      uploadId,
      sortedBlobs,
      contentType,
      onPartSent,
      totalFileSize
    );
  } else {
    await streamSinglePart(uploadId, sortedBlobs, contentType);
  }
}

/**
 * Sliding window prefetch: fetches blobs ahead in parallel while maintaining order.
 * FIFO queue ensures blobs are yielded in index order.
 */
async function* prefetchBlobs(
  sortedBlobs: BlobInfo[],
  concurrency: number = PREFETCH_CONCURRENCY
): AsyncGenerator<Buffer> {
  const pending: Promise<Buffer>[] = [];
  let nextIdx = 0;

  const fetchOne = (blob: BlobInfo): Promise<Buffer> =>
    fetchWithRetry(blob.url, { method: "GET" }, { timeoutMs: 30_000 })
      .then((r) => r.arrayBuffer())
      .then((ab) => Buffer.from(ab));

  // Seed the prefetch queue
  while (nextIdx < Math.min(concurrency, sortedBlobs.length)) {
    pending.push(fetchOne(sortedBlobs[nextIdx++]));
  }

  // Consume from front, replenish at back
  while (pending.length > 0) {
    yield await pending.shift()!;
    if (nextIdx < sortedBlobs.length) {
      pending.push(fetchOne(sortedBlobs[nextIdx++]));
    }
  }
}

async function streamSinglePart(
  uploadId: string,
  sortedBlobs: BlobInfo[],
  contentType: string
): Promise<void> {
  const chunks: Buffer[] = [];

  for await (const chunk of prefetchBlobs(sortedBlobs)) {
    chunks.push(chunk);
  }

  const combinedBuffer = Buffer.concat(chunks);
  await sendFileData(uploadId, combinedBuffer, contentType);
}

async function streamMultiPart(
  uploadId: string,
  sortedBlobs: BlobInfo[],
  contentType: string,
  onPartSent?: (partNumber: number, totalParts: number) => void,
  totalFileSize?: number
): Promise<void> {
  // Buffer accumulation: collect chunks in array, concat only when flushing
  const bufferChunks: Buffer[] = [];
  let bufferedSize = 0;
  let partNumber = 1;

  // Calculate totalParts accurately if fileSize is known, otherwise estimate
  const totalParts = totalFileSize
    ? Math.ceil(totalFileSize / NOTION_CHUNK_SIZE)
    : undefined;

  // Sliding window for parallel Notion sends
  const sendQueue: Promise<void>[] = [];

  for await (const chunk of prefetchBlobs(sortedBlobs)) {
    bufferChunks.push(chunk);
    bufferedSize += chunk.length;

    // Flush 10MB parts as they accumulate
    while (bufferedSize >= NOTION_CHUNK_SIZE) {
      const combined = Buffer.concat(bufferChunks);
      const part = combined.subarray(0, NOTION_CHUNK_SIZE);
      const remainder = combined.subarray(NOTION_CHUNK_SIZE);

      // Reset buffer
      bufferChunks.length = 0;
      if (remainder.length > 0) {
        bufferChunks.push(Buffer.from(remainder));
      }
      bufferedSize = remainder.length;

      // Parallel send: wait for oldest if at capacity
      if (sendQueue.length >= SEND_CONCURRENCY) {
        await sendQueue.shift();
      }

      const currentPart = partNumber;
      const estimatedTotal = totalParts ?? currentPart; // fallback to current part count
      sendQueue.push(
        sendFileData(uploadId, Buffer.from(part), contentType, currentPart)
          .then(() => onPartSent?.(currentPart, estimatedTotal))
      );
      partNumber++;
    }
  }

  // Flush remaining data
  if (bufferedSize > 0) {
    const remainingBuffer = Buffer.concat(bufferChunks);
    const currentPart = partNumber;
    const finalTotal = totalParts ?? currentPart;

    // Wait for queue before final send
    if (sendQueue.length >= SEND_CONCURRENCY) {
      await sendQueue.shift();
    }

    sendQueue.push(
      sendFileData(uploadId, remainingBuffer, contentType, currentPart)
        .then(() => onPartSent?.(currentPart, finalTotal))
    );
  }

  // Wait for all remaining sends to complete
  await Promise.all(sendQueue);

  await completeMultiPartUpload(uploadId);
}
