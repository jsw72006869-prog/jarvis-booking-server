/**
 * IP 관리자 모듈
 *
 * Railway는 재배포 시마다 서버 외부 IP가 변경됩니다.
 * 네이버 커머스 API는 허용 IP를 수동 등록해야 하므로,
 * IP가 변경되면 즉시 텔레그램으로 알림을 보내고
 * 사용자가 빠르게 대응할 수 있도록 안내합니다.
 *
 * 동작 방식:
 * 1. 서버 시작 시 현재 IP 확인 → 이전 IP와 비교
 * 2. IP 변경 감지 시 텔레그램 즉시 알림 (네이버 커머스 등록 링크 포함)
 * 3. 토큰 발급 실패 시 IP 문제로 판단 → 현재 IP 포함 안내 메시지 발송
 * 4. 토큰 캐싱으로 불필요한 발급 요청 최소화 (55분 유효)
 */

import * as fs from 'fs';
import * as path from 'path';

const IP_CACHE_FILE = '/tmp/jarvis_last_ip.txt';
const TOKEN_CACHE: { token: string; expiresAt: number } | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

// 현재 서버 외부 IP 조회
export async function getCurrentIP(): Promise<string> {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const data = await res.json() as { ip: string };
    return data.ip || 'unknown';
  } catch {
    try {
      const res2 = await fetch('https://checkip.amazonaws.com/', { signal: AbortSignal.timeout(5000) });
      const text = await res2.text();
      return text.trim() || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

// 이전 IP 파일에서 읽기
function getLastKnownIP(): string | null {
  try {
    if (fs.existsSync(IP_CACHE_FILE)) {
      return fs.readFileSync(IP_CACHE_FILE, 'utf-8').trim() || null;
    }
  } catch {}
  return null;
}

// 현재 IP를 파일에 저장
function saveCurrentIP(ip: string) {
  try {
    fs.writeFileSync(IP_CACHE_FILE, ip, 'utf-8');
  } catch {}
}

// 텔레그램 발송 (순환 참조 방지를 위해 직접 구현)
async function notifyTelegram(message: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
  } catch {}
}

/**
 * 서버 시작 시 IP 변경 여부 확인 및 알림
 * index.ts 서버 시작 직후 호출
 */
export async function checkAndNotifyIPChange() {
  const currentIP = await getCurrentIP();
  const lastIP = getLastKnownIP();

  console.log(`[IP관리자] 현재 IP: ${currentIP} | 이전 IP: ${lastIP || '없음'}`);

  if (lastIP && lastIP !== currentIP) {
    // IP 변경 감지 → 즉시 텔레그램 알림
    const msg =
      `⚠️ <b>서버 IP 변경 감지!</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🔴 이전 IP: <code>${lastIP}</code>\n` +
      `🟢 새 IP: <code>${currentIP}</code>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📋 <b>지금 바로 네이버 커머스 API에 새 IP를 등록해야 합니다.</b>\n\n` +
      `1️⃣ 아래 링크 접속:\n` +
      `https://partner.naver.com/\n\n` +
      `2️⃣ 내 애플리케이션 → API 설정 → IP 허용 목록\n\n` +
      `3️⃣ 기존 IP 삭제 후 새 IP 추가:\n` +
      `<code>${currentIP}</code>\n\n` +
      `⏱ 등록 후 /report 명령어로 정상 작동 확인하세요.`;

    await notifyTelegram(msg);
    console.log(`[IP관리자] IP 변경 알림 발송 완료: ${lastIP} → ${currentIP}`);
  } else if (!lastIP) {
    console.log(`[IP관리자] 최초 실행 - IP 저장: ${currentIP}`);
  }

  // 현재 IP 저장
  saveCurrentIP(currentIP);
  return currentIP;
}

/**
 * 토큰 발급 실패 시 IP 문제 여부 확인 및 안내
 * getSmartStoreToken에서 실패 시 호출
 */
export async function handleTokenFailure(errorCode: string, errorMessage: string) {
  const currentIP = await getCurrentIP();

  // IP 관련 에러 코드 패턴
  const isIPError =
    errorCode?.includes('Unauthorized') ||
    errorCode?.includes('Forbidden') ||
    errorCode?.includes('403') ||
    errorMessage?.includes('IP') ||
    errorMessage?.includes('허용') ||
    errorMessage?.includes('unauthorized') ||
    errorMessage?.includes('forbidden');

  const msg =
    `❌ <b>스마트스토어 인증 실패</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `오류: ${errorCode || '알 수 없음'}\n` +
    `${errorMessage ? '상세: ' + errorMessage + '\n' : ''}` +
    `━━━━━━━━━━━━━━━\n` +
    (isIPError
      ? `🔴 <b>IP 허용 문제로 추정됩니다.</b>\n\n` +
        `현재 서버 IP: <code>${currentIP}</code>\n\n` +
        `📋 네이버 커머스 파트너센터에서\n` +
        `이 IP를 허용 목록에 추가하세요:\n` +
        `https://partner.naver.com/\n\n` +
        `등록 후 /report 로 재시도하세요.`
      : `현재 서버 IP: <code>${currentIP}</code>\n` +
        `환경변수(SMARTSTORE_CLIENT_ID/SECRET) 확인 필요`);

  await notifyTelegram(msg);
  console.log(`[IP관리자] 토큰 실패 알림 발송 - IP: ${currentIP}, 에러: ${errorCode}`);
}

/**
 * 토큰 캐시에서 유효한 토큰 반환 (없으면 null)
 * 토큰 유효시간 1시간 → 55분 캐싱으로 안전하게 재사용
 */
export function getCachedToken(): string | null {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    console.log('[토큰캐시] 캐시된 토큰 사용 (만료까지 ' + Math.round((cachedToken.expiresAt - Date.now()) / 60000) + '분)');
    return cachedToken.token;
  }
  return null;
}

/**
 * 발급된 토큰을 캐시에 저장
 */
export function setCachedToken(token: string) {
  cachedToken = {
    token,
    expiresAt: Date.now() + 55 * 60 * 1000, // 55분
  };
  console.log('[토큰캐시] 새 토큰 캐시 저장 (55분 유효)');
}

/**
 * 캐시 강제 초기화 (IP 변경 후 재발급 강제)
 */
export function clearTokenCache() {
  cachedToken = null;
  console.log('[토큰캐시] 캐시 초기화');
}
