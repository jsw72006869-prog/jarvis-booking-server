// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)
// ★ 핵심: Node.js 내장 fetch는 agent를 무시함 → axios 사용으로 프록시 확실 적용
// ★ 2026-04-22 수정: 조건형 API + 순차 처리 + 재시도 로직으로 rate limit 대응

import axios, { AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getCachedToken, setCachedToken, handleTokenFailure } from './ip-manager';

/**
 * Quotaguard Static 프록시 에이전트 생성
 */
function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = process.env.QUOTAGUARDSTATIC_URL;
  if (proxyUrl) {
    return new HttpsProxyAgent(proxyUrl);
  }
  return undefined;
}

/**
 * 네이버 커머스 API 전용 GET (axios + 프록시 + 재시도)
 * rate limit 에러 시 지수 백오프로 재시도
 */
async function naverGet(url: string, headers: Record<string, string> = {}, maxRetries = 3): Promise<any> {
  const agent = getProxyAgent();
  const config: AxiosRequestConfig = { url, method: 'GET', headers };
  if (agent) {
    config.httpsAgent = agent;
    config.httpAgent = agent;
    console.log('[프록시] Quotaguard GET →', url.substring(0, 100));
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios(config);
      return res.data;
    } catch (e: any) {
      const status = e.response?.status;
      const errMsg = e.response?.data?.message || e.message || '';

      // rate limit (429) 또는 서비스 일시 불가 (503) → 재시도
      if ((status === 429 || status === 503 || errMsg.includes('요청이 많아') || errMsg.includes('일시적으로')) && attempt < maxRetries) {
        const waitSec = attempt * 3; // 3초, 6초, 9초...
        console.warn(`[API] Rate limit 감지 (시도 ${attempt}/${maxRetries}), ${waitSec}초 대기 후 재시도...`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw e;
    }
  }
}

/**
 * 네이버 커머스 API 전용 POST (axios + 프록시)
 */
async function naverPost(url: string, data?: any, headers: Record<string, string> = {}): Promise<any> {
  const agent = getProxyAgent();
  const config: AxiosRequestConfig = { url, method: 'POST', headers, data };
  if (agent) {
    config.httpsAgent = agent;
    config.httpAgent = agent;
    console.log('[프록시] Quotaguard POST →', url.substring(0, 100));
  }
  const res = await axios(config);
  return res.data;
}

export async function sendTelegram(message: string, replyMarkup?: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!botToken || !chatId) return null;
  try {
    const body: any = { chat_id: chatId, text: message, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await axios.post('https://api.telegram.org/bot' + botToken + '/sendMessage', body);
    const data = res.data;
    if (!data.ok) { console.error('[텔레그램] 발송 실패:', data.description); return null; }
    console.log('[텔레그램] 발송 성공 to chat_id:', chatId, 'message_id:', data.result?.message_id);
    return data.result?.message_id || null;
  } catch (e) { console.error('[텔레그램] 발송 오류:', e); return null; }
}

export async function answerCallbackQuery(callbackQueryId: string, text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!botToken) return;
  try {
    await axios.post('https://api.telegram.org/bot' + botToken + '/answerCallbackQuery', {
      callback_query_id: callbackQueryId, text, show_alert: false,
    });
  } catch (e) { console.error('[텔레그램] Callback 응답 오류:', e); }
}

