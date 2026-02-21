# Notion Uploader

## Notion File Upload API

### Multi-part 업로드 시 주의사항
- `part_number`는 **URL 쿼리 파라미터가 아닌 FormData body**에 전송해야 함
- `Notion-Version: 2025-09-03` 헤더 필수
- 각 파트 크기: 5~20MB (마지막 파트는 5MB 미만 가능)
- 권장 파트 크기: 10MB
- 20MB 이하 파일은 single-part 모드 사용

### 지원 파일 형식
- **Image**: .gif, .heic, .jpeg, .jpg, .png, .svg, .tif, .tiff, .webp, .ico
- **Document**: .pdf, .txt, .json, .doc, .dot, .docx, .dotx, .xls, .xlt, .xla, .xlsx, .xltx, .ppt, .pot, .pps, .ppa, .pptx, .potx
- **Audio**: .aac, .adts, .mid, .midi, .mp3, .mpga, .m4a, .m4b, .oga, .ogg, .wav, .wma
- **Video**: .amv, .asf, .wmv, .avi, .f4v, .flv, .gifv, .m4v, .mp4, .mkv, .webm, .mov, .qt, .mpeg
- ⚠️ **ZIP/RAR/7z 등 압축 파일은 지원되지 않음**
- 클라이언트 측 검증: `components/FileDropzone.tsx`의 `SUPPORTED_EXTENSIONS`

### 참고 문서
- https://developers.notion.com/reference/send-a-file-upload
- https://developers.notion.com/docs/sending-larger-files

## Vercel 대용량 파일 업로드 패턴

### 제한사항
- Request Body Size: 4.5MB (Pro 포함)
- Function Timeout: Pro 최대 900초

### 해결 패턴 (클라이언트 → 외부 API)
1. 클라이언트: 4MB 청크로 분할
2. Vercel API: 청크를 Vercel Blob에 임시 저장
3. Complete 단계: Blob에서 읽어서 합침 → 외부 API 규격(예: 10MB)으로 재분할 → 전송
4. Cleanup: 성공/실패 모두 Blob 청크 삭제 (try-finally)

### 핵심
클라이언트 청크 크기 ≠ 외부 API 청크 크기일 때 **중간 저장소(Vercel Blob)** 활용

## 에러 응답 및 재시도

### 이중 재시도 방지
- 서버 API 엔드포인트는 Notion API 실패 시 **422** (Unprocessable Entity) 반환
- 500을 반환하면 `client-retry.ts`가 재시도 → 이중 재시도 발생 (서버 4회 × 클라이언트 4회 = 16회)
- 422는 `retryableStatuses` [429, 500, 502, 503, 504]에 포함되지 않으므로 즉시 에러 표시
- **새 API 엔드포인트 추가 시 catch 블록에서 반드시 422 사용**

### 재시도 (Retry) 아키텍처
- **서버 측** (`lib/retry.ts`): Notion API 호출 시 사용, 에러 body 포함
- **클라이언트 측** (`lib/client-retry.ts`): Vercel API 호출 시 사용, 에러 body 포함
- 두 계층 모두 exponential backoff + jitter 적용
- 에러 메시지 형식: `Request failed after N retries (STATUS): BODY`

## 프로젝트 구조

### 업로드 API 흐름
- `/api/upload/init` - Notion 파일 업로드 객체 생성
- `/api/upload/chunk` - 청크를 Vercel Blob에 저장
- `/api/upload/complete` - Blob 청크 합침 → Notion 전송 → 페이지 첨부
- `/api/upload/cleanup` - Blob 청크 정리 (수동/에러 시)

## 테스트
- 테스트 위치: `__tests__/lib/`
- 테스트 파일: notion, retry, client-retry, stream-rechunker, upload-pool
- `npm run test`로 실행
