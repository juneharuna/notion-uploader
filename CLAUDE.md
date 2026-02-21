# Notion Uploader

Next.js 16 (App Router) + Mantine UI, Vercel 배포, Vercel Blob (임시 저장소)

## Notion File Upload API

- `part_number`는 **URL 쿼리 파라미터가 아닌 FormData body**에 전송해야 함
- `Notion-Version: 2025-09-03` 헤더 필수
- 파트 크기: 10MB 권장 (5~20MB), 20MB 이하 파일은 single-part 모드
- ⚠️ ZIP/RAR/7z 등 압축 파일은 Notion이 지원하지 않음
- 지원 확장자 목록: `components/FileDropzone.tsx`의 `SUPPORTED_EXTENSIONS`

## 업로드 아키텍처

### API 흐름
1. `/api/upload/init` — Notion 파일 업로드 객체 생성
2. `/api/upload/chunk` — 4MB 청크를 Vercel Blob에 임시 저장
3. `/api/upload/complete` — Blob → 10MB로 재분할 → Notion 전송 → 페이지 첨부 → Blob 삭제
4. `/api/upload/cleanup` — Blob 청크 수동 정리

### Vercel 제한사항
- Request Body: 4.5MB → 클라이언트에서 4MB 청크 분할
- Function Timeout: Pro 최대 900초

### 이중 재시도 방지
- 서버 API catch 블록은 반드시 **422** 반환 (500이면 client-retry가 재시도 → 서버×클라이언트 중첩)
- 재시도 계층: 서버 `lib/retry.ts` (Notion API) + 클라이언트 `lib/client-retry.ts` (Vercel API)
- 둘 다 exponential backoff + jitter + AbortController 타임아웃

## 테스트
- `__tests__/lib/` — notion, retry, client-retry, stream-rechunker, upload-pool
- `npm run test`
