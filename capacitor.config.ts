import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "top.imsyy.splayer.car",
  appName: "SPlayer-Next",
  webDir: "dist/android/web",
  server:
    process.env.SPLAYER_ANDROID_DEV === "1"
      ? { url: "http://localhost:14559", cleartext: true }
      : undefined,
  loggingBehavior: "none",
  android: { allowMixedContent: true },
};

export default config;
