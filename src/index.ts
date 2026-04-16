import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { bookingRouter } from './routes/booking';
import { sessionStore } from './session-store';

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

// 예약 라우터
app.use('/api/booking', bookingRouter);

// 세션 정리 (1시간마다)
setInterval(() => {
  sessionStore.cleanup();
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`🤖 Jarvis Booking Server running on port ${PORT}`);
});
