import { engines, env, json } from "./_lib.js";
export const config = { runtime: "edge" };
export default async function handler() {
  return json({ engines: engines(), llm: !!(env("OPENAI_API_KEY") || env("ANTHROPIC_API_KEY")), access: !!env("ACCESS_CODE") });
}
