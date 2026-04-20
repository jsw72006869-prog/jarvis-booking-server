import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { bookingRouter } from './routes/booking';
import { sessionStore } from './session-store';
import { runDailyOrderReport } from './smartstore-scheduler';
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;
// CORS — 자비스 프론트엔드에서 접근 허용
app.use(cors({
  origin: [
    'https://mawinpay-jarvis.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL || '',
  ].filter(Boolean),
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
// 헬스체크
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});
// 서버 외부 IP 확인 (스마트스토어 API IP 등록용)
app.get('/my-ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json() as { ip: string };
    res.json({ ip: data.ip, message: '스마트스토어 API 호출 IP 등록 시 이 IP를 사용하세요' });
  } catch (e) {
    res.json({ ip: 'unknown', error: String(e) });
  }
});
// 수동 테스트용 - 즉시 주문 보고 실행
app.get('/run-order-report', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET && secret !== 'jarvis2024') {
    return res.status(401).json({ error: '인증 실패' });
  }
  try {
    await runDailyOrderReport();
    res.json({ success: true, message: '주문 보고 실행 완료' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
// 예약 라우터
app.use('/api/booking', bookingRouter);
// 세션 정리 (1시간마다)
setInterval(() => {
  sessionStore.cleanup();
}, 60 * 60 * 1000);
// 매일 아침 9시(한국시간 = UTC 0시) 스마트스토어 자동 주문 보고
function scheduleDaily9AM() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(0, 0, 0, 0);
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }
  const msUntilRun = nextRun.getTime() - now.getTime();
  const minutesUntil = Math.round(msUntilRun / 1000 / 60);
  console.log(`⏰ 다음 자동 보고: ${nextRun.toISOString()} (${minutesUntil}분 후)`);
  setTimeout(async () => {
    await runDailyOrderReport();
    scheduleDaily9AM();
  }, msUntilRun);
}
// 스케줄러 시작
scheduleDaily9AM();
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Booking Server running on port ${PORT}`);
});
