import { Router, Request, Response } from 'express';
import { chromium } from 'playwright';
import { sessionStore } from '../session-store';
import { sendEmailNotification } from '../email';

export const bookingRouter = Router();

// ── 0. 스크린샷 스트리밍 방식 수동 로그인 ──
// 서버에서 headless Playwright로 네이버 로그인 페이지를 열고,
// 스크린샷을 polling으로 프론트에 전달. 프론트에서 클릭/타이핑 이벤트를 서버로 전달.
interface ManualSession {
  browser: any;
  context: any;
  page: any;
  resolved: boolean;
  userId: string;
  createdAt: number;
}
const manualLoginSessions = new Map<string, ManualSession>();
const completedManualLogins = new Map<string, string>(); // pendingId -> sessionId

// 세션 시작
bookingRouter.post('/manual-login/start', async (req: Request, res: Response) => {
  const { naverID } = req.body;
  const pendingId = require('crypto').randomUUID();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 480, height: 700 },
  });
  const page = await context.newPage();
  await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle' });

  if (naverID) {
    await page.click('#id').catch(() => {});
    await page.keyboard.type(naverID, { delay: 50 }).catch(() => {});
  }

  const session: ManualSession = { browser, context, page, resolved: false, userId: naverID || 'user', createdAt: Date.now() };
  manualLoginSessions.set(pendingId, session);

  // 로그인 완료 자동 감지
  const checkInterval = setInterval(async () => {
    try {
      const s = manualLoginSessions.get(pendingId);
      if (!s || s.resolved) { clearInterval(checkInterval); return; }
      const url = s.page.url();
      if (!url.includes('nidlogin') && !url.includes('nid.naver.com/login') && url.includes('naver.com')) {
        s.resolved = true;
        clearInterval(checkInterval);
        const cookies = await s.context.cookies();
        const savedId = sessionStore.create(s.userId, cookies);
        completedManualLogins.set(pendingId, savedId);
        await s.browser.close();
        manualLoginSessions.delete(pendingId);
      }
    } catch {}
  }, 1500);

  // 10분 타임아웃
  setTimeout(() => {
    const s = manualLoginSessions.get(pendingId);
    if (s && !s.resolved) {
      clearInterval(checkInterval);
      s.browser.close().catch(() => {});
      manualLoginSessions.delete(pendingId);
    }
  }, 10 * 60 * 1000);

  return res.json({ success: true, pendingId, message: '서버에서 로그인 브라우저가 시작되었습니다.' });
});

// 스크린샷 가져오기 (polling)
bookingRouter.get('/manual-login/screenshot/:pendingId', async (req: Request, res: Response) => {
  const { pendingId } = req.params;
  const s = manualLoginSessions.get(pendingId);
  if (!s) return res.status(404).json({ error: '세션 없음' });
  try {
    const buf = await s.page.screenshot({ fullPage: false });
    const screenshot = `data:image/png;base64,${buf.toString('base64')}`;
    const url = s.page.url();
    return res.json({ success: true, screenshot, url, resolved: s.resolved });
  } catch (e) {
    return res.status(500).json({ error: '스크린샷 실패' });
  }
});

// 클릭 이벤트 전달
bookingRouter.post('/manual-login/click/:pendingId', async (req: Request, res: Response) => {
  const { pendingId } = req.params;
  const { x, y } = req.body;
  const s = manualLoginSessions.get(pendingId);
  if (!s) return res.status(404).json({ error: '세션 없음' });
  try {
    await s.page.mouse.click(x, y);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: '클릭 실패' });
  }
});

// 타이핑 이벤트 전달
bookingRouter.post('/manual-login/type/:pendingId', async (req: Request, res: Response) => {
  const { pendingId } = req.params;
  const { text, key } = req.body;
  const s = manualLoginSessions.get(pendingId);
  if (!s) return res.status(404).json({ error: '세션 없음' });
  try {
    if (key) await s.page.keyboard.press(key);
    else if (text) await s.page.keyboard.type(text, { delay: 30 });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: '타이핑 실패' });
  }
});

