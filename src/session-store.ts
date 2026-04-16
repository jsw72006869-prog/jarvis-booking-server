import { v4 as uuidv4 } from 'uuid';

interface NaverSession {
  id: string;
  cookies: any[];
  createdAt: number;
  lastUsed: number;
  userId: string; // 네이버 아이디 (비밀번호는 저장 안 함)
}

class SessionStore {
  private sessions = new Map<string, NaverSession>();

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

  // 24시간 이상 된 세션 정리
  cleanup() {
    const now = Date.now();
    const TTL = 24 * 60 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > TTL) {
        this.sessions.delete(id);
      }
    }
  }
}

export const sessionStore = new SessionStore();
