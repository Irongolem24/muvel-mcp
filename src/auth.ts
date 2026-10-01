import { Entry } from "@napi-rs/keyring";

export const API_BASE = process.env.MUVEL_API_BASE ?? "https://muvel.app/api";

// The Muvel desktop app (Tauri, identifier "com.muvel") stores its tokens in the
// OS keyring via keyring-rs. We only ever read from it, never write.
const KEYRING_SERVICE = "com.muvel";
const KEYRING_REFRESH_ACCOUNT = "com.muvel/refreshToken/password";

// Muvel refresh tokens are not rotated (verified 2026-10-01): refreshing returns
// only a new access token and the stored refresh token stays valid, so the MCP
// server can refresh on its own without logging the desktop app out.

function readRefreshToken(): string {
  const fromEnv = process.env.MUVEL_REFRESH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  let token: string | null = null;
  try {
    token = new Entry(KEYRING_SERVICE, KEYRING_REFRESH_ACCOUNT).getPassword();
  } catch (err) {
    throw new Error(
      `Muvel 데스크톱 앱의 로그인 정보를 OS 키링에서 읽지 못했습니다 (${(err as Error).message}). ` +
        "Muvel 데스크톱 앱에서 로그인하거나 MUVEL_REFRESH_TOKEN 환경변수를 설정하세요.",
    );
  }
  if (!token) {
    throw new Error("Muvel 로그인 정보가 없습니다. Muvel 데스크톱 앱에서 로그인하세요.");
  }
  return token;
}

function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export class TokenProvider {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  async get(): Promise<string> {
    // Refresh a minute early so a request never goes out with a token about to expire.
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    return this.refresh();
  }

  refresh(): Promise<string> {
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    // Re-read every time: the user may have re-logged in the desktop app.
    const refreshToken = readRefreshToken();
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        `Muvel 토큰 갱신 실패 (HTTP ${res.status}). Muvel 데스크톱 앱에서 다시 로그인한 뒤 재시도하세요.`,
      );
    }
    const { accessToken } = (await res.json()) as { accessToken?: string };
    if (!accessToken) throw new Error("Muvel 토큰 갱신 응답에 accessToken이 없습니다.");
    this.accessToken = accessToken;
    this.expiresAt = jwtExpiry(accessToken) || Date.now() + 10 * 60_000;
    return accessToken;
  }
}
