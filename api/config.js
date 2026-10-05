import { engines, env, json, llmProvider } from "./_lib.js";
export const config = { runtime: "edge" };
export default async function handler() {
  return json({ engines: engines(), llm: !!llmProvider(), writer: llmProvider(), access: !!env("ACCESS_CODE") });
}
