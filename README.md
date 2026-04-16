# Jarvis Booking Server

Playwright 기반 네이버 예약 자동화 백엔드 서버

## Railway 배포 방법

1. [railway.app](https://railway.app) 로그인
2. New Project → Deploy from GitHub repo
3. 이 저장소 선택
4. 환경변수 설정 (Variables 탭):
   - `PORT` = 3001
   - `FRONTEND_URL` = https://mawinpay-jarvis.vercel.app
   - `EMAIL_USER` = Gmail 주소
   - `EMAIL_PASS` = Gmail 앱 비밀번호

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | /health | 서버 상태 확인 |
| POST | /api/booking/login | 네이버 로그인 |
| POST | /api/booking/availability | 예약 가능 시간 조회 |
| POST | /api/booking/fill-form | 예약 폼 자동 입력 |
| POST | /api/booking/notify | 이메일 알림 발송 |

## Gmail 앱 비밀번호 설정

1. Google 계정 → 보안 → 2단계 인증 활성화
2. 앱 비밀번호 생성 → "메일" 선택
3. 생성된 16자리 비밀번호를 EMAIL_PASS에 입력
