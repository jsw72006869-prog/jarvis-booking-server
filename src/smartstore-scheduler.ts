// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문/정산 현황을 조회하고
// 텔레그램으로 보고합니다.
// 인증 방식: bcrypt (네이버 커머스API 공식 방식)

// 텔레그램 메시지 발송
async function sendTelegram(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!botToken || !chatId) {
    console.error('[텔레그램] 환경변수 없음 - BOT_TOKEN:', !!botToken, 'CHAT_ID:', !!chatId);
    return;
  }
  try {
    const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) { console.error('[텔레그램] 발송 실패:', data.description); }
    else { console.log('[텔레그램] 발송 성공 to chat_id:', chatId); }
  } catch (e) { console.error('[텔레그램] 발송 오류:', e); }
}

// 스마트스토어 인증 토큰 발급 (bcrypt 방식 - 네이버 공식)
async function getSmartStoreToken() {
  const clientId = process.env.SMARTSTORE_CLIENT_ID || '';
  const clientSecret = process.env.SMARTSTORE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    console.error('[스마트스토어] 환경변수 없음');
    return null;
  }
  try {
    const bcrypt = await import('bcryptjs');
    const timestamp = String(Math.floor(Date.now() - 3000));
    const password = clientId + '_' + timestamp;
    const hashed = bcrypt.hashSync(password, clientSecret);
    const clientSecretSign = Buffer.from(hashed).toString('base64');
    console.log('[토큰발급] 시도 중... client_id 앞 8자리:', clientId.substring(0, 8));
    const params = new URLSearchParams({
      client_id: clientId,
      timestamp: timestamp,
      client_secret_sign: clientSecretSign,
      grant_type: 'client_credentials',
      type: 'SELF'
    });
    const response = await fetch(
      'https://api.commerce.naver.com/external/v1/oauth2/token?' + params.toString(),
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const data = await response.json();
    if (data.error || data.code) {
      console.error('[토큰발급] 실패:', data.error || data.code, '-', data.error_description || data.message);
      return null;
    }
    console.log('[토큰발급] 성공');
    return data.access_token || null;
  } catch (e) {
    console.error('[토큰발급] 오류:', e);
    return null;
  }
}

// 특정 주문 상태의 건수 조회
async function getOrderCountByStatus(token, statuses, fromDate, toDate) {
  try {
    const statusParam = statuses.map(s => 'orderStatuses=' + s).join('&');
    const res = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
      'lastChangedFrom=' + fromDate + 'T00:00:00.000Z&lastChangedTo=' + toDate + 'T23:59:59.000Z&' +
      statusParam + '&page=1&pageSize=1',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const data = await res.json();
    return data.totalCount || 0;
  } catch (e) {
    console.error('[주문조회] 오류:', e);
    return 0;
  }
}

// 일별 정산 내역 조회
async function getDailySettlement(token, settleDate) {
  try {
    const res = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-settle/settle/daily?' +
      'settleStartDate=' + settleDate + '&settleEndDate=' + settleDate,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const data = await res.json();
    console.log('[정산조회] 응답:', JSON.stringify(data).substring(0, 300));
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      let totalAmount = 0;
      let totalCount = 0;
      for (const item of data.data) {
        totalAmount += item.settleAmount || item.totalSettleAmount || item.settleAmountTotal || 0;
        totalCount += item.settleCount || item.totalCount || 0;
      }
      return { settleAmount: totalAmount, settleCount: totalCount };
    }
    if (data.settleAmount !== undefined) {
      return { settleAmount: data.settleAmount || 0, settleCount: data.settleCount || 0 };
    }
    return { settleAmount: 0, settleCount: 0 };
  } catch (e) {
    console.error('[정산조회] 오류:', e);
    return null;
  }
}

