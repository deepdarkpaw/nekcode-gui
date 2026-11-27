// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { NekConfigTarget } from "@zcode/shared/nek-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createNekTestEnv } from "../test/nekTestUtils.js";
import { LOCAL_TARGET } from "./NekSettingsContext.js";
import { useProjectSettingsTarget } from "./useProjectSettingsTarget.js";

afterEach(cleanup);

it("uses the matched host by default, but preserves an explicit local choice", async () => {
  const env = createNekTestEnv();
  const saved = env.host.hosts[0]!;
  const options = {
    apis: { config: env.config, host: env.host, isMock: false },
    remote: saved.target,
    isRemote: true,
    scoped: false,
    configPage: true,
  };
  const { result, rerender } = renderHook(
    ({ selected }: { selected?: NekConfigTarget }) =>
      useProjectSettingsTarget({ ...options, selected }),
    {
      wrapper: env.wrapper,
      initialProps: {},
    },
  );
  expect(result.current.target.kind).toBe("remote");
  expect(result.current.targetInfo?.connected).toBe(false);
  await waitFor(() =>
    expect(result.current.target).toEqual({ kind: "remote", connectionId: saved.connectionId }),
  );
  rerender({ selected: LOCAL_TARGET });
  expect(result.current.target).toBe(LOCAL_TARGET);
  expect(result.current.onProjectHost).toBe(false);
  rerender({});
  expect(result.current.target).toEqual({ kind: "remote", connectionId: saved.connectionId });
});

it("does not silently use local settings for an unsaved host", async () => {
  const env = createNekTestEnv();
  const connect = vi.spyOn(env.host, "connectHost");
  const { result } = renderHook(
    () =>
      useProjectSettingsTarget({
        apis: { config: env.config, host: env.host, isMock: false },
        remote: { kind: "ssh", host: "unsaved.example", username: "dev" },
        isRemote: true,
        scoped: false,
        configPage: true,
      }),
    { wrapper: env.wrapper },
  );
  await waitFor(() => expect(result.current.unsaved).toBe(true));
  expect(result.current.target.kind).toBe("remote");
  expect(result.current.targetInfo).toMatchObject({ connected: false });
  expect(connect).not.toHaveBeenCalled();
});
