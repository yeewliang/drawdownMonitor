import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** Emit /__/firebase/init.json (read by the proxied Firebase auth handler) from env, so no key is committed. */
function firebaseInitJson(env: Record<string, string>): Plugin {
  return {
    name: "firebase-init-json",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "__/firebase/init.json",
        source: JSON.stringify({
          apiKey: env.VITE_FIREBASE_API_KEY,
          appId: env.VITE_FIREBASE_APP_ID,
          authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
          messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
          projectId: env.VITE_FIREBASE_PROJECT_ID,
        }),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), firebaseInitJson(loadEnv(mode, process.cwd(), "VITE_"))],
}));
