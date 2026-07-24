import OpenAI from "openai";

import { getConfiguredOpenAIModel, getServerEnv } from "@/lib/env";

let openaiClient: OpenAI | null = null;

export function getOpenAIClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: getServerEnv().OPENAI_API_KEY
    });
  }
  return openaiClient;
}

/** Lazy proxy so importing this module during builds does not require secrets. */
export const openai = new Proxy({} as OpenAI, {
  get(_target, property, receiver) {
    const client = getOpenAIClient() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(client, property, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  }
});

export function getOpenAIModel() {
  return getConfiguredOpenAIModel();
}
