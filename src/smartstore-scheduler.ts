// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)
// 핵심: 모든 네이버 API 호출은 Quotaguard Static 프록시를 통해 고정 IP로 나감

import { HttpsProxyAgent } from 'https-proxy-agent';
import { getCachedToken, setCachedToken, handleTokenFailure } from './ip-manager';

/**
 * Quotaguard Static 프록시 에이전트 생성
 * 환경변수 QUOTAGUARDSTATIC_URL이 설정되어 있으면 프록시 사용
 * 없으면 직접 연결 (개발 환경)
 */
function getProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl = process.env.QUOTAGUARDSTATIC_URL;
  if (proxyUrl) {
    return new HttpsProxyAgent(proxyUrl);
  }
  return undefined;
}

/**
 * 네이버 커머스 API 전용 fetch 래퍼
 * 항상 Quotaguard 프록시를 통해 호출 → 고정 IP 보장
 */
async function naverFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const agent = getProxyAgent();
  const fetchOptions: any = { ...options };
  if (agent) {
    fetchOptions.agent = agent;
    console.log('[프록시] Quotaguard 경유 →', url.substring(0, 80));
  }
  return fetch(url, fetchOptions);
}

export async function sendTelegram(message: string, replyMarkup?: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!botToken || !chatId) return null;
  try {
    const body: any = { chat_id: chatId, text: message, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    // 텔레그램은 IP 제한 없으므로 프록시 불필요 → 일반 fetch 사용
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

      // ★ 핵심: 토큰 발급도 프록시 경유 → 고정 IP로 나감
      const response = await naverFetch(
        'https://api.commerce.naver.com/external/v1/oauth2/token?' + params.toString(),
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const data = await response.json() as any;

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
    } catch (e) {
      console.error(`[토큰발급] 오류 (시도 ${attempt}):`, e);
      if (attempt === 2) await handleTokenFailure('NetworkError', String(e));
    }

    if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
  }

  return null;
}

function toKSTDateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

function splitDateRanges(fromDate: string, toDate: string, chunkDays: number): Array<{from: string, to: string}> {
  const ranges: Array<{from: string, to: string}> = [];
  let current = new Date(fromDate + 'T00:00:00.000Z');
  const end = new Date(toDate + 'T23:59:59.000Z');

  while (current <= end) {
    const chunkEnd = new Date(current);
    chunkEnd.setDate(chunkEnd.getDate() + chunkDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    ranges.push({
      from: current.toISOString().split('T')[0],
      to: chunkEnd.toISOString().split('T')[0],
    });

    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }

  return ranges;
}

async function getOrderCountInRange(token: string, statuses: string[], fromDate: string, toDate: string): Promise<number> {
  try {
    const statusParam = statuses.map(s => 'orderStatuses=' + s).join('&');
    const url =
      'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
      'lastChangedFrom=' + fromDate + 'T00:00:00.000Z&' +
      'lastChangedTo=' + toDate + 'T23:59:59.000Z&' +
      statusParam + '&page=1&pageSize=1';

    // ★ 프록시 경유
    const res = await naverFetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;
    return data.totalCount || 0;
  } catch (e) {
    console.error('[주문조회] 구간 오류:', e);
    return 0;
  }
}

async function getOrderCountByStatus(token: string, statuses: string[], fromDate: string, toDate: string): Promise<number> {
  const ranges = splitDateRanges(fromDate, toDate, 30);
  let total = 0;

  for (const range of ranges) {
    const count = await getOrderCountInRange(token, statuses, range.from, range.to);
    total += count;
    console.log(`[주문조회] 상태:${statuses.join(',')} 구간:${range.from}~${range.to} → ${count}건`);
  }

  console.log(`[주문조회] 상태:${statuses.join(',')} 합계 → ${total}건`);
  return total;
}

export async function getNewOrderDetails(token: string, fromDate: string, toDate: string) {
  try {
    // ★ 프록시 경유
    const res = await naverFetch(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
      'lastChangedFrom=' + fromDate + 'T00:00:00.000Z&lastChangedTo=' + toDate + 'T23:59:59.000Z&' +
      'orderStatuses=PAYED&page=1&pageSize=100',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;
    return data.data?.lastChangeStatuses || [];
  } catch (e) { console.error('[신규주문 상세조회] 오류:', e); return []; }
}

export async function getDailySettlement(token: string, settleDate: string) {
  try {
    // ★ 프록시 경유
    const res = await naverFetch(
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

    const ninetyDaysAgo = new Date(kstNow);
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const ninetyDaysAgoKST = toKSTDateStr(ninetyDaysAgo);

    console.log(`[스케줄러] 조회 기간: ${ninetyDaysAgoKST} ~ ${todayKST}`);

    const [newOrderCount, dispatchCount, deliveringCount, deliveredCount, confirmedCount, settlement] = await Promise.all([
      getOrderCountByStatus(token, ['PAYED'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING_HOLD'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERED'], ninetyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['PURCHASE_DECIDED'], ninetyDaysAgoKST, todayKST),
      getDailySettlement(token, yesterdayKST),
    ]);

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
