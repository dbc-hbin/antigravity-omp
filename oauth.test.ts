import { expect, test } from "bun:test";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { loadExtension } from "./extension-fixture";

test("advertises agy's OAuth callback and PKCE contract when login starts", async () => {
  const { registration } = await loadExtension();
  const controller = new AbortController();
  let authorization: URL | undefined;
  const error: unknown = await registration.oauth
    .login({
      signal: controller.signal,
      onAuth(info) {
        authorization = new URL(info.url);
        controller.abort();
      },
    })
    .catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(LoginCancelledError);
  if (!authorization) throw new Error("Login did not supply an authorization URL");

  expect(authorization.origin + authorization.pathname).toBe(
    "https://accounts.google.com/o/oauth2/auth",
  );
  expect(authorization.searchParams.get("client_id")).toBe(
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  );
  expect(authorization.searchParams.get("scope")?.split(" ")).toEqual([
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "https://www.googleapis.com/auth/aicode",
  ]);
  expect(authorization.searchParams.get("response_type")).toBe("code");
  expect(authorization.searchParams.get("access_type")).toBe("offline");
  expect(authorization.searchParams.get("prompt")).toBe("consent");
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(authorization.searchParams.get("state")).toMatch(/^[a-f0-9]+$/);
  const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  expect(redirect.protocol).toBe("http:");
  expect(redirect.hostname).toBe("localhost");
  expect(redirect.pathname).toBe("/auth/callback");
  expect(Number(redirect.port)).toBeGreaterThan(0);
});
