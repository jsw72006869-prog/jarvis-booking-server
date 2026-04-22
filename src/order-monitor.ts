// 실시간 주문 모니터 - 5분마다 스마트스토어 주문 상태 변화 감지
// 새 주문 또는 상태 변경 시 텔레그램으로 즉시 알림
// ★ Node.js 내장 fetch는 agent를 무시함 → axios 사용으로 프록시 확실 적용

import axios, { AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getSmartStoreToken, sendTelegram } from './smartstore-scheduler.js';

/**
 * 네이버 커머스 API 전용 GET (axios + 프록시)
 */
async function naverGet(url: string, headers: Record<string, string> = {}): Promise<any> {
  const proxyUrl = process.env.QUOTAGUARDSTATIC_URL;
  const config: AxiosRequestConfig = { url, method: 'GET', headers };
  if (proxyUrl) {
    const agent = new HttpsProxyAgent(proxyUrl);
    config.httpsAgent = agent;
    config.httpAgent = agent;
  }
  const res = await axios(config);
  return res.data;
}

interface OrderSnapshot {
  orderId: string;
  status: string;
  productName: string;
  quantity: number;
  buyerName: string;
  orderAmount: number;
}

// 이전 스냅샷 메모리 저장 (서버 재시작 시 초기화됨)
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

async function fetchRecentOrders(token: string): Promise<OrderSnapshot[]> {
  try {
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + kstOffset);
    const thirtyDaysAgo = new Date(kstNow);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const fromDate = thirtyDaysAgo.toISOString().split('T')[0];
    const toDate = kstNow.toISOString().split('T')[0];

    const statuses = [
      'PAYED', 'DELIVERING_HOLD', 'DELIVERING', 'DELIVERED',
      'PURCHASE_DECIDED', 'CANCEL_REQUEST', 'CANCELED',
      'EXCHANGE_REQUEST', 'RETURN_REQUEST', 'RETURNED'
    ];

    const allOrders: OrderSnapshot[] = [];

    for (const status of statuses) {
      try {
        // ★ axios + 프록시 경유
        const data = await naverGet(
          `https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?` +
          `lastChangedFrom=${fromDate}T00:00:00.000Z&lastChangedTo=${toDate}T23:59:59.000Z&` +
          `orderStatuses=${status}&page=1&pageSize=100`,
          { 'Authorization': 'Bearer ' + token }
        );
        const orders = data.data?.lastChangeStatuses || [];
        for (const o of orders) {
          allOrders.push({
            orderId: o.orderId || o.productOrderId || String(Math.random()),
            status,
            productName: o.productName || o.productOption || '상품명 없음',
            quantity: o.quantity || 1,
            buyerName: o.buyerName || o.receiverName || '구매자',
            orderAmount: o.totalPaymentAmount || o.productOrderAmount || 0,
          });
        }
      } catch (e) {
        // 개별 상태 조회 실패는 무시
      }
    }

    return allOrders;
  } catch (e) {
    console.error('[주문모니터] 주문 조회 오류:', e);
    return [];
  }
}

async function checkOrderChanges() {
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      console.log('[주문모니터] 토큰 발급 실패 - 다음 주기에 재시도');
      return;
    }

    const currentOrders = await fetchRecentOrders(token);
    const currentSnapshot = new Map<string, OrderSnapshot>();
    for (const order of currentOrders) {
      currentSnapshot.set(order.orderId, order);
    }

    if (isFirstRun) {
      previousSnapshot = currentSnapshot;
      isFirstRun = false;
      console.log(`[주문모니터] 초기화 완료 - 현재 주문 ${currentSnapshot.size}건 추적 시작`);
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