export async function getSmartStoreToken(): Promise<string | null> {
  const cached = getCachedToken();
  if (cached) return cached;

  const clientId = process.env.SMARTSTORE_CLIENT_ID || '';
  const clientSecret = process.env.SMARTSTORE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    console.error('[스마트스토어] 환경변수 없음 - SMARTSTORE_CLIENT_ID/SECRET 확인 필요');
    await handleTokenFailure('EnvMissing', '환경변수(SMARTSTORE_CLIENT_ID/SECRET)가 설정되지 않았습니다.');
    return null;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const bcrypt = await import('bcryptjs');
      const timestamp = String(Date.now());
      const password = clientId + '_' + timestamp;
      const hashed = bcrypt.hashSync(password, clientSecret);
      const clientSecretSign = Buffer.from(hashed).toString('base64');

      console.log(`[토큰발급] 시도 ${attempt}/2 - Quotaguard 프록시 경유`);

      const params = new URLSearchParams({
        client_id: clientId,
        timestamp,
        client_secret_sign: clientSecretSign,
        grant_type: 'client_credentials',
        type: 'SELF',
      });

      const data = await naverPost(
        'https://api.commerce.naver.com/external/v1/oauth2/token?' + params.toString(),
        undefined,
        { 'Content-Type': 'application/x-www-form-urlencoded' }
      );

      if (data.error || data.code) {
        const errCode = data.error || data.code || '';
        const errMsg = data.error_description || data.message || '';
        console.error(`[토큰발급] 실패 (시도 ${attempt}):`, errCode, '-', errMsg);
        if (attempt === 2) await handleTokenFailure(errCode, errMsg);
        continue;
      }

      const token = data.access_token || null;
      if (token) {
        setCachedToken(token);
        console.log('[토큰발급] 성공 ✅');
        return token;
      }
    } catch (e: any) {
      const errData = e.response?.data;
      const errCode = errData?.error || errData?.code || '';
      const errMsg = errData?.error_description || errData?.message || String(e);
      console.error(`[토큰발급] 오류 (시도 ${attempt}):`, errCode, errMsg);
      if (attempt === 2) await handleTokenFailure(errCode, errMsg);
    }

    if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
  }

  return null;
}

function toKSTDateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * 조건형 API로 특정 날짜(1일)의 주문을 조회합니다.
 * ★ 순차 처리 + 재시도 로직으로 rate limit 대응
 */
async function getOrdersForDateWithStatus(
  token: string,
  dateStr: string,
  statusFilter?: string
): Promise<any[]> {
  const orders: any[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    try {
      const fromDT = dateStr + 'T00:00:00.000%2B09:00';
      const toDT = dateStr + 'T23:59:59.000%2B09:00';
      let url =
        'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?' +
        'from=' + fromDT + '&' +
        'to=' + toDT + '&' +
        'rangeType=PAYED_DATETIME&' +
        'pageSize=300&' +
        'page=' + page;

      if (statusFilter) {
        url += '&productOrderStatuses=' + statusFilter;
      }

      const data = await naverGet(url, { 'Authorization': 'Bearer ' + token });

      const contents = data?.data?.contents || [];
      const pagination = data?.data?.pagination;

      for (const order of contents) {
        const po = order.productOrder || order;
        orders.push({
          productOrderId: order.productOrderId || po.productOrderId,
          orderId: order.orderId || po.orderId,
          productOrderStatus: order.productOrderStatus || po.productOrderStatus || 'UNKNOWN',
          productName: po.productName || order.productName || '',
          productOption: po.productOption || order.productOption || '',
          quantity: po.quantity || order.quantity || 1,
          totalPaymentAmount: po.totalPaymentAmount || order.totalPaymentAmount || 0,
          buyerName: po.buyerName || order.buyerName || '',
          receiverName: po.receiverName || order.receiverName || '',
          paymentDate: po.paymentDate || order.paymentDate || '',
        });
      }

      hasNext = pagination?.hasNext === true;
      page++;
      if (page > 10) break;
    } catch (e: any) {
      const errMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[주문조회] ${dateStr} page=${page} 오류:`, errMsg);
      hasNext = false;
    }
  }

  return orders;
}

/**
 * ★ 핵심 함수: 상태별 주문 건수를 효율적으로 조회합니다.
 * 
 * 전략: 각 상태별로 적절한 기간만 순차 조회
 * - PAYED (신규주문): 최근 30일 (결제 후 30일 이상 미처리는 드묾)
 * - DELIVERING_HOLD (배송준비): 최근 14일
 * - DELIVERING (배송중): 최근 14일
 * - DELIVERED (배송완료): 최근 14일
 * - PURCHASE_DECIDED (구매확정): 최근 7일
 * 
 * 순차 처리 + 요청 간 1.5초 딜레이로 rate limit 방지
 */
async function getStatusCounts(token: string): Promise<Record<string, number>> {
  const statusCounts: Record<string, number> = {};
  const kstOffset = 9 * 60 * 60 * 1000;
  const kstNow = new Date(Date.now() + kstOffset);

  // 상태별 조회 기간 설정 (일수)
  const statusConfig: Array<{ status: string; days: number }> = [
    { status: 'PAYED', days: 30 },
    { status: 'DELIVERING_HOLD', days: 14 },
    { status: 'DELIVERING', days: 14 },
    { status: 'DELIVERED', days: 14 },
    { status: 'PURCHASE_DECIDED', days: 7 },
  ];

  for (const { status, days } of statusConfig) {
    let count = 0;
    const startDate = new Date(kstNow);
    startDate.setDate(startDate.getDate() - days);

    // 날짜 목록 생성
    const dates: string[] = [];
    const current = new Date(startDate);
    while (current <= kstNow) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    console.log(`[주문조회] ${status} 상태 조회 시작 (${dates.length}일, ${dates[0]} ~ ${dates[dates.length - 1]})`);

    // ★ 순차 처리 - 한 번에 하나씩만 요청
    for (const dateStr of dates) {
      try {
        const orders = await getOrdersForDateWithStatus(token, dateStr, status);
        count += orders.length;

        // ★ 요청 간 1.5초 딜레이 (rate limit 방지)
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.error(`[주문조회] ${status} ${dateStr} 실패:`, e);
        // 실패해도 계속 진행
      }
    }

    statusCounts[status] = count;
    console.log(`[주문조회] ${status}: ${count}건`);
  }

  return statusCounts;
}

/**
 * 신규 주문(PAYED 상태)의 상세 정보를 조회합니다.
 * ★ 순차 처리 + 딜레이로 rate limit 방지
 */
export async function getNewOrderDetails(token: string, fromDate: string, toDate: string) {
  const allOrders: any[] = [];

  // 날짜 목록 생성
  const dates: string[] = [];
  const current = new Date(fromDate + 'T00:00:00.000Z');
  const end = new Date(toDate + 'T00:00:00.000Z');

  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  console.log(`[신규주문] ${dates.length}일 순차 조회 시작 (${fromDate} ~ ${toDate})`);

  // ★ 순차 처리 - 한 번에 하나씩만 요청
  for (const dateStr of dates) {
    try {
      const orders = await getOrdersForDateWithStatus(token, dateStr, 'PAYED');
      allOrders.push(...orders);

      // 요청 간 1.5초 딜레이
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[신규주문] ${dateStr} 실패:`, e);
    }
  }

  return allOrders;
}