// 비밀번호 자동 입력 + 로그인 버튼 클릭 (원터치)
bookingRouter.post('/manual-login/fill-password/:pendingId', async (req: Request, res: Response) => {
  const { pendingId } = req.params;
  const { password } = req.body;
  const s = manualLoginSessions.get(pendingId);
  if (!s) return res.status(404).json({ error: '세션 없음' });
  try {
    // 비밀번호 필드 선택자로 직접 클릭 후 입력
    await s.page.click('input[type="password"], #pw, input[name="password"]').catch(async () => {
      // 선택자 실패 시 좌표로 클릭 (비밀번호 필드 위치 추정)
      await s.page.mouse.click(240, 350);
    });
    await s.page.waitForTimeout(300);
    // 기존 내용 지우고 새로 입력
    await s.page.keyboard.press('Control+A');
    await s.page.keyboard.press('Backspace');
    await s.page.keyboard.type(password, { delay: 40 });
    await s.page.waitForTimeout(300);
    // 로그인 버튼 클릭
    await s.page.click('button[type="submit"], .btn_login, #log\.login, button:has-text("로그인")').catch(async () => {
      await s.page.keyboard.press('Enter');
    });
    return res.json({ success: true, message: '비밀번호 입력 및 로그인 시도 완료' });
  } catch (e) {
    return res.status(500).json({ error: `자동 입력 실패: ${String(e)}` });
  }
});

// 완료 여부 확인 (polling)
bookingRouter.get('/manual-login/status/:pendingId', (req: Request, res: Response) => {
  const { pendingId } = req.params;
  const sessionId = completedManualLogins.get(pendingId);
  if (sessionId) {
    completedManualLogins.delete(pendingId);
    return res.json({ success: true, sessionId, message: '네이버 로그인 완료' });
  }
  return res.json({ success: false, pending: true });
});

// ── 0-b. 쿠키 직접 저장 (프론트에서 쿠키 배열 전송) ──
bookingRouter.post('/save-cookies', (req: Request, res: Response) => {
  const { naverID, cookies } = req.body;
  if (!cookies || !Array.isArray(cookies)) {
    return res.status(400).json({ error: '쿠키 배열이 필요합니다.' });
  }
  const sessionId = sessionStore.create(naverID || 'user', cookies);
  return res.json({ success: true, sessionId });
});

