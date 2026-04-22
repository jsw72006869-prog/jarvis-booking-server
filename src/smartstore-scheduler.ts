// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)
// 개선: 토큰 캐싱 + IP 변경 감지 + 실패 시 명확한 안내 + 정확한 현황 조회

import { getCachedToken, setCachedToken, handleTokenFailure } from './ip-manager';

export async function sendTelegram(message: string, replyMarkup?: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!botToken || !chatId) return null;
  try {
    const body: any = { chat_id: chatId, text: message, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as any;
    if (!data.ok) { console.error('[텔레그램] 발송 실패:', data.description); return null; }
    console.log('[텔레그램] 발송 성공 to chat_id:', chatId, 'message_id:', data.result?.message_id);
    return data.result?.message_id || null;
  } catch (e) { console.error('[텔레그램] 발송 오류:', e); return null; }
}

export async function answerCallbackQuery(callbackQueryId: string, text: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!botToken) return;
  try {
    await fetch('https://api.telegram.org/bot' + botToken + '/answerCallbackQuery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch (e) { console.error('[텔레그램] Callback 응답 오류:', e); }
}

export async function getSmartStoreToken(): Promise<string | null> {
  // 1. 캐시된 토큰이 있으면 재사용 (불필요한 발급 요청 방지)
  const cached = getCachedToken();
  if (cached) return cached;

  const clientId = process.env.SMARTSTORE_CLIENT_ID || '';
  const clientSecret = process.env.SMARTSTORE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    console.error('[스마트스토어] 환경변수 없음 - SMARTSTORE_CLIENT_ID/SECRET 확인 필요');
    await handleTokenFailure('EnvMissing', '환경변수(SMARTSTORE_CLIENT_ID/SECRET)가 설정되지 않았습니다.');
    return null;
  }

  // 2. 최대 2회 재시도 (일시적 네트워크 오류 대응)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const bcrypt = await import('bcryptjs');
      const timestamp = String(Date.now());
      const password = clientId + '_' + timestamp;
      const hashed = bcrypt.hashSync(password, clientSecret);
      const clientSecretSign = Buffer.from(hashed).toString('base64');

      console.log(`[토큰발급] 시도 ${attempt}/2 - client_id 앞 8자리: ${clientId.substring(0, 8)}`);

      const params = new URLSearchParams({
        client_id: clientId,
        timestamp,
        client_secret_sign: clientSecretSign,
        grant_type: 'client_credentials',
        type: 'SELF',
      });

      const response = await fetch(
        'https://api.commerce.naver.com/external/v1/oauth2/token?' + params.toString(),
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const data = await response.json() as any;

      if (data.error || data.code) {
        const errCode = data.error || data.code || '';
        const errMsg = data.error_description || data.message || '';
        console.error(`[토큰발급] 실패 (시도 ${attempt}):`, errCode, '-', errMsg);
        if (attempt === 2) {
          await handleTokenFailure(errCode, errMsg);
        }
        continue;
      }

      const token = data.access_token || null;
      if (token) {
        setCachedToken(token);
        console.log('[토큰발급] 성공');
        return token;
      }
    } catch (e) {
      console.error(`[토큰발급] 오류 (시도 ${attempt}):`, e);
      if (attempt === 2) {
        await handleTokenFailure('NetworkError', String(e));
      }
    }

    if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
  }

  return null;
}

/**
 * 현재 상태별 주문 건수 조회
 * - paymentDateFrom/To: 결제일 기준 범위 (최대 90일)
 * - productOrderStatuses: 현재 상태 기준 필터 (lastChangedStatuses와 다름)
 *
 * 주의: lastChangedFrom/To API는 "기간 내 상태 변경된 주문"만 반환하므로
 * 오래된 배송중/배송완료 주문이 누락됨 → productOrderStatuses 사용
 */
