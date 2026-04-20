/**
 * 스마트스토어 자동 처리 스케줄러
 * 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문을 조회하고
 * 텔레그램으로 보고합니다.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SMARTSTORE_CLIENT_ID = process.env.SMARTSTORE_CLIENT_ID || '';
const SMARTSTORE_CLIENT_SECRET = process.env.SMARTSTORE_CLIENT_SECRET || '';

// 텔레그램 메시지 발송
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('텔레그램 환경변수 없음');
    return;
  }
  try {
    const res = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
    const data = await res.json();
    if (!data.ok) { console.error('텔레그램 발송 실패:', data.description); }
    else { console.log('텔레그램 발송 성공'); }
  } catch (e) { console.error('텔레그램 발송 오류:', e); }
}

// 스마트스토어 인증 토큰 발급 (HMAC-SHA256 방식)
async function getSmartStoreToken() {
  try {
    const crypto = await import('crypto');
    const timestamp = Date.now();
    const password = SMARTSTORE_CLIENT_ID + '_' + timestamp;
    const hashed = crypto.createHmac('sha256', SMARTSTORE_CLIENT_SECRET).update(password).digest('base64');
    console.log('[토큰발급] 시도 중...');
    const response = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SMARTSTORE_CLIENT_ID,
        timestamp: timestamp.toString(),
        client_secret_sign: hashed,
        grant_type: 'client_credentials',
        type: 'SELF'
      })
    });
    const data = await response.json();
    if (data.error) { console.error('[토큰발급] 실패:', data.error, data.error_description); return null; }
    console.log('[토큰발급] 성공');
    return data.access_token || null;
  } catch (e) { console.error('토큰 발급 오류:', e); return null; }
}

// 주문 조회 및 텔레그램 보고
export async function runDailyOrderReport() {
  console.log('[스케줄러] 자동 주문 보고 시작...');
  try {
    const token = await getSmartStoreToken();
    if (!token) { await sendTelegram('❌ [자동 보고] 스마트스토어 인증 실패'); return; }
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
      const isCorn = optionName.includes('옥수수') || optionName.includes('옥광') || optionName.includes('3X') || optionName.includes('찰옥');
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
}/**
 * 스마트스토어 자동 처리 스케줄러
 * 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문을 조회하고
 * 텔레그램으로 보고합니다.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SMARTSTORE_CLIENT_ID = process.env.SMARTSTORE_CLIENT_ID || '';
const SMARTSTORE_CLIENT_SECRET = process.env.SMARTSTORE_CLIENT_SECRET || '';

// 텔레그램 메시지 발송
async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('텔레그램 환경변수 없음:', { bot: !!TELEGRAM_BOT_TOKEN, chat: !!TELEGRAM_CHAT_ID });
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error('텔레그램 발송 실패:', data.description);
    } else {
      console.log('텔레그램 발송 성공');
    }
  } catch (e) {
    console.error('텔레그램 발송 오류:', e);
  }
}

// 스마트스토어 인증 토큰 발급 (HMAC-SHA256 방식)
async function getSmartStoreToken(): Promise<string | null> {
  try {
    const crypto = await import('crypto');
    const timestamp = Date.now();
    const password = `${SMARTSTORE_CLIENT_ID}_${timestamp}`;

    // HMAC-SHA256: clientSecret을 키로 사용하여 서명
    const hashed = crypto
      .createHmac('sha256', SMARTSTORE_CLIENT_SECRET)
      .update(password)
      .digest('base64');

    console.log(`[토큰발급] client_id=${SMARTSTORE_CLIENT_ID.substring(0, 8)}...`);

    const response = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SMARTSTORE_CLIENT_ID,
        timestamp: timestamp.toString(),
        client_secret_sign: hashed,
        grant_type: 'client_credentials',
        type: 'SELF'
      })
    });

    const data = await response.json() as { access_token?: string; error?: string; error_description?: string };

    if (data.error) {
      console.error(`[토큰발급] 실패: ${data.error} - ${data.error_description}`);
      return null;
    }

    console.log('[토큰발급] 성공');
    return data.access_token || null;
  } catch (e) {
    console.error('토큰 발급 오류:', e);
    return null;
  }
}

// 주문 조회 및 텔레그램 보고
export async function runDailyOrderReport(): Promise<void> {
  console.log('[스케줄러] 매일 아침 9시 자동 주문 보고 시작...');

  try {
    const token = await getSmartStoreToken();
    if (!token) {
      await sendTelegram('❌ [자동 보고] 스마트스토어 인증 실패\n토큰을 발급받지 못했습니다.');
      return;
    }

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const ordersRes = await fetch(
      `https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?` +
      `lastChangedFrom=${yesterdayStr}T00:00:00.000Z&lastChangedTo=${todayStr}T00:00:00.000Z&` +
      `orderStatuses=PAYED&page=1&pageSize=100`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
