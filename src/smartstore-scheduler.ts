// 스마트스토어 자동 처리 스케줄러
// 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문을 조회하고
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
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
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

// 주문 조회 및 텔레그램 보고
export async function runDailyOrderReport() {
  console.log('[스케줄러] 자동 주문 보고 시작...');
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      await sendTelegram('❌ [자동 보고] 스마트스토어 인증 실패\n서버 로그를 확인해주세요.');
      return;
    }

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const ordersRes = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?' +
      'lastChangedFrom=' + yesterdayStr + 'T00:00:00.000Z&lastChangedTo=' + todayStr + 'T00:00:00.000Z&' +
      'orderStatuses=PAYED&page=1&pageSize=100',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );

    const ordersData = await ordersRes.json();
    const orders = ordersData.data?.lastChangeStatuses || [];
    const totalCount = ordersData.totalCount || orders.length;

    if (totalCount === 0) {
      await sendTelegram('📋 <b>[자동 보고] ' + yesterdayStr + ' 주문 현황</b>\n\n📦 신규 주문: 0건\n\n처리할 주문이 없습니다.');
      return;
    }

    const bamOrders = {};
    const cornOrders = {};
    for (const order of orders) {
      const optionName = order.productOption || order.productName || '';
      const isCorn = optionName.includes('옥수수') || optionName.includes('옥광') ||
                     optionName.includes('3X') || optionName.includes('찰옥');
      if (isCorn) { cornOrders[optionName] = (cornOrders[optionName] || 0) + (order.quantity || 1); }
      else { bamOrders[optionName] = (bamOrders[optionName] || 0) + (order.quantity || 1); }
    }

    let message = '🌅 <b>[자동 보고] ' + yesterdayStr + ' 주문 현황</b>\n';
    message += '📦 총 주문: <b>' + totalCount + '건</b>\n\n';

    if (Object.keys(bamOrders).length > 0) {
      message += '🌰 <b>밤 주문</b>\n';
      for (const [name, qty] of Object.entries(bamOrders)) { message += '  • ' + name + ': ' + qty + '개\n'; }
      message += '\n';
    }
    if (Object.keys(cornOrders).length > 0) {
      message += '🌽 <b>옥수수 주문</b>\n';
      for (const [name, qty] of Object.entries(cornOrders)) { message += '  • ' + name + ': ' + qty + '개\n'; }
      message += '\n';
    }

    message += '⚡ <b>지금 처리하시겠습니까?</b>\n자비스에게 "발주서 처리해줘"라고 말씀해주세요.';
    await sendTelegram(message);
    console.log('[스케줄러] 텔레그램 보고 완료 - ' + totalCount + '건');

  } catch (error) {
    console.error('[스케줄러] 오류:', error);
    await sendTelegram('❌ [자동 보고] 오류 발생\n' + String(error));
  }
}
