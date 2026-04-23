// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)
// ★ 핵심: Node.js 내장 fetch는 agent를 무시함 → axios 사용으로 프록시 확실 적용
// ★ 2026-04-22 최종 수정: 최근 14일 순차 조회 → 판매자센터와 동일한 현황
//   - API 호출: 14번 (각 2초 간격, 초당 2회 제한 준수)
//   - productOrderStatuses 미지정 → 모든 상태 조회 → 현재 상태로 분류
//   - 중복 제거 (productOrderId 기준)

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
 */
async function naverGet(url: string, headers: Record<string, string> = {}, maxRetries = 3): Promise<any> {
  const agent = getProxyAgent();
  const config: AxiosRequestConfig = { url, method: 'GET', headers };
  if (agent) {
    config.httpsAgent = agent;
    config.httpAgent = agent;
    console.log('[프록시] Quotaguard GET →', url.substring(0, 120));
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
        console.warn(`[API] Rate limit (시도 ${attempt}/${maxRetries}), ${waitSec}초 대기 후 재시도...`);
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
    console.log('[프록시] Quotaguard POST →', url.substring(0, 120));
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

/**
 * KST 날짜 문자열 생성 (YYYY-MM-DD)
 * ★ 안전한 방식: Intl.DateTimeFormat 사용
 */
function getKSTDateStr(date?: Date): string {
  const d = date || new Date();
  const kst = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(d);
  return kst; // 'YYYY-MM-DD' 형식
}

/**
 * N일 전 날짜의 KST 문자열 배열 생성
 * 예: getKSTDateRange(14) → ['2026-04-22', '2026-04-21', ..., '2026-04-09']
 */
function getKSTDateRange(days: number): string[] {
  const dates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(getKSTDateStr(d));
  }
  return dates;
}

/**
 * ★ 핵심: 조건형 API로 "하루" 주문을 조회합니다.
 * from/to가 24시간 이내이므로 API 1번 호출로 끝남.
 * productOrderStatuses를 지정하지 않으면 모든 상태의 주문이 조회됨.
 * 조회된 주문의 productOrderStatus는 "현재 상태"를 반영함.
 */
async function getOrdersForOneDay(
  token: string,
  dateStr: string,
  statusFilter?: string
): Promise<any[]> {
  const orders: any[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    try {
      const fromDT = encodeURIComponent(dateStr + 'T00:00:00.000+09:00');
      const toDT = encodeURIComponent(dateStr + 'T23:59:59.000+09:00');
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

      // 응답 구조 탐색
      let contents: any[] = [];
      let pagination: any = null;

      if (data?.data?.contents) {
        contents = data.data.contents;
        pagination = data.data.pagination;
      } else if (data?.contents) {
        contents = data.contents;
        pagination = data.pagination;
      } else if (Array.isArray(data?.data)) {
        contents = data.data;
      }

      // ★ 첫 번째 아이템 구조 로그 (디버깅용)
      if (page === 1 && contents.length > 0) {
        const sample = contents[0];
        console.log(`[주문조회] ${dateStr} 응답 샘플 키:`, Object.keys(sample).join(', '));
        if (sample.content) console.log(`[주문조회] content 키:`, Object.keys(sample.content).join(', '));
        if (sample.content?.productOrder) console.log(`[주문조회] content.productOrder.status:`, sample.content.productOrder.productOrderStatus);
        if (sample.productOrder) console.log(`[주문조회] productOrder.status:`, sample.productOrder.productOrderStatus);
        if (sample.productOrderStatus) console.log(`[주문조회] item.productOrderStatus:`, sample.productOrderStatus);
      }

      for (const item of contents) {
        // ★ 네이버 커머스 API 응답 구조 - 여러 경로 모두 시도:
        // 경로1: item.content.productOrder.productOrderStatus (신규 API)
        // 경로2: item.productOrder.productOrderStatus (구형 API)
        // 경로3: item.productOrderStatus (단순 구조)
        const contentPO = item.content?.productOrder || {};
        const contentOrder = item.content?.order || {};
        const po = item.productOrder || {};
        
        // 모든 경로에서 상태값 추출 (비어있지 않은 첫 번째 값 사용)
        const status = (contentPO.productOrderStatus && contentPO.productOrderStatus !== '')
          ? contentPO.productOrderStatus
          : (po.productOrderStatus && po.productOrderStatus !== '')
          ? po.productOrderStatus
          : (item.productOrderStatus && item.productOrderStatus !== '')
          ? item.productOrderStatus
          : 'UNKNOWN';

        const productOrderId = item.productOrderId 
          || contentPO.productOrderId 
          || po.productOrderId 
          || '';

        orders.push({
          productOrderId,
          orderId: contentOrder.orderId || item.orderId || po.orderId || '',
          productOrderStatus: status,
          productName: contentPO.productName || po.productName || item.productName || '',
          productOption: contentPO.productOption || po.productOption || item.productOption || '',
          quantity: contentPO.quantity || po.quantity || item.quantity || 1,
          totalPaymentAmount: contentPO.totalPaymentAmount || po.totalPaymentAmount || item.totalPaymentAmount || 0,
          buyerName: contentOrder.buyerName || po.buyerName || item.buyerName || '',
          receiverName: contentPO.shippingAddress?.name || po.receiverName || item.receiverName || '',
          paymentDate: contentPO.paymentDate || contentOrder.orderDate || po.paymentDate || item.paymentDate || '',
        });
      }

      hasNext = pagination?.hasNext === true;
      page++;
      if (page > 10) break;
    } catch (e: any) {
      const errStatus = e.response?.status || '';
      const errMsg = e.response?.data?.message || e.message || '';
      console.error(`[주문조회] ${dateStr} 오류: status=${errStatus} msg=${errMsg}`);
      hasNext = false;
    }
  }

  return orders;
}

/**
 * ★ 최근 N일간의 전체 주문을 순차 조회하여 현재 상태별로 분류
 * - 각 호출 간 2초 간격 (초당 2회 제한 준수)
 * - 중복 제거 (productOrderId 기준)
 * - 취소/반품 상태는 활성 주문에서 제외
 */
async function getAllActiveOrders(token: string, days: number): Promise<any[]> {
  const dates = getKSTDateRange(days);
  const orderMap = new Map<string, any>(); // productOrderId → order (중복 제거)
  let successCount = 0;
  let errorCount = 0;

  console.log(`[전체조회] 최근 ${days}일 순차 조회 시작 (${dates[dates.length - 1]} ~ ${dates[0]})`);

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i];
    try {
      const orders = await getOrdersForOneDay(token, dateStr);
      for (const order of orders) {
        if (order.productOrderId) {
          orderMap.set(order.productOrderId, order);
        }
      }
      successCount++;
      console.log(`[전체조회] ${i + 1}/${dates.length} ${dateStr}: ${orders.length}건 (누적 ${orderMap.size}건)`);
    } catch (e: any) {
      errorCount++;
      console.error(`[전체조회] ${dateStr} 실패: ${e.message || ''}`);
    }

    // ★ 2초 대기 (초당 2회 제한 준수) - 마지막 날짜는 대기 불필요
    if (i < dates.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`[전체조회] 완료: 성공 ${successCount}일, 실패 ${errorCount}일, 총 주문 ${orderMap.size}건`);
  return Array.from(orderMap.values());
}

