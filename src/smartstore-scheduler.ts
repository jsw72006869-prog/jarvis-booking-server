/**
 * 스마트스토어 자동 처리 스케줄러
 * 매일 아침 9시(한국시간)에 자동으로 스마트스토어 주문을 조회하고
 * 텔레그램으로 보고합니다.
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const VERCEL_API_URL = process.env.VERCEL_API_URL || 'https://mawinpay-jarvis.vercel.app';
const SMARTSTORE_CLIENT_ID = process.env.SMARTSTORE_CLIENT_ID || '';
const SMARTSTORE_CLIENT_SECRET = process.env.SMARTSTORE_CLIENT_SECRET || '';

// 텔레그램 메시지 발송
async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('텔레그램 발송 실패:', e);
  }
}

// 스마트스토어 인증 토큰 발급
async function getSmartStoreToken(): Promise<string | null> {
  try {
    const crypto = await import('crypto');
    const timestamp = Date.now();
    const password = `${SMARTSTORE_CLIENT_ID}_${timestamp}`;
    const hashed = crypto.createHash('sha256').update(password).digest('base64');
    
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
    
    const data = await response.json() as { access_token?: string };
    return data.access_token || null;
  } catch (e) {
    console.error('토큰 발급 실패:', e);
    return null;
  }
}

// 주문 조회 및 텔레그램 보고
export async function runDailyOrderReport(): Promise<void> {
  console.log('🕘 [스케줄러] 매일 아침 9시 자동 주문 보고 시작...');
  
  try {
    const token = await getSmartStoreToken();
    if (!token) {
      await sendTelegram('❌ [자동 보고] 스마트스토어 인증 실패\n토큰을 발급받지 못했습니다.');
      return;
    }

    // 오늘 날짜 범위
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // 주문 조회 (어제 날짜 기준)
    const ordersRes = await fetch(
      `https://api.commerce.naver.com/external/v1/pay-order/seller/orders/last-changed-statuses?` +
      `lastChangedFrom=${yesterdayStr}T00:00:00.000Z&lastChangedTo=${todayStr}T00:00:00.000Z&` +
      `orderStatuses=PAYED&page=1&pageSize=100`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    const ordersData = await ordersRes.json() as {
      data?: { lastChangeStatuses?: Array<{
        productOrderId: string;
        productName: string;
        quantity: number;
        productOption?: string;
      }> };
      totalCount?: number;
    };

    const orders = ordersData.data?.lastChangeStatuses || [];
    const totalCount = ordersData.totalCount || orders.length;

    if (totalCount === 0) {
      await sendTelegram(
        `📋 <b>[자동 보고] ${yesterdayStr} 주문 현황</b>\n\n` +
        `📦 신규 주문: 0건\n\n` +
        `✅ 처리할 주문이 없습니다.`
      );
      return;
    }

    // 상품별 수량 집계
    const bamOrders: Record<string, number> = {};
    const cornOrders: Record<string, number> = {};
    
    for (const order of orders) {
      const optionName = order.productOption || order.productName || '';
      const isCorn = optionName.includes('옥수수') || optionName.includes('옥광') || 
                     optionName.includes('3X') || optionName.includes('찰옥');
      
      if (isCorn) {
        cornOrders[optionName] = (cornOrders[optionName] || 0) + (order.quantity || 1);
      } else {
        bamOrders[optionName] = (bamOrders[optionName] || 0) + (order.quantity || 1);
      }
    }

    // 텔레그램 보고 메시지 생성
    let message = `🌅 <b>[자동 보고] ${yesterdayStr} 주문 현황</b>\n`;
    message += `📦 총 주문: <b>${totalCount}건</b>\n\n`;

    if (Object.keys(bamOrders).length > 0) {
      message += `🌰 <b>밤 주문</b>\n`;
      for (const [name, qty] of Object.entries(bamOrders)) {
        message += `  • ${name}: ${qty}개\n`;
      }
      message += '\n';
    }

    if (Object.keys(cornOrders).length > 0) {
      message += `🌽 <b>옥수수 주문</b>\n`;
      for (const [name, qty] of Object.entries(cornOrders)) {
        message += `  • ${name}: ${qty}개\n`;
      }
      message += '\n';
    }

    message += `⚡ <b>지금 처리하시겠습니까?</b>\n`;
    message += `자비스에게 "발주서 처리해줘"라고 말씀해주세요.`;

    await sendTelegram(message);
    console.log(`✅ [스케줄러] 텔레그램 보고 완료 - ${totalCount}건`);

  } catch (error) {
    console.error('[스케줄러] 오류:', error);
    await sendTelegram(`❌ [자동 보고] 오류 발생\n${String(error)}`);
  }
}