async function getOrderCountByStatus(token: string, statuses: string[], fromDate: string, toDate: string): Promise<number> {
  try {
    const statusParam = statuses.map(s => 'productOrderStatuses=' + s).join('&');
    const url =
      'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?' +
      'paymentDateFrom=' + fromDate + 'T00:00:00.000Z&' +
      'paymentDateTo=' + toDate + 'T23:59:59.000Z&' +
      statusParam + '&page=1&pageSize=1';

    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;

    // 응답 구조 로깅 (디버그용)
    console.log(`[주문조회] 상태:${statuses.join(',')} → totalCount:${data.totalCount} count:${data.count}`);

    // API가 에러 반환 시 lastChangedStatuses로 fallback
    if (data.code && data.code !== 200) {
      console.warn(`[주문조회] product-orders 실패(${data.code}), lastChangedStatuses로 fallback`);
      return await getOrderCountFallback(token, statuses, fromDate, toDate);
    }

    return data.totalCount || data.count || 0;
  } catch (e) {
    console.error('[주문조회] 오류:', e);
    return 0;
  }
}

/**
 * Fallback: lastChangedStatuses API (기존 방식)
 * product-orders API 실패 시 사용
 */
async function getOrderCountFallback(token: string, statuses: string[], fromDate: string, toDate: string): Promise<number> {
  try {
    const statusParam = statuses.map(s => 'orderStatuses=' + s).join('&');
    const res = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
      'lastChangedFrom=' + fromDate + 'T00:00:00.000Z&lastChangedTo=' + toDate + 'T23:59:59.000Z&' +
      statusParam + '&page=1&pageSize=1',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;
    return data.totalCount || 0;
  } catch (e) { return 0; }
}

export async function getNewOrderDetails(token: string, fromDate: string, toDate: string) {
  try {
    // 신규 주문(PAYED) 상세는 product-orders API 사용
    const url =
      'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?' +
      'paymentDateFrom=' + fromDate + 'T00:00:00.000Z&' +
      'paymentDateTo=' + toDate + 'T23:59:59.000Z&' +
      'productOrderStatuses=PAYED&page=1&pageSize=100';

    const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;

    // product-orders 응답 구조: data.productOrders 또는 data.data
    const orders = data.productOrders || data.data?.lastChangeStatuses || data.data || [];
    console.log('[신규주문] 조회 건수:', orders.length);
    return orders;
  } catch (e) { console.error('[신규주문 상세조회] 오류:', e); return []; }
}

export async function getDailySettlement(token: string, settleDate: string) {
  try {
    const res = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?' +
      'settleStartDate=' + settleDate + '&settleEndDate=' + settleDate,
      { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;
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
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      console.error('[스케줄러] 토큰 발급 실패 - 보고 중단');
      return;
    }
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + kstOffset);
    const todayKST = kstNow.toISOString().split('T')[0];
    const yesterday = new Date(kstNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKST = yesterday.toISOString().split('T')[0];

    // 현재 진행중인 모든 주문 포함을 위해 90일 범위 사용
    // (배송중/배송완료는 30일 이전 결제 주문도 포함될 수 있음)
    const ninetyDaysAgo = new Date(kstNow);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoKST = ninetyDaysAgo.toISOString().split('T')[0];

    const [newOrderCount, dispatchCount, deliveringCount, deliveredCount, confirmedCount, settlement] = await Promise.all([
      getOrderCountByStatus(token, ['PAYED'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING_HOLD'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERED'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['PURCHASE_DECIDED'], ninetyDaysAgoKST, todayKST),
      getDailySettlement(token, yesterdayKST),
    ]);

    let newOrders: any[] = [];
    if (newOrderCount > 0) newOrders = await getNewOrderDetails(token, ninetyDaysAgoKST, todayKST);

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
        const optionName = order.productOption || order.productName || order.productTitle || '';
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
    console.log('[스케줄러] 보고 완료 - 신규:' + newOrderCount + ' 배송준비:' + dispatchCount + ' 배송중:' + deliveringCount + ' 배송완료:' + deliveredCount + ' 확정:' + confirmedCount + ' 정산:' + (settlement?.settleAmount || 0) + '원');
  } catch (error) {
    console.error('[스케줄러] 오류:', error);
    await sendTelegram('❌ [자동 보고] 오류 발생\n' + String(error));
  }
}
