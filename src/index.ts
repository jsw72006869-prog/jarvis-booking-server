import express from 'express';
import { generateSettlementXlsx, generateBamDispatchXlsx, generateCornDispatchXlsx, calcCostSummary, isCornProduct, parseNaverOrderSheet, getProductCostTable, BAM_PRODUCTS, CORN_PRODUCTS, type OrderItem } from './settlement';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import cors from 'cors';
import dotenv from 'dotenv';
import { bookingRouter } from './routes/booking';
import { startOrderMonitor } from './order-monitor';
import { checkAndNotifyIPChange } from './ip-manager';
import { sessionStore } from './session-store';
import {
  runDailyOrderReport,
  sendTelegram,
  answerCallbackQuery,
  getSmartStoreToken,
  getNewOrderDetails,
  getDailySettlement,
  updateOrderShippingStatus,
  getDispatchReadyOrders,
  confirmProductOrders,
  dispatchProductOrders,
} from './smartstore-scheduler';
import {
  writeSettlementToGoogleSheet,
  writeDispatchToGoogleSheet,
  isGoogleSheetsConfigured,
} from './google-sheets';

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

// ─── 텔레그램 파일 전송 함수 ───
async function sendTelegramDocument(fileBuffer: Buffer, filename: string, caption?: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!botToken || !chatId) return false;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fileBuffer, { filename, contentType: 'application/octet-stream' });
    if (caption) form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendDocument', {
      method: 'POST',
      body: form as any,
      headers: form.getHeaders(),
    });
    const data = await res.json() as any;
    if (!data.ok) {
      console.error('[텔레그램] 파일 전송 실패:', data.description);
      return false;
    }
    console.log('[텔레그램] 파일 전송 성공:', filename);
    return true;
  } catch (e) {
    console.error('[텔레그램] 파일 전송 오류:', e);
    return false;
  }
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

          // 상품 분류
          const orderItems: OrderItem[] = orders.map((o: any) => ({
            productName: o.productName || '',
            productOption: o.productOption || '',
            quantity: o.quantity || 1,
            orderId: o.orderId || '',
            receiverName: o.receiverName || '',
            receiverPhone: o.receiverPhone || '',
            address: o.address || '',
            senderName: '이혜안',
            senderPhone: process.env.SENDER_PHONE || '',
          }));
          // 밤 / 옥수수 분류
          const bamItems = orderItems.filter(o => !isCornProduct(o.productOption || o.productName));
          const cornItems = orderItems.filter(o => isCornProduct(o.productOption || o.productName));

          const { sendEmailNotification } = await import('./email');
          const dispatchEmail = process.env.DISPATCH_EMAIL || 'jungsng805@naver.com';
          let sentSummary = '';

          // ── 밤 발주서 (로젠택배) ──
          if (bamItems.length > 0) {
            const bamDispatch = generateBamDispatchXlsx(dateStr, bamItems);
            const bamSettlement = generateSettlementXlsx(dateStr, bamItems, 'bam');
            const bamAttachments = [
              { filename: dateStr + '_밤발주서(로젠).xls', content: bamDispatch, contentType: 'application/vnd.ms-excel' },
              { filename: dateStr + '_밤정산서.xlsx', content: bamSettlement.xlsxBuffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            ];
            let bamHtml = '<h2>🌰 ' + dateStr + ' 밤 발주서 (로젠택배)</h2>';
            bamHtml += '<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">';
            bamHtml += '<tr style="background:#fff3cd"><th>제품</th><th>수량</th><th>받는분</th><th>핸드폰</th><th>주소</th></tr>';
            for (const o of bamItems) {
              bamHtml += `<tr><td>${o.productOption || o.productName}</td><td>${o.quantity}</td><td>${o.receiverName}</td><td>${o.receiverPhone}</td><td>${o.address}</td></tr>`;
            }
            bamHtml += `</table><p>총 ${bamItems.length}건 | 로젠택배 발주서 + 정산서 첨부</p>`;
            broadcastEvent({ type: 'node_active', node: 'email', message: '밤 발주서(로젠) 이메일 발송 중...', progress: 60, flow: ['brain->email'] });
            await sendEmailNotification({
              to: dispatchEmail,
              subject: `[자비스] ${dateStr} 밤 발주서(로젠택배) ${bamItems.length}건`,
              html: bamHtml,
              attachments: bamAttachments,
            });
            sentSummary += `🌰 밤(로젠): ${bamItems.length}건 발송 완료\n`;
          }

          // ── 옥수수 발주서 (롯데택배) ──
          if (cornItems.length > 0) {
            const cornDispatch = generateCornDispatchXlsx(dateStr, cornItems);
            const cornSettlement = generateSettlementXlsx(dateStr, cornItems, 'corn');
            const cornAttachments = [
              { filename: dateStr + '_옥수수발주서(롯데).xlsx', content: cornDispatch, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
              { filename: dateStr + '_옥수수정산서.xlsx', content: cornSettlement.xlsxBuffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            ];
            let cornHtml = '<h2>🌽 ' + dateStr + ' 옥수수 발주서 (롯데택배)</h2>';
            cornHtml += '<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">';
            cornHtml += '<tr style="background:#d4edda"><th>상품주문번호</th><th>수취인</th><th>상품명</th><th>수량</th><th>연락처</th><th>주소</th></tr>';
            for (const o of cornItems) {
              cornHtml += `<tr><td>${o.orderId}</td><td>${o.receiverName}</td><td>${o.productOption || o.productName}</td><td>${o.quantity}</td><td>${o.receiverPhone}</td><td>${o.address}</td></tr>`;
            }
            cornHtml += `</table><p>총 ${cornItems.length}건 | 롯데택배 발주서 + 정산서 첨부</p>`;
            broadcastEvent({ type: 'node_active', node: 'email', message: '옥수수 발주서(롯데) 이메일 발송 중...', progress: 75, flow: ['brain->email'] });
            await sendEmailNotification({
              to: dispatchEmail,
              subject: `[자비스] ${dateStr} 옥수수 발주서(롯데택배) ${cornItems.length}건`,
              html: cornHtml,
              attachments: cornAttachments,
            });
            sentSummary += `🌽 옥수수(롯데): ${cornItems.length}건 발송 완료\n`;
          }

          broadcastEvent({ type: 'node_complete', node: 'email', message: '발주서+정산서 이메일 발송 완료', progress: 85, flow: ['brain->email'] });

          // 원가 계산 요약
          const costSummary = calcCostSummary(bamItems, cornItems);

          broadcastEvent({ type: 'node_active', node: 'telegram', message: '발주서 완료 알림 발송 중...', progress: 90, flow: ['brain->telegram'] });
          await sendTelegram(
            '✅ <b>발주서+정산서 이메일 발송 완료</b>\n' +
            '━━━━━━━━━━━━━━━\n' +
            '📅 날짜: ' + dateStr + '\n' +
            '📦 총 주문: <b>' + orders.length + '건</b>\n' +
            sentSummary +
            '📧 발송처: ' + dispatchEmail + '\n' +
            '━━━━━━━━━━━━━━━' +
            costSummary
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

      // ── 발주확인 처리 (PAYED → OK) ──
      else if (data.startsWith('confirm_order_')) {
        const dateStr = data.replace('confirm_order_', '');
        await answerCallbackQuery(query.id, '발주확인 중...');
        broadcastEvent({ type: 'node_active', node: 'brain', message: '발주확인 시작: ' + dateStr, progress: 10, flow: ['commander->brain'] });
        await sendTelegram('⏳ 발주확인 중...');
        try {
          const token = await getSmartStoreToken();
          if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
          // PAYED 상태 주문 조회 (해당 날짜 + 전날까지 범위로 조회)
          const kstNow2 = new Date(Date.now() + 9 * 60 * 60 * 1000);
          const todayKST2 = kstNow2.toISOString().split('T')[0];
          const newOrders = await getNewOrderDetails(token, dateStr, todayKST2);
          if (!newOrders || newOrders.length === 0) {
            await sendTelegram('📭 발주확인할 신규 주문이 없습니다.');
            return;
          }
          const orderIds = newOrders.map((o: any) => o.productOrderId).filter(Boolean);
          const result = await confirmProductOrders(token, orderIds);
          broadcastEvent({ type: 'node_complete', node: 'smartstore', message: result.message, progress: 100 });
          if (result.success) {
            await sendTelegram(
              '✅ <b>발주확인 완료</b>\n' +
              '━━━━━━━━━━━━━━━\n' +
              '📅 날짜: ' + dateStr + '\n' +
              '✅ 성공: <b>' + result.successIds.length + '건</b>\n' +
              '━━━━━━━━━━━━━━━\n' +
              '📦 배송준비 상태로 변경되었습니다.'
            );
          } else {
            await sendTelegram(
              '⚠️ <b>발주확인 부분 실패</b>\n' +
              '━━━━━━━━━━━━━━━\n' +
              '✅ 성공: ' + result.successIds.length + '건\n' +
              '❌ 실패: ' + result.failIds.length + '건\n' +
              result.message
            );
          }
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'brain', message: '발주확인 오류: ' + String(e) });
          await sendTelegram('❌ 발주확인 오류\n' + String(e));
        }
      }

      // ── 배송처리 시작 (송장번호 입력 요청) ──
      else if (data.startsWith('start_shipping_')) {
        const dateStr = data.replace('start_shipping_', '');
        await answerCallbackQuery(query.id, '송장번호 입력 요청');
        // 송장번호 입력 대기 상태 저장
        (global as any).__pendingShipping = { dateStr };
        await sendTelegram(
          '🚚 <b>배송처리 - 송장번호 입력</b>\n' +
          '━━━━━━━━━━━━━━━\n' +
          '📅 날짜: ' + dateStr + '\n' +
          '\n송장번호를 입력해주세요.\n' +
          '형식: <code>택배사 송장번호</code>\n' +
          '예시: <code>로젠 1234567890</code>\n' +
          '예시: <code>롯데 9876543210</code>\n' +
          '━━━━━━━━━━━━━━━\n' +
          '지원 택배사: 로젠, 롯데, CJ, 한진, 우체국'
        );
      }

      // ── 배송 처리 (기존 코드 유지) ──
      else if (data.startsWith('confirm_shipping_')) {
        const dateStr = data.replace('confirm_shipping_', '');
        await answerCallbackQuery(query.id, '배송 처리 중...');
        broadcastEvent({ type: 'node_active', node: 'brain', message: '배송 처리 시작: ' + dateStr, progress: 10, flow: ['commander->brain'] });
        await sendTelegram('⏳ 배송 상태를 업데이트하고 있습니다...');
        try {
          const token = await getSmartStoreToken();
          if (!token) {
            await sendTelegram('❌ 스마트스토어 인증 실패. 배송 처리를 중단합니다.');
            return;
          }
          const orders = await getDispatchReadyOrders(token, dateStr, dateStr);
          if (orders.length === 0) {
            await sendTelegram('📭 배송 준비 중인 주문이 없습니다.');
            return;
          }
          let successCount = 0;
          let failCount = 0;
          for (const order of orders) {
            const result = await updateOrderShippingStatus(
              token,
              [order.productOrderId],
              '로젠',
              'PENDING'
            );
            if (result.success) successCount++;
            else failCount++;
          }
          broadcastEvent({ type: 'node_complete', node: 'smartstore', message: `배송 처리 완료: ${successCount}건 성공, ${failCount}건 실패`, progress: 100 });
          await sendTelegram(
            '✅ <b>배송 처리 완료</b>\n' +
            '━━━━━━━━━━━━━━━\n' +
            '📅 날짜: ' + dateStr + '\n' +
            '✅ 성공: <b>' + successCount + '건</b>\n' +
            (failCount > 0 ? '❌ 실패: <b>' + failCount + '건</b>\n' : '') +
            '━━━━━━━━━━━━━━━'
          );
        } catch (e) {
          broadcastEvent({ type: 'node_error', node: 'brain', message: '배송 처리 오류: ' + String(e) });
          await sendTelegram('❌ 배송 처리 중 오류 발생\n' + String(e));
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

      // ── 통합주문서 발주서+정산서 발송 확인 ──
      else if (data.startsWith('send_order_sheet_')) {
        const dateStr = data.replace('send_order_sheet_', '');
        await answerCallbackQuery(query.id, '발주서+정산서 발송 중...');
        broadcastEvent({ type: 'node_active', node: 'brain', message: '통합주문서 기반 발주서 발송 시작', progress: 10, flow: ['commander->brain'] });
        const pending = (global as any).__pendingOrders;
        if (!pending || pending.dateStr !== dateStr) {
          await sendTelegram('⚠️ 주문 데이터가 만료되었습니다. 파일을 다시 업로드해 주세요.');
        } else {
          const { bamOrders, cornOrders } = pending;
          try {
            await sendTelegram('⏳ 3단계: 발주서+정산서 엑셀 생성 중...');
            const { sendEmailNotification } = await import('./email');
            const emailTo = process.env.DISPATCH_EMAIL || 'jungsng805@naver.com';

            if (bamOrders.length > 0) {
              await sendTelegram(`🌰 밤 발주서(로젠택배) 생성 중... (${bamOrders.length}건)`);
              const bamDispatch = generateBamDispatchXlsx(dateStr, bamOrders);
              const bamSettlement = generateSettlementXlsx(dateStr, bamOrders, 'bam');
              broadcastEvent({ type: 'node_active', node: 'email', message: '밤 발주서(로젠) 이메일 발송 중...', progress: 60, flow: ['brain->email'] });
              await sendTelegram(`✅ 밤 발주서 완료\n⏳ 이메일 발송 중...`);
              await sendEmailNotification({
                to: emailTo,
                subject: `[셀렌] ${dateStr} 밤 발주서 (로젠택배)`,
                html: `<p>${dateStr} 밤 발주서입니다.</p><p>총 ${bamOrders.length}건 / 로젠택배</p>`,
                attachments: [
                  { filename: dateStr + '_밤발주서(로젠).xls', content: bamDispatch, contentType: 'application/vnd.ms-excel' },
                  { filename: dateStr + '_밤정산서.xlsx', content: bamSettlement.xlsxBuffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
                ],
              });
            }

            if (cornOrders.length > 0) {
              await sendTelegram(`🌽 옥수수 발주서(롯데택배) 생성 중... (${cornOrders.length}건)`);
              const cornDispatch = generateCornDispatchXlsx(dateStr, cornOrders);
              const cornSettlement = generateSettlementXlsx(dateStr, cornOrders, 'corn');
              broadcastEvent({ type: 'node_active', node: 'email', message: '옥수수 발주서(롯데) 이메일 발송 중...', progress: 75, flow: ['brain->email'] });
              await sendTelegram(`✅ 옥수수 발주서 완료\n⏳ 이메일 발송 중...`);
              await sendEmailNotification({
                to: emailTo,
                subject: `[셀렌] ${dateStr} 옥수수 발주서 (롯데택배)`,
                html: `<p>${dateStr} 옥수수 발주서입니다.</p><p>총 ${cornOrders.length}건 / 롯데택배</p>`,
                attachments: [
                  { filename: dateStr + '_옥수수발주서(롯데).xlsx', content: cornDispatch, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
                  { filename: dateStr + '_옥수수정산서.xlsx', content: cornSettlement.xlsxBuffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
                ],
              });
            }

            broadcastEvent({ type: 'node_complete', node: 'email', message: '발주서+정산서 이메일 발송 완료', progress: 90 });
            const costSummary = calcCostSummary(bamOrders, cornOrders);
            await sendTelegram(
              `✅ <b>발주서+정산서 이메일 발송 완료</b>\n` +
              `━━━━━━━━━━━━━━━\n` +
              `📅 날짜: ${dateStr}\n` +
              `📦 총 주문: ${bamOrders.length + cornOrders.length}건\n` +
              `🌰 밤(로젠): ${bamOrders.length}건\n` +
              `🌽 옥수수(롯데): ${cornOrders.length}건\n` +
              `📧 발송처: ${emailTo}\n` +
              `━━━━━━━━━━━━━━━` +
              costSummary
            );
            (global as any).__pendingOrders = null;
          } catch (e) {
            broadcastEvent({ type: 'node_error', node: 'email', message: '이메일 발송 오류: ' + String(e) });
            await sendTelegram('❌ 이메일 발송 오류: ' + String(e));
          }
        }
      }
      // ── 통합주문서 취소 ──
      else if (data === 'cancel_order_sheet') {
        await answerCallbackQuery(query.id, '취소되었습니다');
        (global as any).__pendingOrders = null;
        await sendTelegram('❌ 발주서 발송이 취소되었습니다.');
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
      let text = (update.message.text || '').trim();
      const chatId = update.message.chat?.id;

      // ── 통합주문서 엑셀 파일 업로드 처리 ──
      if (update.message.document) {
        const doc = update.message.document;
        const fname = (doc.file_name || '').toLowerCase();
        const isExcel = fname.endsWith('.xlsx') || fname.endsWith('.xls');
        if (isExcel) {
          broadcastEvent({ type: 'node_active', node: 'brain', message: '통합주문서 파일 수신: ' + doc.file_name, progress: 10, flow: ['telegram->brain'] });
          await sendTelegram(`📂 <b>통합주문서 파일 수신</b>\n━━━━━━━━━━━━━━━\n파일명: ${doc.file_name}\n\n⏳ 1단계: 파일 분석 중...`);
          try {
            const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
            // 파일 다운로드
            const fileInfoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${doc.file_id}`);
            const fileInfo = await fileInfoRes.json() as any;
            const filePath = fileInfo.result?.file_path;
            if (!filePath) throw new Error('파일 경로를 가져올 수 없습니다');
            const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
            const fileBuffer = Buffer.from(await fileRes.arrayBuffer());

            // 파싱 및 분류
            await sendTelegram('✅ 1단계 완료\n⏳ 2단계: 밤/옥수수 분류 중...');
            const parsed = parseNaverOrderSheet(fileBuffer, '1234');
            const { bamOrders, cornOrders, unknownOrders, totalCount } = parsed;

            broadcastEvent({ type: 'node_complete', node: 'smartstore', message: `통합주문서 분류 완료: 밤 ${bamOrders.length}건, 옥수수 ${cornOrders.length}건`, progress: 50 });

            if (totalCount === 0) {
              await sendTelegram('⚠️ 주문 데이터를 찾을 수 없습니다. 파일을 확인해주세요.');
            } else {
              const dateStr = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
              let previewMsg = `✅ 2단계 완료\n\n📋 <b>통합주문서 분석 결과</b>\n━━━━━━━━━━━━━━━\n`;
              previewMsg += `📅 날짜: ${dateStr}\n`;
              previewMsg += `📦 총 ${totalCount}건\n`;
              previewMsg += `🌰 밤(로젠택배): ${bamOrders.length}건\n`;
              previewMsg += `🌽 옥수수(롯데택배): ${cornOrders.length}건\n`;
              if (unknownOrders.length > 0) previewMsg += `❓ 미분류: ${unknownOrders.length}건\n`;
              previewMsg += `━━━━━━━━━━━━━━━\n발주서+정산서를 이메일로 발송할까요?`;

              await sendTelegram(previewMsg, {
                inline_keyboard: [[
                  { text: '✅ 발주서+정산서 발송', callback_data: 'send_order_sheet_' + dateStr },
                  { text: '❌ 취소', callback_data: 'cancel_order_sheet' },
                ]]
              });

              // 임시 저장 (전역 변수)
              (global as any).__pendingOrders = { bamOrders, cornOrders, dateStr };
            }
          } catch (e) {
            broadcastEvent({ type: 'node_error', node: 'brain', message: '통합주문서 처리 오류: ' + String(e) });
            await sendTelegram('❌ 파일 처리 오류: ' + String(e));
          }
          return res.sendStatus(200);
        }
      }
      // ── 음성 메시지 처리 (OpenAI Whisper) ──
      if (update.message.voice || update.message.audio) {
        const voiceObj = update.message.voice || update.message.audio;
        await sendTelegram('🎤 음성 메시지를 인식하고 있습니다...');
        try {
          const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
          const openaiKey = process.env.OPENAI_API_KEY || '';
          if (!openaiKey) {
            await sendTelegram('❌ OpenAI API 키가 설정되지 않았습니다.\nRailway 환경변수에 OPENAI_API_KEY를 추가해주세요.');
            return res.sendStatus(200);
          }
          // 파일 정보 조회
          const fileInfoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${voiceObj.file_id}`);
          const fileInfo = await fileInfoRes.json() as any;
          const filePath = fileInfo.result?.file_path;
          if (!filePath) throw new Error('음성 파일 경로를 가져올 수 없습니다');
          // 파일 다운로드
          const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
          const audioBuffer = Buffer.from(await fileRes.arrayBuffer());

          // Whisper API로 음성 → 텍스트 변환
          const FormData = (await import('form-data')).default;
          const formData = new FormData();
          formData.append('file', audioBuffer, { filename: 'voice.oga', contentType: 'audio/ogg' });
          formData.append('model', 'whisper-1');
          formData.append('language', 'ko');

          const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${openaiKey}`, ...formData.getHeaders() },
            body: formData as any,
          });
          const whisperData = await whisperRes.json() as any;
          const transcribedText = (whisperData.text || '').trim();

          if (!transcribedText) {
            await sendTelegram('❌ 음성 인식에 실패했습니다. 다시 시도해주세요.');
            return res.sendStatus(200);
          }

          await sendTelegram(`🎤 음성 인식 완료: "<b>${transcribedText}</b>"\n\n처리 중...`);

          // 인식된 텍스트를 자연어 처리로 전달
          update.message.text = transcribedText;
          text = transcribedText; // text 변수도 업데이트
        } catch (e) {
          await sendTelegram('❌ 음성 처리 오류: ' + String(e));
          return res.sendStatus(200);
        }
      }

      console.log('[Webhook] 메시지:', text, 'from chat_id:', chatId);

      // ── 송장번호 입력 대기 상태 확인 ──
      const pendingShipping = (global as any).__pendingShipping;
      if (pendingShipping && text && !text.startsWith('/')) {
        // 송장번호 파싱: "택배사 송장번호" 형식
        const CARRIER_MAP: Record<string, string> = {
          '로젠': 'LOGEN', '로젠택배': 'LOGEN',
          '롯데': 'LOTTE', '롯데택배': 'LOTTE', '롯데택배서비스': 'LOTTE',
          'CJ': 'CJ_LOGISTICS', 'CJ대한': 'CJ_LOGISTICS', 'CJ택배': 'CJ_LOGISTICS',
          '한진': 'HANJIN', '한진택배': 'HANJIN',
          '우체국': 'EPOST', '우체국택배': 'EPOST',
        };
        const parts = text.trim().split(/\s+/);
        let carrierCode = '';
        let trackingNumber = '';
        if (parts.length >= 2) {
          const carrierKey = parts[0];
          carrierCode = CARRIER_MAP[carrierKey] || carrierKey;
          trackingNumber = parts[1];
        } else if (parts.length === 1 && /^\d{10,14}$/.test(parts[0])) {
          // 숫자만 입력 시 로젠 기본 적용
          carrierCode = 'LOGEN';
          trackingNumber = parts[0];
        }

        if (carrierCode && trackingNumber) {
          (global as any).__pendingShipping = null;
          broadcastEvent({ type: 'node_active', node: 'brain', message: '배송처리 시작: ' + trackingNumber, progress: 10, flow: ['commander->brain'] });
          await sendTelegram('⏳ 배송처리 중...');
          try {
            const token = await getSmartStoreToken();
            if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return res.sendStatus(200); }
            const readyOrders = await getDispatchReadyOrders(token, pendingShipping.dateStr, pendingShipping.dateStr);
            if (readyOrders.length === 0) {
              await sendTelegram('📭 배송 준비 중인 주문이 없습니다.');
              return res.sendStatus(200);
            }
            const dispatchItems = readyOrders.map((o: any) => ({
              productOrderId: o.productOrderId,
              deliveryCompanyCode: carrierCode,
              trackingNumber: trackingNumber,
            }));
            const result = await dispatchProductOrders(token, dispatchItems);
            broadcastEvent({ type: 'node_complete', node: 'smartstore', message: result.message, progress: 100 });
            if (result.success) {
              await sendTelegram(
                '✅ <b>배송처리 완료</b>\n' +
                '━━━━━━━━━━━━━━━\n' +
                '🚚 택배사: ' + parts[0] + '\n' +
                '📋 송장번호: <code>' + trackingNumber + '</code>\n' +
                '✅ 처리: <b>' + result.successIds.length + '건</b>\n' +
                '━━━━━━━━━━━━━━━\n' +
                '🚚 배송중 상태로 변경되었습니다.'
              );
            } else {
              await sendTelegram(
                '⚠️ <b>배송처리 부분 실패</b>\n' +
                '━━━━━━━━━━━━━━━\n' +
                '✅ 성공: ' + result.successIds.length + '건\n' +
                '❌ 실패: ' + result.failIds.length + '건\n' +
                result.message
              );
            }
          } catch (e) {
            broadcastEvent({ type: 'node_error', node: 'brain', message: '배송처리 오류: ' + String(e) });
            await sendTelegram('❌ 배송처리 오류\n' + String(e));
          }
          return res.sendStatus(200);
        } else {
          // 형식이 맞지 않으면 다시 안내
          await sendTelegram(
            '⚠️ 송장번호 형식이 맞지 않습니다.\n' +
            '형식: <code>택배사 송장번호</code>\n' +
            '예시: <code>로젠 1234567890</code>\n' +
            '예시: <code>롯데 9876543210</code>\n' +
            '또는 /cancel 입력으로 취소'
          );
          return res.sendStatus(200);
        }
      }

      // KST 날짜 헬퍼
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const todayKST = kstNow.toISOString().split('T')[0];
      const yesterdayKST = (() => { const d = new Date(kstNow); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();

      // ── /start 또는 /help ──
      if (text === '/start' || text === '/help') {
        broadcastEvent({ type: 'log', node: 'telegram', message: '텔레그램 /help 명령 수신' });
        await sendTelegram(
          '🤖 <b>자비스 (JARVIS) 전체 명령어</b>\n' +
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
          '📄 <b>문서 보기 (3채널)</b>\n' +
          '• "정산서 보여줘" → 텔레그램 파일 전송\n' +
          '• "정산서 구글시트로" → 구글 시트 링크\n' +
          '• "정산서 깃헙" → GitHub 다운로드 링크\n' +
          '• "발주서 보여줘" → 텔레그램 파일 전송\n' +
          '• "발주서 구글시트로" → 구글 시트 링크\n' +
          '• "발주서 깃헙" → GitHub 다운로드 링크\n\n' +
          '💵 <b>원가 관리</b>\n' +
          '• "원가 보여줘" → 전 상품 원가표\n' +
          '• "원가 변경 밤 8000 9000" → 원가 수정\n\n' +
          '⚙️ <b>시스템</b>\n' +
          '• /status - 서버 및 시스템 상태 확인\n' +
          '• /help - 이 도움말 보기\n\n' +
          '━━━━━━━━━━━━━━━\n' +
          '💡 자연어로 말씀하셔도 됩니다!\n' +
          '예: "현황 알려줘", "오늘 주문 몇 개야?"\n' +
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

      // ── 자연어 인식 ──
      } else if (text.length > 0) {
        const t = text.toLowerCase();

        // 전체 현황 / 리포트
        if (
          t.includes('현황') ||
          t.includes('리포트') ||
          t.includes('report') ||
          t.includes('전체') ||
          (t.includes('주문') && (t.includes('얼마') || t.includes('몇') || t.includes('알려') || t.includes('보여') || t.includes('상태') || t.includes('현재') || t.includes('어때') || t.includes('어떻')))
        ) {
          broadcastEvent({ type: 'node_active', node: 'brain', message: '자연어 현황 요청 수신', progress: 0, flow: ['telegram->brain'] });
          await sendTelegram('🔄 전체 현황을 조회하고 있습니다...');
          await runDailyOrderReport();
          broadcastEvent({ type: 'node_complete', node: 'brain', message: '주문 현황 조회 완료', progress: 100 });

        // 오늘 주문
        } else if (
          (t.includes('오늘') && t.includes('주문')) ||
          t.includes('today') ||
          (t.includes('오늘') && (t.includes('몇') || t.includes('얼마') || t.includes('들어')))
        ) {
          broadcastEvent({ type: 'node_active', node: 'smartstore', message: '자연어 오늘 주문 요청', progress: 20, flow: ['telegram->brain', 'brain->smartstore'] });
          await sendTelegram('🔄 오늘 신규 주문을 조회하고 있습니다...');
          try {
            const token = await getSmartStoreToken();
            if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
            const orders = await getNewOrderDetails(token, todayKST, todayKST);
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
          } catch (e) {
            await sendTelegram('❌ 오늘 주문 조회 실패\n' + String(e));
          }

        // 주문 목록
        } else if (
          t.includes('목록') ||
          t.includes('리스트') ||
          t.includes('list') ||
          (t.includes('주문') && (t.includes('뭐') || t.includes('뭔') || t.includes('어떤')))
        ) {
          broadcastEvent({ type: 'node_active', node: 'smartstore', message: '자연어 주문 목록 요청', progress: 20, flow: ['telegram->brain', 'brain->smartstore'] });
          await sendTelegram('🔄 처리 중인 주문을 조회하고 있습니다...');
          try {
            const token = await getSmartStoreToken();
            if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
            const orders = await getNewOrderDetails(token, yesterdayKST, todayKST);
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
          } catch (e) {
            await sendTelegram('❌ 주문 목록 조회 실패\n' + String(e));
          }

        // ── 정산서 보기 (3채널: 텔레그램/구글시트/깃헙) ──
        } else if (t.includes('정산서')) {
          const channel = t.includes('구글') || t.includes('시트') ? 'google'
            : t.includes('깃') || t.includes('git') || t.includes('github') ? 'github'
            : 'telegram';
          broadcastEvent({ type: 'node_active', node: 'brain', message: '정산서 요청 (' + channel + ')', progress: 10, flow: ['telegram->brain'] });
          await sendTelegram('🔄 정산서를 준비하고 있습니다...');
          try {
            const token = await getSmartStoreToken();
            if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
            const orders = await getNewOrderDetails(token, yesterdayKST, yesterdayKST);
            if (orders.length === 0) {
              await sendTelegram('📭 ' + yesterdayKST + ' 주문이 없어 정산서를 생성할 수 없습니다.');
            } else {
              const orderItems: OrderItem[] = orders.map((o: any) => ({
                productName: o.productName || '', productOption: o.productOption || '',
                quantity: o.quantity || 1, orderId: o.orderId || '',
                receiverName: o.receiverName || '', receiverPhone: o.receiverPhone || '',
                address: o.address || '', senderName: '셀렌', senderPhone: process.env.SENDER_PHONE || '',
              }));
              const bamItems = orderItems.filter(o => !isCornProduct(o.productOption || o.productName));
              const cornItems = orderItems.filter(o => isCornProduct(o.productOption || o.productName));

              if (channel === 'telegram') {
                // 텔레그램으로 Excel 파일 직접 전송
                if (bamItems.length > 0) {
                  const bamResult = generateSettlementXlsx(yesterdayKST, bamItems, 'bam');
                  await sendTelegramDocument(bamResult.xlsxBuffer, yesterdayKST + '_밤정산서.xlsx',
                    '🌰 ' + yesterdayKST + ' 밤 정산서 (' + bamItems.length + '건)\n💰 정산금: ' + bamResult.totalCostWithShipping.toLocaleString('ko-KR') + '원');
                }
                if (cornItems.length > 0) {
                  const cornResult = generateSettlementXlsx(yesterdayKST, cornItems, 'corn');
                  await sendTelegramDocument(cornResult.xlsxBuffer, yesterdayKST + '_옥수수정산서.xlsx',
                    '🌽 ' + yesterdayKST + ' 옥수수 정산서 (' + cornItems.length + '건)\n💰 정산금: ' + cornResult.totalCostWithShipping.toLocaleString('ko-KR') + '원');
                }
                await sendTelegram('✅ 정산서 파일 전송 완료!');
              } else if (channel === 'google') {
                // 구글 시트에 입력
                if (!isGoogleSheetsConfigured()) {
                  await sendTelegram('⚠️ 구글 시트 연동이 설정되지 않았습니다.\n환경변수 GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY를 설정해주세요.\n\n대신 텔레그램으로 파일을 보내드릴까요?', {
                    inline_keyboard: [[
                      { text: '📎 텔레그램으로 받기', callback_data: 'settlement_telegram_' + yesterdayKST },
                    ]]
                  });
                } else {
                  try {
                    if (bamItems.length > 0) {
                      const result = await writeSettlementToGoogleSheet(yesterdayKST, bamItems, 'bam');
                      await sendTelegram('🌰 <b>밤 정산서 구글 시트</b>\n📎 ' + result.url);
                    }
                    if (cornItems.length > 0) {
                      const result = await writeSettlementToGoogleSheet(yesterdayKST, cornItems, 'corn');
                      await sendTelegram('🌽 <b>옥수수 정산서 구글 시트</b>\n📎 ' + result.url);
                    }
                    await sendTelegram('✅ 구글 시트에 정산서가 생성되었습니다!');
                  } catch (e) {
                    await sendTelegram('❌ 구글 시트 생성 실패: ' + String(e) + '\n\n텔레그램 파일로 대신 보내드리겠습니다.');
                    if (bamItems.length > 0) {
                      const bamResult = generateSettlementXlsx(yesterdayKST, bamItems, 'bam');
                      await sendTelegramDocument(bamResult.xlsxBuffer, yesterdayKST + '_밤정산서.xlsx', '🌰 밤 정산서');
                    }
                    if (cornItems.length > 0) {
                      const cornResult = generateSettlementXlsx(yesterdayKST, cornItems, 'corn');
                      await sendTelegramDocument(cornResult.xlsxBuffer, yesterdayKST + '_옥수수정산서.xlsx', '🌽 옥수수 정산서');
                    }
                  }
                }
              } else if (channel === 'github') {
                // GitHub에 저장 후 링크 전달
                try {
                  const dataDir = path.join(process.cwd(), 'data', yesterdayKST);
                  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                  if (bamItems.length > 0) {
                    const bamResult = generateSettlementXlsx(yesterdayKST, bamItems, 'bam');
                    fs.writeFileSync(path.join(dataDir, yesterdayKST + '_밤정산서.xlsx'), bamResult.xlsxBuffer);
                  }
                  if (cornItems.length > 0) {
                    const cornResult = generateSettlementXlsx(yesterdayKST, cornItems, 'corn');
                    fs.writeFileSync(path.join(dataDir, yesterdayKST + '_옥수수정산서.xlsx'), cornResult.xlsxBuffer);
                  }
                  execSync('cd ' + process.cwd() + ' && git add data/ && git commit -m "docs: ' + yesterdayKST + ' 정산서 저장" && git push origin main', { stdio: 'pipe' });
                  const repoUrl = 'https://github.com/jsw72006869-prog/jarvis-booking-server/tree/main/data/' + yesterdayKST;
                  await sendTelegram('✅ <b>정산서 GitHub 저장 완료</b>\n📎 ' + repoUrl);
                } catch (e) {
                  await sendTelegram('❌ GitHub 저장 실패: ' + String(e));
                }
              }
            }
          } catch (e) {
            await sendTelegram('❌ 정산서 생성 실패\n' + String(e));
          }

        // ── 발주서 보기 (3채널) ──
        } else if (t.includes('발주서')) {
          const channel = t.includes('구글') || t.includes('시트') ? 'google'
            : t.includes('깃') || t.includes('git') || t.includes('github') ? 'github'
            : 'telegram';
          broadcastEvent({ type: 'node_active', node: 'brain', message: '발주서 요청 (' + channel + ')', progress: 10, flow: ['telegram->brain'] });
          await sendTelegram('🔄 발주서를 준비하고 있습니다...');
          try {
            const token = await getSmartStoreToken();
            if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
            const orders = await getNewOrderDetails(token, yesterdayKST, yesterdayKST);
            if (orders.length === 0) {
              await sendTelegram('📭 ' + yesterdayKST + ' 주문이 없어 발주서를 생성할 수 없습니다.');
            } else {
              const orderItems: OrderItem[] = orders.map((o: any) => ({
                productName: o.productName || '', productOption: o.productOption || '',
                quantity: o.quantity || 1, orderId: o.orderId || '',
                receiverName: o.receiverName || '', receiverPhone: o.receiverPhone || '',
                address: o.address || '', senderName: '셀렌', senderPhone: process.env.SENDER_PHONE || '',
              }));
              const bamItems = orderItems.filter(o => !isCornProduct(o.productOption || o.productName));
              const cornItems = orderItems.filter(o => isCornProduct(o.productOption || o.productName));

              if (channel === 'telegram') {
                if (bamItems.length > 0) {
                  const bamDispatch = generateBamDispatchXlsx(yesterdayKST, bamItems);
                  await sendTelegramDocument(bamDispatch, yesterdayKST + '_밤발주서(로젠).xls',
                    '🌰 ' + yesterdayKST + ' 밤 발주서 - 로젠택배 (' + bamItems.length + '건)');
                }
                if (cornItems.length > 0) {
                  const cornDispatch = generateCornDispatchXlsx(yesterdayKST, cornItems);
                  await sendTelegramDocument(cornDispatch, yesterdayKST + '_옥수수발주서(롯데).xlsx',
                    '🌽 ' + yesterdayKST + ' 옥수수 발주서 - 롯데택배 (' + cornItems.length + '건)');
                }
                await sendTelegram('✅ 발주서 파일 전송 완료!');
              } else if (channel === 'google') {
                if (!isGoogleSheetsConfigured()) {
                  await sendTelegram('⚠️ 구글 시트 연동이 설정되지 않았습니다.\n대신 텔레그램으로 파일을 보내드릴까요?', {
                    inline_keyboard: [[
                      { text: '📎 텔레그램으로 받기', callback_data: 'dispatch_telegram_' + yesterdayKST },
                    ]]
                  });
                } else {
                  try {
                    const result = await writeDispatchToGoogleSheet(yesterdayKST, bamItems, cornItems);
                    await sendTelegram('✅ <b>발주서 구글 시트</b>\n📎 ' + result.url);
                  } catch (e) {
                    await sendTelegram('❌ 구글 시트 생성 실패: ' + String(e));
                    if (bamItems.length > 0) {
                      const bamDispatch = generateBamDispatchXlsx(yesterdayKST, bamItems);
                      await sendTelegramDocument(bamDispatch, yesterdayKST + '_밤발주서(로젠).xls', '🌰 밤 발주서');
                    }
                    if (cornItems.length > 0) {
                      const cornDispatch = generateCornDispatchXlsx(yesterdayKST, cornItems);
                      await sendTelegramDocument(cornDispatch, yesterdayKST + '_옥수수발주서(롯데).xlsx', '🌽 옥수수 발주서');
                    }
                  }
                }
              } else if (channel === 'github') {
                try {
                  const dataDir = path.join(process.cwd(), 'data', yesterdayKST);
                  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                  if (bamItems.length > 0) {
                    const bamDispatch = generateBamDispatchXlsx(yesterdayKST, bamItems);
                    fs.writeFileSync(path.join(dataDir, yesterdayKST + '_밤발주서(로젠).xls'), bamDispatch);
                  }
                  if (cornItems.length > 0) {
                    const cornDispatch = generateCornDispatchXlsx(yesterdayKST, cornItems);
                    fs.writeFileSync(path.join(dataDir, yesterdayKST + '_옥수수발주서(롯데).xlsx'), cornDispatch);
                  }
                  execSync('cd ' + process.cwd() + ' && git add data/ && git commit -m "docs: ' + yesterdayKST + ' 발주서 저장" && git push origin main', { stdio: 'pipe' });
                  const repoUrl = 'https://github.com/jsw72006869-prog/jarvis-booking-server/tree/main/data/' + yesterdayKST;
                  await sendTelegram('✅ <b>발주서 GitHub 저장 완료</b>\n📎 ' + repoUrl);
                } catch (e) {
                  await sendTelegram('❌ GitHub 저장 실패: ' + String(e));
                }
              }
            }
          } catch (e) {
            await sendTelegram('❌ 발주서 생성 실패\n' + String(e));
          }

        // ── 원가 보기 ──
        } else if (t.includes('원가') && (t.includes('보여') || t.includes('알려') || t.includes('얼마') || t.includes('표'))) {
          await sendTelegram(getProductCostTable());

        // ── 원가 변경 ──
        } else if (t.includes('원가') && (t.includes('변경') || t.includes('수정') || t.includes('바꿔') || t.includes('변경해'))) {
          const isBam = t.includes('밤');
          const isCornFlag = t.includes('옥수수') || t.includes('옥광');
          if (!isBam && !isCornFlag) {
            await sendTelegram('❓ 상품을 명시해 주세요.\n예: "원가 변경 밤 8000 9000"');
          } else {
            const numbers = text.match(/\d+/g);
            if (!numbers || numbers.length < 2) {
              await sendTelegram('❓ 원가 형식이 잘못되었습니다.\n예: "원가 변경 밤 8000 9000"');
            } else {
              const oldCost = parseInt(numbers[0]);
              const newCost = parseInt(numbers[1]);
              try {
                const costFilePath = path.join(process.cwd(), 'data', 'product_cost.json');
                let costData: any = {};
                if (fs.existsSync(costFilePath)) {
                  costData = JSON.parse(fs.readFileSync(costFilePath, 'utf-8'));
                }
                const category = isBam ? '밤' : '옥수수';
                if (!costData[category]) costData[category] = [];
                let updated = false;
                for (const product of costData[category]) {
                  if (product.cost === oldCost) {
                    product.cost = newCost;
                    updated = true;
                  }
                }
                if (!updated) {
                  await sendTelegram('❌ 원가 ' + oldCost.toLocaleString('ko-KR') + '원을 찾을 수 없습니다.\n현재 원가표를 확인하려면 "원가 보여줘"라고 말씀해주세요.');
                } else {
                  costData.last_updated = new Date().toISOString();
                  costData.updated_by = 'TELEGRAM_USER';
                  const dataDir = path.join(process.cwd(), 'data');
                  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                  fs.writeFileSync(costFilePath, JSON.stringify(costData, null, 2));
                  try {
                    execSync('cd ' + process.cwd() + ' && git add data/product_cost.json && git commit -m "docs: 원가 수정 - ' + category + ' ' + oldCost + '원 -> ' + newCost + '원" && git push origin main', { stdio: 'pipe' });
                  } catch (gitErr) {
                    console.error('[Git] 원가 변경 커밋 실패:', gitErr);
                  }
                  await sendTelegram(
                    '✅ <b>' + category + ' 원가 변경 완료</b>\n' +
                    '━━━━━━━━━━━━━━━\n' +
                    '변경 전: ' + oldCost.toLocaleString('ko-KR') + '원\n' +
                    '변경 후: ' + newCost.toLocaleString('ko-KR') + '원\n' +
                    '━━━━━━━━━━━━━━━\n' +
                    '📁 GitHub에 자동 저장되었습니다.'
                  );
                }
              } catch (e) {
                await sendTelegram('❌ 원가 변경 실패\n' + String(e));
              }
            }
          }

        // ── 정산 금액 조회 (기존) ──
        } else if (t.includes('정산') || t.includes('매출') || t.includes('수익') || t.includes('얼마 벌')) {
          broadcastEvent({ type: 'node_active', node: 'smartstore', message: '자연어 정산 요청', progress: 20, flow: ['telegram->brain', 'brain->smartstore'] });
          await sendTelegram('🔄 ' + yesterdayKST + ' 정산 내역을 조회하고 있습니다...');
          try {
            const token = await getSmartStoreToken();
            if (!token) { await sendTelegram('❌ 스마트스토어 인증 실패'); return; }
            const settlement = await getDailySettlement(token, yesterdayKST);
            if (!settlement || settlement.settleAmount === 0) {
              await sendTelegram('💰 ' + yesterdayKST + ' 정산 내역이 없습니다.');
            } else {
              await sendTelegram(
                '💰 <b>' + yesterdayKST + ' 정산 내역</b>\n' +
                '━━━━━━━━━━━━━━━\n' +
                '정산 금액: <b>' + settlement.settleAmount.toLocaleString('ko-KR') + '원</b>\n' +
                '정산 건수: <b>' + settlement.settleCount + '건</b>\n' +
                '━━━━━━━━━━━━━━━'
              );
            }
          } catch (e) {
            await sendTelegram('❌ 정산 조회 실패\n' + String(e));
          }

        // 도움말
        } else if (t.includes('도움') || t.includes('help') || t.includes('기능') || t.includes('명령')) {
          await sendTelegram(
            '안녕하세요! 저는 자비스입니다 🤖\n\n' +
            '이렇게 말씀해 주세요:\n' +
            '• "현황 알려줘" → 전체 주문 현황\n' +
            '• "오늘 주문 몇 개야?" → 오늘 신규 주문\n' +
            '• "주문 목록 보여줘" → 처리 중 주문 목록\n' +
            '• "정산서 보여줘" → 텔레그램 파일 전송\n' +
            '• "정산서 구글시트로" → 구글 시트 링크\n' +
            '• "발주서 보여줘" → 텔레그램 파일 전송\n' +
            '• "원가 보여줘" → 전 상품 원가표\n' +
            '• "원가 변경 밤 8000 9000" → 원가 수정\n\n' +
            '또는 슬래시 명령어:\n' +
            '/report /today /orders /settle /dispatch /status'
          );

        // 인사
        } else if (t.includes('안녕') || t.includes('hello') || t.includes('hi') || t === 'ㅎㅇ') {
          await sendTelegram('안녕하세요! 자비스입니다 🤖\n무엇을 도와드릴까요?\n"현황 알려줘" 또는 "오늘 주문 몇 개야?" 라고 말씀해 보세요!');

        // 그 외
        } else {
          await sendTelegram(
            '죄송합니다, 잘 이해하지 못했습니다 😅\n\n' +
            '이렇게 말씀해 주세요:\n' +
            '• "현황 알려줘" / "오늘 주문 몇 개야?"\n' +
            '• "정산서 보여줘" / "발주서 보여줘"\n' +
            '• "정산서 구글시트로" / "발주서 깃헙"\n' +
            '• "원가 보여줘" / "원가 변경 밤 8000 9000"\n\n' +
            '또는 /help 를 입력해 주세요.'
          );
        }
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
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query', 'channel_post', 'inline_query'] }),
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
  // 서버 시작 시 IP 변경 감지 및 텔레그램 알림
  checkAndNotifyIPChange();
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
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query', 'channel_post', 'inline_query'] }),
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