/**
 * 오늘/어제의 신규 주문(PAYED) 상세 정보를 조회합니다.
 */
export async function getNewOrderDetails(token: string, fromDate: string, toDate: string) {
  const allOrders: any[] = [];
  const dates: string[] = [fromDate];
  if (toDate !== fromDate) dates.push(toDate);

  for (const dateStr of dates) {
    const orders = await getOrdersForOneDay(token, dateStr, 'PAYED');
    allOrders.push(...orders);
    if (dates.length > 1) await new Promise(r => setTimeout(r, 2000));
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
  } catch (e: any) {
    const errStatus = e.response?.status || '';
    const errMsg = e.response?.data?.message || e.message || '';
    console.error(`[정산조회] 오류: status=${errStatus} msg=${errMsg}`);
    return null;
  }
}

/**
 * ★ /report 보고서: 판매자센터와 동일한 현재 상태별 주문 현황
 * 
 * 방식: 최근 14일 순차 조회 → 현재 상태별 분류 → 중복 제거
 * API 호출: 14번 (각 2초 간격) + 정산 1번 = 약 30초 소요
 * 
 * 활성 주문 상태:
 * - PAYED: 신규 주문 (결제 완료, 발주확인 전)
 * - OK: 배송 준비 (발주확인 완료) ← 판매자센터 '배송준비' 상태
 * - DELIVERING: 배송 중
 * - DELIVERED: 배송 완료
 * - PURCHASE_DECIDED: 구매 확정
 * 
 * 제외 상태 (취소/반품):
 * - CANCELED, CANCEL_REQUESTED, RETURNED, RETURN_REQUESTED, EXCHANGED 등
 */
