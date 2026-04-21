import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { bookingRouter } from './routes/booking';
import { startOrderMonitor } from './order-monitor';
import { sessionStore } from './session-store';
import {
  runDailyOrderReport,
  sendTelegram,
  answerCallbackQuery,
  getSmartStoreToken,
  getNewOrderDetails,
  getDailySettlement,
} from './smartstore-scheduler';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;

// ─── SSE 클라이언트 관리 ───
type SSEClient = {
  id: string;
  res: express.Response;
};
const sseClients: SSEClient[] = [];

// SSE 이벤트 브로드캐스트 함수
function broadcastEvent(event: {
  type: 'node_active' | 'node_complete' | 'node_error' | 'node_idle' | 'log' | 'flow';
  node?: string;   // 'brain' | 'smartstore' | 'telegram' | 'scheduler' | 'email' | 'commander'
  message: string;
  progress?: number; // 0-100
  flow?: string[];   // 활성화된 노드 연결선 (예: ['brain->smartstore'])
}) {
  const data = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (e) {
      // 연결 끊긴 클라이언트 무시
    }
  });
  console.log(`[SSE] ${event.type} | ${event.node || 'system'} | ${event.message}`);
}

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

// 다음 실행 시간 계산 헬퍼
function getNextRunTime(): string {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(0, 0, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  const kst = new Date(nextRun.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getFullYear()}-${String(kst.getMonth()+1).padStart(2,'0')}-${String(kst.getDate()).padStart(2,'0')} 09:00 KST`;
}

// 헬스체크
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    nextRun: getNextRunTime(),
    server: 'Jarvis Booking Server',
    version: '2.0',
    sseClients: sseClients.length,
  });
});

// Webhook 정보 조회
app.get('/webhook-info', async (req, res) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.json({ webhookUrl: '', error: 'No token' });
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await r.json() as { result?: { url?: string } };
    res.json({ webhookUrl: data.result?.url || '', raw: data.result });
  } catch (e) {
    res.json({ webhookUrl: '', error: String(e) });
  }
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

// ─── SSE 실시간 이벤트 스트림 엔드포인트 ───
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now().toString() + Math.random().toString(36).slice(2);
  const client: SSEClient = { id: clientId, res };
  sseClients.push(client);

  // 연결 즉시 현재 상태 전송
  res.write(`data: ${JSON.stringify({
    type: 'log',
    message: 'JARVIS 시스템 연결됨 | 실시간 모니터링 시작',
    timestamp: new Date().toISOString(),
  })}\n\n`);

  // 연결 해제 시 클라이언트 제거
  req.on('close', () => {
    const idx = sseClients.findIndex(c => c.id === clientId);
    if (idx !== -1) sseClients.splice(idx, 1);
    console.log(`[SSE] 클라이언트 연결 해제 (총 ${sseClients.length}명)`);
  });

  console.log(`[SSE] 새 클라이언트 연결 (총 ${sseClients.length}명)`);
});

// 수동 테스트용 - 즉시 주문 보고 실행
app.get('/run-order-report', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET && secret !== 'jarvis2024') {
    return res.status(401).json({ error: '인증 실패' });
  }
  try {
    broadcastEvent({ type: 'node_active', node: 'brain', message: '수동 주문 보고 실행 시작', progress: 0 });
    await runDailyOrderReport();
    broadcastEvent({ type: 'node_complete', node: 'brain', message: '주문 보고 실행 완료', progress: 100 });
    res.json({ success: true, message: '주문 보고 실행 완료' });
  } catch (e) {
    broadcastEvent({ type: 'node_error', node: 'brain', message: '주문 보고 오류: ' + String(e) });
    res.status(500).json({ error: String(e) });
  }
});

// ─── 텔레그램 Webhook 엔드포인트 ───
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // 즉시 응답 (텔레그램 요구사항)
  const update = req.body;
  try {
    // Callback Query (버튼 클릭) 처리
    if (update.callback_query) {
      const query = update.callback_query;
      const data = query.data as string;
      const messageId = query.message?.message_id;
      console.log('[Webhook] Callback Query:', data);

      // ── 발주서 발송 확인 ──
      if (data.startsWith('confirm_dispatch_')) {
        const dateStr = data.replace('confirm_dispatch_', '');
        await answerCallbackQuery(query.id, '발주서 처리 중...');
        broadcastEvent({ type: 'node_active', node: 'brain', message: '발주서 처리 시작: ' + dateStr, progress: 10, flow: ['commander->brain'] });
        await sendTelegram('⏳ 발주서를 준비하고 있습니다...');
        broadcastEvent({ type: 'node_active', node: 'telegram', message: '발주서 준비 중 알림 발송', progress: 20, flow: ['brain->telegram'] });
        try {
          await processDispatch(dateStr, messageId);
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'brain', message: '발주서 처리 오류: ' + String(e) });
          await sendTelegram('❌ 발주서 처리 중 오류 발생\n' + String(e));
        }
      }

      // ── 발주서 이메일 실제 발송 ──
      else if (data.startsWith('send_dispatch_email_')) {
        const dateStr = data.replace('send_dispatch_email_', '');
        await answerCallbackQuery(query.id, '이메일 발송 중...');
        broadcastEvent({ type: 'node_active', node: 'brain', message: '발주서 이메일 발송 시작', progress: 10, flow: ['commander->brain'] });
        try {
          broadcastEvent({ type: 'node_active', node: 'smartstore', message: '스마트스토어 주문 조회 중...', progress: 30, flow: ['brain->smartstore'] });
          const token = await getSmartStoreToken();
          if (!token) {
            broadcastEvent({ type: 'node_error', node: 'smartstore', message: '스마트스토어 인증 실패' });
            await sendTelegram('❌ 스마트스토어 인증 실패');
            return;
          }
          const orders = await getNewOrderDetails(token, dateStr, dateStr);
          broadcastEvent({ type: 'node_complete', node: 'smartstore', message: `주문 ${orders.length}건 조회 완료`, progress: 50, flow: ['brain->smartstore'] });

          // 발주서 HTML 이메일 구성
          let htmlBody = '<h2>📦 ' + dateStr + ' 발주서</h2><table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">';
          htmlBody += '<tr style="background:#f0f0f0"><th>상품명/옵션</th><th>수량</th><th>주문번호</th><th>수령인</th></tr>';
          for (const order of orders) {
            htmlBody += '<tr><td>' + (order.productName || '') + ' ' + (order.productOption || '') + '</td>';
            htmlBody += '<td>' + (order.quantity || 1) + '</td>';
            htmlBody += '<td>' + (order.orderId || '') + '</td>';
            htmlBody += '<td>' + (order.receiverName || '') + '</td></tr>';
          }
          htmlBody += '</table><p>총 ' + orders.length + '건</p>';

          broadcastEvent({ type: 'node_active', node: 'email', message: '발주서 이메일 발송 중...', progress: 70, flow: ['brain->email'] });
          const { sendEmailNotification } = await import('./email');
          await sendEmailNotification({
            to: process.env.DISPATCH_EMAIL || 'jungsng805@naver.com',
            subject: '[자비스] ' + dateStr + ' 발주서 (' + orders.length + '건)',
            html: htmlBody,
          });
          broadcastEvent({ type: 'node_complete', node: 'email', message: '발주서 이메일 발송 완료', progress: 85, flow: ['brain->email'] });

          broadcastEvent({ type: 'node_active', node: 'telegram', message: '발주서 완료 알림 발송 중...', progress: 90, flow: ['brain->telegram'] });
          await sendTelegram(
            '✅ <b>발주서 이메일 발송 완료</b>\n' +
            '━━━━━━━━━━━━━━━\n' +
            '📅 날짜: ' + dateStr + '\n' +
            '📦 주문 수: <b>' + orders.length + '건</b>\n' +
            '📧 발송처: ' + (process.env.DISPATCH_EMAIL || 'jungsng805@naver.com') + '\n' +
            '━━━━━━━━━━━━━━━'
          );
          broadcastEvent({ type: 'node_complete', node: 'telegram', message: '발주서 발송 완료 보고', progress: 100, flow: ['brain->telegram'] });
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'email', message: '이메일 발송 실패: ' + String(e) });
          await sendTelegram('❌ 발주서 이메일 발송 실패\n' + String(e));
        }
      }

      // ── 발주서 취소 ──
      else if (data === 'cancel_dispatch') {
        await answerCallbackQuery(query.id, '발주서 발송을 취소했습니다.');
        broadcastEvent({ type: 'node_idle', node: 'email', message: '발주서 발송 취소됨' });
        await sendTelegram('⏹ 발주서 발송이 취소되었습니다.');
      }

      // ── 발주서 나중에 ──
      else if (data === 'skip_dispatch') {
        await answerCallbackQuery(query.id, '나중에 처리합니다.');
        broadcastEvent({ type: 'node_idle', node: 'email', message: '발주서 발송 건너뜀' });
        if (messageId) {
          const originalText = query.message?.text || '';
          const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
          const chatId = process.env.TELEGRAM_CHAT_ID || '';
          await fetch('https://api.telegram.org/bot' + botToken + '/editMessageText', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: originalText + '\n\n⏭ 발주서 발송을 건너뛰었습니다.', parse_mode: 'HTML' }),
          });
        }
      }

      // ── 정산 확인 완료 ──
      else if (data.startsWith('confirm_settle_')) {
        const parts = data.replace('confirm_settle_', '').split('_');
        const dateStr = parts[0];
        const amount = parseInt(parts[1] || '0', 10);
        await answerCallbackQuery(query.id, '정산 확인 완료!');
        broadcastEvent({ type: 'node_active', node: 'brain', message: '정산 확인 처리 중...', progress: 50, flow: ['commander->brain'] });
        const formattedAmount = amount.toLocaleString('ko-KR');
        broadcastEvent({ type: 'node_active', node: 'telegram', message: '정산 확인 완료 알림 발송 중...', progress: 80, flow: ['brain->telegram'] });
        await sendTelegram(
          '✅ <b>정산 확인 완료</b>\n' +
          '━━━━━━━━━━━━━━━\n' +
          '📅 날짜: ' + dateStr + '\n' +
          '💰 정산 금액: <b>' + formattedAmount + '원</b>\n' +
          '━━━━━━━━━━━━━━━\n' +
          '정산 내역이 확인되었습니다. 입금 처리 후 알려주시면 기록하겠습니다.'
        );
        broadcastEvent({ type: 'node_complete', node: 'telegram', message: '정산 확인 완료 보고', progress: 100 });
      }

      // ── 정산 재확인 ──
      else if (data.startsWith('recheck_settle_')) {
        const dateStr = data.replace('recheck_settle_', '');
        await answerCallbackQuery(query.id, '정산 재조회 중...');
        broadcastEvent({ type: 'node_active', node: 'smartstore', message: '정산 재조회 중: ' + dateStr, progress: 30, flow: ['commander->brain', 'brain->smartstore'] });
        await sendTelegram('🔄 ' + dateStr + ' 정산 내역을 다시 조회합니다...');
        const token = await getSmartStoreToken();
        if (token) {
          const settlement = await getDailySettlement(token, dateStr);
          if (settlement) {
            broadcastEvent({ type: 'node_complete', node: 'smartstore', message: '정산 조회 완료: ' + settlement.settleAmount.toLocaleString('ko-KR') + '원', progress: 80 });
            const formattedAmount = settlement.settleAmount.toLocaleString('ko-KR');
            await sendTelegram(
              '📊 <b>정산 재조회 결과</b>\n' +
              '━━━━━━━━━━━━━━━\n' +
              '📅 날짜: ' + dateStr + '\n' +
              '💰 정산 금액: <b>' + formattedAmount + '원</b>\n' +
              '건수: ' + settlement.settleCount + '건\n' +
              '━━━━━━━━━━━━━━━',
              {
                inline_keyboard: [[
                  { text: '✅ 정산 확인 완료', callback_data: 'confirm_settle_' + dateStr + '_' + settlement.settleAmount },
                ]],
              }
            );
            broadcastEvent({ type: 'node_complete', node: 'telegram', message: '정산 재조회 결과 발송 완료', progress: 100 });
          } else {
            broadcastEvent({ type: 'node_error', node: 'smartstore', message: '정산 조회 실패' });
            await sendTelegram('❌ 정산 조회 실패. 스마트스토어 관리자 페이지를 직접 확인해주세요.');
          }
        }
      }
    }

    // 일반 메시지 처리
    if (update.message) {
      const text = (update.message.text || '').trim();
      const chatId = update.message.chat?.id;
      console.log('[Webhook] 메시지:', text, 'from chat_id:', chatId);

      // KST 날짜 헬퍼
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const todayKST = kstNow.toISOString().split('T')[0];
      const yesterdayKST = (() => { const d = new Date(kstNow); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();

      // ── /start 또는 /help ──
      if (text === '/start' || text === '/help') {
        broadcastEvent({ type: 'log', node: 'telegram', message: '텔레그램 /help 명령 수신' });
        await sendTelegram(
          '🤖 <b>자비스 (JARVIS) 명령어 목록</b>\n' +
          '━━━━━━━━━━━━━━━\n\n' +
          '📊 <b>주문/현황</b>\n' +
          '• /report - 어제+오늘 전체 현황 보고\n' +
          '• /today - 오늘 신규 주문 조회\n' +
          '• /orders - 현재 처리 중인 주문 목록\n\n' +
          '💰 <b>정산</b>\n' +
          '• /settle - 어제 정산 내역 조회\n' +
          '• /settle YYYY-MM-DD - 특정 날짜 정산 조회\n\n' +
          '📋 <b>발주서</b>\n' +
          '• /dispatch - 어제 발주서 발송 준비\n' +
          '• /dispatch YYYY-MM-DD - 특정 날짜 발주서\n\n' +
          '⚙️ <b>시스템</b>\n' +
          '• /status - 서버 및 시스템 상태 확인\n' +
          '• /help - 이 도움말 보기\n\n' +
          '━━━━━━━━━━━━━━━\n' +
          '매일 09:00 KST 자동 보고 실행 중'
        );

      // ── /report - 전체 현황 보고 ──
      } else if (text === '/report') {
        broadcastEvent({ type: 'node_active', node: 'brain', message: '텔레그램 /report 명령 수신', progress: 0, flow: ['telegram->brain'] });
        await sendTelegram('🔄 전체 현황을 조회하고 있습니다...');
        await runDailyOrderReport();
        broadcastEvent({ type: 'node_complete', node: 'brain', message: '주문 현황 조회 완료', progress: 100 });

      // ── /today - 오늘 신규 주문 ──
      } else if (text === '/today') {
        broadcastEvent({ type: 'node_active', node: 'smartstore', message: '오늘 신규 주문 조회 중...', progress: 20, flow: ['telegram->brain', 'brain->smartstore'] });
        await sendTelegram('🔄 오늘 신규 주문을 조회하고 있습니다...');
        try {
          const token = await getSmartStoreToken();
          if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
          const orders = await getNewOrderDetails(token, todayKST, todayKST);
          broadcastEvent({ type: 'node_complete', node: 'smartstore', message: `오늘 신규 주문 ${orders.length}건`, progress: 80 });
          if (orders.length === 0) {
            await sendTelegram('📭 오늘(' + todayKST + ') 신규 주문이 없습니다.');
          } else {
            const bamOrders: Record<string, number> = {};
            const cornOrders: Record<string, number> = {};
            for (const order of orders) {
              const opt = order.productOption || order.productName || '기타';
              const isCorn = opt.includes('옥수수') || opt.includes('옥광') || opt.includes('3X') || opt.includes('찰옥');
              if (isCorn) cornOrders[opt] = (cornOrders[opt] || 0) + (order.quantity || 1);
              else bamOrders[opt] = (bamOrders[opt] || 0) + (order.quantity || 1);
            }
            let msg = '🛒 <b>오늘(' + todayKST + ') 신규 주문</b>\n';
            msg += '━━━━━━━━━━━━━━━\n';
            msg += '📦 총 <b>' + orders.length + '건</b>\n\n';
            if (Object.keys(bamOrders).length > 0) {
              msg += '🌰 <b>밤</b>\n';
              for (const [name, qty] of Object.entries(bamOrders)) msg += '  • ' + name + ': ' + qty + '개\n';
            }
            if (Object.keys(cornOrders).length > 0) {
              msg += '🌽 <b>옥수수</b>\n';
              for (const [name, qty] of Object.entries(cornOrders)) msg += '  • ' + name + ': ' + qty + '개\n';
            }
            await sendTelegram(msg, {
              inline_keyboard: [[
                { text: '📋 발주서 발송', callback_data: 'confirm_dispatch_' + todayKST },
              ]]
            });
          }
          broadcastEvent({ type: 'node_complete', node: 'telegram', message: '오늘 주문 조회 완료 보고', progress: 100 });
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'smartstore', message: '오늘 주문 조회 실패' });
          await sendTelegram('❌ 오늘 주문 조회 실패\n' + String(e));
        }

      // ── /orders - 처리 중인 주문 목록 ──
      } else if (text === '/orders') {
        broadcastEvent({ type: 'node_active', node: 'smartstore', message: '처리 중 주문 조회 중...', progress: 20, flow: ['telegram->brain', 'brain->smartstore'] });
        await sendTelegram('🔄 처리 중인 주문을 조회하고 있습니다...');
        try {
          const token = await getSmartStoreToken();
          if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
          const orders = await getNewOrderDetails(token, yesterdayKST, todayKST);
          broadcastEvent({ type: 'node_complete', node: 'smartstore', message: `처리 중 주문 ${orders.length}건`, progress: 80 });
          if (orders.length === 0) {
            await sendTelegram('📭 처리 중인 주문이 없습니다.');
          } else {
            let msg = '📋 <b>처리 중인 주문 목록</b>\n';
            msg += '━━━━━━━━━━━━━━━\n';
            for (const order of orders.slice(0, 20)) {
              msg += '• ' + (order.productName || '') + ' ' + (order.productOption || '') + ' x' + (order.quantity || 1) + ' | ' + (order.receiverName || '') + '\n';
            }
            if (orders.length > 20) msg += '...외 ' + (orders.length - 20) + '건';
            await sendTelegram(msg);
          }
          broadcastEvent({ type: 'node_complete', node: 'telegram', message: '주문 목록 보고 완료', progress: 100 });
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'smartstore', message: '주문 목록 조회 실패' });
          await sendTelegram('❌ 주문 목록 조회 실패\n' + String(e));
        }

      // ── /settle [날짜] - 정산 조회 ──
      } else if (text.startsWith('/settle')) {
        const parts = text.split(' ');
        const targetDate = parts[1] || yesterdayKST;
        broadcastEvent({ type: 'node_active', node: 'smartstore', message: '정산 조회 중: ' + targetDate, progress: 20, flow: ['telegram->brain', 'brain->smartstore'] });
        await sendTelegram('🔄 ' + targetDate + ' 정산 내역을 조회하고 있습니다...');
        try {
          const token = await getSmartStoreToken();
          if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
          const settlement = await getDailySettlement(token, targetDate);
          broadcastEvent({ type: 'node_complete', node: 'smartstore', message: '정산 조회 완료', progress: 80 });
          if (!settlement || settlement.settleAmount === 0) {
            await sendTelegram('💰 ' + targetDate + ' 정산 내역이 없습니다.\n(아직 정산 처리 전이거나 해당 날짜 거래가 없습니다.)');
          } else {
            const formattedAmount = settlement.settleAmount.toLocaleString('ko-KR');
            await sendTelegram(
              '💰 <b>' + targetDate + ' 정산 내역</b>\n' +
              '━━━━━━━━━━━━━━━\n' +
              '정산 금액: <b>' + formattedAmount + '원</b>\n' +
              '정산 건수: <b>' + settlement.settleCount + '건</b>\n' +
              '━━━━━━━━━━━━━━━',
              {
                inline_keyboard: [[
                  { text: '✅ 정산 확인 완료', callback_data: 'confirm_settle_' + targetDate + '_' + settlement.settleAmount },
                  { text: '🔄 재조회', callback_data: 'recheck_settle_' + targetDate },
                ]]
              }
            );
          }
          broadcastEvent({ type: 'node_complete', node: 'telegram', message: '정산 조회 보고 완료', progress: 100 });
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'smartstore', message: '정산 조회 실패' });
          await sendTelegram('❌ 정산 조회 실패\n' + String(e));
        }

      // ── /dispatch [날짜] - 발주서 발송 준비 ──
      } else if (text.startsWith('/dispatch')) {
        const parts = text.split(' ');
        const targetDate = parts[1] || yesterdayKST;
        broadcastEvent({ type: 'node_active', node: 'brain', message: '발주서 준비 시작: ' + targetDate, progress: 10, flow: ['telegram->brain'] });
        await sendTelegram('🔄 ' + targetDate + ' 발주서를 준비하고 있습니다...');
        try {
          await processDispatch(targetDate);
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'brain', message: '발주서 준비 실패' });
          await sendTelegram('❌ 발주서 준비 실패\n' + String(e));
        }

      // ── /status - 시스템 상태 ──
      } else if (text === '/status') {
        broadcastEvent({ type: 'log', node: 'brain', message: '시스템 상태 조회 요청' });
        try {
          const token = await getSmartStoreToken();
          const sseCount = sseClients.length;
          const nextRun = getNextRunTime();
          const statusMsg =
            '⚙️ <b>자비스 시스템 상태</b>\n' +
            '━━━━━━━━━━━━━━━\n' +
            '🟢 Railway 서버: <b>정상 가동 중</b>\n' +
            '🤖 스마트스토어 API: <b>' + (token ? '연결됨' : '연결 실패') + '</b>\n' +
            '📡 텔레그램 Webhook: <b>등록됨</b>\n' +
            '🔴 실시간 모니터: <b>' + sseCount + '명 연결 중</b>\n' +
            '⏰ 다음 자동 보고: <b>' + nextRun + '</b>\n' +
            '━━━━━━━━━━━━━━━\n' +
            '서버 시간: ' + new Date().toISOString();
          await sendTelegram(statusMsg);
          broadcastEvent({ type: 'log', node: 'brain', message: '시스템 상태 보고 완료' });
        } catch (e) {
          await sendTelegram('❌ 상태 조회 실패\n' + String(e));
        }

      // ── 알 수 없는 명령어 ──
      } else if (text.startsWith('/')) {
        await sendTelegram(
          '❓ 알 수 없는 명령어입니다.\n' +
          '/help 를 입력하면 전체 명령어를 확인할 수 있습니다.'
        );
      }
    }
  } catch (e) {
    console.error('[Webhook] 처리 오류:', e);
    broadcastEvent({ type: 'node_error', node: 'brain', message: 'Webhook 처리 오류: ' + String(e) });
  }
});

// ─── Webhook 등록 ───
app.get('/setup-webhook', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.CRON_SECRET && secret !== 'jarvis2024') {
    return res.status(401).json({ error: '인증 실패' });
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : (process.env.SERVER_URL || '');
  if (!serverUrl) {
    return res.status(400).json({ error: 'SERVER_URL 환경변수가 없습니다.' });
  }
  try {
    const webhookUrl = serverUrl + '/telegram-webhook';
    const result = await fetch('https://api.telegram.org/bot' + botToken + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await result.json();
    console.log('[Webhook] 등록 결과:', data);
    res.json({ success: true, webhookUrl, result: data });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── 발주서 처리 함수 ───
async function processDispatch(dateStr: string, originalMessageId?: number): Promise<void> {
  broadcastEvent({ type: 'node_active', node: 'smartstore', message: '스마트스토어 토큰 발급 중...', progress: 20, flow: ['brain->smartstore'] });
  const token = await getSmartStoreToken();
  if (!token) {
    broadcastEvent({ type: 'node_error', node: 'smartstore', message: '스마트스토어 인증 실패' });
    await sendTelegram('❌ 스마트스토어 인증 실패. 발주서 처리를 중단합니다.');
    return;
  }

  // 날짜 범위 계산 (해당 날짜 전체)
  const fromDate = dateStr;
  const toDate = dateStr;
  broadcastEvent({ type: 'node_active', node: 'smartstore', message: '주문 목록 조회 중...', progress: 40, flow: ['brain->smartstore'] });
  const orders = await getNewOrderDetails(token, fromDate, toDate);
  broadcastEvent({ type: 'node_complete', node: 'smartstore', message: `주문 ${orders.length}건 조회 완료`, progress: 60 });

  if (orders.length === 0) {
    broadcastEvent({ type: 'node_idle', node: 'smartstore', message: '신규 주문 없음' });
    await sendTelegram('📭 ' + dateStr + ' 날짜의 신규 주문이 없습니다.');
    return;
  }

  // 주문 목록 정리
  const bamOrders: any[] = [];
  const cornOrders: any[] = [];

  for (const order of orders) {
    const optionName = order.productOption || order.productName || '';
    const isCorn = optionName.includes('옥수수') || optionName.includes('옥광') ||
                   optionName.includes('3X') || optionName.includes('찰옥');
    if (isCorn) cornOrders.push(order);
    else bamOrders.push(order);
  }

  // 발주서 요약 메시지 구성
  let summaryMsg = '📋 <b>발주서 발송 준비 완료</b>\n';
  summaryMsg += '━━━━━━━━━━━━━━━\n';
  summaryMsg += '📅 날짜: ' + dateStr + '\n';
  summaryMsg += '📦 총 주문: <b>' + orders.length + '건</b>\n';
  if (bamOrders.length > 0) summaryMsg += '🌰 밤: ' + bamOrders.length + '건\n';
  if (cornOrders.length > 0) summaryMsg += '🌽 옥수수: ' + cornOrders.length + '건\n';
  summaryMsg += '━━━━━━━━━━━━━━━\n';
  summaryMsg += '📧 발송 대상: jungsng805@naver.com\n\n';
  summaryMsg += '⚠️ 위 내용으로 발주서를 이메일 발송하겠습니다.\n확인 후 아래 버튼을 눌러주세요.';

  broadcastEvent({ type: 'node_active', node: 'telegram', message: '발주서 확인 요청 발송 중...', progress: 80, flow: ['brain->telegram'] });
  await sendTelegram(summaryMsg, {
    inline_keyboard: [[
      { text: '✅ 발주서 이메일 발송', callback_data: 'send_dispatch_email_' + dateStr },
      { text: '❌ 취소', callback_data: 'cancel_dispatch' },
    ]],
  });
  broadcastEvent({ type: 'node_complete', node: 'telegram', message: '발주서 확인 요청 발송 완료 - 사장님 응답 대기 중', progress: 90 });
}

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
    broadcastEvent({ type: 'node_active', node: 'scheduler', message: '매일 9시 자동 주문 보고 시작', progress: 0, flow: ['scheduler->brain'] });
    await runDailyOrderReport();
    broadcastEvent({ type: 'node_complete', node: 'scheduler', message: '자동 주문 보고 완료', progress: 100 });
    scheduleDaily9AM();
  }, msUntilRun);
}

// 스케줄러 시작
scheduleDaily9AM();
// 실시간 주문 모니터 시작 (5분 간격 폴링)
startOrderMonitor();

app.listen(PORT, () => {
  console.log(`🤖 Jarvis Booking Server running on port ${PORT}`);
  // 서버 시작 시 Webhook 자동 등록
  autoSetupWebhook();
});

// ─── 서버 시작 시 Webhook 자동 등록 ───
async function autoSetupWebhook() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || '';
  const serverUrl = process.env.SERVER_URL || '';
  const baseUrl = railwayDomain ? 'https://' + railwayDomain : serverUrl;

  if (!botToken || !baseUrl) {
    console.log('[Webhook] 자동 등록 건너뜀 - BOT_TOKEN 또는 SERVER_URL 없음');
    return;
  }

  try {
    const webhookUrl = baseUrl + '/telegram-webhook';
    const result = await fetch('https://api.telegram.org/bot' + botToken + '/setWebhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await result.json() as any;
    if (data.ok) {
      console.log('[Webhook] 자동 등록 성공:', webhookUrl);
    } else {
      console.error('[Webhook] 자동 등록 실패:', data.description);
    }
  } catch (e) {
    console.error('[Webhook] 자동 등록 오류:', e);
  }
}
