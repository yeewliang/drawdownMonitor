import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

const env = import.meta.env;

export const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || "asia-southeast1");

if (env.VITE_USE_EMULATORS === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export const TELEGRAM_BOT_USERNAME: string = env.VITE_TELEGRAM_BOT_USERNAME ?? "";

/** Public URL of the `mcp` Cloud Function. */
export const MCP_URL: string =
  env.VITE_MCP_URL ||
  (env.VITE_USE_EMULATORS === "true"
    ? `http://127.0.0.1:5001/${env.VITE_FIREBASE_PROJECT_ID}/${env.VITE_FUNCTIONS_REGION || "asia-southeast1"}/mcp`
    : `https://${env.VITE_FUNCTIONS_REGION || "asia-southeast1"}-${env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net/mcp`);