export async function getDailySettlement(token: string, settleDate: string) {
  try {
    const data = await naverGet(
      'https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?' +
      'settleStartDate=' + settleDate + '&settleEndDate=' + settleDate,
      { 'Authorization': 'Bearer ' + token });
    console.log('[정산조회] 응답:', JSON.stringify(data).substring(0, 300));
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      let totalAmount = 0, totalCount = 0;
      for (const item of data.data) {
        totalAmount += item.settleAmount || item.totalSettleAmount || item.settleAmountTotal || 0;
        totalCount += item.settleCount || item.totalCount || 0;
      }
      return { settleAmount: totalAmount, settleCount: totalCount };
    }
    if (data.settleAmount !== undefined) return { settleAmount: data.settleAmount || 0, settleCount: data.settleCount || 0 };
    return { settleAmount: 0, settleCount: 0 };
  } catch (e) { console.error('[정산조회] 오류:', e); return null; }
}

export async function runDailyOrderReport() {
  console.log('[스케줄러] 자동 주문 보고 시작...');
  console.log('[스케줄러] 프록시:', process.env.QUOTAGUARDSTATIC_URL ? '✅ Quotaguard 활성' : '⚠️ 프록시 미설정');
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      console.error('[스케줄러] 토큰 발급 실패 - 보고 중단');
      return;
    }

    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + kstOffset);
    const todayKST = toKSTDateStr(kstNow);
    const yesterday = new Date(kstNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKST = toKSTDateStr(yesterday);

    // ★ 정산은 먼저 조회 (빠름)
    const settlement = await getDailySettlement(token, yesterdayKST);

    // ★ 핵심: 상태별 순차 조회 (rate limit 방지)
    console.log(`[스케줄러] 상태별 주문 건수 조회 시작...`);
    const statusCounts = await getStatusCounts(token);

    const newOrderCount = statusCounts['PAYED'] || 0;
    const dispatchCount = statusCounts['DELIVERING_HOLD'] || 0;
    const deliveringCount = statusCounts['DELIVERING'] || 0;
    const deliveredCount = statusCounts['DELIVERED'] || 0;
    const confirmedCount = statusCounts['PURCHASE_DECIDED'] || 0;

    console.log(`[스케줄러] 상태별 건수 - 신규:${newOrderCount} 배송준비:${dispatchCount} 배송중:${deliveringCount} 배송완료:${deliveredCount} 구매확정:${confirmedCount}`);

    // 신규 주문 상세 조회 (최근 7일만 - 효율성)
    let newOrders: any[] = [];
    if (newOrderCount > 0) {
      const sevenDaysAgo = new Date(kstNow);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const sevenDaysAgoKST = toKSTDateStr(sevenDaysAgo);
      newOrders = await getNewOrderDetails(token, sevenDaysAgoKST, todayKST);
    }

    let message = '📊 <b>[자동 보고] ' + todayKST + ' 현황</b>\n';
    message += '━━━━━━━━━━━━━━━\n';
    message += '🆕 신규 주문: <b>' + newOrderCount + '건</b>\n';
    message += '📦 배송 준비: <b>' + dispatchCount + '건</b>\n';
    message += '🚚 배송 중: <b>' + deliveringCount + '건</b>\n';
    message += '📬 배송 완료: <b>' + deliveredCount + '건</b>\n';
    message += '✅ 구매 확정: <b>' + confirmedCount + '건</b>\n';
    message += '━━━━━━━━━━━━━━━\n';

    if (settlement !== null) {
      if (settlement.settleAmount > 0) {
        const formattedAmount = settlement.settleAmount.toLocaleString('ko-KR');
        message += '💰 정산 입금: <b>' + formattedAmount + '원</b>';
        if (settlement.settleCount > 0) message += ' (' + settlement.settleCount + '건)';
        message += '\n';
      } else { message += '💰 정산 입금: <b>0원</b>\n'; }
      message += '━━━━━━━━━━━━━━━\n';
    }

    if (newOrders.length > 0) {
      const bamOrders: Record<string, number> = {};
      const cornOrders: Record<string, number> = {};
      for (const order of newOrders) {
        const optionName = order.productOption || order.productName || '';
        const isCorn = optionName.includes('옥수수') || optionName.includes('옥광') || optionName.includes('3X') || optionName.includes('찰옥');
        if (isCorn) cornOrders[optionName] = (cornOrders[optionName] || 0) + (order.quantity || 1);
        else bamOrders[optionName] = (bamOrders[optionName] || 0) + (order.quantity || 1);
      }
      if (Object.keys(bamOrders).length > 0) {
        message += '\n🌰 <b>밤 주문 상세</b>\n';
        for (const [name, qty] of Object.entries(bamOrders)) message += '  • ' + name + ': ' + qty + '개\n';
      }
      if (Object.keys(cornOrders).length > 0) {
        message += '\n🌽 <b>옥수수 주문 상세</b>\n';
        for (const [name, qty] of Object.entries(cornOrders)) message += '  • ' + name + ': ' + qty + '개\n';
      }
    } else if (newOrderCount === 0 && dispatchCount === 0 && deliveringCount === 0 && deliveredCount === 0 && confirmedCount === 0) {
      message += '\n처리할 주문이 없습니다.';
    }

    const buttons: any[] = [];
    if (newOrderCount > 0) {
      buttons.push([
        { text: '📋 발주서 발송하기', callback_data: 'confirm_dispatch_' + todayKST },
        { text: '⏭ 나중에', callback_data: 'skip_dispatch' },
      ]);
    }
    if (settlement && settlement.settleAmount > 0) {
      buttons.push([
        { text: '✅ 정산 확인 완료', callback_data: 'confirm_settle_' + yesterdayKST + '_' + settlement.settleAmount },
        { text: '❓ 정산 재확인', callback_data: 'recheck_settle_' + yesterdayKST },
      ]);
    }
    const replyMarkup = buttons.length > 0 ? { inline_keyboard: buttons } : undefined;
    await sendTelegram(message, replyMarkup);
    console.log('[스케줄러] 보고 완료 ✅');
  } catch (error) {
    console.error('[스케줄러] 오류:', error);
    await sendTelegram('❌ [자동 보고] 오류 발생\n' + String(error));
  }
}
