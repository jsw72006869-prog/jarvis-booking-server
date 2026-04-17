import { Router, Request, Response } from 'express';
import { chromium } from 'playwright';
import { sessionStore } from '../session-store';
import { sendEmailNotification } from '../email';

export const bookingRouter = Router();

// ── 1. 네이버 로그인 ──────────────────────────────────────────
bookingRouter.post('/login', async (req: Request, res: Response) => {
  const { naverID, naverPW } = req.body;

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
    await page.click('.btn_login');

    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    // ── 캡차 감지: 로그인 페이지에 머물러 있으면 캡차 또는 오류 ──
    if (currentUrl.includes('nidlogin') || currentUrl.includes('nid.naver.com/login')) {
      // 캡차 이미지 존재 여부 확인
      const captchaImg = page.locator('img[src*="captcha"], .captcha_area img, #captchaimg').first();
      const hasCaptcha = await captchaImg.count() > 0;

      // 오류 메시지 확인
      const errorMsg = await page.locator('.error_message, .msg, [class*="error"]').first().textContent().catch(() => '');

      const screenshotBuf = await page.screenshot({ fullPage: false });
      const screenshot = `data:image/png;base64,${screenshotBuf.toString('base64')}`;

      if (hasCaptcha) {
        // 캡차 이미지 URL 추출
        const captchaSrc = await captchaImg.getAttribute('src').catch(() => '');
        // 브라우저를 닫지 않고 pending 세션으로 저장
        const pendingId = sessionStore.createPending(naverID, browser, context, page);
        return res.json({
          success: false,
          needVerification: true,
          verificationType: 'captcha',
          pendingSessionId: pendingId,
          message: '네이버 로그인 중 자동입력 방지 문자가 표시되었습니다. 화면에 보이는 문자를 말씀해 주세요.',
          screenshot,
          captchaSrc,
        });
      }

      // 2단계 인증 (SMS/앱 인증)
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

// ── 1-b. 캡차/OTP 인증번호 제출 ──────────────────────────────
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
    // 캡차 입력 필드 찾기
    const captchaInput = page.locator(
      'input[name*="captcha"], input[id*="captcha"], input[placeholder*="문자"], .captcha_area input'
    ).first();

    const otpInput = page.locator(
      'input[name*="otp"], input[name*="code"], input[placeholder*="인증"], input[type="number"][maxlength]'
    ).first();

    if (await captchaInput.count() > 0) {
      await captchaInput.fill('');
      await captchaInput.type(code, { delay: 60 });
    } else if (await otpInput.count() > 0) {
      await otpInput.fill('');
      await otpInput.type(code, { delay: 60 });
    } else {
      // 현재 화면에 입력 가능한 필드가 없음 → 스크린샷 반환
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

  const session = sessionStore.get(sessionId);
  if (!session) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1280, height: 800 },
    });

    await context.addCookies(session.cookies);
    const page = await context.newPage();

    await page.goto(`https://map.naver.com/p/search/${encodeURIComponent(businessName)}`, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    const firstResult = page.locator('.place_bluelink, .CHC5F, a[class*="place"]').first();
    if (await firstResult.count() > 0) {
      await firstResult.click();
      await page.waitForTimeout(2000);
    }

    const bookingTab = page.locator('a:has-text("예약"), button:has-text("예약"), span:has-text("예약")').first();
    if (await bookingTab.count() > 0) {
      await bookingTab.click();
      await page.waitForTimeout(2000);
    }

    const screenshotBuf = await page.screenshot({ fullPage: false });
    const screenshot = screenshotBuf.toString('base64');
    const bookingUrl = page.url();

    const availableSlots: string[] = [];

    if (date) {
      const dateObj = new Date(date);
      const day = dateObj.getDate();

      const dateCell = page.locator(`[aria-label*="${day}일"], td:has-text("${day}"), .calendar-day:has-text("${day}")`).first();
      if (await dateCell.count() > 0) {
        await dateCell.click();
        await page.waitForTimeout(1500);
      }

      const timeSlots = await page.locator(
        '.time-slot, [class*="time"], button:has-text("시"), .booking-time'
      ).allTextContents();

      timeSlots.forEach(slot => {
        const trimmed = slot.trim();
        if (trimmed && (trimmed.includes('시') || trimmed.match(/\d{1,2}:\d{2}/))) {
          availableSlots.push(trimmed);
        }
      });
    }

    await browser.close();

    return res.json({
      success: true,
      businessName,
      date,
      availableSlots: availableSlots.length > 0 ? availableSlots : ['예약 페이지를 직접 확인해주세요'],
      bookingUrl,
      screenshot: `data:image/png;base64,${screenshot}`,
    });

  } catch (err: any) {
    await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// ── 3. 예약 폼 자동 입력 ─────────────────────────────────────
bookingRouter.post('/fill-form', async (req: Request, res: Response) => {
  const { sessionId, bookingUrl, userName, userPhone, selectedTime, date } = req.body;

  const session = sessionStore.get(sessionId);
  if (!session) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1280, height: 800 },
    });

    await context.addCookies(session.cookies);
    const page = await context.newPage();

    await page.goto(bookingUrl, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);

    if (date) {
      const dateObj = new Date(date);
      const day = dateObj.getDate();
      const dateCell = page.locator(`[aria-label*="${day}일"], td:has-text("${day}")`).first();
      if (await dateCell.count() > 0) {
        await dateCell.click();
        await page.waitForTimeout(1000);
      }
    }

    if (selectedTime) {
      const timeBtn = page.locator(`button:has-text("${selectedTime}"), [data-time="${selectedTime}"]`).first();
      if (await timeBtn.count() > 0) {
        await timeBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    const nextBtn = page.locator('button:has-text("다음"), button:has-text("예약하기")').first();
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
    }

    const nameInput = page.locator('input[placeholder*="이름"], input[name*="name"], input[id*="name"]').first();
    if (await nameInput.count() > 0) {
      await nameInput.fill('');
      await nameInput.type(userName, { delay: 60 });
    }

    const phoneInput = page.locator('input[placeholder*="전화"], input[placeholder*="연락처"], input[type="tel"]').first();
    if (await phoneInput.count() > 0) {
      await phoneInput.fill('');
      await phoneInput.type(userPhone, { delay: 60 });
    }

    await page.waitForTimeout(1000);

    const screenshotBuf = await page.screenshot({ fullPage: false });
    const screenshot = screenshotBuf.toString('base64');
    const finalUrl = page.url();

    await browser.close();

    return res.json({
      success: true,
      message: '예약 정보 입력 완료. 결제만 진행해주세요.',
      screenshot: `data:image/png;base64,${screenshot}`,
      paymentUrl: finalUrl,
    });

  } catch (err: any) {
    await browser.close().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
});