// 주문 조회 및 텔레그램 보고
export async function runDailyOrderReport() {
  console.log('[스케줄러] 자동 주문 보고 시작...');
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      await sendTelegram('❌ [자동 보고] 스마트스토어 인증 실패\n서버 로그를 확인해주세요.');
      return;
    }
    const kstOffset = 9 * 60 * 60 * 1000;
    const kstNow = new Date(Date.now() + kstOffset);
    const todayKST = kstNow.toISOString().split('T')[0];
    const yesterday = new Date(kstNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKST = yesterday.toISOString().split('T')[0];

    const [newOrderCount, dispatchCount, deliveringCount, confirmedCount, settlement] = await Promise.all([
      getOrderCountByStatus(token, ['PAYED'], yesterdayKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING_HOLD'], yesterdayKST, todayKST),
      getOrderCountByStatus(token, ['DELIVERING'], yesterdayKST, todayKST),
      getOrderCountByStatus(token, ['PURCHASE_DECIDED'], yesterdayKST, todayKST),
      getDailySettlement(token, yesterdayKST),
    ]);

    let newOrders = [];
    if (newOrderCount > 0) {
      try {
        const detailRes = await fetch(
          'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
          'lastChangedFrom=' + yesterdayKST + 'T00:00:00.000Z&lastChangedTo=' + todayKST + 'T23:59:59.000Z&' +
          'orderStatuses=PAYED&page=1&pageSize=100',
          { headers: { 'Authorization': 'Bearer ' + token } }
        );
        const detailData = await detailRes.json();
        newOrders = detailData.data?.lastChangeStatuses || [];
      } catch (e) {
        console.error('[신규주문 상세조회] 오류:', e);
      }
    }

    let message = '📊 <b>[자동 보고] ' + yesterdayKST + ' 현황</b>\n';
    message += '━━━━━━━━━━━━━━━\n';
    message += '🆕 신규 주문: <b>' + newOrderCount + '건</b>\n';
    message += '📦 발주 현황: <b>' + dispatchCount + '건</b>\n';
    message += '🚚 배송 현황: <b>' + deliveringCount + '건</b>\n';
    message += '✅ 구매 확정: <b>' + confirmedCount + '건</b>\n';
    message += '━━━━━━━━━━━━━━━\n';

    if (settlement !== null) {
      if (settlement.settleAmount > 0) {
        const formattedAmount = settlement.settleAmount.toLocaleString('ko-KR');
        message += '💰 정산 입금: <b>' + formattedAmount + '원</b>';
        if (settlement.settleCount > 0) { message += ' (' + settlement.settleCount + '건)'; }
        message += '\n';
      } else {
        message += '💰 정산 입금: <b>0원</b>\n';
      }
      message += '━━━━━━━━━━━━━━━\n';
    }

    if (newOrders.length > 0) {
      const bamOrders = {};
      const cornOrders = {};
      for (const order of newOrders) {
        const optionName = order.productOption || order.productName || '';
        const isCorn = optionName.includes('옥수수') || optionName.includes('옥광') ||
                       optionName.includes('3X') || optionName.includes('찰옥');
        if (isCorn) { cornOrders[optionName] = (cornOrders[optionName] || 0) + (order.quantity || 1); }
        else { bamOrders[optionName] = (bamOrders[optionName] || 0) + (order.quantity || 1); }
      }
      if (Object.keys(bamOrders).length > 0) {
        message += '\n🌰 <b>밤 주문 상세</b>\n';
        for (const [name, qty] of Object.entries(bamOrders)) { message += '  • ' + name + ': ' + qty + '개\n'; }
      }
      if (Object.keys(cornOrders).length > 0) {
        message += '\n🌽 <b>옥수수 주문 상세</b>\n';
        for (const [name, qty] of Object.entries(cornOrders)) { message += '  • ' + name + ': ' + qty + '개\n'; }
      }
      message += '\n⚡ <b>지금 처리하시겠습니까?</b>\n자비스에게 "발주서 처리해줘"라고 말씀해주세요.';
    } else if (newOrderCount === 0 && dispatchCount === 0 && deliveringCount === 0 && confirmedCount === 0) {
      message += '\n처리할 주문이 없습니다.';
    }

    await sendTelegram(message);
    console.log('[스케줄러] 보고 완료 - 신규:' + newOrderCount + ' 발주:' + dispatchCount + ' 배송:' + deliveringCount + ' 확정:' + confirmedCount + ' 정산:' + (settlement?.settleAmount || 0) + '원');

  } catch (error) {
    console.error('[스케줄러] 오류:', error);
    await sendTelegram('❌ [자동 보고] 오류 발생\n' + String(error));
  }
}
