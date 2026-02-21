interface PoolOptions {
  concurrency: number;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Uploads chunks in parallel with a concurrency limit.
 * Aborts remaining uploads on first error.
 */
export async function uploadChunksParallel(
  chunks: { blob: Blob; partNumber: number }[],
  uploadFn: (blob: Blob, partNumber: number) => Promise<void>,
  options: PoolOptions
): Promise<void> {
  const { concurrency, onProgress } = options;
  const total = chunks.length;

  if (total === 0) return;

  let completed = 0;
  let nextIndex = 0;
  let abortError: Error | null = null;

  return new Promise<void>((resolve, reject) => {
    let activeCount = 0;

    function startNext() {
      while (activeCount < concurrency && nextIndex < total && !abortError) {
        const chunk = chunks[nextIndex];
        nextIndex++;
        activeCount++;

        uploadFn(chunk.blob, chunk.partNumber)
          .then(() => {
            if (abortError) return;
            activeCount--;
            completed++;
            onProgress?.(completed, total);

            if (completed === total) {
              resolve();
            } else {
              startNext();
            }
          })
          .catch((error) => {
            if (abortError) return;
            abortError = error;
            reject(error);
          });
      }
    }

    startNext();
  });
}
