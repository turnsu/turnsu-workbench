// Chromium silently drops non-ASCII upload paths in a POSIX locale on Linux.
// Normalize only this application's child-process environment, never system settings.
export function prepareChromiumEnvironment(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "linux") return;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "C";
  if (!/utf-?8/i.test(locale)) {
    env.LC_CTYPE = "C.UTF-8";
    if (env.LC_ALL) env.LC_ALL = "C.UTF-8";
  }
}
