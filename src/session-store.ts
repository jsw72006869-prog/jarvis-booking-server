import { v4 as uuidv4 } from 'uuid';
import { Browser, BrowserContext, Page } from 'playwright';

interface NaverSession {
  id: string;
  cookies: any[];
  createdAt: number;
  lastUsed: number;
  userId: string;
}

// 캡차/2단계 인증 대기 중인 브라우저 세션
interface PendingSession {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  userId: string;
}

class SessionStore {
  private sessions = new Map<string, NaverSession>();
  private pendingSessions = new Map<string, PendingSession>();

  create(userId: string, cookies: any[]): string {
    const id = uuidv4();
    this.sessions.set(id, {
      id,
      cookies,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      userId,
    });
    return id;
  }

  get(id: string): NaverSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastUsed = Date.now();
    }
    return session;
  }

  delete(id: string) {
    this.sessions.delete(id);
  }

  // ── 캡차 대기 세션 ──────────────────────────────────────────
  createPending(userId: string, browser: Browser, context: BrowserContext, page: Page): string {
    const id = uuidv4();
    this.pendingSessions.set(id, {
      id,
      browser,
      context,
      page,
      createdAt: Date.now(),
      userId,
    });
    return id;
  }

  getPending(id: string): PendingSession | undefined {
    return this.pendingSessions.get(id);
  }

  deletePending(id: string) {
    this.pendingSessions.delete(id);
  }

  // 24시간 이상 된 세션 정리
  cleanup() {
    const now = Date.now();
    const TTL = 24 * 60 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > TTL) {
        this.sessions.delete(id);
      }
    }
    // 5분 이상 된 pending 세션 정리 (브라우저 닫기)
    const PENDING_TTL = 5 * 60 * 1000;
    for (const [id, pending] of this.pendingSessions) {
      if (now - pending.createdAt > PENDING_TTL) {
        pending.browser.close().catch(() => {});
        this.pendingSessions.delete(id);
      }
    }
  }
}

export const sessionStore = new SessionStore();
