// 실시간 주문 모니터 - 5분마다 스마트스토어 주문 상태 변화 감지
// 새 주문 또는 상태 변경 시 텔레그램으로 즉시 알림
// ★ 2026-04-22 최종 수정: 오늘 하루만 조회 → API 1번 호출

import axios, { AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getSmartStoreToken, sendTelegram } from './smartstore-scheduler.js';

/**
 * 네이버 커머스 API 전용 GET (axios + 프록시 + 재시도)
 */
async function naverGet(url: string, headers: Record<string, string> = {}, maxRetries = 3): Promise<any> {
  const proxyUrl = process.env.QUOTAGUARDSTATIC_URL;
  const config: AxiosRequestConfig = { url, method: 'GET', headers };
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    config.httpsAgent = agent;
    config.httpAgent = agent;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios(config);
      return res.data;
    } catch (e: any) {
      const status = e.response?.status;
      const errMsg = e.response?.data?.message || e.message || '';
      if ((status === 429 || status === 503 || errMsg.includes('요청이 많아') || errMsg.includes('일시적으로')) && attempt < maxRetries) {
        const waitSec = attempt * 3;
        console.warn(`[주문모니터 API] Rate limit (시도 ${attempt}/${maxRetries}), ${waitSec}초 대기...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw e;
    }
  }
}

interface OrderSnapshot {
  orderId: string;
  status: string;
  productName: string;
  quantity: number;
  buyerName: string;
  orderAmount: number;
}

// 이전 스냅샷 메모리 저장
let previousSnapshot: Map<string, OrderSnapshot> = new Map();
let isFirstRun = true;
let monitorInterval: NodeJS.Timeout | null = null;

const STATUS_LABEL: Record<string, string> = {
  PAYMENT_WAITING: '💳 결제 대기',
  PAYED: '🆕 신규 주문',
  DELIVERING_HOLD: '📦 배송 준비',
  DELIVERING: '🚚 배송 중',
  DELIVERED: '📬 배송 완료',
  PURCHASE_DECIDED: '✅ 구매 확정',
  EXCHANGE_REQUEST: '🔄 교환 요청',
  CANCEL_REQUEST: '❌ 취소 요청',
  CANCELED: '🚫 취소 완료',
  RETURN_REQUEST: '↩️ 반품 요청',
  RETURNED: '↩️ 반품 완료',
};

/**
 * ★ 오늘 하루 주문만 조회 - API 1번 호출
 */
async function fetchTodayOrders(token: string): Promise<OrderSnapshot[]> {
  const orders: OrderSnapshot[] = [];

  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(Date.now() + kstOffset);
  const todayStr = kstNow.toISOString().split('T')[0];

  let page = 1;
  let hasNext = true;

  while (hasNext) {
    try {
      const fromDT = todayStr + 'T00:00:00.000%2B09:00';
      const toDT = todayStr + 'T23:59:59.000%2B09:00';
      const url =
        'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?' +
        'from=' + fromDT + '&' +
        'to=' + toDT + '&' +
        'rangeType=PAYED_DATETIME&' +
        'pageSize=300&' +
        'page=' + page;

      const data = await naverGet(url, { 'Authorization': 'Bearer ' + token });
      const contents = data?.data?.contents || [];

      for (const o of contents) {
        const po = o.productOrder || o;
        orders.push({
          orderId: o.productOrderId || po.productOrderId || String(Math.random()),
          status: o.productOrderStatus || po.productOrderStatus || 'UNKNOWN',
          productName: po.productName || o.productName || '상품명 없음',
          quantity: po.quantity || o.quantity || 1,
          buyerName: po.buyerName || o.buyerName || po.receiverName || o.receiverName || '구매자',
          orderAmount: po.totalPaymentAmount || o.totalPaymentAmount || 0,
        });
      }

      hasNext = data?.data?.pagination?.hasNext === true;
      page++;
      if (page > 10) break;
    } catch (e) {
      console.error(`[주문모니터] 오늘 주문 조회 오류:`, e);
      hasNext = false;
    }
  }

  return orders;
}

async function checkOrderChanges() {
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      console.log('[주문모니터] 토큰 발급 실패 - 다음 주기에 재시도');
      return;
    }

    const currentOrders = await fetchTodayOrders(token);
    const currentSnapshot = new Map<string, OrderSnapshot>();
    for (const order of currentOrders) {
      currentSnapshot.set(order.orderId, order);
    }

    if (isFirstRun) {
      previousSnapshot = currentSnapshot;
      isFirstRun = false;
      console.log(`[주문모니터] 초기화 완료 - 오늘 주문 ${currentSnapshot.size}건 추적 시작`);
      return;
    }

    const newOrders: OrderSnapshot[] = [];
    const statusChanges: Array<{ order: OrderSnapshot; prevStatus: string }> = [];

    for (const [orderId, current] of currentSnapshot) {
      const prev = previousSnapshot.get(orderId);
      if (!prev) {
        if (current.status === 'PAYED') {
          newOrders.push(current);
        }
      } else if (prev.status !== current.status) {
        statusChanges.push({ order: current, prevStatus: prev.status });
      }
    }

    if (newOrders.length > 0) {
      let msg = `🔔 <b>새 주문 ${newOrders.length}건 접수!</b>\n`;
      msg += '━━━━━━━━━━━━━━━\n';
      for (const o of newOrders) {
        msg += `🆕 ${o.productName}\n`;
        msg += `   수량: ${o.quantity}개 | 구매자: ${o.buyerName}\n`;
        if (o.orderAmount > 0) {
          msg += `   금액: ${o.orderAmount.toLocaleString('ko-KR')}원\n`;
        }
        msg += '\n';
      }
      msg += '📋 발주서 준비가 필요합니다.';
      await sendTelegram(msg, {
        inline_keyboard: [[
          { text: '📋 발주서 바로 발송', callback_data: 'confirm_dispatch_today' },
          { text: '⏭ 나중에', callback_data: 'skip_dispatch' },
        ]]
      });
      console.log(`[주문모니터] 새 주문 알림 발송 - ${newOrders.length}건`);
    }

    const importantChanges = statusChanges.filter(({ order }) =>
      ['DELIVERED', 'PURCHASE_DECIDED', 'CANCEL_REQUEST', 'RETURN_REQUEST', 'EXCHANGE_REQUEST'].includes(order.status)
    );

    if (importantChanges.length > 0) {
      const grouped: Record<string, typeof importantChanges> = {};
      for (const change of importantChanges) {
        if (!grouped[change.order.status]) grouped[change.order.status] = [];
        grouped[change.order.status].push(change);
      }

      let msg = `📡 <b>주문 상태 변경 감지</b>\n`;
      msg += '━━━━━━━━━━━━━━━\n';

      for (const [status, changes] of Object.entries(grouped)) {
        const label = STATUS_LABEL[status] || status;
        msg += `\n${label} (${changes.length}건)\n`;
        for (const { order } of changes.slice(0, 5)) {
          msg += `  • ${order.productName} (${order.buyerName})\n`;
        }
        if (changes.length > 5) msg += `  ...외 ${changes.length - 5}건\n`;
      }

      await sendTelegram(msg);
      console.log(`[주문모니터] 상태 변경 알림 발송 - ${importantChanges.length}건`);
    }

    previousSnapshot = currentSnapshot;

  } catch (e) {
    console.error('[주문모니터] 오류:', e);
  }
}

export function startOrderMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
  }
  console.log('[주문모니터] 실시간 모니터링 시작 (5분 간격) - 프록시:', process.env.QUOTAGUARDSTATIC_URL ? '✅ 활성' : '⚠️ 미설정');
  checkOrderChanges();
  monitorInterval = setInterval(checkOrderChanges, 5 * 60 * 1000);
}

export function stopOrderMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[주문모니터] 모니터링 중지');
  }
}