export async function runDailyOrderReport() {
  console.log('[스케줄러] 자동 주문 보고 시작...');
  console.log('[스케줄러] 프록시:', process.env.QUOTAGUARDSTATIC_URL ? '✅ Quotaguard 활성' : '⚠️ 프록시 미설정');
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      console.error('[스케줄러] 토큰 발급 실패 - 보고 중단');
      return;
    }

    const todayKST = getKSTDateStr();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayKST = getKSTDateStr(yesterdayDate);

    console.log(`[스케줄러] 오늘(KST): ${todayKST}`);

    // ★ 최근 14일 전체 주문 조회 (순차, 2초 간격)
    const allOrders = await getAllActiveOrders(token, 14);

    // 2초 대기 후 정산 조회
    await new Promise(r => setTimeout(r, 2000));
    console.log('[스케줄러] 정산 조회...');
    const settlement = await getDailySettlement(token, yesterdayKST);

    // ★ 활성 주문만 필터링 (취소/반품 제외)
    // ★ 취소/반품 상태만 제외 (활성 주문 상태는 모두 포함)
    // PAYED=신규, OK=배송준비, DISPATCHED/DELIVERING=배송중, DELIVERED=배송완료, PURCHASE_DECIDED=구매확정
    const excludeStatuses = new Set([
      'CANCELED', 'CANCEL_REQUESTED', 'CANCEL_DONE',
      'RETURNED', 'RETURN_REQUESTED', 'RETURN_DONE',
      'EXCHANGED', 'EXCHANGE_REQUESTED',
      'COLLECT_DONE',
    ]);

    const activeOrders = allOrders.filter(o => !excludeStatuses.has(o.productOrderStatus));

    // 상태별 카운트
    const statusCounts: Record<string, number> = {};
    for (const order of activeOrders) {
      const status = order.productOrderStatus || 'UNKNOWN';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }

    const newOrderCount = statusCounts['PAYED'] || 0;
    // OK = 배송준비, DISPATCHED = 배송중 (스마트스토어 판매자센터와 동일한 분류)
    const dispatchCount = (statusCounts['OK'] || 0) + (statusCounts['DELIVERING_HOLD'] || 0);
    const deliveringCount = (statusCounts['DELIVERING'] || 0) + (statusCounts['DISPATCHED'] || 0);
    const deliveredCount = statusCounts['DELIVERED'] || 0;
    const confirmedCount = statusCounts['PURCHASE_DECIDED'] || 0;

    console.log(`[스케줄러] 전체 조회 결과: ${allOrders.length}건 (활성: ${activeOrders.length}건)`);
    console.log(`[스케줄러] 상태별 - 신규(PAYED):${newOrderCount} 배송준비(OK):${dispatchCount} 배송중(DELIVERING/DISPATCHED):${deliveringCount} 배송완료:${deliveredCount} 구매확정:${confirmedCount}`);
    console.log(`[스케줄러] 전체 상태 분포:`, JSON.stringify(statusCounts));

    // 신규 주문(PAYED) 상세
    const newOrders = activeOrders.filter(o => o.productOrderStatus === 'PAYED');

    let message = '📊 <b>[자동 보고] ' + todayKST + ' 현황</b>\n';
    message += '━━━━━━━━━━━━━━━\n';
    message += '🆕 신규 주문: <b>' + newOrderCount + '건</b>\n';
    message += '📦 배송 준비: <b>' + dispatchCount + '건</b>\n';
    message += '🚚 배송 중: <b>' + deliveringCount + '건</b>\n'; // DELIVERING + DISPATCHED
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
    } else if (activeOrders.length === 0) {
      message += '\n처리할 주문이 없습니다.';
    }

    const buttons: any[] = [];
    if (newOrderCount > 0) {
      buttons.push([
        { text: '✅ 발주확인 처리', callback_data: 'confirm_order_' + todayKST },
        { text: '📋 발주서 발송', callback_data: 'confirm_dispatch_' + todayKST },
      ]);
      buttons.push([
        { text: '⏭ 나중에', callback_data: 'skip_dispatch' },
      ]);
    }
    if (dispatchCount > 0) {
      buttons.push([
        { text: '🚚 배송처리 (송장입력)', callback_data: 'start_shipping_' + todayKST },
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
  } catch (error: any) {
    const errMsg = error.response?.data?.message || error.message || String(error);
    console.error('[스케줄러] 오류:', errMsg);
    await sendTelegram('❌ [자동 보고] 오류 발생\n' + errMsg);
  }
}


/**
 * 발주 확인 처리 (결제완료 PAYED → 배송준비 OK)
 * 네이버 커머스 API: PUT /external/v1/product-orders/confirm
 * @param token 스마트스토어 API 토큰
 * @param productOrderIds 상품주문ID 배열 (최대 30개)
 */
export async function confirmProductOrders(
  token: string,
  productOrderIds: string[]
): Promise<{ success: boolean; message: string; successIds: string[]; failIds: string[] }> {
  const successIds: string[] = [];
  const failIds: string[] = [];

  try {
    if (!productOrderIds || productOrderIds.length === 0) {
      return { success: false, message: '상품주문ID가 없습니다.', successIds, failIds };
    }

    console.log(`[발주확인] 처리 시작: ${productOrderIds.length}건`);

    const url = 'https://api.commerce.naver.com/external/v1/product-orders/confirm';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 최대 30개씩 배치 처리
    const batchSize = 30;
    for (let i = 0; i < productOrderIds.length; i += batchSize) {
      const batch = productOrderIds.slice(i, i + batchSize);
      const payload = { productOrderIds: batch };

      try {
        const response = await naverPost(url, payload, headers);
        if (response.code === 'Success' || response.code === '00000000' || !response.code) {
          successIds.push(...batch);
          console.log(`[발주확인] 성공: ${batch.length}건`);
        } else {
          failIds.push(...batch);
          console.error(`[발주확인] 실패:`, response.message || response.code);
        }
      } catch (e: any) {
        failIds.push(...batch);
        console.error(`[발주확인] 배치 오류:`, e.response?.data?.message || e.message);
      }

      if (i + batchSize < productOrderIds.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const success = failIds.length === 0;
    const message = `발주확인 완료: ${successIds.length}건 성공${failIds.length > 0 ? `, ${failIds.length}건 실패` : ''}`;
    console.log(`[발주확인] ${message}`);
    return { success, message, successIds, failIds };
  } catch (error: any) {
    const errMsg = error.response?.data?.message || error.message || String(error);
    console.error('[발주확인] 오류:', errMsg);
    return { success: false, message: `발주확인 오류: ${errMsg}`, successIds, failIds };
  }
}

/**
 * 배송정보 등록 (배송준비 OK → 배송중 DELIVERING)
 * 네이버 커머스 API: POST /external/v1/product-orders/dispatch
 * @param token 스마트스토어 API 토큰
 * @param dispatchItems 배송정보 배열 [{productOrderId, deliveryCompanyCode, trackingNumber}]
 */
export async function dispatchProductOrders(
  token: string,
  dispatchItems: Array<{ productOrderId: string; deliveryCompanyCode: string; trackingNumber: string }>
): Promise<{ success: boolean; message: string; successIds: string[]; failIds: string[] }> {
  const successIds: string[] = [];
  const failIds: string[] = [];

  try {
    if (!dispatchItems || dispatchItems.length === 0) {
      return { success: false, message: '배송 정보가 없습니다.', successIds, failIds };
    }

    console.log(`[배송처리] 시작: ${dispatchItems.length}건`);

    const url = 'https://api.commerce.naver.com/external/v1/product-orders/dispatch';
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 최대 30개씩 배치 처리
    const batchSize = 30;
    for (let i = 0; i < dispatchItems.length; i += batchSize) {
      const batch = dispatchItems.slice(i, i + batchSize);
      const payload = {
        dispatchProductOrders: batch.map(item => ({
          productOrderId: item.productOrderId,
          deliveryMethod: 'DELIVERY',
          deliveryCompanyCode: item.deliveryCompanyCode,
          trackingNumber: item.trackingNumber,
        }))
      };

      try {
        const response = await naverPost(url, payload, headers);
        if (response.code === 'Success' || response.code === '00000000' || !response.code) {
          successIds.push(...batch.map(b => b.productOrderId));
          console.log(`[배송처리] 성공: ${batch.length}건`);
        } else {
          failIds.push(...batch.map(b => b.productOrderId));
          console.error(`[배송처리] 실패:`, response.message || response.code);
        }
      } catch (e: any) {
        failIds.push(...batch.map(b => b.productOrderId));
        console.error(`[배송처리] 배치 오류:`, e.response?.data?.message || e.message);
      }

      if (i + batchSize < dispatchItems.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const success = failIds.length === 0;
    const message = `배송처리 완료: ${successIds.length}건 성공${failIds.length > 0 ? `, ${failIds.length}건 실패` : ''}`;
    console.log(`[배송처리] ${message}`);
    return { success, message, successIds, failIds };
  } catch (error: any) {
    const errMsg = error.response?.data?.message || error.message || String(error);
    console.error('[배송처리] 오류:', errMsg);
    return { success: false, message: `배송처리 오류: ${errMsg}`, successIds, failIds };
  }
}

/**
 * 배송 준비 중인 주문 조회 (OK 상태)
 * @param token 스마트스토어 API 토큰
 */
export async function getDispatchReadyOrders(
  token: string,
  fromDate: string,
  toDate: string
): Promise<any[]> {
  try {
    const allOrders = await getOrdersForDateRange(token, fromDate, toDate);
    const dispatchReady = allOrders.filter((o: any) => o.productOrderStatus === 'OK');
    console.log(`[배송준비조회] ${dispatchReady.length}건 조회 완료`);
    return dispatchReady;
  } catch (error: any) {
    console.error('[배송준비조회] 오류:', error.message);
    return [];
  }
}

/**
 * 날짜 범위 주문 조회 (내부 헬퍼)
 */
async function getOrdersForDateRange(token: string, fromDate: string, toDate: string): Promise<any[]> {
  const allOrders: any[] = [];
  const headers = { 'Authorization': `Bearer ${token}` };
  const startDate = new Date(fromDate);
  const endDate = new Date(toDate);

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    try {
      const url = `https://api.commerce.naver.com/external/v1/product-orders?rangeType=PAYED_DATETIME&startDate=${dateStr}T00:00:00.000Z&endDate=${dateStr}T23:59:59.999Z&pageSize=100`;
      const response = await naverGet(url, headers);
      if (response.contents && Array.isArray(response.contents)) {
        for (const item of response.contents) {
          const po = item.order?.productOrder || item.productOrder || item;
          const contentPO = item.content?.productOrder || {};
          const status = contentPO.productOrderStatus || po.productOrderStatus || item.productOrderStatus || 'UNKNOWN';
          allOrders.push({ ...po, ...contentPO, productOrderStatus: status });
        }
      }
    } catch (e: any) {
      console.error(`[날짜범위조회] ${dateStr} 오류:`, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return allOrders;
}

/**
 * 최근 N일 범위의 PAYED(신규) 주문을 모두 조회합니다.
 * 발주확인 처리 시 날짜 범위를 넓게 조회하기 위해 사용합니다.
 */
export async function getNewOrderDetailsRange(token: string, fromDate: string, toDate: string) {
  const allOrders: any[] = [];
  // fromDate ~ toDate 사이의 모든 날짜 생성
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const dates: string[] = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }
  console.log(`[발주확인조회] ${fromDate} ~ ${toDate} (${dates.length}일) PAYED 주문 조회`);
  for (const dateStr of dates) {
    const orders = await getOrdersForOneDay(token, dateStr, 'PAYED');
    if (orders.length > 0) {
      console.log(`[발주확인조회] ${dateStr}: ${orders.length}건`);
      allOrders.push(...orders);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  // 중복 제거 (productOrderId 기준)
  const seen = new Set<string>();
  const unique = allOrders.filter(o => {
    const id = o.productOrderId;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  console.log(`[발주확인조회] 총 ${unique.length}건 PAYED 주문 발견`);
  return unique;
}

/**
 * @deprecated updateOrderShippingStatus 대신 dispatchProductOrders 사용
 */
export async function updateOrderShippingStatus(
  token: string,
  productOrderIds: string[],
  shippingCompany: string,
  trackingNumber: string
): Promise<{ success: boolean; message: string }> {
  const items = productOrderIds.map(id => ({
    productOrderId: id,
    deliveryCompanyCode: shippingCompany,
    trackingNumber,
  }));
  const result = await dispatchProductOrders(token, items);
  return { success: result.success, message: result.message };
}
