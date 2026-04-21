// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)

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

export async function getSmartStoreToken() {
  const clientId = process.env.SMARTSTORE_CLIENT_ID || '';
  const clientSecret = process.env.SMARTSTORE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) { console.error('[스마트스토어] 환경변수 없음'); return null; }
  try {
    const bcrypt = await import('bcryptjs');
    const timestamp = String(Math.floor(Date.now() - 3000));
    const password = clientId + '_' + timestamp;
    const hashed = bcrypt.hashSync(password, clientSecret);
    const clientSecretSign = Buffer.from(hashed).toString('base64');
    console.log('[토큰발급] 시도 중... client_id 앞 8자리:', clientId.substring(0, 8));
    const params = new URLSearchParams({
      client_id: clientId, timestamp, client_secret_sign: clientSecretSign,
      grant_type: 'client_credentials', type: 'SELF',
    });
    const response = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token?' + params.toString(),
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const data = await response.json() as any;
    if (data.error || data.code) { console.error('[토큰발급] 실패:', data.error || data.code, '-', data.error_description || data.message); return null; }
    console.log('[토큰발급] 성공'); return data.access_token || null;
  } catch (e) { console.error('[토큰발급] 오류:', e); return null; }
}

async function getOrderCountByStatus(token: string, statuses: string[], fromDate: string, toDate: string) {
  try {
    const statusParam = statuses.map(s => 'orderStatuses=' + s).join('&');
    const res = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
      'lastChangedFrom=' + fromDate + 'T00:00:00.000Z&lastChangedTo=' + toDate + 'T23:59:59.000Z&' +
      statusParam + '&page=1&pageSize=1',
      { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await res.json() as any;
    return data.totalCount || 0;
  } catch (e) { console.error('[주문조회] 오류:', e); return 0; }
}

export async function getNewOrderDetails(token: string, fromDate: string, toDate: string) {
  try {
    const res = await fetch(
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
    if (!token) { await sendTelegram('❌ [자동 보고] 스마트스토어 인증 실패\n서버 로그를 확인해주세요.'); return; }
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + kstOffset);
    const todayKST = kstNow.toISOString().split('T')[0];
    const yesterday = new Date(kstNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKST = yesterday.toISOString().split('T')[0];
    // 누적 현황 조회를 위해 30일 범위 사용
    const thirtyDaysAgo = new Date(kstNow);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoKST = thirtyDaysAgo.toISOString().split('T')[0];
    const [newOrderCount, dispatchCount, deliveringCount, deliveredCount, confirmedCount, settlement] = await Promise.all([
      getOrderCountByStatus(token, ['PAYED'], thirtyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING_HOLD'], thirtyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING'], thirtyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERED'], thirtyDaysAgoKST, todayKST),
      getOrderCountByStatus(token, ['PURCHASE_DECIDED'], thirtyDaysAgoKST, todayKST),
      getDailySettlement(token, yesterdayKST),
    ]);
    let newOrders = [];
    if (newOrderCount > 0) newOrders = await getNewOrderDetails(token, thirtyDaysAgoKST, todayKST);
    let message = '📊 <b>[자동 보고] ' + yesterdayKST + ' 현황</b>\n';
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
      const bamOrders = {};
      const cornOrders = {};
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
    const buttons = [];
    if (newOrderCount > 0) {
      buttons.push([
        { text: '📋 발주서 발송하기', callback_data: 'confirm_dispatch_' + yesterdayKST },
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
