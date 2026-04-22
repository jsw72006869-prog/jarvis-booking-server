// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)
// ★ 핵심: Node.js 내장 fetch는 agent를 무시함 → axios 사용으로 프록시 확실 적용
// ★ 2024-04-22 수정: last-changed-statuses → /v1/pay-order/seller/product-orders (조건형 조회)

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
 * 네이버 커머스 API 전용 GET (axios + 프록시)
 */
async function naverGet(url: string, headers: Record<string, string> = {}): Promise<any> {
  const agent = getProxyAgent();
  const config: AxiosRequestConfig = { url, method: 'GET', headers };
  if (agent) {
    config.httpsAgent = agent;
    config.httpAgent = agent;
    console.log('[프록시] Quotaguard GET →', url.substring(0, 100));
  }
  const res = await axios(config);
  return res.data;
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
    // 텔레그램은 IP 제한 없으므로 프록시 불필요
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

      // ★ 핵심: 토큰 발급도 axios + 프록시 경유 → 고정 IP로 나감
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
 * 조건형 상품 주문 상세 내역 조회 API를 사용하여
 * 특정 날짜(1일)의 모든 주문을 조회하고 상태별로 카운트합니다.
 * 
 * API: GET /v1/pay-order/seller/product-orders
 * - rangeType: PAYED_DATETIME (결제일 기준)
 * - from/to: 최대 24시간 차이 (1일 단위로 조회)
 * - productOrderStatuses: 생략하여 모든 상태 반환
 * - pageSize: 300 (최대)
 * - 페이징: hasNext가 true면 다음 페이지 조회
 */
async function getOrdersForDate(
  token: string,
  dateStr: string
): Promise<Record<string, number>> {
  const statusCounts: Record<string, number> = {};
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    try {
      const fromDT = dateStr + 'T00:00:00.000%2B09:00';
      const toDT = dateStr + 'T23:59:59.000%2B09:00';
      const url =
        'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?' +
        'from=' + fromDT + '&' +
        'to=' + toDT + '&' +
        'rangeType=PAYED_DATETIME&' +
        'pageSize=300&' +
        'page=' + page;

      const data = await naverGet(url, { 'Authorization': 'Bearer ' + token });

      const contents = data?.data?.contents || [];
      const pagination = data?.data?.pagination;

      for (const order of contents) {
        const status = order.productOrderStatus || order.lastProductOrderStatus || 'UNKNOWN';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      }

      hasNext = pagination?.hasNext === true;
      page++;

      // 안전장치: 최대 10페이지까지만 (3000건)
      if (page > 10) {
        console.warn(`[주문조회] ${dateStr} 페이지 초과 (10+), 중단`);
        break;
      }
    } catch (e: any) {
      const errMsg = e.response?.data?.message || e.message || String(e);
      console.error(`[주문조회] ${dateStr} page=${page} 오류:`, errMsg);
      hasNext = false;
    }
  }

  return statusCounts;
}

/**
 * 여러 날짜의 주문을 병렬로 조회하고 상태별로 합산합니다.
 * API rate limit을 고려하여 동시 요청 수를 제한합니다.
 */
async function getAllOrderStatusCounts(
  token: string,
  fromDateStr: string,
  toDateStr: string
): Promise<Record<string, number>> {
  const totalCounts: Record<string, number> = {};

  // 날짜 목록 생성
  const dates: string[] = [];
  const current = new Date(fromDateStr + 'T00:00:00.000Z');
  const end = new Date(toDateStr + 'T00:00:00.000Z');

  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() + 1);
  }

  console.log(`[주문조회] 총 ${dates.length}일 조회 시작 (${fromDateStr} ~ ${toDateStr})`);

  // 동시 요청 제한: 5개씩 병렬 처리
  const BATCH_SIZE = 5;
  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(date => getOrdersForDate(token, date))
    );

    for (const result of results) {
      for (const [status, count] of Object.entries(result)) {
        totalCounts[status] = (totalCounts[status] || 0) + count;
      }
    }

    // 배치 간 짧은 딜레이 (rate limit 방지)
    if (i + BATCH_SIZE < dates.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log('[주문조회] 전체 상태별 결과:', JSON.stringify(totalCounts));
  return totalCounts;
}