// ── 4. 예약 완료 이메일 알림 ─────────────────────────────────
bookingRouter.post('/notify', async (req: Request, res: Response) => {
  const { email, businessName, date, time, userName } = req.body;

  try {
    await sendEmailNotification({
      to: email,
      subject: `[자비스] ${businessName} 예약 완료`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0a1a; color: #e0e0ff; padding: 30px; border-radius: 12px;">
          <h2 style="color: #00d4ff; font-size: 24px; margin-bottom: 20px;">✅ 예약이 완료되었습니다</h2>
          <div style="background: #1a1a2e; padding: 20px; border-radius: 8px; border-left: 4px solid #00d4ff;">
            <p><strong style="color: #00d4ff;">업체명:</strong> ${businessName}</p>
            <p><strong style="color: #00d4ff;">예약자:</strong> ${userName}</p>
            <p><strong style="color: #00d4ff;">날짜:</strong> ${date}</p>
            <p><strong style="color: #00d4ff;">시간:</strong> ${time}</p>
          </div>
          <p style="margin-top: 20px; color: #888; font-size: 12px;">이 메일은 MAWINPAY JARVIS에서 자동 발송되었습니다.</p>
        </div>
      `,
    });

    return res.json({ success: true, message: '이메일 알림 발송 완료' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
