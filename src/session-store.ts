import { v4 as uuidv4 } from 'uuid';
import { Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

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

// 파일 저장 경로 (Railway 볼륨 또는 /tmp)
const SESSION_FILE = process.env.SESSION_FILE_PATH || '/tmp/jarvis_sessions.json';

class SessionStore {
  private sessions = new Map<string, NaverSession>();
  private pendingSessions = new Map<string, PendingSession>();

  constructor() {
    this.loadFromFile();
  }

  // 파일에서 세션 로드
  private loadFromFile() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        const now = Date.now();
        const TTL = 7 * 24 * 60 * 60 * 1000; // 7일
        for (const [id, session] of Object.entries(data) as [string, NaverSession][]) {
          if (now - session.lastUsed < TTL) {
            this.sessions.set(id, session);
          }
        }
        console.log(`[SessionStore] ${this.sessions.size}개 세션 로드됨`);
      }
    } catch (e) {
      console.warn('[SessionStore] 세션 파일 로드 실패:', e);
    }
  }

  // 파일에 세션 저장
  private saveToFile() {
    try {
      const data: Record<string, NaverSession> = {};
      for (const [id, session] of this.sessions) {
        data[id] = session;
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[SessionStore] 세션 파일 저장 실패:', e);
    }
  }

  create(userId: string, cookies: any[]): string {
    const id = uuidv4();
    const session: NaverSession = {
      id,
      cookies,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      userId,
    };
    this.sessions.set(id, session);

    // 같은 userId의 기존 세션 제거 (최신 세션만 유지)
    for (const [existingId, existingSession] of this.sessions) {
      if (existingId !== id && existingSession.userId === userId) {
        this.sessions.delete(existingId);
      }
    }

    this.saveToFile();
    return id;
  }

  get(id: string): NaverSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastUsed = Date.now();
      this.saveToFile();
    }
    return session;
  }

  // userId로 최신 세션 찾기
  getByUserId(userId: string): NaverSession | undefined {
    let latest: NaverSession | undefined;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        if (!latest || session.lastUsed > latest.lastUsed) {
          latest = session;
        }
      }
    }
    return latest;
  }

  // 가장 최근에 사용된 세션 반환
  getLatest(): NaverSession | undefined {
    let latest: NaverSession | undefined;
    for (const session of this.sessions.values()) {
      if (!latest || session.lastUsed > latest.lastUsed) {
        latest = session;
      }
    }
    return latest;
  }

  delete(id: string) {
    this.sessions.delete(id);
    this.saveToFile();
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
    const TTL = 7 * 24 * 60 * 60 * 1000; // 7일
    let changed = false;
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > TTL) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.saveToFile();

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