/**
 * 신규 주문(PAYED 상태)의 상세 정보를 조회합니다.
 * 조건형 API를 사용하여 최근 30일간 PAYED 상태 주문을 조회합니다.
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

  // 5개씩 병렬 처리
  const BATCH_SIZE = 5;
  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (dateStr) => {
        const orders: any[] = [];
        let page = 1;
        let hasNext = true;

        while (hasNext) {
          try {
            const fromDT = dateStr + 'T00:00:00.000%2B09:00';
            const toDT = dateStr + 'T23:59:59.000%2B09:00';
            const url =
              'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?' +
              'from=' + fromDT + '&' +
              'to=' + toDT + '&' +
              'rangeType=PAYED_DATETIME&' +
              'productOrderStatuses=PAYED&' +
              'pageSize=300&' +
              'page=' + page;

            const data = await naverGet(url, { 'Authorization': 'Bearer ' + token });
            const contents = data?.data?.contents || [];

            for (const order of contents) {
              orders.push({
                productOrderId: order.productOrderId,
                orderId: order.orderId,
                productName: order.productOrder?.productName || order.productName || '',
                productOption: order.productOrder?.productOption || order.productOption || '',
                quantity: order.productOrder?.quantity || order.quantity || 1,
                totalPaymentAmount: order.productOrder?.totalPaymentAmount || order.totalPaymentAmount || 0,
                orderDate: order.productOrder?.paymentDate || order.paymentDate || '',
              });
            }

            hasNext = data?.data?.pagination?.hasNext === true;
            page++;
            if (page > 10) break;
          } catch (e) {
            console.error(`[신규주문 상세] ${dateStr} page=${page} 오류:`, e);
            hasNext = false;
          }
        }

        return orders;
      })
    );

    for (const orders of batchResults) {
      allOrders.push(...orders);
    }

    if (i + BATCH_SIZE < dates.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allOrders;
}

export async function getDailySettlement(token: string, settleDate: string) {
  try {
    // ★ axios + 프록시 경유
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

    // 90일 전부터 오늘까지 조회
    const ninetyDaysAgo = new Date(kstNow);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoKST = toKSTDateStr(ninetyDaysAgo);

    console.log(`[스케줄러] 조회 기간: ${ninetyDaysAgoKST} ~ ${todayKST}`);

    // ★ 핵심 변경: 조건형 API로 전체 주문 조회 후 상태별 카운트
    const [statusCounts, settlement] = await Promise.all([
      getAllOrderStatusCounts(token, ninetyDaysAgoKST, todayKST),
      getDailySettlement(token, yesterdayKST),
    ]);

    const newOrderCount = statusCounts['PAYED'] || 0;
    const dispatchCount = statusCounts['DELIVERING_HOLD'] || 0;
    const deliveringCount = statusCounts['DELIVERING'] || 0;
    const deliveredCount = statusCounts['DELIVERED'] || 0;
    const confirmedCount = statusCounts['PURCHASE_DECIDED'] || 0;

    console.log(`[스케줄러] 상태별 건수 - 신규:${newOrderCount} 배송준비:${dispatchCount} 배송중:${deliveringCount} 배송완료:${deliveredCount} 구매확정:${confirmedCount}`);

    // 신규 주문 상세 조회 (최근 30일)
    const thirtyDaysAgo = new Date(kstNow);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoKST = toKSTDateStr(thirtyDaysAgo);

    let newOrders: any[] = [];
    if (newOrderCount > 0) newOrders = await getNewOrderDetails(token, thirtyDaysAgoKST, todayKST);

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
