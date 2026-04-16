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

    // 네이버 로그인 페이지
    await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'networkidle' });

    // 아이디/비밀번호 입력 (자연스러운 타이핑)
    await page.click('#id');
    await page.keyboard.type(naverID, { delay: 80 });
    await page.click('#pw');
    await page.keyboard.type(naverPW, { delay: 80 });
    await page.click('.btn_login');

    // 로그인 결과 대기
    await page.waitForTimeout(3000);

    const currentUrl = page.url();

    // 2FA 인증 필요 여부 확인
    if (currentUrl.includes('nid.naver.com/login/sso') || currentUrl.includes('naver.com/nidlogin')) {
      const screenshot = await page.screenshot({ encoding: 'base64' });
      await browser.close();
      return res.json({
        success: false,
        needVerification: true,
        message: '네이버에서 추가 인증이 필요합니다. 휴대폰으로 받은 인증번호를 입력해주세요.',
        screenshot: `data:image/png;base64,${screenshot}`,
      });
    }

    // 로그인 성공 확인
    if (currentUrl.includes('naver.com') && !currentUrl.includes('nidlogin')) {
      const cookies = await context.cookies();
      const sessionId = sessionStore.create(naverID, cookies);
      await browser.close();
      return res.json({
        success: true,
        sessionId,
        message: '네이버 로그인 성공',
      });
    }

    // 로그인 실패
    const screenshot = await page.screenshot({ encoding: 'base64' });
    await browser.close();
    return res.json({
      success: false,
      message: '아이디 또는 비밀번호가 올바르지 않습니다.',
      screenshot: `data:image/png;base64,${screenshot}`,
    });

  } catch (err: any) {
    await browser.close();
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

    // 저장된 쿠키로 로그인 상태 복원
    await context.addCookies(session.cookies);
    const page = await context.newPage();

    // 네이버 지도에서 업체 검색
    await page.goto(`https://map.naver.com/p/search/${encodeURIComponent(businessName)}`, {
      waitUntil: 'networkidle',
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    // 첫 번째 검색 결과 클릭
    const firstResult = page.locator('.place_bluelink, .CHC5F, a[class*="place"]').first();
    if (await firstResult.count() > 0) {
      await firstResult.click();
      await page.waitForTimeout(2000);
    }

    // 예약 탭 찾기
    const bookingTab = page.locator('a:has-text("예약"), button:has-text("예약"), span:has-text("예약")').first();
    if (await bookingTab.count() > 0) {
      await bookingTab.click();
      await page.waitForTimeout(2000);
    }

    // 스크린샷 캡처
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });

    // 현재 URL 저장 (예약 페이지)
    const bookingUrl = page.url();

    // 날짜별 예약 가능 시간 파싱 시도
    const availableSlots: string[] = [];

    // 달력에서 해당 날짜 찾기
    if (date) {
      const dateObj = new Date(date);
      const day = dateObj.getDate();

      // 날짜 클릭 시도
      const dateCell = page.locator(`[aria-label*="${day}일"], td:has-text("${day}"), .calendar-day:has-text("${day}")`).first();
      if (await dateCell.count() > 0) {
        await dateCell.click();
        await page.waitForTimeout(1500);
      }

      // 시간 슬롯 파싱
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
    await browser.close();
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

    // 날짜 선택
    if (date) {
      const dateObj = new Date(date);
      const day = dateObj.getDate();
      const dateCell = page.locator(`[aria-label*="${day}일"], td:has-text("${day}")`).first();
      if (await dateCell.count() > 0) {
        await dateCell.click();
        await page.waitForTimeout(1000);
      }
    }

    // 시간 선택
    if (selectedTime) {
      const timeBtn = page.locator(`button:has-text("${selectedTime}"), [data-time="${selectedTime}"]`).first();
      if (await timeBtn.count() > 0) {
        await timeBtn.click();
        await page.waitForTimeout(1000);
      }
    }

    // 다음 버튼 클릭
    const nextBtn = page.locator('button:has-text("다음"), button:has-text("예약하기")').first();
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
    }

    // 이름 입력
    const nameInput = page.locator('input[placeholder*="이름"], input[name*="name"], input[id*="name"]').first();
    if (await nameInput.count() > 0) {
      await nameInput.fill('');
      await nameInput.type(userName, { delay: 60 });
    }

    // 전화번호 입력
    const phoneInput = page.locator('input[placeholder*="전화"], input[placeholder*="연락처"], input[type="tel"]').first();
    if (await phoneInput.count() > 0) {
      await phoneInput.fill('');
      await phoneInput.type(userPhone, { delay: 60 });
    }

    await page.waitForTimeout(1000);

    // 결제 직전 스크린샷
    const screenshot = await page.screenshot({ encoding: 'base64', fullPage: false });
    const finalUrl = page.url();

    await browser.close();

    return res.json({
      success: true,
      message: '예약 정보 입력 완료. 결제만 진행해주세요.',
      screenshot: `data:image/png;base64,${screenshot}`,
      paymentUrl: finalUrl,
    });

  } catch (err: any) {
    await browser.close();
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