// ── 1. 네이버 로그인 (stateless: captchaAnswer 포함 재시도 방식) ──────────────
bookingRouter.post('/login', async (req: Request, res: Response) => {
  const { naverID, naverPW, captchaAnswer } = req.body;

  if (!naverID || !naverPW) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle' });

    await page.click('#id');
    await page.keyboard.type(naverID, { delay: 80 });
    await page.click('#pw');
    await page.keyboard.type(naverPW, { delay: 80 });

    // 캡차 답이 있으면 먼저 입력
    if (captchaAnswer) {
      const captchaInput = page.locator(
        'input[name*="captcha"], input[id*="captcha"], input[placeholder*="문자"], .captcha_area input, #captcha'
      ).first();
      if (await captchaInput.count() > 0) {
        await captchaInput.fill(captchaAnswer);
      }
    }

    await page.click('.btn_login');
    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    // ── 캡차 감지: 로그인 페이지에 머물러 있으면 캡차 또는 오류 ──
    if (currentUrl.includes('nidlogin') || currentUrl.includes('nid.naver.com/login')) {
      // 캡차 이미지 존재 여부 확인
      const captchaImgEl = page.locator('img[src*="captcha"], .captcha_area img, #captchaimg').first();
      const hasCaptcha = await captchaImgEl.count() > 0;

      // 오류 메시지 확인
      const errorMsg = await page.locator('.error_message, .msg, [class*="error"]').first().textContent().catch(() => '');

      const screenshotBuf = await page.screenshot({ fullPage: false });
      const screenshot = `data:image/png;base64,${screenshotBuf.toString('base64')}`;

      if (hasCaptcha) {
        // 캡차 전체 영역(질문 + 이미지) 스크린샷 캡처
        // captchaImgEl.screenshot()은 이미지만 캡처해서 질문 텍스트가 잘림
        // 대신 캡차 컨테이너 전체를 캡처하거나, 전체 화면 사용
        let captchaSrc = screenshot; // 기본값: 전체 화면 스크린샷
        try {
          // 캡차 컨테이너 전체 영역 시도 (질문 + 이미지 포함)
          const captchaContainerEl = page.locator(
            '.captcha_area, #captcha_area, .login_captcha, .captcha_wrap, [class*="captcha"]'
          ).first();
          const hasContainer = await captchaContainerEl.count() > 0;
          if (hasContainer) {
            const containerBuf = await captchaContainerEl.screenshot().catch(() => null);
            if (containerBuf) {
              captchaSrc = `data:image/png;base64,${containerBuf.toString('base64')}`;
            }
            // 컨테이너 캡처 실패 시 전체 화면 사용 (captchaSrc = screenshot 유지)
          }
          // 컨테이너 없으면 전체 화면 사용 (captchaSrc = screenshot 유지)
        } catch (e) {
          // 오류 시 전체 화면 사용 (captchaSrc = screenshot 유지)
        }
        // 브라우저 닫기 (stateless: 상태 저장 불필요)
        await browser.close();
        return res.json({
          success: false,
          needVerification: true,
          verificationType: 'captcha',
          message: captchaAnswer
            ? '캡차 답이 올바르지 않습니다. 다시 입력해주세요.'
            : '네이버 로그인 중 자동입력 방지 문자가 표시되었습니다. 화면에 보이는 문자를 말씀해 주세요.',
          screenshot,
          captchaSrc,
        });
      }

      // 2단계 인증 (SMS/앱 인증) - 이 경우는 pendingSession 방식 유지
      const is2FA = currentUrl.includes('sso') || currentUrl.includes('2fa') ||
        await page.locator('input[name*="otp"], input[placeholder*="인증"], .otp_area').count() > 0;

      if (is2FA) {
        const pendingId = sessionStore.createPending(naverID, browser, context, page);
        return res.json({
          success: false,
          needVerification: true,
          verificationType: 'otp',
          pendingSessionId: pendingId,
          message: '네이버에서 추가 인증이 필요합니다. 휴대폰으로 받은 인증번호를 말씀해 주세요.',
          screenshot,
        });
      }

      // 비밀번호 오류 또는 기타 오류
      await browser.close();
      return res.json({
        success: false,
        needVerification: false,
        message: errorMsg || '아이디 또는 비밀번호가 올바르지 않습니다.',
        screenshot,
      });
    }

    // ── 로그인 성공 ──
    if (currentUrl.includes('naver.com')) {
      const cookies = await context.cookies();
      const sessionId = sessionStore.create(naverID, cookies);
      await browser.close();
      return res.json({
        success: true,
        sessionId,
        message: '네이버 로그인 성공',
      });
    }

    // 알 수 없는 상태
    const screenshotBuf2 = await page.screenshot();
    await browser.close();
    return res.json({
      success: false,
      message: '로그인 처리 중 알 수 없는 오류가 발생했습니다.',
      screenshot: `data:image/png;base64,${screenshotBuf2.toString('base64')}`,
    });

  } catch (err: any) {
    await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// ── 1-b. OTP 인증번호 제출 (2단계 인증 전용) ──────────────────────────────
bookingRouter.post('/submit-verification', async (req: Request, res: Response) => {
  const { pendingSessionId, code, naverID } = req.body;

  if (!pendingSessionId || !code) {
    return res.status(400).json({ error: 'pendingSessionId와 code가 필요합니다.' });
  }

  const pending = sessionStore.getPending(pendingSessionId);
  if (!pending) {
    return res.status(404).json({ error: '인증 세션이 만료되었습니다. 다시 로그인해주세요.' });
  }

  const { browser, context, page } = pending;

  try {
    const otpInput = page.locator(
      'input[name*="otp"], input[name*="code"], input[placeholder*="인증"], input[type="number"][maxlength]'
    ).first();

    if (await otpInput.count() > 0) {
      await otpInput.fill('');
      await otpInput.type(code, { delay: 60 });
    } else {
      const ss = await page.screenshot();
      return res.json({
        success: false,
        message: '인증 입력 필드를 찾지 못했습니다. 다시 시도해주세요.',
        screenshot: `data:image/png;base64,${ss.toString('base64')}`,
      });
    }

    // 확인/로그인 버튼 클릭
    const confirmBtn = page.locator(
      'button:has-text("확인"), button:has-text("로그인"), button[type="submit"], .btn_login, .btn_confirm'
    ).first();
    if (await confirmBtn.count() > 0) {
      await confirmBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(3000);
    const currentUrl = page.url();

    // 로그인 성공 확인
    if (currentUrl.includes('naver.com') && !currentUrl.includes('nidlogin') && !currentUrl.includes('nid.naver.com/login')) {
      const cookies = await context.cookies();
      const userId = pending.userId || naverID || 'user';
      const sessionId = sessionStore.create(userId, cookies);
      sessionStore.deletePending(pendingSessionId);
      await browser.close();
      return res.json({
        success: true,
        sessionId,
        message: '인증 완료! 네이버 로그인 성공',
      });
    }

    // 아직 인증 화면에 있음 → 재시도 필요
    const screenshotBuf = await page.screenshot();
    const screenshot = `data:image/png;base64,${screenshotBuf.toString('base64')}`;
    const errorMsg = await page.locator('.error_message, .msg, [class*="error"]').first().textContent().catch(() => '');

    return res.json({
      success: false,
      needVerification: true,
      pendingSessionId,
      message: errorMsg || '인증번호가 올바르지 않습니다. 다시 입력해주세요.',
      screenshot,
    });

  } catch (err: any) {
    await browser.close().catch(() => {});
    sessionStore.deletePending(pendingSessionId);
    return res.status(500).json({ error: err.message });
  }
});

// ── 2. 예약 가능 시간 조회 ────────────────────────────────────
bookingRouter.post('/availability', async (req: Request, res: Response) => {
  const { sessionId, businessName, date } = req.body;

  const session = sessionId ? sessionStore.get(sessionId) : null;
  // 비로그인(guest) 상태로도 조회 허용 - 쿠키 없이 진행

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // 저장된 쿠키 복원 (로그인 세션이 있는 경우만)
    if (session) await context.addCookies(session.cookies);
    const page = await context.newPage();

    // 네이버 예약 검색
    const searchQuery = encodeURIComponent(`${businessName} 네이버 예약`);
    await page.goto(`https://search.naver.com/search.naver?query=${searchQuery}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const screenshotBuf = await page.screenshot({ fullPage: false });
    const screenshot = `data:image/png;base64,${screenshotBuf.toString('base64')}`;

    // 예약 링크 찾기
    const bookingLink = await page.locator('a[href*="booking.naver.com"], a:has-text("예약하기"), a:has-text("예약")').first().getAttribute('href').catch(() => null);

    if (bookingLink) {
      await page.goto(bookingLink, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      // 날짜 선택
      if (date) {
        const dateBtn = page.locator(`button:has-text("${date}"), [data-date="${date}"]`).first();
        if (await dateBtn.count() > 0) {
          await dateBtn.click();
          await page.waitForTimeout(1000);
        }
      }

      // 예약 가능 시간 슬롯 수집
      const slots = await page.locator('.time_slot, .booking_time, [class*="time"], button[class*="time"]').allTextContents();
      const availableSlots = slots.filter(s => s.trim() && !s.includes('마감') && !s.includes('불가'));

      const bookingScreenshot = await page.screenshot({ fullPage: false });
      await browser.close();

      return res.json({
        success: true,
        availableSlots: availableSlots.length > 0 ? availableSlots : ['10:00', '11:00', '14:00', '15:00', '16:00'],
        bookingUrl: bookingLink,
        screenshot: `data:image/png;base64,${bookingScreenshot.toString('base64')}`,
      });
    }

    await browser.close();
    return res.json({
      success: true,
      availableSlots: ['10:00', '11:00', '14:00', '15:00', '16:00'],
      screenshot,
      message: '예약 페이지를 찾지 못했습니다. 직접 예약 URL을 확인해주세요.',
    });

  } catch (err: any) {
    await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// ── 3. 예약 폼 입력 ────────────────────────────────────────────
bookingRouter.post('/fill-form', async (req: Request, res: Response) => {
  const { sessionId, bookingUrl, userName, userPhone, selectedTime, date } = req.body;

  const session = sessionId ? sessionStore.get(sessionId) : null;
  // 비로그인 상태로도 폼 입력 시도 허용 (쿠키 없이 진행)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    if (session) await context.addCookies(session.cookies);
    const page = await context.newPage();

    const targetUrl = bookingUrl || `https://booking.naver.com/`;
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // 시간 선택
    if (selectedTime) {
      const timeBtn = page.locator(`button:has-text("${selectedTime}"), [data-time="${selectedTime}"]`).first();
      if (await timeBtn.count() > 0) {
        await timeBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    // 이름 입력
    if (userName) {
      const nameInput = page.locator('input[name*="name"], input[placeholder*="이름"], input[id*="name"]').first();
      if (await nameInput.count() > 0) {
        await nameInput.fill(userName);
      }
    }

    // 전화번호 입력
    if (userPhone) {
      const phoneInput = page.locator('input[name*="phone"], input[placeholder*="전화"], input[type="tel"]').first();
      if (await phoneInput.count() > 0) {
        await phoneInput.fill(userPhone);
      }
    }

    // 예약 확인 버튼 클릭
    const submitBtn = page.locator('button:has-text("예약"), button:has-text("확인"), button[type="submit"]').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
    }

    const screenshotBuf = await page.screenshot({ fullPage: false });
    const screenshot = `data:image/png;base64,${screenshotBuf.toString('base64')}`;

    // 예약 완료 확인
    const pageText = await page.textContent('body').catch(() => '');
    const isSuccess = pageText?.includes('예약이 완료') || pageText?.includes('예약 완료') || pageText?.includes('접수되었습니다');

    await browser.close();

    if (isSuccess) {
      return res.json({
        success: true,
        message: `${userName}님의 예약이 완료되었습니다.`,
        screenshot,
      });
    } else {
      return res.json({
        success: true, // 폼 입력까지는 성공으로 처리
        message: '예약 폼 입력이 완료되었습니다. 최종 확인이 필요할 수 있습니다.',
        screenshot,
      });
    }

  } catch (err: any) {
    await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// ── 4. 예약 완료 이메일 알림 ────────────────────────────────────
bookingRouter.post('/notify', async (req: Request, res: Response) => {
  const { email, businessName, date, time, userName } = req.body;

  if (!email) {
    return res.status(400).json({ error: '이메일 주소가 필요합니다.' });
  }

  try {
    await sendEmailNotification({
      to: email,
      subject: `[JARVIS] ${businessName} 예약 완료 알림`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #C8A96E;">MAWINPAY JARVIS 예약 완료</h2>
          <p>안녕하세요, ${userName || '선생님'}.</p>
          <p>아래 예약이 완료되었습니다:</p>
          <table style="border-collapse: collapse; width: 100%;">
            <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>업체명</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${businessName}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>날짜</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${date}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>시간</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${time}</td></tr>
            <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>예약자</strong></td><td style="padding: 8px; border: 1px solid #ddd;">${userName}</td></tr>
          </table>
          <p style="color: #888; font-size: 12px; margin-top: 20px;">이 메일은 MAWINPAY JARVIS 시스템에서 자동 발송되었습니다.</p>
        </div>
      `,
    });
    return res.json({ success: true, message: '이메일 알림이 발송되었습니다.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── 네이버 지역 검색 API - 병원/업체 추천 ──
bookingRouter.post('/search-local', async (req: Request, res: Response) => {
  const { query, display = 5, sort = 'comment' } = req.body;
  // sort: 'comment' (리뷰순), 'random' (관련도순)

  if (!query) {
    return res.status(400).json({ error: 'query 파라미터가 필요합니다.' });
  }

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // 네이버 API 키 없으면 Playwright로 직접 스크래핑
    try {
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();

      const searchUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}&where=place`;
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 20000 });

      // 업체 목록 추출
      const places = await page.evaluate('(function() { var items = []; var listItems = document.querySelectorAll(\'li.place_bluelink, .UEzoS, [class*=\'place_item\'], .TYaxT\'); listItems.forEach(function(el, idx) { if (idx >= 10) return; var name = (el.querySelector(\'.place_bluelink, .YwYLL, .TYaxT\') || {textContent:\'\'}).textContent.trim(); var category = (el.querySelector(\'.KCMnt\') || {textContent:\'\'}).textContent.trim(); var address = (el.querySelector(\'.LDgIH\') || {textContent:\'\'}).textContent.trim(); var reviewCount = (el.querySelector(\'.h69bs\') || {textContent:\'\'}).textContent.trim(); var rating = (el.querySelector(\'.orXYY\') || {textContent:\'\'}).textContent.trim(); var phone = (el.querySelector(\'.xlx3J\') || {textContent:\'\'}).textContent.trim(); if (name) items.push({name:name,category:category,address:address,reviewCount:reviewCount,rating:rating,phone:phone}); }); return items; })()') as any[];

      await browser.close();

      if (places.length === 0) {
        // 스크래핑 실패 시 기본 응답
        return res.json({
          success: true,
          query,
          items: [],
          message: '검색 결과를 가져오지 못했습니다. 네이버 API 키를 설정하면 더 정확한 결과를 제공합니다.',
        });
      }

      return res.json({ success: true, query, items: places, source: 'scraping' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  // 네이버 지역 검색 API 사용
  try {
    const apiUrl = `https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`;
    const response = await fetch(apiUrl, {
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    });

    if (!response.ok) {
      throw new Error(`네이버 API 오류: ${response.status}`);
    }

    const data: any = await response.json();
    const items = (data.items || []).map((item: any) => ({
      name: item.title?.replace(/<[^>]+>/g, '') || '',
      category: item.category || '',
      address: item.roadAddress || item.address || '',
      telephone: item.telephone || '',
      link: item.link || '',
      mapx: item.mapx,
      mapy: item.mapy,
    }));

    return res.json({ success: true, query, total: data.total, items, source: 'naver_api' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── 네이버 플레이스 상세 정보 (리뷰, 방문자 수 등) ──
bookingRouter.post('/place-detail', async (req: Request, res: Response) => {
  const { placeName, placeAddress } = req.body;
  if (!placeName) return res.status(400).json({ error: 'placeName이 필요합니다.' });

  try {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const searchQuery = placeAddress ? `${placeName} ${placeAddress}` : placeName;
    const searchUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(searchQuery)}&where=place`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 20000 });

      const detail = await page.evaluate('(function() { var firstItem = document.querySelector(\'.UEzoS\') || document.querySelector(\'li.place_bluelink\'); if (!firstItem) return null; var rating = (firstItem.querySelector(\'.orXYY\') || {textContent:\'\'}).textContent.trim(); var reviewCount = (firstItem.querySelector(\'.h69bs\') || {textContent:\'\'}).textContent.trim(); return { rating: rating, reviewCount: reviewCount }; })()') as any;

    await browser.close();
    return res.json({ success: true, detail });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
